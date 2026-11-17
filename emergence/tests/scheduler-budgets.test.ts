import type { StreamChunk } from '@deepseek-ai/dsh-llm';
import UserApproval from '@deepseek-ai/dsh-user-approval';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { allocationViolation, tasksConflict } from '../src/core/application/task-allocation.ts';
import { advanceClock, budgetExceeded, budgetPolicySchema } from '../src/core/domain/run-budget.ts';
import { executionFixture, until } from './fixtures/core-execution.ts';

test('clock separates execution, approval, queue and pause; total elapsed remains bounded', () => {
  const policy = budgetPolicySchema.parse({ totalMs: 10000, approvalMs: 5000, queueMs: 3000 });
  let clock = advanceClock(undefined, 0, 'queued', 0);
  clock = advanceClock(clock, 0, 'active', 1000);
  clock = advanceClock(clock, 0, 'waiting', 1500);
  clock = advanceClock(clock, 0, 'active', 5500);
  assert.equal(clock.active, 500);
  assert.equal(clock.waiting, 4000);
  assert.equal(clock.queued, 1000);
  assert.equal(budgetExceeded(clock, 0, 1000, policy, 5500), undefined);
  clock = advanceClock(clock, 0, 'paused', 5600);
  clock = advanceClock(clock, 0, 'paused', 10000);
  assert.equal(budgetExceeded(clock, 0, 1000, policy, 10000), 'overall');
  const restored = JSON.parse(JSON.stringify(clock));
  assert.deepEqual(advanceClock(restored, 0, 'active', 9000), { ...clock, mode: 'active' });
});

test('approval longer than execution allowance can still complete after approval', async () => {
  const f = await executionFixture();
  try {
    await f.ctx.plugin(UserApproval);
    const worker = await f.w.split('row');
    worker.controller!.setPermissionMode('ask');
    const task = await f.w.taskEngine.enqueue(worker.id, worker.id, 'wait', 'fixture:write', [], {
      role: 'developer',
      scope: ['result.txt'],
      acceptance: ['实际写入'],
      maxDurationMs: 1000,
    });
    await until(() => task.status === 'waiting_user');
    await delay(1400);
    assert.equal(task.status, 'waiting_user');
    assert.equal(task.timeout, undefined);
    assert.equal(f.writes(), 0);
    worker.controller!.pending!.respond('y');
    await until(() => task.status === 'needs_review');
    assert.equal(f.writes(), 1);
    assert.ok(task.timing!.waiting >= 1300);
    assert.ok(task.timing!.active < 1000);
    const run = worker.controller!.diagnostics.forTask(task.id).at(-1)!;
    assert.ok(run.durations.approval >= 1300);
    assert.ok(run.durations.tool < 1000, 'approval must not be charged to the tool phase');
  } finally {
    await f.close();
  }
});

test('approval wait has its own bounded timeout and does not execute the tool', async () => {
  const f = await executionFixture();
  try {
    await f.ctx.plugin(UserApproval);
    f.config.orchestration.budgets.approvalMs = 1000;
    const worker = await f.w.split('row');
    worker.controller!.setPermissionMode('ask');
    const task = await f.w.taskEngine.enqueue(worker.id, worker.id, 'wait-expiry', 'fixture:write');
    await until(() => task.status === 'cancelled');
    assert.equal(task.timeout, 'approval');
    // The task watchdog and phase watchdog enforce the same approval boundary.
    // Either may win; the stable timeout code above is the contract, not its wording.
    assert.match(task.cancelReason!, /等待(?:审批|用户确认)/);
    assert.equal(f.writes(), 0);
  } finally {
    await f.close();
  }
});

test('queued work behind an approval uses approval waiting rather than expiring its queue allowance', async () => {
  const f = await executionFixture();
  try {
    await f.ctx.plugin(UserApproval);
    f.config.orchestration.budgets.queueMs = 1000;
    const worker = await f.w.split('row');
    worker.controller!.setPermissionMode('ask');
    const first = await f.w.taskEngine.enqueue(worker.id, worker.id, 'approval-head', 'fixture:write');
    await until(() => first.status === 'waiting_user');
    const next = await f.w.taskEngine.enqueue(worker.id, worker.id, 'approval-tail', 'fixture:write');
    await delay(1400);
    assert.equal(next.status, 'queued');
    assert.equal(next.timeout, undefined);
    assert.ok(next.timing!.waiting >= 1000);
    assert.equal(f.writes(), 0);
  } finally {
    await f.close();
  }
});

test('queued task has a finite wait and exposes why it cannot start', async () => {
  const f = await executionFixture();
  try {
    f.config.orchestration.budgets.queueMs = 1000;
    const worker = await f.w.split('row');
    const first = await f.w.taskEngine.enqueue(worker.id, worker.id, 'first', 'fixture:write', [], {
      role: 'developer',
      scope: ['result.txt'],
      acceptance: ['核对'],
    });
    await until(() => first.status === 'needs_review');
    const next = await f.w.taskEngine.enqueue(worker.id, worker.id, 'next', 'fixture:write', [first.id]);
    await delay(100);
    assert.match(next.progress, /独立验收/);
    await until(() => next.status === 'cancelled');
    assert.equal(next.timeout, 'queue');
    assert.equal(f.writes(), 1);
  } finally {
    await f.close();
  }
});

