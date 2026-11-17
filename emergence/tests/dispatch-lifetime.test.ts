import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { executionFixture, until } from './fixtures/core-execution.ts';

for (const stop of ['cancel', 'close', 'late-read-failure'] as const)
  test(`${stop} while observing dependencies cannot inject a late task into an unowned window`, async () => {
    const f = await executionFixture();
    const observed = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<string>();
    let starting: Promise<void> | undefined;
    try {
      const project = join(f.home, 'worker-project');
      await mkdir(project);
      const worker = await f.w.split('row', project);
      f.w.taskEngine.scheduler.pump = async () => {};
      const dependency = await f.w.taskEngine.enqueue(worker.id, worker.id, 'dep', 'completed dependency');
      f.w.taskEngine.lifecycle.amend(dependency, { notified: true });
      await f.w.taskEngine.finishWithoutTurn(dependency, 'succeeded', 'fixture completed');
      const task = await f.w.taskEngine.enqueue(worker.id, worker.id, 'child', 'fixture:write', [
        dependency.id,
      ]);
      f.w.taskEngine.lifecycle.amend(task, { notified: true });
      f.w.taskEngine.assurance.version = async () => {
        observed.resolve();
        return resume.promise;
      };
      starting = f.w.taskEngine.start(task);
      await observed.promise;
      if (stop === 'close') await f.w.closePane(worker.id);
      else await f.w.taskEngine.cancel(task.id);
      assert.equal(task.status, 'cancelled');
      assert.equal(f.w.taskEngine.active.size, 0);
      if (stop === 'late-read-failure') resume.reject(new Error('late dependency read failed'));
      else resume.resolve('current-dependency');
      await starting;
      if (stop !== 'close') await worker.controller!.agent.whenIdle();
      assert.equal(f.writes(), 0, 'cancelled preflight must never execute outside task ownership');
      assert.equal(f.provider.calls, 0, 'cancelled preflight must not make a model request');
      assert.equal(task.status, 'cancelled');
      assert.equal(f.w.taskEngine.journal.effects(task.id).length, 0);
      assert.equal(f.w.taskEngine.execution.readOnlyToolMasks.size, 0);
    } finally {
      resume.resolve('cleanup');
      await starting;
      await f.close();
    }
  });

test('late turn settlement cannot replace the authoritative cancellation receipt', async () => {
  const f = await executionFixture();
  const observed = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  try {
    const worker = await f.w.split('row');
    f.w.taskEngine.scheduler.pump = async () => {};
    const task = await f.w.taskEngine.enqueue(worker.id, worker.id, 'settlement', 'fixture:write');
    f.w.taskEngine.lifecycle.amend(task, { notified: true });
    const work = worker.controller!.codeWork;
    const get = work.get.bind(work);
    work.get = async (agent) => {
      if (f.w.taskEngine.execution.finishing.has(task)) {
        observed.resolve();
        await resume.promise;
      }
      return get(agent);
    };
    await f.w.taskEngine.start(task);
    await observed.promise;
    await f.w.taskEngine.cancel(task.id, 'cancel during settlement');
    const receipt = structuredClone(task.result);
    assert.equal(task.status, 'cancelled');
    resume.resolve();
    await until(() => !f.w.taskEngine.execution.finishing.has(task));
    assert.deepEqual(task.result, receipt, 'late evidence must not overwrite the settled outcome');
    assert.equal(f.writes(), 1, 'the original write remains recorded, never replayed');
    assert.equal(task.status, 'cancelled');
  } finally {
    resume.resolve();
    await f.close();
  }
});
