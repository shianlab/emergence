import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { executionFixture, until } from './fixtures/core-execution.ts';

for (const stop of ['cancel', 'takeover', 'late-read-failure'] as const)
  test(`${stop} while observing dependencies cannot inject a late task into an unowned window`, async () => {
    const f = await executionFixture();
    const observed = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<string>();
    let starting: Promise<void> | undefined;
    try {
      const main = f.w.current;
      const project = join(f.home, 'worker-project');
      await mkdir(project);
      const worker = await f.w.split('row', project);
      await f.w.setMaster(main.id);
      f.w.collaboration.scheduler.pump = async () => {};
      const dependency = await f.w.collaboration.enqueue(main.id, worker.id, 'dep', 'completed dependency');
      f.w.collaboration.lifecycle.amend(dependency, { notified: true });
      await f.w.collaboration.finishWithoutTurn(dependency, 'succeeded', 'fixture completed');
      const task = await f.w.collaboration.enqueue(main.id, worker.id, 'child', 'fixture:write', [
        dependency.id,
      ]);
      f.w.collaboration.lifecycle.amend(task, { notified: true });
      f.w.collaboration.assurance.version = async () => {
        observed.resolve();
        return resume.promise;
      };
      starting = f.w.collaboration.start(task);
      await observed.promise;
      if (stop === 'takeover') await f.w.collaboration.takeover(worker.id);
      else await f.w.collaboration.cancel(task.id);
      assert.equal(task.status, 'cancelled');
      assert.equal(f.w.collaboration.active.size, 0);
      if (stop === 'late-read-failure') resume.reject(new Error('late dependency read failed'));
      else resume.resolve('current-dependency');
      await starting;
      await worker.controller!.agent.whenIdle();
      assert.equal(f.writes(), 0, 'cancelled preflight must never execute outside task ownership');
      assert.equal(f.provider.calls, 0, 'cancelled preflight must not make a model request');
      assert.equal(task.status, 'cancelled');
      assert.equal(f.w.collaboration.journal.effects(task.id).length, 0);
      assert.equal(f.w.collaboration.execution.readOnlyToolMasks.size, 0);
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
    const main = f.w.current;
    const worker = await f.w.split('row');
    await f.w.setMaster(main.id);
    f.w.collaboration.scheduler.pump = async () => {};
    const task = await f.w.collaboration.enqueue(main.id, worker.id, 'settlement', 'fixture:write');
    f.w.collaboration.lifecycle.amend(task, { notified: true });
    const work = worker.controller!.codeWork;
    const get = work.get.bind(work);
    work.get = async (agent) => {
      if (f.w.collaboration.execution.finishing.has(task)) {
        observed.resolve();
        await resume.promise;
      }
      return get(agent);
    };
    await f.w.collaboration.start(task);
    await observed.promise;
    await f.w.collaboration.cancel(task.id, 'cancel during settlement');
    const receipt = structuredClone(task.result);
    assert.equal(task.status, 'cancelled');
    resume.resolve();
    await until(() => !f.w.collaboration.execution.finishing.has(task));
    assert.deepEqual(task.result, receipt, 'late evidence must not overwrite the settled outcome');
    assert.equal(f.writes(), 1, 'the original write remains recorded, never replayed');
    assert.equal(task.status, 'cancelled');
  } finally {
    resume.resolve();
    await f.close();
  }
});
