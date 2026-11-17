import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { assertPlanAdmission, planTaskContract } from '../src/core/application/task-admission.ts';
import { planSchema, type TaskPlan } from '../src/core/domain/planning.ts';
import { executionFixture, until } from './fixtures/core-execution.ts';
import { safeError } from '../src/core/adapters/redaction.ts';
import { pathIdentity } from '../src/platform/path-policy.ts';

function planFor(f: Awaited<ReturnType<typeof executionFixture>>, count = 1): TaskPlan {
  const pane = f.w.current;
  return planSchema.parse({
    objective: '完整保存任务约束',
    constraints: ['只修改指定文件'],
    acceptance: ['数据正确'],
    nonGoals: ['不发布'],
    unknowns: [],
    assumptions: ['输入格式已确认'],
    options: [],
    reason: '按依赖执行',
    evidence: [],
    steps: Array.from({ length: count }, (_, i) => ({
      id: `step${i}`,
      objective: 'fixture:write',
      window: pane.id,
      session: pane.controller!.id,
      project: pane.cwd,
      model: pane.modelId,
      role: 'developer',
      capabilities: ['tool:write'],
      dependsOn: i ? [`step${i - 1}`] : [],
      scope: ['result.txt'],
      acceptance: ['文件正确'],
    })),
  });
}

test('credential words redact diagnostics without rewriting executable contract keys or role values', async () => {
  const f = await executionFixture();
  const credentials = { ADMISSION_TEST_PASSWORD: 'root', ADMISSION_TEST_SECRET: 'developer' };
  const previous = Object.fromEntries(Object.keys(credentials).map((key) => [key, process.env[key]]));
  Object.assign(process.env, credentials);
  try {
    const plan = planFor(f);
    const tasks = await f.w.taskEngine.executePlan(f.w.focused, plan);
    await until(() => tasks[0].status === 'needs_review');
    assert.equal(tasks[0].contract?.binding?.project.root, pathIdentity(await realpath(f.w.current.cwd)));
    assert.equal(tasks[0].contract?.role, 'developer');
    assert.equal(f.writes(), 1);
    assert.equal(safeError('root developer'), '[已隐藏] [已隐藏]');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await f.close();
  }
});

test('final admission handles twelve steps and rejects expanded path budgets before any execution', async () => {
  const f = await executionFixture();
  try {
    const plan = planFor(f, 12);
    assert.doesNotThrow(() => assertPlanAdmission(plan, 16000));
    for (const step of plan.steps) step.project += '/long-project'.repeat(120);
    assert.throws(() => assertPlanAdmission(plan, 16000), /绑定后的计划超过.*预算/);
    await assert.rejects(f.w.taskEngine.executePlan(f.w.focused, plan), /绑定后的计划超过.*预算/);
    assert.equal(f.w.taskEngine.state.tasks.length, 0);
    assert.equal(f.writes(), 0);
  } finally {
    await f.close();
  }
});

test('execution context keeps constraints and background but only local acceptance is executable', async () => {
  const f = await executionFixture();
  try {
    const plan = planFor(f);
    const contract = planTaskContract(plan, plan.steps[0]);
    const context = JSON.parse(contract.context);
    assert.deepEqual(context.constraints, plan.constraints);
    assert.equal(context.acceptance, undefined);
    assert.equal(context.background.objective, plan.objective);
    assert.deepEqual(contract.acceptance, plan.steps[0].acceptance);
    assert.deepEqual(context.assumptions, plan.assumptions);
    plan.constraints = Array.from({ length: 9 }, (_, i) => `${i}:` + '约束'.repeat(480));
    assert.ok(JSON.stringify(plan).length < 13000, 'plan fits but execution envelope does not');
    await assert.rejects(f.w.taskEngine.executePlan(f.w.focused, plan), /完整任务上下文.*8000/);
    assert.equal(f.w.taskEngine.state.tasks.length, 0);
    assert.equal(f.writes(), 0);
  } finally {
    await f.close();
  }
});

test('local task admission preserves all acceptance, deliverables and context', async () => {
  const f = await executionFixture();
  try {
    const worker = await f.w.split('row');
    const acceptance = Array.from({ length: 20 }, (_, i) => `验收 ${i}:` + 'z'.repeat(980));
    const task = await f.w.taskEngine.enqueue(worker.id, worker.id, 'many-criteria', 'fixture:write', [], {
      role: 'developer',
      scope: ['result.txt'],
      acceptance,
      deliverables: ['result.txt'],
      context: 'c'.repeat(7900),
    });
    await until(() => task.status === 'needs_review');
    const admitted = task.contract!;
    assert.deepEqual(admitted.acceptance, acceptance);
    assert.deepEqual(admitted.deliverables, ['result.txt']);
    assert.equal(admitted.context, task.contract!.context);
    assert.equal(admitted.context.length, 7900);
  } finally {
    await f.close();
  }
});

test('a task cannot run or be duplicate-acknowledged while its admission write is pending', async () => {
  const f = await executionFixture();
  const save = f.w.save.bind(f.w);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const worker = await f.w.split('row');
    let entered = false;
    f.w.save = async () => {
      if (!entered && f.w.taskEngine.state.tasks.some((t) => t.requestKey === 'held')) {
        entered = true;
        await held;
      }
      await save();
    };
    const admission = f.w.taskEngine.enqueue(worker.id, worker.id, 'held', 'fixture:write');
    await until(() => entered);
    f.w.taskEngine.kick();
    await delay(50);
    assert.equal(f.writes(), 0);
    await assert.rejects(f.w.taskEngine.enqueue(worker.id, worker.id, 'held', 'fixture:write'), /正在提交/);
    release();
    const task = await admission;
    await until(() => task.status === 'succeeded');
    assert.equal(f.writes(), 1);
  } finally {
    release();
    f.w.save = save;
    await f.close();
  }
});

test('repair feedback stays visible beside a full original context and survives durable serialization', async () => {
  const f = await executionFixture();
  try {
    const worker = await f.w.split('row');
    const context = 'c'.repeat(7900),
      feedback = '修复反馈尾部必须保留';
    const task = await f.w.taskEngine.enqueue(worker.id, worker.id, 'long-repair', 'fixture:write', [], {
      role: 'developer',
      scope: ['result.txt'],
      acceptance: ['文件正确'],
      context,
    });
    await until(() => task.status === 'needs_review');
    const repair = await f.w.taskEngine.repair(task.id, feedback);
    assert.equal(repair.contract!.context, context);
    assert.ok(f.w.taskEngine.view(repair).followup?.includes(feedback));
    assert.equal(f.w.taskEngine.view(repair).priorResult?.summary, task.result?.summary);
    const persisted = f.w.taskEngine.journal.load() as { tasks: Array<{ id: string; followup?: string }> };
    assert.ok(persisted.tasks.find((t) => t.id === repair.id)?.followup?.includes(feedback));
  } finally {
    await f.close();
  }
});
