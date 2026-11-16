import * as ObservationPolicy from '@deepseek-ai/dsh-fs-observation-policy';
import { ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm';
import Pwsh from '@deepseek-ai/dsh-pwsh-local';
import * as ShellEnv from '@deepseek-ai/dsh-shell-env';
import Subprocess from '@deepseek-ai/dsh-subprocess-local';
import * as FileTools from '@deepseek-ai/dsh-tool-fs';
import * as PwshTools from '@deepseek-ai/dsh-tool-pwsh';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { HistoricalOrchestrationWorkspace as WorkspaceController } from './fixtures/historical-orchestration.ts';
import { evaluatePermission } from '../src/core/adapters/permissions.ts';
import { resolvedEvidenceCurrent } from '../src/core/application/task-failures.ts';
import { defaultConfig } from '../src/core/domain/configuration.ts';
import { diagnostics, discoverChecks } from '../src/domains/code/checks.ts';
import { CodeWorkflow } from '../src/domains/code/workflow.ts';
import { ExecutionProvider, until } from './fixtures/core-execution.ts';
import { harness } from './fixtures/harness.ts';

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'emergence-code-work-')),
    root = join(home, '中文 项目');
  await mkdir(root);
  await mkdir(join(root, 'tests'));
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }),
  );
  await writeFile(join(root, '计算.js'), 'export const add = (a, b) => a - b;\r\n');
  await writeFile(
    join(root, 'tests/calc.test.js'),
    "import { add } from '../计算.js';\nimport assert from 'node:assert/strict';\nimport { test } from 'node:test';\ntest('add', () => assert.equal(add(2, 3), 5));\n",
  );
  return { home, root, work: new CodeWorkflow(home, root, 'fixture') };
}
const signal = () => AbortSignal.timeout(15000);
async function check(work: CodeWorkflow, id: string, exitCode: number, value: object = {}) {
  const input = await work.beforeCheck('npm run test', signal());
  assert.ok(input);
  return work.afterCheck(
    input,
    id,
    'pwsh',
    { exitCode, ...value },
    false,
    false,
    `计算.js(1,20): error TS2322: fixture failure ${exitCode}`,
  );
}

test('check discovery is data only; diagnostic locations preserve Windows/Chinese paths', async () => {
  const f = await fixture(),
    snapshot = await f.work.snapshot(signal());
  assert.equal(discoverChecks(snapshot)[0].command, 'npm run test');
  assert.equal(await f.work.beforeCheck('npm run test; Remove-Item *', signal()), undefined);
  assert.deepEqual(
    diagnostics('C:\\项目\\a.ts(12,3): error TS2322: bad\nlib/a.py:6:9: E999 bad').map((d) => [
      d.path,
      d.line,
      d.column,
    ]),
    [
      ['C:\\项目\\a.ts', 12, 3],
      ['lib/a.py', 6, 9],
    ],
  );
});

test('baseline failure resolves only after same actual check on current sources; stale and weakened criteria do not pass', async () => {
  const f = await fixture();
  await check(f.work, 'baseline', 1);
  const edit = await f.work.beforeEdit('计算.js');
  await writeFile(join(f.root, '计算.js'), 'export const add = (a, b) => a + b;\r\n');
  await f.work.afterEdit(edit, true);
  assert.equal((await f.work.status(signal())).verified, false);
  await check(f.work, 'fixed', 0);
  assert.equal((await f.work.status(signal())).verified, true);
  assert.ok((await f.work.resolvedFailures(signal())).has('baseline'));
  await writeFile(join(f.root, 'tests/calc.test.js'), '// removed assertions');
  assert.equal((await f.work.status(signal())).verified, false);
  await check(f.work, 'weakened', 0);
  assert.equal((await f.work.resolvedFailures(signal())).size, 0);
  const restored = new CodeWorkflow(f.home, f.root, 'fixture');
  assert.equal((await restored.status(signal())).verified, false, 'restart must rerun checks');
  assert.equal(restored.run?.changes[0].before, 'export const add = (a, b) => a - b;\r\n');
});

