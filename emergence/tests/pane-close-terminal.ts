import xterm from '@xterm/headless';
import { spawn } from 'node-pty';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { saveConfig } from '../src/app/config.ts';
import { defaultConfig } from '../src/core/domain/configuration.ts';
import { enterWorkspace } from './fixtures/enter-workspace.ts';
import { modelServer } from './fixtures/model-server.ts';
import { clickTerminalText, exitTerminal, sendTerminalInput } from './fixtures/terminal-interaction.ts';

const artifacts = resolve('../artifacts/fixes/pane-close');
await mkdir(artifacts, { recursive: true });
const root = await mkdtemp(join(artifacts, 'terminal-')),
  home = join(root, 'home'),
  project = join(root, '项目');
await mkdir(project);
const server = await modelServer();
await saveConfig(home, {
  ...structuredClone(defaultConfig),
  models: [
    {
      ...defaultConfig.models[0],
      baseURL: server.baseURL,
      model: 'fixture-one',
      apiKeyEnv: 'PANE_CLOSE_KEY',
    },
  ],
});
type Saved = { focused: string; panes: Array<{ id: string; sessionId: string }> };
async function state(): Promise<Saved | undefined> {
  try {
    const file = (await readdir(join(home, 'workspaces'))).find((n) => n.endsWith('.json'))!;
    return JSON.parse(await readFile(join(home, 'workspaces', file), 'utf8'));
  } catch {
    return undefined;
  }
}
const quote = (s: string) => "'" + s.replaceAll("'", "''") + "'";
const checks: Record<string, boolean> = {},
  frames: Record<string, string> = {};
async function open() {
  const terminal = new xterm.Terminal({ cols: 120, rows: 36, allowProposedApi: true });
  const command = `& ${quote(process.execPath)} ${quote(resolve('bin/emergence.cjs'))} ${quote(project)} --home ${quote(home)}; Write-Output EMERGENCE_RETURNED`;
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', command], {
    cwd: process.cwd(),
    cols: 120,
    rows: 36,
    useConptyDll: true,
    env: { ...process.env, PANE_CLOSE_KEY: 'local-close-fixture', TERM: 'xterm-256color' },
  });
  let ended = false,
    bytes = '';
  child.onData((text) => {
    bytes += text;
    terminal.write(text);
  });
  const exit = new Promise<number>((done) =>
    child.onExit((event) => {
      ended = true;
      done(event.exitCode);
    }),
  );
  const screen = () =>
    Array.from(
      { length: terminal.rows },
      (_, y) => terminal.buffer.active.getLine(y)?.translateToString(true) ?? '',
    ).join('\n');
  async function until(label: string, predicate: () => boolean | Promise<boolean>) {
    for (let i = 0; i < 300; i++) {
      if (await predicate()) return;
      if (ended) break;
      await delay(50);
    }
    frames.failure = screen();
    throw new Error(`Timeout: ${label}\n${screen()}`);
  }
  async function send(text: string) {
    await sendTerminalInput(text, screen, (bytes) => child.write(bytes));
  }
  await until('startup', () => screen().includes('就绪'));
  await enterWorkspace(screen, (bytes) => child.write(bytes), until);
  return {
    child,
    screen,
    until,
    send,
    async count(n: number) {
      await until('pane count ' + n, async () => (await state())?.panes.length === n);
    },
    async close() {
      await exitTerminal(screen, (bytes) => child.write(bytes));
      assert.equal(
        await Promise.race([
          exit,
          delay(15000).then(() => {
            throw new Error('Exit timeout');
          }),
        ]),
        0,
      );
      assert.ok(bytes.includes('EMERGENCE_RETURNED'));
      assert.equal(terminal.buffer.active.type, 'normal');
      terminal.dispose();
    },
    dispose() {
      if (!ended) child.kill();
      terminal.dispose();
    },
  };
}
let ui: Awaited<ReturnType<typeof open>> | undefined;
try {
  ui = await open();
  await ui.count(1);
  assert.ok(ui.screen().includes('[关闭]'));
  assert.ok(!ui.screen().includes('F6 关闭'), '定稿底栏不常驻快捷键，后续仍实测 F6 关闭');
  checks.visibleCloseControls = true;
  await ui.send('/split right');
  await ui.count(2);
  await ui.send('/split down');
  await ui.count(3);
  const [a, , c] = (await state())!.panes;
  await ui.send('/focus 1');
  await ui.send('phase2:cancel');
  await ui.send('/focus 2');
  await ui.send('phase2:cancel');
  await ui.until('two streams', () => server.calls.filter((call) => call.scenario === 'cancel').length === 2);
  ui.child.write('\x1b[17~');
  await ui.count(2);
  await ui.until('only closed stream cancelled', () => server.cancelled === 1);
  assert.deepEqual(
    (await state())!.panes.map((p) => p.id),
    [a.id, c.id],
  );
  checks.f6StopsOnlyClosedWindow = true;
  await ui.send(`/hide ${c.id}`);
  await ui.send('/close');
  await ui.count(1);
  await ui.until('remaining stream stopped', () => server.cancelled === 2);
  assert.equal((await state())!.focused, c.id);
  checks.closeLastVisibleRevealsHidden = true;
  await ui.send('/split right');
  await ui.count(2);
  const d = (await state())!.panes[1];
  await ui.send('phase2:question');
  await ui.until('question pending', () => ui!.screen().includes('请选择验证颜色'));
  await ui.send('/focus 1');
  await ui.until('both close buttons visible', () => ui!.screen().split('[关闭]').length === 3);
  clickTerminalText('[关闭]', ui.screen, (bytes) => ui!.child.write(bytes));
  await ui.count(1);
  assert.equal((await state())!.focused, c.id);
  assert.ok(!(await state())!.panes.some((p) => p.id === d.id));
  checks.mouseClosesUnfocusedWaitingWindow = true;
  ui.child.write('\x1b[17~');
  await ui.until('last window hint', () => ui!.screen().includes('最后一个窗口'));
  assert.equal((await state())!.panes.length, 1);
  checks.lastPaneExplainsExit = true;
  await ui.send('/split right');
  await ui.count(2);
  const hidden = (await state())!.panes[1];
  await ui.send('/hide');
  await ui.send(`/close ${hidden.id}`);
  await ui.count(1);
  checks.closeNamedBackgroundWindow = true;
  frames.afterClosing = ui.screen();
  const saved = (await state())!;
  await ui.close();
  ui = undefined;
  ui = await open();
  await ui.count(1);
  assert.deepEqual(
    (await state())!.panes.map((p) => p.sessionId),
    saved.panes.map((p) => p.sessionId),
  );
  checks.closedWindowsDoNotReturnOnRestart = true;
  await ui.close();
  ui = undefined;
  checks.cleanExit = true;
  await writeFile(
    join(artifacts, 'terminal.json'),
    JSON.stringify({ passed: true, root, checks, frames }, null, 2),
  );
  console.log(JSON.stringify(checks, null, 2));
} catch (error) {
  await writeFile(
    join(artifacts, 'terminal.json'),
    JSON.stringify({ passed: false, root, checks, frames, error: String(error) }, null, 2),
  );
  console.error(error);
  process.exitCode = 1;
} finally {
  ui?.dispose();
  await server.close();
}
// Dedicated Windows ConPTY driver; application and shell exit before the driver.
process.exit(process.exitCode ?? 0);
