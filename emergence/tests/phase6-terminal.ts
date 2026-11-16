import xterm from '@xterm/headless';
import { spawn } from 'node-pty';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { saveConfig } from '../src/app/config.ts';
import { defaultConfig } from '../src/core/domain/configuration.ts';
import { enterWorkspace } from './fixtures/enter-workspace.ts';
import { phase6Server } from './fixtures/phase6-model-server.ts';
import { clickTerminalText, exitTerminal, sendTerminalInput } from './fixtures/terminal-interaction.ts';

const dir = resolve('../artifacts/phase6'),
  releaseMode = process.argv.includes('--release');
await mkdir(dir, { recursive: true });
const record = releaseMode ? JSON.parse(await readFile(join(dir, 'release-path.json'), 'utf8')) : undefined;
const root = await mkdtemp(join(dir, 'terminal-matrix-')),
  cwd = join(root, '终端 项目');
await mkdir(cwd);
const server = await phase6Server(),
  quote = (s: string) => "'" + s.replaceAll("'", "''") + "'";
const pwsh = (
  await promisify(execFile)('powershell.exe', [
    '-NoProfile',
    '-Command',
    '(Get-Command pwsh.exe -ErrorAction Stop).Source',
  ])
).stdout.trim();
const shells = [
  { name: 'Windows PowerShell 5.1', file: 'powershell.exe', kind: 'ps' },
  { name: 'PowerShell 7', file: pwsh, kind: 'ps' },
  { name: 'cmd.exe', file: 'cmd.exe', kind: 'cmd' },
];
type Saved = {
  focused: string;
  layout: unknown;
  panes: Array<{ id: string; sessionId: string; draft: string }>;
};
async function saved(home: string): Promise<Saved | undefined> {
  try {
    const file = (await readdir(join(home, 'workspaces'))).find((n) => /^[a-f0-9]{20}\.json$/.test(n));
    return JSON.parse(await readFile(join(home, 'workspaces', file!), 'utf8'));
  } catch {
    return;
  }
}
const frames: Record<string, string> = {},
  checks: Record<string, boolean> = {};