test('R4 rerunning the same source to green does not resolve a real failing check', async () => {
  const f = await fixture();
  await check(f.work, 'failed', 1);
  await check(f.work, 'flaky-green', 0);
  assert.equal((await f.work.status(signal())).verified, false);
  assert.equal((await f.work.resolvedFailures(signal())).size, 0);
});

test('native check receipts belong to their actual subproject directory, not an identical root command', async () => {
  const originalPath = process.env.PATH;
  process.env.PATH = dirname(process.execPath) + ';' + originalPath;
  const f = await realHarness();
  try {
    await mkdir(join(f.root, 'nested'));
    await writeFile(
      join(f.root, 'nested/package.json'),
      JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }),
    );
    const c = f.w.current.controller!;
    f.queue.push(
      {
        name: 'emergence_analyze',
        args: { objective: '检查子项目', reason: '已授权', route: 'focused', intent: 'execute' },
      },
      {
        name: 'pwsh',
        args: {
          command: 'npm run test',
          workdir: join(f.root, 'nested'),
          description: '只检查子项目',
          timeoutMs: 15000,
        },
      },
    );
    await f.w.send(f.w.focused, '运行子项目检查');
    await c.agent.whenIdle();
    const status = await (await c.codeWork.get(c.agent)).status(signal());
    assert.equal(status.checks.find((c) => c.config === 'package.json')?.state, 'not-run');
    assert.equal(status.checks.find((c) => c.config === 'nested/package.json')?.state, 'passed');
    assert.equal(status.verified, false, 'subproject success cannot certify the broken root project');
  } finally {
    await f.close();
    process.env.PATH = originalPath;
  }
});

test('timeouts, background, exceptions, missing checks, repeated failures and changed-during-check remain unverified', async () => {
  const f = await fixture();
  assert.equal((await f.work.status(signal())).verified, false);
  await check(f.work, 'timeout', 0, { timedOut: true });
  assert.equal((await f.work.status(signal())).verified, false);
  await check(f.work, 'pending', 0, { kind: 'background' });
  assert.equal((await f.work.status(signal())).verified, false);
  await check(f.work, 'failed', 1);
  await assert.rejects(f.work.beforeCheck('npm run test', signal()), /失败两次/);
  await f.work.begin('new attempt');
  const input = await f.work.beforeCheck('npm run test', signal());
  assert.ok(input);
  await writeFile(join(f.root, '计算.js'), 'export const add = (a,b)=>a+b;');
  await f.work.afterCheck(input, 'racy', 'pwsh', { exitCode: 0 }, false, false, 'ok');
  assert.equal((await f.work.status(signal())).verified, false);
});

test('change recovery preserves CRLF and dirty originals; external edits, unknown writes, and path escape block recovery', async () => {
  const f = await fixture(),
    original = await readFile(join(f.root, '计算.js'), 'utf8');
  const edit = await f.work.beforeEdit('计算.js');
  await writeFile(join(f.root, '计算.js'), 'export const add = (a,b)=>a+b;');
  await f.work.afterEdit(edit, true);
  const preview = await f.work.preview('计算.js');
  assert.equal(preview.restorable, true);
  assert.equal(await f.work.restoreContent('计算.js', preview.expectedHash), original);
  await writeFile(join(f.root, '计算.js'), 'external change');
  await assert.rejects(f.work.restoreContent('计算.js', preview.expectedHash), /过期/);
  await assert.rejects(f.work.beforeEdit('计算.js'), /冲突/);
  await assert.rejects(f.work.beforeEdit('../outside.js'), /超出/);
  const creation = await f.work.beforeEdit('new/sub/new.js');
  await mkdir(join(f.root, 'new/sub'), { recursive: true });
  await writeFile(join(f.root, 'new/sub/new.js'), 'export const fresh = true;');
  await f.work.afterEdit(creation, true);
  assert.equal(
    (await f.work.preview('new/sub/new.js')).restorable,
    false,
    'new files are not silently deleted',
  );
  const other = new CodeWorkflow(f.home, f.home, 'fixture');
  assert.equal((await other.status(signal())).runId, null);
  const policy = { mode: 'plan' as const, root: f.root, rules: [], deny: [], confirm: [] };
  assert.equal(
    evaluatePermission(policy, {
      name: 'emergence_code_restore',
      arguments: { file_path: '计算.js' },
      cwd: f.root,
      actor: 'fixture',
    }).effect,
    'deny',
  );
  assert.equal(
    evaluatePermission(policy, { name: 'emergence_code_work', arguments: {}, cwd: f.root, actor: 'fixture' })
      .effect,
    'allow',
  );
});

