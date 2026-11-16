import type { StreamChunk } from '@deepseek-ai/dsh-llm';
import UserApproval from '@deepseek-ai/dsh-user-approval';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { executionFixture, until } from '../tests/fixtures/core-execution.ts';

// REPRO means an unresolved symptom is confirmed; CHECK means current correct behavior.
async function completedTask(context = '') {
  const f = await executionFixture();
  const master = f.w.current;
  const worker = await f.w.split('row');
  f.w.collaboration.configure(master.id, [worker.id]);
  const task = await f.w.collaboration.enqueue(master.id, worker.id, 'subject', 'fixture:write', [], {
    role: 'developer',
    scope: ['result.txt'],
    acceptance: ['实际文件及检查成功'],
    context,
  });
  await until(() => task.status === 'needs_review');
  await until(() => !worker.controller!.busy);
  return { ...f, master, worker, task };
}

test('CHECK: accepted long context can now create an audit without context expansion', async () => {
  const f = await completedTask('x'.repeat(7900));
  try {
    const before = f.w.panes.size;
    const tasksBefore = f.w.collaboration.state.tasks.length;
    const audit = await f.w.collaboration.assurance.request(f.task.id, 'verify', f.master.id);
    assert.equal(audit.contract!.context, f.task.contract!.context);
    assert.equal(f.w.panes.size, before + 1);
    assert.equal(f.w.collaboration.state.tasks.length, tasksBefore + 1);
  } finally {
    await f.close();
  }
});

test('CHECK: automatic audit at pane limit reuses an independent empty context', async () => {
  const f = await completedTask();
  try {
    while (f.w.panes.size < 16) await f.w.split('row');
    const spare = [...f.w.panes.values()].find((p) => p.id !== f.master.id && p.id !== f.worker.id)!;
    assert.equal(spare.controller!.busy, false);
    const audit = await f.w.collaboration.assurance.request(f.task.id, 'verify', f.master.id);
    assert.equal(f.w.panes.size, 16);
    assert.equal(audit.target, spare.id);
  } finally {
    await f.close();
  }
});

test('CHECK: independently busy worker becoming idle wakes its queued task', async () => {
  const f = await executionFixture();
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = f.provider.stream.bind(f.provider);
  let entered = false;
  f.provider.stream = async function* (options): AsyncIterable<StreamChunk> {
    if (JSON.stringify(options.messages).includes('review-probe-hold') && !entered) {
      entered = true;
      await hold;
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    yield* original(options);
  };
  try {
    const master = f.w.current;
    const worker = await f.w.split('row');
    f.w.collaboration.configure(master.id, [worker.id]);
    await worker.controller!.send('review-probe-hold');
    await until(() => entered);
    const task = await f.w.collaboration.enqueue(master.id, worker.id, 'queued', 'fixture:write');
    await delay(100);
    assert.equal(task.status, 'queued');
    release();
    await until(() => !worker.controller!.busy);
    await delay(1200);
    await until(() => task.status === 'succeeded');
  } finally {
    release();
    await f.close();
  }
});

test('CHECK: approval wait no longer consumes the execution deadline', async () => {
  const f = await executionFixture();
  try {
    await f.ctx.plugin(UserApproval);
    const master = f.w.current;
    const worker = await f.w.split('row');
    master.controller!.setPermissionMode('ask');
    f.w.collaboration.configure(master.id, [worker.id]);
    const task = await f.w.collaboration.enqueue(
      master.id,
      worker.id,
      'approval-timeout',
      'fixture:write',
      [],
      {
        role: 'developer',
        scope: ['result.txt'],
        acceptance: ['实际写入成功'],
        maxDurationMs: 1000,
      },
    );
    await until(() => task.status === 'waiting_user');
    assert.equal(f.writes(), 0);
    await delay(1400);
    assert.equal(task.status, 'waiting_user');
    assert.equal(task.timeout, undefined);
    assert.equal(f.writes(), 0);
  } finally {
    await f.close();
  }
});
