import xterm from '@xterm/headless';
import { spawn } from 'node-pty';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { saveConfig } from '../src/app/config.ts';
import { defaultConfig } from '../src/core/domain/configuration.ts';
import { enterWorkspace } from './fixtures/enter-workspace.ts';
import { modelServer } from './fixtures/model-server.ts';
import { exitTerminal, sendTerminalInput } from './fixtures/terminal-interaction.ts';
const artifacts = resolve('../artifacts/audit-2026-10-29');
await mkdir(artifacts, { recursive: true });
const root = await mkdtemp(join(artifacts, 'instances-')),
  home = join(root, 'home'),
  a = join(root, '项目 A'),
  b = join(root, '项目 B'),
  c = join(root, '项目 C');
for (const path of [a, b, c]) await mkdir(path);
const server = await modelServer(),
  env = { ...process.env, AUDIT_TERMINAL_KEY: 'local-audit-terminal', TERM: 'xterm-256color' };
await saveConfig(home, {
  ...structuredClone(defaultConfig),
  models: [
    {
      ...defaultConfig.models[0],
      model: 'fixture-one',
      baseURL: server.baseURL,
      apiKeyEnv: 'AUDIT_TERMINAL_KEY',
    },
  ],
});
type Saved = { panes: Array<{ cwd: string; sessionId: string; draft: string }> };
async function saved(cwd: string): Promise<Saved | undefined> {
  try {
    for (const file of (await readdir(join(home, 'workspaces'))).filter((n) => n.endsWith('.json'))) {
      const value = JSON.parse(await readFile(join(home, 'workspaces', file), 'utf8'));
      if (value.panes[0]?.cwd === cwd) return value;
    }
  } catch {}
  return undefined;
}
const quote = (s: string) => "'" + s.replaceAll("'", "''") + "'";
async function open(project: string) {
  const terminal = new xterm.Terminal({ cols: 110, rows: 32, allowProposedApi: true });
  const command = `& ${quote(process.execPath)} ${quote(resolve('bin/emergence.cjs'))} ${quote(project)} --home ${quote(home)}; Write-Output EMERGENCE_RETURNED`;
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', command], {
    cwd: process.cwd(),
    cols: 110,
    rows: 32,
    useConptyDll: true,
    env,
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
    throw new Error(`Timeout ${label}\n${screen()}`);
  }
  await until('ready', () => screen().includes('就绪'));
  await enterWorkspace(screen, (bytes) => child.write(bytes), until);
  return {
    child,
    screen,
    until,
    async send(text: string) {
      await sendTerminalInput(text, screen, (bytes) => child.write(bytes));
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
      terminal.dispose();
    },
    dispose() {
      if (!ended) child.kill();
      terminal.dispose();
    },
  };
}
let first: Awaited<ReturnType<typeof open>> | undefined, second: Awaited<ReturnType<typeof open>> | undefined;
const checks: Record<string, boolean> = {};
try {
  first = await open(a);
  first.child.write('\x1b[200~保留草稿\x1b[201~');
  await first.until('draft persisted', async () => (await saved(a))?.panes[0].draft === '保留草稿');
  const originalId = (await saved(a))!.panes[0].sessionId;
  try {
    await promisify(execFile)(
      process.execPath,
      ['bin/emergence.cjs', a, '--home', home, '--print', 'hello'],
      { cwd: process.cwd(), env, timeout: 25000, windowsHide: true },
    );
    assert.fail('Duplicate workspace was admitted');
  } catch (error) {
    assert.ok(String((error as { stderr?: string }).stderr).includes('当前项目的工作台'));
  }
  assert.equal(server.calls.length, 0);
  assert.equal((await saved(a))!.panes[0].draft, '保留草稿');
  checks.duplicateWorkspaceRejectedWithoutChangingFirst = true;
  second = await open(b);
  await second.send('hello');
  await second.until('second project reply', () => second!.screen().includes('OPENAI_OK'));
  assert.equal((await saved(a))!.panes[0].draft, '保留草稿');
  assert.ok((await saved(b))!.panes[0].sessionId !== originalId);
  checks.differentProjectsCanRunTogether = true;
  try {
    await promisify(execFile)(
      process.execPath,
      ['bin/emergence.cjs', c, '--home', home, '--resume', originalId, '--print', 'hello'],
      { cwd: process.cwd(), env, timeout: 25000, windowsHide: true },
    );
    assert.fail('Live session was resumed twice');
  } catch (error) {
    assert.ok(String((error as { stderr?: string }).stderr).includes('该历史会话'));
  }
  checks.crossProjectResumeCannotBypassSessionLease = true;
  await first.close();
  first = undefined;
  first = await open(a);
  assert.equal((await saved(a))!.panes[0].sessionId, originalId);
  assert.equal((await saved(a))!.panes[0].draft, '保留草稿');
  checks.leaseReleasedForRestart = true;
  await first.close();
  first = undefined;
  await second.close();
  second = undefined;
  const profiles = (await readdir(join(home, 'harness', 'profiles'))).filter((name) =>
    name.startsWith('emergence-'),
  );
  assert.deepEqual(profiles, []);
  checks.generatedProfilesCleaned = true;
  await writeFile(
    join(artifacts, 'multi-instance.json'),
    JSON.stringify({ passed: true, root, checks }, null, 2),
  );
  console.log(JSON.stringify(checks, null, 2));
} catch (error) {
  await writeFile(
    join(artifacts, 'multi-instance.json'),
    JSON.stringify({ passed: false, root, checks, error: String(error) }, null, 2),
  );
  console.error(error);
  process.exitCode = 1;
} finally {
  first?.dispose();
  second?.dispose();
  await server.close();
}
process.exit(process.exitCode ?? 0);
