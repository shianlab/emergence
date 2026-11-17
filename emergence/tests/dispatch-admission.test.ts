import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import UserApproval from '@deepseek-ai/dsh-user-approval';
import { planSchema } from '../src/core/domain/planning.ts';
import { executionFixture, until } from './fixtures/core-execution.ts';
import { digest } from '../src/core/storage/execution-journal.ts';

async function setup() {
  const f = await executionFixture(),
    master = f.w.current,
    worker = master;
  const plan = (count = 1) =>
    planSchema.parse({
      objective: '实际写文件',
      constraints: ['仅项目内'],
      acceptance: ['文件存在'],
      nonGoals: [],
      unknowns: [],
      assumptions: [],
      options: [],
      evidence: [],
      reason: '分步执行',
      steps: Array.from({ length: count }, (_, i) => ({
        id: 'step' + i,
        objective: 'fixture:write',
        window: worker.id,
        session: worker.controller!.id,
        project: worker.cwd,
        model: worker.modelId,
        role: 'developer',
        capabilities: ['tool:write'],
        dependsOn: i ? ['step' + (i - 1)] : [],
        scope: ['result.txt'],
        acceptance: ['文件存在'],
      })),
    });
  return { ...f, master, worker, plan };
}

test('concurrent graph submissions share one approval and durable graph; presentation changes do not duplicate work', async () => {
  const f = await setup();
  try {
    await f.ctx.plugin(UserApproval);
    const c = f.master.controller!;
    c.launch.appConfig.permissions.rules.push({ tool: 'emergence_execute_plan', effect: 'ask' });
    const first = f.w.taskEngine.executePlan(f.master.id, f.plan());
    await until(() => !!c.pending);
    const approval = c.pending!.id;
    const second = f.w.taskEngine.executePlan(f.master.id, { ...f.plan(), reason: '同图换种说明' });
    assert.equal(c.pending!.id, approval);
    assert.equal(f.w.taskEngine.state.tasks.length, 0);
    c.pending!.respond('y');
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a[0].id, b[0].id);
    await until(() => a[0].status === 'needs_review');
    const repeat = await f.w.taskEngine.executePlan(f.master.id, f.plan());
    assert.equal(repeat[0].id, a[0].id);
    assert.equal(f.writes(), 1);
    assert.equal(f.w.taskEngine.state.tasks.length, 1);
    Object.assign(a[0], { requestKey: `plan-${digest(f.plan()).slice(0, 20)}-step0` });
    await f.w.save();
    assert.equal((await f.w.taskEngine.executePlan(f.master.id, f.plan()))[0].id, a[0].id);
    assert.equal(f.writes(), 1, 'legacy request keys remain idempotent');
  } finally {
    await f.close();
  }
});

test('worker permissions changed during approval cannot be admitted using the old snapshot', async () => {
  const f = await setup();
  try {
    await f.ctx.plugin(UserApproval);
    const c = f.master.controller!;
    c.launch.appConfig.permissions.rules.push({ tool: 'emergence_dispatch', effect: 'ask' });
    const operation = f.w.taskEngine.executePlan(f.master.id, f.plan());
    await until(() => !!c.pending);
    const stale = c.pending!;
    f.worker.controller!.setPermissionMode('plan');
    assert.throws(() => stale.respond('y'), /过期/);
    assert.deepEqual(await operation, []);
    assert.equal(f.w.taskEngine.state.tasks.length, 0);
    assert.equal(f.writes(), 0);
  } finally {
    await f.close();
  }
});

test('capability lookup discards a mixed snapshot when session permission changes mid-query', async () => {
  const f = await setup();
  const resolve = f.ctx.tools.resolve.bind(f.ctx.tools);
  try {
    let changed = false;
    f.ctx.tools.resolve = async (input) => {
      const result = await resolve(input);
      if (!changed) {
        changed = true;
        f.worker.controller!.setPermissionMode('plan');
      }
      return result;
    };
    const inventory = await f.master.controller!.planning.inventory();
    assert.equal(inventory.snapshot?.version, 1);
    assert.ok(inventory.windows.every((window) => window.stale && !window.dispatchable));
    assert.ok(inventory.windows.every((window) => !window.capabilities.length));
  } finally {
    f.ctx.tools.resolve = resolve;
    await f.close();
  }
});