async function realHarness() {
  const f = await fixture(),
    provider = new ExecutionProvider(),
    config = structuredClone(defaultConfig);
  config.models[0].apiKeyEnv = 'CODE_WORK_TEST_KEY';
  process.env.CODE_WORK_TEST_KEY = 'fixture-only';
  config.permissions = {
    defaultMode: 'auto',
    rules: ['npm run test', 'npm run typecheck'].map((command) => ({
      tool: 'pwsh',
      command,
      effect: 'allow' as const,
    })),
  };
  const ctx = await harness(f.home, ['deepseek'], provider);
  await ctx.plugin(ObservationPolicy);
  await ctx.plugin(FileTools, { readImage: false });
  await ctx.plugin(ShellEnv);
  await ctx.plugin(Subprocess);
  await ctx.plugin(Pwsh);
  await ctx.plugin(PwshTools, { enableRunInBackground: false, promoteOnTimeout: false });
  const w = new WorkspaceController(ctx, {
    home: f.home,
    cwd: f.root,
    modelId: 'deepseek',
    appConfig: config,
  });
  await w.initialize();
  let seq = 0;
  const queue: { name: string; args: object; before?: () => Promise<void> }[] = [];
  provider.stream = async function* (options): AsyncIterable<StreamChunk> {
    // Master receipt turns share this provider but must not consume worker scripts.
    const assigned = options.messages.some(
      (message) =>
        message.role === 'user' &&
        message.content.some((block) => block.type === 'text' && block.text.startsWith('[Emergence task ')),
    );
    if (w.collaboration.state.mode === 'collaborate' && !assigned) {
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    const step = queue.shift();
    if (!step) {
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    await step.before?.();
    const id = ToolCallId('code-work-' + ++seq),
      raw = JSON.stringify(step.args);
    yield { type: 'block-start', index: 0, blockType: 'tool-call' };
    yield { type: 'tool-call-delta', index: 0, id, name: step.name, argumentsDelta: raw };
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: step.name, arguments: raw } };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  };
  return {
    ...f,
    ctx,
    w,
    queue,
    async close() {
      await w.close();
      await ctx.fiber.dispose();
      delete process.env.CODE_WORK_TEST_KEY;
    },
  };
}

