import xterm from '@xterm/headless';
import { spawn } from 'node-pty';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { saveConfig } from '../src/app/config.ts';
import type { IntegrationRecord } from '../src/app/integration.ts';
import { defaultConfig } from '../src/core/domain/configuration.ts';
import type { CollaborationState, TaskRecord } from '../src/core/domain/task.ts';
import { enterWorkspace } from './fixtures/enter-workspace.ts';
import { phase4ModelServer } from './fixtures/phase4-model-server.ts';
import { exitTerminal, sendTerminalInput } from './fixtures/terminal-interaction.ts';

const navigationTest = process.argv.includes('--navigation');
const artifacts = resolve(navigationTest ? '../artifacts/experience-e5' : '../artifacts/experience-e4');
await mkdir(artifacts, { recursive: true });
const root = await mkdtemp(join(artifacts, 'terminal-')),
  home = join(root, 'home'),
  a = join(root, '项目 A'),
  b = join(root, '项目 B');
await mkdir(a);
await mkdir(b);
const server = await phase4ModelServer();
const git = async (cwd: string, ...args: string[]) =>
  (await promisify(execFile)('git', args, { cwd, windowsHide: true })).stdout;
await git(a, 'init', '-q');
await git(a, 'config', 'user.name', 'Fixture');
await git(a, 'config', 'user.email', 'fixture@example.test');
await git(a, 'commit', '--allow-empty', '-qm', 'base');
// This suite covers explicit contracts and legacy dispatch, independently of the default
// automatic planner covered by master-dispatch/master-followthrough and live acceptance.
const config = structuredClone(defaultConfig);
config.core.planning.enabled = false;
await saveConfig(home, {
  ...config,
  permissions: {
    defaultMode: 'auto',
    rules: ['write', 'edit'].map((tool) => ({
      tool,
      effect: 'allow',
      path: root.replaceAll('\\', '/') + '/**',
    })),
  },
  defaultModel: 'master',
  models: ['master', 'alpha', 'beta'].map((id) => ({
    ...defaultConfig.models[0],
    id,
    provider: id,
    model: `fixture-${id}`,
    apiKeyEnv: 'PHASE4_KEY',
    baseURL: server.baseURL,
  })),
});
type Saved = {
  focused: string;
  panes: Array<{ id: string; sessionId: string; draft: string }>;
  collaboration: CollaborationState;
  integrations: IntegrationRecord[];
};
async function state(): Promise<Saved | undefined> {
  try {
    const file = (await readdir(join(home, 'workspaces'))).find((n) => n.endsWith('.json'))!;
    return JSON.parse(await readFile(join(home, 'workspaces', file), 'utf8'));
  } catch {
    return undefined;
  }
}
const checks: Record<string, boolean> = {},
  frames: Record<string, string> = {};
const quote = (s: string) => "'" + s.replaceAll("'", "''") + "'";
async function open() {
  const terminal = new xterm.Terminal({ cols: 160, rows: 48, allowProposedApi: true });
  const command = `& ${quote(process.execPath)} ${quote(resolve('bin/emergence.cjs'))} ${quote(a)} --home ${quote(home)}; Write-Output EMERGENCE_RETURNED`;
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', command], {
    cwd: process.cwd(),
    cols: 160,
    rows: 48,
    useConptyDll: true,
    env: { ...process.env, PHASE4_KEY: 'local-phase4-fixture', TERM: 'xterm-256color' },
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
    for (let i = 0; i < 400; i++) {
      if (await predicate()) return;
      if (ended) break;
      await delay(50);
    }
    frames.failure = screen();
    throw new Error(`Timeout: ${label}\n${screen()}\n${bytes.slice(-400)}`);
  }
  async function send(text: string) {
    await sendTerminalInput(text, screen, (bytes) => child.write(bytes));
  }
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
    screen,
    until,
    send,
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
      assert.ok(!bytes.includes('local-phase4-fixture'));
      terminal.dispose();
    },
    dispose() {
      if (!ended) child.kill();
      terminal.dispose();
    },
  };
}
let ui: Awaited<ReturnType<typeof open>> | undefined;
const tasks = async () => (await state())?.collaboration.tasks ?? [];
async function assigned(target: number, objective: string, dependencies?: string) {
  const before = (await tasks()).length;
  await ui!.send(`/assign ${target} "${objective}"${dependencies ? ' ' + dependencies : ''}`);
  await ui!.until('task accepted', async () => (await tasks()).length > before);
  return (await tasks()).at(-1)!;
}
const taskState = async (id: string) => (await tasks()).find((t) => t.id === id)!;
const waitStatus = (id: string, status: TaskRecord['status']) =>
  ui!.until(`${id} ${status}`, async () => (await taskState(id))?.status === status);
