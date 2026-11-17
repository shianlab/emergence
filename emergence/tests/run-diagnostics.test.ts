import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { StreamChunk } from '@deepseek-ai/dsh-llm';
import { RunDiagnostics } from '../src/core/application/run-diagnostics.ts';
import { RunDiagnosticsStore } from '../src/core/storage/run-diagnostics-store.ts';
import { budgetPolicySchema } from '../src/core/domain/run-budget.ts';
import { digest } from '../src/core/storage/execution-journal.ts';
import { modelProviders } from '../src/app/model-config-runtime.ts';
import { executionFixture, until } from './fixtures/core-execution.ts';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { setTimeout as delay } from 'node:timers/promises';

test('parallel tools share wall time; approval and resource waits never count as execution', async () => {
  const home = await mkdtemp(join(tmpdir(), 'emergence-timing-'));
  let now = 1000;
  const store = new RunDiagnosticsStore(home);
  const clock = new RunDiagnostics(
    store,
    () => budgetPolicySchema.parse({}),
    async () => {},
    () => now,
  );
  await clock.bind('session');
  clock.start();
  clock.assign('task');
  clock.model('start');
  now += 100;
  clock.model('output');
  now += 200;
  clock.model('end');
  clock.tool('one', true);
  clock.tool('two', true);
  now += 300;
  clock.pending(true);
  now += 500;
  clock.pending(false);
  clock.tool('one', false);
  now += 100;
  clock.tool('two', false);
  clock.resource(true);
  now += 400;
  clock.resource(false);
  clock.end();
  const run = clock.snapshot!;
  assert.deepEqual(run.durations, {
    host: 0,
    'model-wait': 100,
    'model-output': 200,
    tool: 400,
    approval: 500,
    resource: 400,
  });
  assert.equal(
    Object.values(run.durations).reduce((a, b) => a + b, 0),
    run.at - run.startedAt,
  );
  now += 10000;
  assert.deepEqual(clock.snapshot, run, 'ended runs do not accumulate idle time');
  await clock.close();
  const restored = new RunDiagnostics(
    store,
    () => budgetPolicySchema.parse({}),
    async () => {},
  );
  await restored.bind('session');
  assert.deepEqual(restored.forTask('task'), [run]);
  await restored.close();
});

test('continuous output and repeated model starts do not reset cumulative stage deadlines', async () => {
  const home = await mkdtemp(join(tmpdir(), 'emergence-timing-'));
  let now = 0;
  const clock = new RunDiagnostics(
    new RunDiagnosticsStore(home),
    () => budgetPolicySchema.parse({ totalMs: 1000000, planningMs: 1000 }),
    async () => {},
    () => now,
  );
  await clock.bind('session');
  clock.start();
  clock.model('start');
  now = 600;
  clock.model('end');
  clock.model('start');
  now = 1000;
  assert.match(clock.deadline()!, /首段响应/);
  clock.end();
  clock.start();
  clock.model('start');
  clock.model('output');
  now += 599999;
  clock.model('output');
  assert.equal(clock.deadline(), undefined);
  now++;
  clock.model('output');
  assert.match(clock.deadline()!, /模型输出/);
  await clock.close();
});

test('crash snapshots retain measured time only; future and corrupt diagnostic files are never overwritten', async () => {
  const home = await mkdtemp(join(tmpdir(), 'emergence-timing-'));
  const store = new RunDiagnosticsStore(home),
    clock = new RunDiagnostics(
      store,
      () => budgetPolicySchema.parse({}),
      async () => {},
    );
  await clock.bind('session');
  clock.start();
  const run = clock.snapshot!;
  await clock.close();
  await store.write('session', [run]);
  const resumed = new RunDiagnostics(
    store,
    () => budgetPolicySchema.parse({}),
    async () => {},
  );
  await resumed.bind('session');
  assert.equal(resumed.snapshot!.outcome, 'interrupted');
  assert.equal(resumed.snapshot!.endedAt, run.at);
  await resumed.close();
  const path = join(home, 'core', 'run-diagnostics', digest('session') + '.json');
  for (const text of ['{broken', JSON.stringify({ version: 99, session: 'session', runs: [] })]) {
    await writeFile(path, text);
    const invalid = new RunDiagnostics(
      store,
      () => budgetPolicySchema.parse({}),
      async () => {},
    );
    await invalid.bind('session');
    invalid.start();
    await invalid.close();
    assert.match(invalid.error!, /不可读取/);
    assert.equal(await readFile(path, 'utf8'), text);
  }
});