async function open(shell: (typeof shells)[number], home: string) {
  const node = record ? join(record.bundle, 'runtime/node.exe') : process.execPath,
    entry = record ? join(record.bundle, 'app/bin/emergence.cjs') : resolve('bin/emergence.cjs');
  const psCommand = `& ${quote(node)} ${quote(entry)} ${quote(cwd)} --home ${quote(home)}; Write-Output EMERGENCE_RETURNED`;
  const cmdCommand = `"${node}" "${entry}" "${cwd}" --home "${home}" & echo EMERGENCE_RETURNED & exit\r`;
  const args = shell.kind === 'ps' ? ['-NoLogo', '-NoProfile', '-Command', psCommand] : ['/d', '/q'];
  const terminal = new xterm.Terminal({ cols: 140, rows: 38, allowProposedApi: true });
  const child = spawn(shell.file, args, {
    cwd,
    cols: 140,
    rows: 38,
    useConptyDll: true,
    env: {
      ...process.env,
      NODE_PATH: '',
      NODE_OPTIONS: '',
      PHASE6_MATRIX_KEY: 'local-terminal-fixture',
      TERM: 'xterm-256color',
    },
  });
  let ended = false,
    bytes = '';
  child.onData((text) => {
    bytes += text;
    terminal.write(text);
  });
  if (shell.kind === 'cmd') {
    await delay(150);
    child.write(cmdCommand);
  }
  const exit = new Promise<number>((done) =>
    child.onExit((e) => {
      ended = true;
      done(e.exitCode);
    }),
  );
  const screen = () =>
    Array.from(
      { length: terminal.rows },
      (_, y) => terminal.buffer.active.getLine(y)?.translateToString(true) ?? '',
    ).join('\n');
  async function until(label: string, predicate: () => boolean | Promise<boolean>) {
    for (let i = 0; i < 400; i++) {
      if (await predicate()) return;
      if (ended) break;
      await delay(40);
    }
    frames.failure = screen();
    throw new Error(`Terminal ${shell.name}: ${label}\n${screen()}\n${bytes.slice(-600)}`);
  }
  async function send(value: string) {
    await sendTerminalInput(value, screen, (bytes) => child.write(bytes));
  }
  await until(
    'startup',
    () =>
      (screen().includes('输入任务或 /help') ||
        screen().includes('Task or /help') ||
        screen().includes('描述你要完成')) &&
      screen().includes('就绪'),
  );
  await enterWorkspace(screen, (bytes) => child.write(bytes), until);
  return {
    child,
    screen,
    until,
    send,
    terminal,
    async close() {
      await exitTerminal(screen, (bytes) => child.write(bytes));
      const code = await Promise.race([
        exit,
        delay(15000).then(() => {
          throw new Error('Terminal exit timeout');
        }),
      ]);
      assert.equal(code, 0);
      assert.ok(bytes.includes('EMERGENCE_RETURNED'));
      assert.equal(terminal.buffer.active.type, 'normal');
      terminal.dispose();
    },
    async crash() {
      child.kill();
      await Promise.race([
        exit,
        delay(15000).then(() => {
          throw new Error('Crash exit timeout');
        }),
      ]);
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
  for (const [index, shell] of shells.entries()) {
    console.log(`Terminal host: ${shell.name}`);
    const home = join(root, `home-${index}`),
      config = structuredClone(defaultConfig);
    config.models[0] = { ...config.models[0], apiKeyEnv: 'PHASE6_MATRIX_KEY', baseURL: server.baseURL };
    await saveConfig(home, config);
    ui = await open(shell, home);
    await ui.until('saved startup', async () => (await saved(home))?.panes.length === 1);
    ui.child.write('\x1b[200~中文🙂\n第二行\x1b[201~');
    await ui.until(
      'unicode multiline paste',
      async () => (await saved(home))?.panes[0].draft === '中文🙂\n第二行',
    );
    checks[`${index}-unicode-paste`] = true;
    await ui.send('hello');
    await ui.until('model reply', () => ui!.screen().includes('ECHO_COMPLETE'));
    ui.child.write('\x1bOQ');
    await ui.until('split', async () => (await saved(home))?.panes.length === 2);
    await ui.send('phase6:hang');
    await ui.until('stream', () => ui!.screen().includes('WAITING_FOR_RECOVERY'));
    const streaming = (await saved(home))!.focused;
    ui.child.write('\t');
    await ui.until('switch', async () => (await saved(home))?.focused !== streaming);
    ui.child.write('\x1b[200~后台草稿🌱\x1b[201~');
    await ui.until(
      'draft survives other-pane stream',
      async () => (await saved(home))?.panes.some((p) => p.draft === '后台草稿🌱') === true,
    );
    frames[`${index}-background`] = ui.screen();
    checks[`${index}-stream-and-draft`] = true;
    clickTerminalText('2 会话', ui.screen, (bytes) => ui!.child.write(bytes));
    await ui.until('mouse focus', async () => (await saved(home))?.focused === streaming);
    checks[`${index}-mouse`] = true;
    ui.child.write('\x1b');
    await ui.until('cancel', () => server.activeStreams === 0);
    ui.child.write('\x1b[17~');
    await ui.until('F6 close', async () => (await saved(home))?.panes.length === 1);
    assert.equal((await saved(home))!.panes[0].draft, '后台草稿🌱');
    ui.child.resize(50, 22);
    ui.terminal.resize(50, 22);
    await delay(200);
    assert.ok(ui.screen().includes('[关闭]'));
    frames[`${index}-narrow`] = ui.screen();
    ui.child.resize(140, 38);
    ui.terminal.resize(140, 38);
    await ui.close();
    ui = undefined;
    checks[`${index}-close-and-buffer`] = true;
    const calls = server.calls.length;
    ui = await open(shell, home);
    await ui.until('restored draft', () => ui!.screen().includes('后台草稿🌱'));
    assert.equal(server.calls.length, calls);
    if (index === 0) {
      await ui.send('phase6:hang');
      await ui.until('pre-crash stream', () => server.activeStreams === 1);
      const session = (await saved(home))!.panes[0].sessionId;
      await ui.crash();
      ui = undefined;
      for (let i = 0; server.activeStreams && i < 300; i++) await delay(40);
      assert.equal(server.activeStreams, 0);
      const before = server.calls.length;
      ui = await open(shell, home);
      await ui.until(
        'same history after hard terminal close',
        async () => (await saved(home))?.panes[0].sessionId === session,
      );
      assert.equal(server.calls.length, before);
      checks.hardTerminalCloseDoesNotReplay = true;
    }
    await ui.close();
    ui = undefined;
    checks[`${index}-restart-without-replay`] = true;
  }
  await writeFile(
    join(dir, 'terminal-matrix.json'),
    JSON.stringify(
      {
        passed: true,
        mode: releaseMode ? 'release' : 'local',
        timestamp: new Date().toISOString(),
        shells,
        checks,
        frames,
        root,
        archiveSha256: record?.sha256,
        scope:
          'Current local build through three shells on Windows ConPTY, decoded by xterm; physical IME candidate windows and font rendering remain manual checks.',
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(checks));
} catch (error) {
  await writeFile(
    join(dir, 'terminal-matrix.json'),
    JSON.stringify({ passed: false, error: String(error), checks, frames, root }, null, 2),
  );
  throw error;
} finally {
  ui?.dispose();
  await server.close();
}
// ConPTY conout worker is explicitly ended after asserting product/shell exits.
process.exit(0);
