import xterm from '@xterm/headless';
import { spawn } from 'node-pty';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { saveConfig } from '../src/app/config.ts';
import { geometry, type Layout } from '../src/app/layout.ts';
import { headerBrandLayout } from '../src/app/tui/header-brand.ts';
import { defaultConfig } from '../src/core/domain/configuration.ts';
import { enterWorkspace } from './fixtures/enter-workspace.ts';
import { modelServer } from './fixtures/model-server.ts';
import { exitTerminal, sendTerminalInput } from './fixtures/terminal-interaction.ts';

const artifacts = resolve('../artifacts/phase3');
await mkdir(artifacts, { recursive: true });
const root = await mkdtemp(join(artifacts, 'terminal-')),
  home = join(root, 'home');
const a = join(root, '项目 A'),
  b = join(root, '项目 B');
await mkdir(a);
await mkdir(b);
await promisify(execFile)('git', ['init', '-q', a]);
await promisify(execFile)('git', [
  '-C',
  a,
  '-c',
  'user.name=Fixture',
  '-c',
  'user.email=fixture@example.test',
  'commit',
  '--allow-empty',
  '-qm',
  'test fixture',
]);
const server = await modelServer();
await saveConfig(home, {
  ...structuredClone(defaultConfig),
  defaultModel: 'one',
  models: ['one', 'two'].map((id) => ({
    ...defaultConfig.models[0],
    id,
    provider: id,
    model: `fixture-${id}`,
    apiKeyEnv: 'PHASE3_KEY',
    baseURL: server.baseURL,
  })),
});
type Saved = {
  focused: string;
  layout: Layout;
  panes: Array<{
    id: string;
    sessionId: string;
    cwd: string;
    modelId: string;
    draft: string;
    scrollTop: number;
  }>;
};
async function state(): Promise<Saved | undefined> {
  try {
    const [file] = (await readdir(join(home, 'workspaces'))).filter((n) => n.endsWith('.json'));
    return JSON.parse(await readFile(join(home, 'workspaces', file), 'utf8'));
  } catch {
    return undefined;
  }
}
const checks: Record<string, boolean> = {},
  frames: Record<string, string> = {};