test('a partially staged graph is absent from checkpoints and cannot be pumped', async () => {
  const f = await setup(),
    collaboration = f.w.taskEngine;
  const enqueue = collaboration.enqueue.bind(collaboration);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    let count = 0;
    collaboration.enqueue = async (...args) => {
      const result = await enqueue(...args);
      if (++count === 1) await held;
      return result;
    };
    const operation = collaboration.executePlan(f.master.id, f.plan(2));
    await until(() => count === 1);
    await f.w.save();
    await collaboration.pump();
    assert.equal(collaboration.state.tasks.length, 0);
    assert.equal((collaboration.journal.load() as { tasks: unknown[] }).tasks.length, 0);
    assert.equal(f.writes(), 0);
    release();
    const tasks = await operation;
    assert.equal(tasks.length, 2);
    await until(() => tasks[0].status === 'needs_review');
    assert.equal(tasks[1].status, 'queued');
  } finally {
    release();
    collaboration.enqueue = enqueue;
    await f.close();
  }
});

test('failed graph persistence rolls back every task and allows one clean retry', async () => {
  const f = await setup(),
    save = f.w.save.bind(f.w);
  try {
    f.w.save = async () => {
      throw new Error('injected write failure');
    };
    await assert.rejects(f.w.taskEngine.executePlan(f.master.id, f.plan(2)), /injected write failure/);
    assert.equal(f.w.taskEngine.state.tasks.length, 0);
    assert.equal(f.writes(), 0);
    assert.equal((f.w.taskEngine.journal.load() as { tasks: unknown[] }).tasks.length, 0);
    f.w.save = save;
    const tasks = await f.w.taskEngine.executePlan(f.master.id, f.plan(2));
    await until(() => tasks[0].status === 'needs_review');
    assert.equal(f.writes(), 1);
    assert.equal(f.w.taskEngine.state.tasks.length, 2);
  } finally {
    f.w.save = save;
    await f.close();
  }
});

test('manual admission rejects duplicate step IDs, cycles and missing dependencies before creating a graph', async () => {
  const f = await setup();
  try {
    const duplicate = f.plan(2);
    duplicate.steps[1].id = duplicate.steps[0].id;
    await assert.rejects(f.w.taskEngine.executePlan(f.master.id, duplicate), /步骤 ID 重复/);
    const cyclic = f.plan(2);
    cyclic.steps[0].dependsOn = ['step1'];
    await assert.rejects(f.w.taskEngine.executePlan(f.master.id, cyclic), /成环/);
    const missing = f.plan();
    missing.steps[0].dependsOn = ['missing'];
    await assert.rejects(f.w.taskEngine.executePlan(f.master.id, missing), /依赖步骤不存在/);
    assert.equal(f.w.taskEngine.state.tasks.length, 0);
    assert.equal(f.writes(), 0);
  } finally {
    await f.close();
  }
});

test('cancellation while saving rolls back the committed intent before any tool executes', async () => {
  const f = await setup(),
    save = f.w.save.bind(f.w),
    abort = new AbortController();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    let entered = false;
    f.w.save = async () => {
      await save();
      if (f.w.taskEngine.batching) {
        entered = true;
        await held;
      }
    };
    const operation = f.w.taskEngine.executePlan(f.master.id, f.plan(), false, abort.signal);
    const failed = assert.rejects(operation, /cancel graph/);
    await until(() => entered);
    await f.w.taskEngine.pump();
    abort.abort(new Error('cancel graph'));
    release();
    await failed;
    await delay(20);
    assert.equal(f.writes(), 0);
    assert.equal(f.w.taskEngine.state.tasks.length, 0);
    assert.equal((f.w.taskEngine.journal.load() as { tasks: unknown[] }).tasks.length, 0);
  } finally {
    release();
    f.w.save = save;
    await f.close();
  }
});

test('concurrent recovery shares one decision and returns the same durable retry on repetition', async () => {
  const f = await setup(),
    c = f.master.controller!;
  const confirm = c.confirmDecision.bind(c);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const task = await f.w.taskEngine.enqueue(f.worker.id, f.worker.id, 'recover-source', 'fixture:write');
    f.w.taskEngine.pause(true);
    await until(() => task.status === 'queued');
    f.w.taskEngine.lifecycle.transition(task, 'interrupted');
    f.w.taskEngine.pause(false);
    let decisions = 0;
    c.confirmDecision = async () => {
      decisions++;
      await held;
      return true;
    };
    const note = '已经核对记录，没有执行副作用，恢复原任务';
    const first = f.w.taskEngine.recover(task.id, f.master.id, note);
    await until(() => decisions === 1);
    const second = f.w.taskEngine.recover(task.id, f.master.id, note);
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a!.id, b!.id);
    assert.equal(decisions, 1);
    assert.equal((await f.w.taskEngine.recover(task.id, f.master.id, note))!.id, a!.id);
    await until(() => a!.status === 'succeeded');
    assert.equal(f.writes(), 1);
    assert.equal(f.w.taskEngine.state.tasks.filter((t) => t.recoveryOf === task.id).length, 1);
  } finally {
    release();
    c.confirmDecision = confirm;
    await f.close();
  }
});