test('real Harness + native FS CAS + native PowerShell: reproduce, fix, rerun and restore without clobbering outside edits', async () => {
  const testContext = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  const originalPath = process.env.PATH;
  process.env.PATH = dirname(process.execPath) + ';' + originalPath;
  const f = await realHarness();
  try {
    const c = f.w.current.controller!;
    f.queue.push(
      {
        name: 'emergence_analyze',
        args: { objective: '修复并验证加法', reason: '已授权实施', route: 'focused', intent: 'execute' },
      },
      { name: 'emergence_code_work', args: { action: 'begin', objective: '修复加法' } },
      { name: 'pwsh', args: { command: 'npm run test', description: '运行项目测试', timeoutMs: 15000 } },
      { name: 'read', args: { file_path: '计算.js' } },
      { name: 'edit', args: { file_path: '计算.js', old_string: 'a - b', new_string: 'a + b' } },
      { name: 'pwsh', args: { command: 'npm run test', description: '运行项目测试', timeoutMs: 15000 } },
      { name: 'emergence_code_work', args: { action: 'status' } },
    );
    await f.w.send(f.w.focused, '修复加法并验证');
    await c.agent.whenIdle();
    const work = await c.codeWork.get(c.agent),
      status = await work.status(signal());
    assert.equal(status.verified, true, JSON.stringify(c.agent.session.snapshotEvents().slice(-10)));
    assert.equal(work.run?.checks[0].exitCode, 1);
    assert.equal(work.run?.checks[1].exitCode, 0);
    assert.equal((await work.resolvedFailures(signal())).size, 1);
    const preview = await work.preview('计算.js');
    f.queue.push(
      {
        name: 'emergence_analyze',
        args: { objective: '恢复已记录文件', reason: '已授权恢复', route: 'focused', intent: 'execute' },
      },
      { name: 'emergence_code_restore', args: { file_path: '计算.js', expected_hash: preview.expectedHash } },
    );
    await f.w.send(f.w.focused, '恢复刚才的代码');
    await c.agent.whenIdle();
    assert.equal(await readFile(join(f.root, '计算.js'), 'utf8'), 'export const add = (a, b) => a - b;\r\n');
    f.queue.push(
      {
        name: 'emergence_analyze',
        args: { objective: '继续核对版本', reason: '已授权', route: 'focused', intent: 'execute' },
      },
      { name: 'read', args: { file_path: '计算.js' } },
      {
        name: 'edit',
        args: { file_path: '计算.js', old_string: 'a - b', new_string: 'a + b' },
        before: () => writeFile(join(f.root, '计算.js'), 'external source'),
      },
    );
    await f.w.send(f.w.focused, '继续尝试');
    await c.agent.whenIdle();
    assert.equal(await readFile(join(f.root, '计算.js'), 'utf8'), 'external source');
    // Fresh run still must obey upstream observation policy, independently of our change tracker.
    f.queue.push(
      {
        name: 'emergence_analyze',
        args: { objective: '核对原生保护', reason: '已授权', route: 'focused', intent: 'execute' },
      },
      { name: 'emergence_code_work', args: { action: 'begin' } },
      {
        name: 'edit',
        args: { file_path: '计算.js', old_string: 'external source', new_string: 'overwritten' },
      },
    );
    await f.w.send(f.w.focused, '核对原生版本保护');
    await c.agent.whenIdle();
    assert.equal(await readFile(join(f.root, '计算.js'), 'utf8'), 'external source');
    assert.ok(
      JSON.stringify(c.agent.session.snapshotEvents()).includes('changed') ||
        JSON.stringify(c.agent.session.snapshotEvents()).includes('STALE'),
    );
  } finally {
    await f.close();
    process.env.PATH = originalPath;
    if (testContext !== undefined) process.env.NODE_TEST_CONTEXT = testContext;
  }
});

test('assigned coding task accepts repaired baseline without erasing failure receipts', async () => {
  const testContext = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  const originalPath = process.env.PATH;
  process.env.PATH = dirname(process.execPath) + ';' + originalPath;
  const f = await realHarness();
  try {
    const master = f.w.current;
    await f.w.split('row');
    const worker = f.w.current;
    f.w.collaboration.configure(master.id, [worker.id]);
    f.queue.push(
      { name: 'emergence_code_work', args: { action: 'begin', objective: 'fix add' } },
      { name: 'pwsh', args: { command: 'npm run test', description: '运行项目测试', timeoutMs: 15000 } },
      { name: 'read', args: { file_path: '计算.js' } },
      { name: 'edit', args: { file_path: '计算.js', old_string: 'a - b', new_string: 'a + b' } },
      { name: 'pwsh', args: { command: 'npm run test', description: '运行项目测试', timeoutMs: 15000 } },
      {
        name: 'emergence_report',
        args: { outcome: 'success', summary: '已复现并修复', artifacts: ['计算.js'] },
      },
    );
    const task = await f.w.collaboration.enqueue(master.id, worker.id, 'code-fix', '修复加法并执行测试');
    await until(() => ['succeeded', 'needs_review', 'failed'].includes(task.status));
    assert.equal(task.result?.errors.length, 0, JSON.stringify(task.result));
    assert.equal(task.executionIssues.length, 1, 'original failure remains in task audit');
    assert.ok(task.receipts.some((r) => r.kind === 'command' && r.exitCode === 1));
    assert.ok(task.receipts.some((r) => r.kind === 'command' && r.exitCode === 0));
    assert.ok(
      task.receipts.some(
        (r) =>
          r.kind === 'command' &&
          r.exitCode === 0 &&
          r.manifest?.inputs.some((f) => f.path.endsWith('计算.js')),
      ),
    );
    assert.equal(task.result?.code?.verified, true);
    assert.equal(await resolvedEvidenceCurrent(task), true);
    assert.ok(task.result?.code?.checks.some((check) => check.exitCode === 1));
    // Reporting settles the task before the scripted model turn finishes. Do not
    // let that old turn consume the next task's queued responses.
    await worker.controller!.agent.whenIdle();
    f.queue.push(
      { name: 'read', args: { file_path: '计算.js' } },
      { name: 'emergence_report', args: { outcome: 'success', summary: '仅查看实现' } },
    );
    const separate = await f.w.collaboration.enqueue(master.id, worker.id, 'read-next', '读取实现');
    await until(() => ['succeeded', 'needs_review', 'failed'].includes(separate.status));
    assert.equal(separate.result?.errors.length, 0, JSON.stringify(separate.result));
    assert.equal(separate.result?.code, undefined, 'a later task must not inherit the previous change set');
  } finally {
    await f.close();
    process.env.PATH = originalPath;
    if (testContext !== undefined) process.env.NODE_TEST_CONTEXT = testContext;
  }
});

