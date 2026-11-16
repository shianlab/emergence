import xterm from '@xterm/headless';
import { spawn } from 'node-pty';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { saveConfig } from '../src/app/config.ts';
import { snapshotPath } from '../src/app/tui/home-state.ts';
import { defaultConfig } from '../src/core/domain/configuration.ts';
import { phase6Server } from './fixtures/phase6-model-server.ts';
import { exitTerminal, sendTerminalInput } from './fixtures/terminal-interaction.ts';

const dir = resolve('../artifacts/tui-phase1');
await mkdir(dir, { recursive: true });
const root = await mkdtemp(join(dir, 'terminal-')),
  home = join(root, 'home'),
  cwd = join(root, '中文 项目');
await mkdir(cwd);
const server = await phase6Server(),
  config = structuredClone(defaultConfig);
config.models[0] = { ...config.models[0], apiKeyEnv: 'TUI_PHASE1_TERMINAL_KEY', baseURL: server.baseURL };
await saveConfig(home, config);
const frames: Record<string, string> = {},
  checks: Record<string, boolean> = {};
async function open(extra: string[] = [], key = true) {
  const terminal = new xterm.Terminal({ cols: 120, rows: 38, allowProposedApi: true });
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  env.TERM = 'xterm-256color';
  env.NODE_OPTIONS = '';
  env.NODE_PATH = '';
  delete env.NO_COLOR; // Exercise the real, interruptible reveal animation on a TTY.
  if (key) env.TUI_PHASE1_TERMINAL_KEY = 'local-model-fixture';
  else delete env.TUI_PHASE1_TERMINAL_KEY;
  const child = spawn(process.execPath, [resolve('bin/emergence.cjs'), cwd, '--home', home, ...extra], {
    cwd: process.cwd(),
    cols: 120,
    rows: 38,
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
    for (let i = 0; i < 350; i++) {
      if (await predicate()) return;
      if (ended) break;
      await delay(40);
    }
    frames.failure = screen();
    throw new Error(`${label}\n${screen()}\n${bytes.slice(-500)}`);
  }
  async function send(text: string) {
    await sendTerminalInput(text, screen, (bytes) => child.write(bytes));
  }
  async function close() {
    // Send one explicit exit; ConPTY can close its pipe before onExit arrives.
    child.write('\x01\x7f');
    await delay(100);
    await exitTerminal(screen, (bytes) => child.write(bytes));
    const code = await Promise.race([
      exit,
      delay(12000).then(() => {
        throw new Error('Exit timeout');
      }),
    ]);
    assert.equal(code, 0);
    assert.equal(terminal.buffer.active.type, 'normal');
    assert.ok(bytes.includes('\x1b[?25h'));
    terminal.dispose();
  }
  return {
    child,
    screen,
    until,
    send,
    close,
    terminal,
    dispose() {
      if (!ended) child.kill();
      terminal.dispose();
    },
  };
}
let app: Awaited<ReturnType<typeof open>> | undefined;
try {
  app = await open();
  await app.until(
    'home ready',
    () => app!.screen().includes('就绪') && app!.screen().includes('描述你要完成'),
  );
  assert.equal(server.calls.length, 0);
  await assert.rejects(readFile(snapshotPath({ home, cwd })), { code: 'ENOENT' });
  const histories = await readdir(join(home, 'sessions'), { recursive: true }).catch(() => []);
  assert.equal(histories.filter((name) => name.endsWith('.jsonl')).length, 0);
  checks.homeHasNoSessionOrModelCall = true;
  frames['home-120'] = app.screen();
  app.child.resize(160, 44);
  app.terminal.resize(160, 44);
  await app.until('wide logo', () => /[▀▄█]/.test(app!.screen()));
  frames['home-160'] = app.screen();
  app.child.resize(80, 24);
  app.terminal.resize(80, 24);
  await app.until(
    'narrow input',
    () => app!.screen().includes('deepseek-flash') && app!.screen().includes('Ctrl+C'),
  );
  frames['home-80'] = app.screen();
  app.child.resize(120, 38);
  app.terminal.resize(120, 38);
  await app.send('第一条任务🙂\n第二行保持');
  app.child.write('\r');
  await app.until('first reply', () => app!.screen().includes('ECHO_COMPLETE'));
  assert.equal(server.calls.length, 1);
  frames.conversation = app.screen();
  checks.singleFirstSubmissionThroughRealCLI = true;
  await app.close();
  app = undefined;
  const original = await readFile(snapshotPath({ home, cwd }), 'utf8'),
    state = JSON.parse(original),
    session = state.panes[0].sessionId as string;
  const logs = (await readdir(join(home, 'sessions'), { recursive: true })).filter((name) =>
    name.endsWith('.jsonl'),
  );
  const content = (
    await Promise.all(logs.map((name) => readFile(join(home, 'sessions', name), 'utf8')))
  ).join('\n');
  assert.ok(content.includes('第一条任务🙂'));
  assert.ok(content.includes('第二行保持'));
  checks.unicodeMultilineInRealHistory = true;
  app = await open();
  await app.until('return home', () => app!.screen().includes('/continue'));
  assert.equal(await readFile(snapshotPath({ home, cwd }), 'utf8'), original);
  assert.equal(server.calls.length, 1);
  await app.send('/continue');
  await app.until('restored history', () => app!.screen().includes('ECHO_COMPLETE'));
  assert.equal(server.calls.length, 1);
  await app.close();
  app = undefined;
  checks.continueRestoresWithoutRequests = true;
  app = await open(['--resume', session]);
  await app.until('explicit resume', () => app!.screen().includes('ECHO_COMPLETE'));
  assert.ok(!app.screen().includes('描述你要完成'));
  assert.equal(server.calls.length, 1);
  await app.close();
  app = undefined;
  checks.explicitResumeSkipsHome = true;
  app = await open([], false);
  await app.until('home without key', () => app!.screen().includes('描述你要完成'));
  await app.send('MISSING_KEY_DRAFT');
  await app.until(
    'missing credential error',
    () => app!.screen().includes('请先设置环境变量') && app!.screen().includes('MISSING_KEY_DRAFT'),
  );
  assert.equal(server.calls.length, 1);
  frames.failedDraft = app.screen();
  await app.close();
  app = undefined;
  checks.failedFirstSendRetainsDraft = true;
  await writeFile(
    join(dir, 'terminal.json'),
    JSON.stringify(
      {
        passed: true,
        checks,
        frames,
        root,
        scope: 'Actual built CLI on Windows ConPTY, decoded by xterm; local model fixture only.',
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(checks));
} catch (error) {
  await writeFile(
    join(dir, 'terminal.json'),
    JSON.stringify({ passed: false, error: String(error), checks, frames, root }, null, 2),
  );
  throw error;
} finally {
  app?.dispose();
  await server.close();
}
process.exit(0);