const quote = (s: string) => "'" + s.replaceAll("'", "''") + "'";
async function open() {
  const terminal = new xterm.Terminal({ cols: 140, rows: 48, allowProposedApi: true });
  const command = `& ${quote(process.execPath)} ${quote(resolve('bin/emergence.cjs'))} ${quote(a)} --home ${quote(home)}; Write-Output EMERGENCE_RETURNED`;
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', command], {
    cwd: process.cwd(),
    cols: 140,
    rows: 48,
    useConptyDll: true,
    env: { ...process.env, PHASE3_KEY: 'local-phase3-fixture', TERM: 'xterm-256color' },
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
    for (let i = 0; i < 300; i++) {
      if (await predicate()) return;
      if (ended) break;
      await delay(50);
    }
    frames.failure = screen();
    throw new Error(`Timeout: ${label}\n${screen()}\n${bytes.slice(-500)}`);
  }
  async function send(text: string) {
    await sendTerminalInput(text, screen, (bytes) => child.write(bytes));
  }
  const waitCount = (n: number) => until('pane count', async () => (await state())?.panes.length === n);
  await until(
    'startup',
    () =>
      (screen().includes('输入任务或 /help') ||
        screen().includes('Task or /help') ||
        screen().includes('描述你要完成') ||
        screen().includes('Describe your task')) &&
      screen().includes('就绪'),
  );
  await enterWorkspace(screen, (bytes) => child.write(bytes), until);
  return {
    child,
    terminal,
    screen,
    until,
    send,
    waitCount,
    async close() {
      await exitTerminal(screen, (bytes) => child.write(bytes));
      const code = await Promise.race([
        exit,
        delay(15000).then(() => {
          throw new Error('Exit timeout');
        }),
      ]);
      assert.equal(code, 0);
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
  await ui.waitCount(1);
  await ui.send('phase3:write:A');
  await ui.until('file A', async () => {
    try {
      return (await readFile(join(a, 'proof-A.txt'), 'utf8')) === 'fixture-one:A';
    } catch {
      return false;
    }
  });
  await ui.until('A idle', () => ui!.screen().includes('WRITE_COMPLETE_A'));
  await ui.send(`/split right "${a}" two`);
  await ui.waitCount(2);
  await ui.send('phase3:write:B');
  await ui.until('file B', async () => {
    try {
      return (await readFile(join(a, 'proof-B.txt'), 'utf8')) === 'fixture-two:B';
    } catch {
      return false;
    }
  });
  await ui.send(`/split down "${b}" one`);
  await ui.waitCount(3);
  await ui.send('phase3:write:C');
  await ui.until('file C', async () => {
    try {
      return (await readFile(join(b, 'proof-C.txt'), 'utf8')) === 'fixture-one:C';
    } catch {
      return false;
    }
  });
  await ui.send(`/split right "${b}" two`);
  await ui.waitCount(4);
  await ui.send('phase3:write:D');
  await ui.until('file D', async () => {
    try {
      return (await readFile(join(b, 'proof-D.txt'), 'utf8')) === 'fixture-two:D';
    } catch {
      return false;
    }
  });
  await delay(300);
  frames.fourPanes = ui.screen();
  checks.fourProjectModelCombinations = true;
  await ui.send('/focus 1');
  await ui.until('focus before keyboard split', async () => {
    const saved = await state();
    return saved?.focused === saved?.panes[0]?.id;
  });
  ui.child.write('\x1bOQ');
  await ui.waitCount(5);
  const sameProject = (await state())!.panes[4];
  assert.equal(sameProject.cwd, a);
  assert.equal(sameProject.modelId, 'one');
  await ui.send('hello');
  await ui.until('same project and model', () => ui!.screen().includes('OPENAI_OK'));
  await ui.send('/terminate');
  await ui.waitCount(4);
  checks.sameProjectSameModel = true;
  await ui.send('/focus 1');
  await ui.send('phase3:long');
  await ui.until('long A', () => ui!.screen().includes('history 99 fixture-one'));
  await ui.send('/focus 2');
  await ui.send('phase3:long');
  await ui.until('long B', () => ui!.screen().includes('history 99 fixture-two'));
  await delay(600); // Wait for terminal layout, sticky scroll and the persisted view snapshot.
  const beforeScroll = (await state())!.panes[1].scrollTop;
  const beforeA = (await state())!.panes[0].scrollTop;
  await ui.send('/focus 1');
  ui.child.write('\x1b[5~');
  await delay(400);
  const afterScroll = await state();
  assert.equal(afterScroll!.panes[1].scrollTop, beforeScroll);
  assert.ok(afterScroll!.panes[0].scrollTop < beforeA);
  checks.independentScrolling = true;
  ui.child.write('\x1b[200~甲乙丙丁\x1b[201~');
  await delay(100);
  ui.child.write('\x1b[1;2D\x1b[1;2D');
  await delay(100);
  ui.child.write('\t');
  await delay(100);
  ui.child.write('\x1b[9;6u');
  await delay(100);
  ui.child.write('戊');
  await delay(400);
  assert.equal((await state())!.panes[0].draft, '甲乙戊');
  checks.draftAndSelectionAcrossFocus = true;
  ui.child.write('\x1b[1;2D');
  await delay(80);
  ui.child.write('\x1b[19~');
  await delay(100);
  await ui.send('/show 1');
  ui.child.write('己');
  await delay(350);
  assert.equal((await state())!.panes[0].draft, '甲乙己');
  checks.selectionAcrossHide = true;
  ui.child.write('\x01');
  ui.child.write('\x7f');
  await delay(100);
  const tree = (await state())!.layout;
  assert.equal(tree.kind, 'split');
  if (tree.kind !== 'split') throw new Error('Expected split');
  const headerRows = headerBrandLayout(140, 48).height;
  const split = geometry(tree, { x: 0, y: 0, width: 140, height: 48 - headerRows }).splits.get(tree.id)!;
  const x = split.divider.x + 1,
    y = split.divider.y + headerRows + 1;
  const toX = x + (split.axis === 'row' ? 8 : 0),
    toY = y + (split.axis === 'column' ? 3 : 0);
  ui.child.write(`\x1b[<0;${x};${y}M`);
  ui.child.write(`\x1b[<32;${toX};${toY}M`);
  ui.child.write(`\x1b[<0;${toX};${toY}m`);
  await delay(400);
  const resized = (await state())!.layout;
  assert.ok(resized.kind === 'split' && resized.ratio !== tree.ratio);
  checks.mouseDividerResize = true;
  ui.child.write('\x1b[18~');
  await delay(200);
  frames.maximized = ui.screen();
  assert.ok(ui.screen().includes('最大化'));
  ui.child.write('\x1b[18~');
  await delay(150);
  checks.maximize = true;
  ui.child.resize(55, 24);
  ui.terminal.resize(55, 24);
  await delay(200);
  frames.narrow = ui.screen();
  ui.child.resize(140, 48);
  ui.terminal.resize(140, 48);
  await delay(200);
  checks.narrowRestore = true;
  await ui.send('phase3:cwd');
  await ui.until('A shell approval', () => ui!.screen().includes('需要确认：pwsh'));
  await ui.send('/focus 3');
  await ui.send('phase3:cwd');
  await ui.until('two independent approvals', () => ui!.screen().includes('2 待确认'));
  await ui.send('y');
  await ui.until('B shell directory', async () => {
    try {
      return (await readFile(join(b, 'shell-cwd.txt'), 'utf8')).trim() === b;
    } catch {
      return false;
    }
  });
  await assert.rejects(readFile(join(a, 'shell-cwd.txt')));
  await ui.send('/focus 1');
  await ui.send('y');
  await ui.until('A shell directory', async () => {
    try {
      return (await readFile(join(a, 'shell-cwd.txt'), 'utf8')).trim() === a;
    } catch {
      return false;
    }
  });
  checks.shellDirectoryAndApprovalIsolation = true;
  await ui.send('phase3:cancel');
  await ui.until('A streaming', () => server.calls.some((c) => c.scenario === 'cancel'));
  await ui.send('/focus 2');
  await ui.send('phase3:question');
  await ui.until('B waiting', () => ui!.screen().includes('请选择验证颜色'));
  await ui.send('/focus 3');
  await ui.send('hello');
  await ui.until('C works', () => ui!.screen().includes('OPENAI_OK'));
  await delay(250);
  assert.equal((await state())!.focused, (await state())!.panes[2].id);
  assert.ok(ui.screen().includes('待确认'));
  assert.equal(server.cancelled, 0);
  checks.backgroundQuestionDoesNotStealFocus = true;
  await ui.send('/focus 2');
  await ui.send('1');
  await ui.until('B answered', () => ui!.screen().includes('QUESTION_COMPLETE'));
  await ui.send('/focus 1');
  ui.child.write('\x1b');
  await ui.until('A cancelled', () => server.cancelled > 0);
  checks.cancelOneOnly = true;
  await ui.send('phase3:cancel');
  await ui.until('A streaming again', () => server.calls.filter((c) => c.scenario === 'cancel').length >= 2);
  await ui.send('/hide');
  await delay(300);
  const cancelled = server.cancelled;
  await ui.send('hello');
  await delay(300);
  assert.equal(server.cancelled, cancelled);
  checks.hiddenTaskKeepsRunning = true;
  await ui.send('/show 1');
  ui.child.write('\x1b');
  await ui.until('stop hidden task', () => server.cancelled > cancelled);
  const worktree = join(root, '隔离 worktree');
  await ui.send(`/worktree "${worktree}"`);
  await ui.waitCount(5);
  assert.ok((await state())!.panes.some((p) => p.cwd === worktree));
  await ui.send('/terminate');
  await ui.waitCount(4);
  checks.gitWorktree = true;
  ui.child.write('\x1b[200~重启保留草稿\x1b[201~');
  await delay(350);
  const saved = (await state())!;
  await ui.close();
  ui = undefined;
  ui = await open();
  await delay(400);
  const restored = (await state())!;
  assert.deepEqual(
    restored.panes.map((p) => p.sessionId),
    saved.panes.map((p) => p.sessionId),
  );
  assert.equal(restored.panes.find((p) => p.id === saved.focused)!.draft, '重启保留草稿');
  checks.layoutSessionsAndDraftRestore = true;
  frames.restored = ui.screen();
  await ui.close();
  ui = undefined;
  checks.cleanExit = true;
  await writeFile(
    join(artifacts, 'terminal.json'),
    JSON.stringify({ passed: true, root, checks, frames, calls: server.calls }, null, 2),
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
process.exit(process.exitCode ?? 0);