try {
  ui = await open();
  await ui.send(`/split right "${a}" alpha`);
  await ui.until('2 windows', async () => (await state())?.panes.length === 2);
  await ui.send(`/split down "${b}" beta`);
  await ui.until('3 windows', async () => (await state())?.panes.length === 3);
  await ui.send('/focus 1');
  const original = (await state())!.panes.map((p) => p.sessionId);
  await ui.send('/mode collaborate 1 2 3');
  await ui.until('collaboration mode', () => ui!.screen().includes('协作模式'));
  assert.deepEqual(
    (await state())!.panes.map((p) => p.sessionId),
    original,
  );
  checks.rolesKeepSessions = true;
  await ui.send('/roles');
  await ui.until('role catalogue', () => ui!.screen().includes('researcher'));
  checks.roleCatalogue = true;
  await ui.send('/assign-role 2 developer "phase4:worker:write:E" "file contains fixture-alpha:E"');
  await ui.until('contracted task created', async () => (await tasks()).some((t) => !!t.contract));
  const contracted = (await tasks()).find((t) => !!t.contract)!;
  await waitStatus(contracted.id, 'needs_review');
  assert.equal(await readFile(join(a, 'phase4-E.txt'), 'utf8'), 'fixture-alpha:E');
  checks.contractWritesButWaitsForReview = true;
  await ui.send(`/task accept ${contracted.id} "Read phase4-E.txt: fixture-alpha:E"`);
  await waitStatus(contracted.id, 'succeeded');
  assert.ok((await taskState(contracted.id)).review?.accepted);
  checks.explicitEvidenceReview = true;

  await ui.send('phase4:master:success');
  await ui.until(
    'master dispatched two tasks',
    async () => (await tasks()).filter((t) => t.requestKey.startsWith('success-')).length === 2,
  );
  await ui.until(
    'two actual completions',
    async () =>
      (await tasks()).filter((t) => t.requestKey.startsWith('success-') && t.status === 'succeeded')
        .length === 2,
  );
  assert.equal(await readFile(join(a, 'phase4-A.txt'), 'utf8'), 'fixture-alpha:A');
  assert.equal(await readFile(join(b, 'phase4-B.txt'), 'utf8'), 'fixture-beta:B');
  await ui.until('master receives results', () => ui!.screen().includes('MASTER_RESULTS'));
  frames.success = ui.screen();
  checks.masterToolDispatchAndReceipt = true;
  assert.equal((await tasks()).filter((t) => t.requestKey.startsWith('success-')).length, 2);
  checks.duplicateToolRequestDoesNotExecuteTwice = true;
  await ui.send('phase4:master:failure');
  await ui.until('failed and waiting tasks', async () => {
    const list = (await tasks()).filter((t) => t.requestKey.startsWith('failure-'));
    return list.some((t) => t.status === 'needs_review') && list.some((t) => t.status === 'waiting_user');
  });
  assert.equal((await state())!.focused, (await state())!.panes[0].id);
  checks.backgroundQuestionKeepsFocus = true;
  frames.waiting = ui.screen();
  await ui.send('/focus 3');
  await ui.send('1');
  await ui.until(
    'question completes',
    async () => (await tasks()).find((t) => t.requestKey === 'failure-1')?.status === 'succeeded',
  );
  const failed = (await tasks()).find((t) => t.requestKey === 'failure-0')!;
  assert.ok(failed.result!.errors.length > 0);
  assert.equal(failed.report!.outcome, 'success');
  checks.toolFailureOverridesModelSuccess = true;
  await ui.send('/focus 1');
  const slow = await assigned(2, 'phase4:worker:slow');
  await waitStatus(slow.id, 'running');
  await ui.until('HTTP stream starts', () => server.calls.some((c) => c.scenario === 'slow'));
  const queued = await assigned(2, 'phase4:worker:write:C');
  assert.equal((await taskState(queued.id)).status, 'queued');
  const dependency = await assigned(3, 'phase4:worker:write:D', slow.id);
  assert.equal((await taskState(dependency.id)).status, 'queued');
  ui.child.write('\x1bOS');
  await delay(200);
  assert.ok(ui.screen().includes('排队'));
  frames.queue = ui.screen();
  checks.visibleQueue = true;
  await ui.send(`/task cancel ${queued.id}`);
  await waitStatus(queued.id, 'cancelled');
  await assert.rejects(readFile(join(a, 'phase4-C.txt')));
  checks.cancelBeforeExecution = true;
  await ui.send('/mode independent');
  await delay(200);
  assert.equal(server.cancelled, 0);
  assert.equal((await taskState(slow.id)).status, 'running');
  checks.switchModeKeepsRunning = true;
  await ui.send(`/task cancel ${slow.id}`);
  await waitStatus(slow.id, 'cancelled');
  await waitStatus(dependency.id, 'blocked');
  checks.cancelAndDependencyFailure = true;
  await ui.send('/mode collaborate 1 2 3');
  const take = await assigned(2, 'phase4:worker:slow');
  await waitStatus(take.id, 'running');
  const parked = await assigned(2, 'phase4:worker:write:C');
  await ui.send(`/task note ${take.id} "用户补充检查要求"`);
  await ui.until('supplement saved', async () => (await taskState(take.id)).notes.length === 1);
  await ui.send('/takeover 2');
  await waitStatus(take.id, 'cancelled');
  await ui.send('manual');
  await ui.until('human controls worker', () => ui!.screen().includes('MANUAL_OK'));
  assert.equal((await taskState(parked.id)).status, 'queued');
  checks.takeoverAndSupplement = true;
  await ui.send('/release 2');
  await waitStatus(parked.id, 'succeeded');
  assert.equal(await readFile(join(a, 'phase4-C.txt'), 'utf8'), 'fixture-alpha:C');
  checks.releaseResumesQueue = true;
  await ui.send('/focus 1');
  await ui.send('/dispatch pause');
  await ui.send('/assign 2 "phase4:worker:write:Z"');
  await delay(250);
  assert.ok(!(await tasks()).some((t) => t.objective.endsWith('write:Z')));
  checks.stopDispatchIsSeparate = true;
  await ui.send('/dispatch resume');
  const shell = await assigned(3, 'phase4:worker:shell-fail');
  await waitStatus(shell.id, 'waiting_user');
  await ui.send('/focus 3');
  await ui.send('y');
  await waitStatus(shell.id, 'needs_review');
  assert.ok((await taskState(shell.id)).result!.errors.some((s) => s.includes('exit code')));
  checks.nonzeroShellExitNeedsReview = true;
  const networkCount = (await tasks()).length;
  await ui.send('/focus 1');
  const network = await assigned(2, 'phase4:worker:network');
  await waitStatus(network.id, 'failed');
  assert.equal((await tasks()).length, networkCount + 1);
  checks.networkFailure = true;
  // Commit only the isolated fixture repository; exercise the actual UI integration command.
  await git(a, 'add', '.');
  await git(a, 'commit', '-qm', 'fixture generated artifacts');
  const worktree = join(root, '隔离 worktree');
  await ui.send(`/worktree "${worktree}"`);
  await ui.until('worktree pane', async () => (await state())?.panes.length === 4);
  await writeFile(join(worktree, 'integrated.txt'), 'checked result');
  await git(worktree, 'add', '.');
  await git(worktree, 'commit', '-qm', 'worker commit');
  await ui.send('/focus 1');
  await ui.send('/mode collaborate 1 2 3 4');
  // The master-shaped fixture model in this new pane returns plain text without a task report.
  const unreported = await assigned(4, 'phase4:worker:no-report');
  await waitStatus(unreported.id, 'needs_review');
  await ui.send('/dispatch pause');
  await ui.until('integration windows idle', () => ui!.screen().includes('0 运行'));
  await ui.send('/integrate 4');
  await ui.until(
    'integration preserves review state',
    async () => (await state())?.integrations[0]?.status === 'needs_review',
  );
  assert.equal(await readFile(join(a, 'integrated.txt'), 'utf8'), 'checked result');
  assert.ok((await state())!.integrations[0].detail.includes(unreported.id));
  checks.worktreeIntegrationCommand = true;
  checks.integrationKeepsUnverifiedTaskVisible = true;
  await ui.send('/mode independent');
  const before = (await state())!;
  await ui.close();
  ui = undefined;
  const callCount = server.calls.length;
  ui = await open();
  await delay(400);
  const restored = (await state())!;
  assert.deepEqual(
    restored.panes.map((p) => p.sessionId),
    before.panes.map((p) => p.sessionId),
  );
  assert.deepEqual(
    restored.collaboration.tasks.map((t) => t.id),
    before.collaboration.tasks.map((t) => t.id),
  );
  assert.equal(server.calls.length, callCount);
  assert.equal(restored.collaboration.mode, 'independent');
  checks.restartKeepsLedgerWithoutReplay = true;
  if (navigationTest) {
    const beforeInput = server.calls.length;
    await ui.send('manual');
    await ui.until(
      'manual reply',
      () => server.calls.length > beforeInput && ui!.screen().includes('0 运行'),
    );
    const beforeRestore = server.calls.length;
    ui.child.write('\x12');
    await ui.until('history picker', () => ui!.screen().includes('输入历史'));
    ui.child.write('\x01');
    ui.child.write('manual');
    await delay(150);
    ui.child.write('\r');
    await delay(450);
    await ui.until('history restored as draft', async () => {
      const saved = await state();
      return saved?.panes.find((p) => p.id === saved.focused)?.draft === 'manual';
    });
    assert.equal(server.calls.length, beforeRestore);
    checks.historyRealKeysDoNotSend = true;
    await ui.send('/model');
    await ui.until('model picker', () => ui!.screen().includes('选择当前窗口模型'));
    ui.child.write('\x1b');
    await delay(150);
    assert.equal((await state())!.panes.find((p) => p.id === restored.focused)?.draft, 'manual');
    checks.cancelModelPickerKeepsDraft = true;
    await ui.send('/tasks');
    await ui.until('task navigation', () => ui!.screen().includes('执行窗口'));
    ui.child.write('\x1b');
    await delay(150);
    checks.realTaskPicker = true;
  }
  frames.restored = ui.screen();
  await ui.close();
  ui = undefined;
  checks.cleanExitAndRedaction = true;
  await writeFile(
    join(artifacts, 'terminal.json'),
    JSON.stringify(
      {
        passed: true,
        root,
        checks,
        frames,
        calls: server.calls,
        taskCount: restored.collaboration.tasks.length,
      },
      null,
      2,
    ),
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
// node-pty Windows conout worker stays live after the application and shell exit; see phase 3 report.
process.exit(process.exitCode ?? 0);