test('actual typecheck discovers an incompatible caller; native literal edit refuses ambiguous replacements', async () => {
  const testContext = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  const originalPath = process.env.PATH;
  process.env.PATH = dirname(process.execPath) + ';' + originalPath;
  const f = await realHarness();
  try {
    const c = f.w.current.controller!;
    const script =
      'node "' +
      resolve('node_modules/typescript/bin/tsc').replaceAll('\\', '/') +
      '" --pretty false --noEmit --skipLibCheck --strict --target es2020 types.ts';
    await writeFile(
      join(f.root, 'package.json'),
      JSON.stringify({ type: 'module', scripts: { typecheck: script } }),
    );
    await writeFile(
      join(f.root, 'types.ts'),
      'function twice(n: number) { return n * 2; }\r\ntwice("2");\r\n// same\r\n// same\r\n',
    );
    f.queue.push(
      {
        name: 'emergence_analyze',
        args: { objective: '修复类型错误', reason: '已授权', route: 'focused', intent: 'execute' },
      },
      { name: 'emergence_code_work', args: { action: 'begin' } },
      {
        name: 'pwsh',
        args: { command: 'npm run typecheck', description: '检查调用方类型', timeoutMs: 15000 },
      },
      { name: 'read', args: { file_path: 'types.ts' } },
      { name: 'edit', args: { file_path: 'types.ts', old_string: 'twice("2")', new_string: 'twice(2)' } },
      { name: 'pwsh', args: { command: 'npm run typecheck', description: '重新检查类型', timeoutMs: 15000 } },
      { name: 'edit', args: { file_path: 'types.ts', old_string: '// same', new_string: '// changed' } },
    );
    await f.w.send(f.w.focused, '修复类型错误并验证');
    await c.agent.whenIdle();
    const work = await c.codeWork.get(c.agent);
    assert.ok((work.run?.checks[0].exitCode ?? 0) > 0);
    assert.ok(work.run?.checks[0].diagnostics.some((d) => d.path === 'types.ts' && d.line === 2));
    assert.equal(work.run?.checks[1].exitCode, 0);
    assert.equal((await work.status(signal())).verified, true);
    const text = await readFile(join(f.root, 'types.ts'), 'utf8');
    assert.equal(text.match(/same/g)?.length, 2);
    assert.ok(!text.includes('changed'));
    assert.ok(
      c.agent.session.snapshotEvents().some((e) => e.type === 'tool/result' && e.data.message.isError),
    );
  } finally {
    await f.close();
    process.env.PATH = originalPath;
    if (testContext !== undefined) process.env.NODE_TEST_CONTEXT = testContext;
  }
});