test('a silent provider reaches a distinct first-response deadline, aborts and does not retry', async () => {
  const f = await executionFixture();
  try {
    f.config.orchestration.budgets.planningMs = 1000;
    let calls = 0,
      aborted = false;
    f.provider.stream = async function* (options): AsyncIterable<StreamChunk> {
      calls++;
      await new Promise<void>((resolve) => {
        const stop = () => {
          aborted = true;
          resolve();
        };
        if (options.signal?.aborted) stop();
        else options.signal?.addEventListener('abort', stop, { once: true });
      });
      throw new Error('test aborted');
    };
    const worker = await f.w.split('row');
    const task = await f.w.taskEngine.enqueue(worker.id, worker.id, 'silent', 'fixture:write');
    await until(() => task.status === 'cancelled');
    assert.equal(aborted, true);
    assert.equal(calls, 1);
    assert.equal(f.writes(), 0);
    assert.match(task.cancelReason!, /模型首段响应/);
    const run = worker.controller!.diagnostics.forTask(task.id).at(-1)!;
    assert.equal(run.outcome, 'deadline');
    assert.ok(run.durations['model-wait'] >= 1000);
    assert.match(f.w.taskEngine.diagnose(task), /模型首段响应/);
  } finally {
    await f.close();
  }
});

test('network failure after a returned write never replays the write or switches provider', async () => {
  const f = await executionFixture();
  try {
    const original = f.provider.stream.bind(f.provider);
    let calls = 0;
    f.provider.stream = async function* (options): AsyncIterable<StreamChunk> {
      calls++;
      if (f.writes()) throw new Error('fixture network disconnected after write');
      yield* original(options);
    };
    const master = f.w.current,
      worker = await f.w.split('row');
    const task = await f.w.taskEngine.enqueue(worker.id, worker.id, 'network', 'fixture:write');
    await until(() => ['failed', 'interrupted', 'needs_review'].includes(task.status));
    assert.equal(f.writes(), 1);
    assert.equal(calls, 2);
    assert.ok(f.w.taskEngine.journal.effects(task.id).length > 0);
    assert.equal(f.w.taskEngine.state.tasks.length, 1);
    assert.equal(worker.modelId, master.modelId);
    assert.ok(
      Object.values(modelProviders(f.config)).every((provider) => provider.retryPolicy.maxRetries === 2),
    );
    assert.equal(worker.controller!.diagnostics.snapshot!.outcome, 'error');
  } finally {
    await f.close();
  }
});

test('a slow response within budget completes and records waiting separately from output', async () => {
  const f = await executionFixture();
  try {
    const original = f.provider.stream.bind(f.provider);
    f.provider.stream = async function* (options): AsyncIterable<StreamChunk> {
      await delay(180, undefined, { signal: options.signal });
      yield* original(options);
    };
    const worker = await f.w.split('row');
    const task = await f.w.taskEngine.enqueue(worker.id, worker.id, 'slow', 'fixture:write');
    await until(() => task.status === 'succeeded');
    const run = worker.controller!.diagnostics.forTask(task.id).at(-1)!;
    assert.equal(run.outcome, 'ended');
    assert.ok(run.durations['model-wait'] >= 300);
    assert.equal(run.requests, 2);
    assert.equal(f.writes(), 1);
  } finally {
    await f.close();
  }
});

test('a blocked tool is diagnosed and cancellation waits until the tool has released its work', async () => {
  const f = await executionFixture();
  let stopped = false;
  try {
    f.ctx.effect(() =>
      f.ctx.tools.register(
        defineTool({
          name: 'read',
          description: 'blocked read fixture',
          parameters: { file_path: { type: 'string', required: true } },
          output: { schema: { type: 'string' }, render: (_a, value) => [{ type: 'text', text: value }] },
          execute: async (_args, exec) => {
            await new Promise<void>((resolve) => {
              if (exec.signal.aborted) resolve();
              else exec.signal.addEventListener('abort', () => resolve(), { once: true });
            });
            await delay(100);
            stopped = true;
            throw new Error('fixture stopped');
          },
        }),
      ),
    );
    f.provider.stream = async function* (): AsyncIterable<StreamChunk> {
      const id = ToolCallId('blocked-read'),
        args = JSON.stringify({ file_path: 'result.txt' });
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id, name: 'read', argumentsDelta: args };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'read', arguments: args } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    };
    const worker = await f.w.split('row');
    const task = await f.w.taskEngine.enqueue(worker.id, worker.id, 'blocked', '读取文件', [], {
      role: 'researcher',
      scope: ['result.txt'],
      acceptance: ['读取完成'],
      maxDurationMs: 1000,
    });
    await until(() => task.status === 'cancelled');
    await worker.controller!.agent.whenIdle();
    assert.equal(stopped, true);
    assert.equal(f.writes(), 0);
    assert.match(task.cancelReason!, /工具执行/);
    const run = worker.controller!.diagnostics.forTask(task.id).at(-1)!;
    assert.ok(run.durations.tool >= 900);
    assert.equal(run.outcome, 'cancelled');
  } finally {
    await f.close();
  }
});
