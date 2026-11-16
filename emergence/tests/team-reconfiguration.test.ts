import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coordinationSchema } from '../src/core/domain/team.ts';
import { settledTaskStatuses } from '../src/core/domain/task.ts';
import { executionFixture } from './fixtures/core-execution.ts';

test('settled history does not permanently lock master selection or independent mode', async () => {
  const f = await executionFixture();
  try {
    const main = f.w.current;
    const worker = await f.w.split('row');
    await f.w.setMaster(main.id);
    f.w.collaboration.scheduler.pump = async () => {};
    for (const status of settledTaskStatuses) {
      const task = await f.w.collaboration.enqueue(main.id, worker.id, status, 'historical task');
      f.w.collaboration.lifecycle.amend(task, { notified: true });
      await f.w.collaboration.finishWithoutTurn(task, status, 'execution already settled');
    }
    const before = structuredClone(f.w.collaboration.state.tasks);
    await f.w.setMaster(worker.id);
    assert.equal(f.w.collaboration.state.master, worker.id);
    await f.w.clearMaster();
    assert.equal(f.w.collaboration.state.mode, 'independent');
    assert.equal(f.w.collaboration.state.master, undefined);
    assert.deepEqual(f.w.collaboration.state.tasks, before, 'role changes never rewrite historical outcomes');
    assert.equal(f.writes(), 0);
  } finally {
    await f.close();
  }
});

test('all role-change entries preserve a queued task and allow additive team membership', async () => {
  const f = await executionFixture();
  try {
    const main = f.w.current;
    const worker = await f.w.split('row');
    await f.w.setMaster(main.id);
    f.w.collaboration.scheduler.pump = async () => {};
    const task = await f.w.collaboration.enqueue(main.id, worker.id, 'queued', 'pending work');
    await assert.rejects(f.w.setMaster(worker.id), /完成|取消/);
    await assert.rejects(f.w.clearMaster(), /完成|取消/);
    assert.throws(() => f.w.collaboration.configure(worker.id, [main.id]), /完成|取消/);
    const extra = await f.w.split('column');
    f.w.collaboration.configure(main.id, [worker.id, extra.id]);
    assert.equal(task.status, 'queued');
    assert.equal(f.w.collaboration.state.master, main.id);
    assert.equal(f.writes(), 0);
  } finally {
    await f.close();
  }
});

test('active objective keeps its coordinator even between execution and automatic audit', async () => {
  const f = await executionFixture();
  try {
    const main = f.w.current;
    const worker = await f.w.split('row');
    await f.w.setMaster(main.id);
    f.w.collaboration.pause(true);
    f.w.team.followthrough.advance = async () => {};
    const goal = coordinationSchema.parse({
      id: 'a'.repeat(64),
      master: main.id,
      session: main.controller!.id,
      project: main.cwd,
      requestIds: ['objective'],
      request: 'finish and audit',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      phase: 'reviewing',
      teamAtIntake: [],
      executions: [],
      followthrough: {
        startedAt: Date.now(),
        maxDurationMs: 60000,
        maxSteps: 20,
        maxActions: 20,
        maxRepairs: 1,
        actions: 0,
      },
    });
    f.w.collaboration.state.coordinations = [goal];
    await assert.rejects(f.w.setMaster(worker.id), /完成|取消/);
    await assert.rejects(f.w.clearMaster(), /完成|取消/);
    assert.throws(() => f.w.collaboration.configure(worker.id, [main.id]), /完成|取消/);
    await f.w.team.followthrough.cancel(main.id);
    assert.equal(goal.phase, 'cancelled');
    await f.w.clearMaster();
    assert.equal(f.w.collaboration.state.master, undefined);
    assert.equal(f.writes(), 0);
  } finally {
    await f.close();
  }
});

test('pending host approval cannot be detached by changing the coordinator', async () => {
  const f = await executionFixture();
  try {
    const main = f.w.current;
    const worker = await f.w.split('row');
    await f.w.setMaster(main.id);
    const answer = main.controller!.confirmDecision('confirm dispatch');
    assert.ok(main.controller!.pending);
    await assert.rejects(f.w.setMaster(worker.id), /完成|取消/);
    await assert.rejects(f.w.clearMaster(), /完成|取消/);
    main.controller!.cancelInteractions();
    assert.equal(await answer, false);
    await f.w.setMaster(worker.id);
    assert.equal(f.w.collaboration.state.master, worker.id);
    assert.equal(f.writes(), 0);
  } finally {
    await f.close();
  }
});