test('host allocated shared reads can overlap but writes and unknown tasks retain locks', async () => {
  const f = await executionFixture();
  try {
    const task = (access: 'read' | 'write') =>
      ({ cwd: f.cwd, allocation: { reason: 'host', paths: [f.cwd], access } }) as Parameters<
        typeof tasksConflict
      >[0];
    assert.equal(tasksConflict(task('read'), task('read')), false);
    assert.equal(tasksConflict(task('read'), task('write')), true);
    assert.ok(allocationViolation(task('read'), 'write', { file_path: 'result.txt' }));
    assert.ok(allocationViolation(task('read'), 'pwsh', { command: 'echo ignored' }));
    assert.equal(allocationViolation(task('read'), 'read', { file_path: 'result.txt' }), undefined);
  } finally {
    await f.close();
  }
});

test('execution and session watchdogs abort an unresponsive model without waiting for another step', async () => {
  for (const mode of ['execution', 'planning'] as const) {
    const f = await executionFixture();
    try {
      let aborted = false;
      f.provider.stream = async function* (options): AsyncIterable<StreamChunk> {
        await new Promise<void>((resolve) => {
          const stop = () => {
            aborted = true;
            resolve();
          };
          if (options.signal?.aborted) stop();
          else options.signal?.addEventListener('abort', stop, { once: true });
        });
        throw new Error('fixture model aborted');
      };
      const master = f.w.current,
        worker = await f.w.split('row');
      if (mode === 'execution') {
        const task = await f.w.taskEngine.enqueue(worker.id, worker.id, 'stall', 'fixture:write', [], {
          role: 'developer',
          scope: ['result.txt'],
          acceptance: ['核对'],
          maxDurationMs: 1000,
        });
        await until(() => task.status === 'cancelled');
        assert.equal(task.timeout, 'execution');
      } else {
        master.controller!.launch.appConfig.orchestration.budgets.planningMs = 1000;
        await f.w.send(master.id, '实现多文件任务并验证');
        await until(() => !!master.controller!.lastError);
        await master.controller!.agent.whenIdle();
        assert.match(master.controller!.notice, /响应|预算|超时/);
      }
      assert.equal(aborted, true);
      assert.equal(f.writes(), 0);
    } finally {
      await f.close();
    }
  }
});

test('a newer overlapping reader cannot bypass an older queued writer on another busy slot', async () => {
  const f = await executionFixture();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = f.provider.stream.bind(f.provider),
    started: string[] = [];
  f.provider.stream = async function* (options): AsyncIterable<StreamChunk> {
    const message = options.messages.findLast(
      (m) =>
        m.role === 'user' &&
        m.content.some((b) => b.type === 'text' && b.text.startsWith('[Emergence task ')),
    );
    const text = message?.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('') ?? '';
    const name = ['fair-busy', 'fair-older', 'fair-newer'].find((name) => text.includes(name));
    if (name && !started.includes(name)) started.push(name);
    if (name === 'fair-busy') await held;
    if (name !== 'fair-older') {
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    yield* original(options);
  };
  try {
    const a = await f.w.split('row'),
      b = await f.w.split('row');
    const allocation = (file: string, access: 'read' | 'write') => ({
      reason: 'host fixture',
      paths: [join(f.cwd, file)],
      access,
    });
    await f.w.taskEngine.enqueue(a.id, a.id, 'busy', 'fair-busy', [], undefined, undefined, {
      allocation: allocation('unrelated.txt', 'write'),
    });
    await until(() => started.includes('fair-busy'));
    await f.w.taskEngine.enqueue(a.id, a.id, 'older', 'fair-older', [], undefined, undefined, {
      allocation: allocation('result.txt', 'write'),
    });
    const newer = await f.w.taskEngine.enqueue(b.id, b.id, 'newer', 'fair-newer', [], undefined, undefined, {
      allocation: allocation('result.txt', 'read'),
    });
    await delay(100);
    assert.deepEqual(started, ['fair-busy']);
    assert.match(newer.progress, /更早任务/);
    release();
    await until(() => started.includes('fair-newer'));
    assert.deepEqual(started, ['fair-busy', 'fair-older', 'fair-newer']);
    assert.equal(f.writes(), 1);
  } finally {
    release();
    await f.close();
  }
});

test('approval waiting propagates through three dependent tasks in one session', async () => {
  const f = await executionFixture();
  try {
    await f.ctx.plugin(UserApproval);
    f.config.orchestration.budgets.queueMs = 1000;
    const master = f.w.current;
    const workers = [master, master, master];
    master.controller!.setPermissionMode('ask');
    const first = await f.w.taskEngine.enqueue(
      workers[0].id,
      workers[0].id,
      'approval-dependency',
      'fixture:write',
    );
    await until(() => first.status === 'waiting_user');
    const second = await f.w.taskEngine.enqueue(
      workers[1].id,
      workers[1].id,
      'direct-dependency',
      'fixture:write',
      [first.id],
    );
    const third = await f.w.taskEngine.enqueue(
      workers[2].id,
      workers[2].id,
      'transitive-dependency',
      'fixture:write',
      [second.id],
    );
    await delay(1400);
    for (const task of [second, third]) {
      assert.equal(task.status, 'queued');
      assert.equal(task.timeout, undefined);
      assert.ok(task.timing!.waiting >= 1000);
    }
    assert.equal(f.writes(), 0);
    workers[0].controller!.pending!.respond('n');
    await until(() => second.status === 'blocked' && third.status === 'blocked');
    assert.equal(f.writes(), 0);
  } finally {
    await f.close();
  }
});
