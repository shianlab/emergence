import { propose } from './fixtures/plan-proposal.ts';
import { ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { WorkspaceController } from '../src/app/workspace.ts';
import { type TaskPlan } from '../src/core/domain/planning.ts';
import { taskStateSchema } from '../src/core/domain/task-state.ts';
import { ExecutionJournal, digest } from '../src/core/storage/execution-journal.ts';
import { executionFixture, until } from './fixtures/core-execution.ts';

function planFor(w: WorkspaceController, windows: string[]): TaskPlan {
  return {
    objective: '实际写文件并验收',
    constraints: ['项目内'],
    acceptance: ['文件正确'],
    nonGoals: ['不发布'],
    unknowns: [],
    assumptions: [],
    options: [],
    conflicts: [],
    reason: '最小执行图',
    evidence: [],
    steps: windows.map((id, index) => {
      const p = w.panes.get(id)!;
      return {
        id: 's' + index,
        objective: 'fixture:write',
        window: id,
        session: p.controller!.id!,
        project: p.cwd,
        model: p.modelId,
        role: 'developer',
        capabilities: ['tool:write'],
        dependsOn: index ? ['s' + (index - 1)] : [],
        scope: ['result.txt'],
        acceptance: ['实际文件正确'],
      };
    }),
  };
}

test('transaction journal excludes a second owner and fences stale commits; incompatible versions are preserved', async () => {
  const home = await mkdtemp(join(tmpdir(), 'emergence-journal-')),
    a = new ExecutionJournal(home, 'p'),
    b = new ExecutionJournal(home, 'p');
  await a.open();
  await assert.rejects(b.open(), /正在被其他/);
  a.commit({ version: 1, tasks: [{ id: 'task', state: 'queued' } as { id: string }] });
  const db = new DatabaseSync(a.path);
  db.prepare('UPDATE ownership SET epoch=epoch+1').run();
  db.close();
  assert.throws(() => a.commit({ tasks: [] }), /租约已失效/);
  await a.close();
  await b.open();
  assert.equal((b.load() as { tasks: unknown[] }).tasks.length, 1);
  const path = b.path;
  await b.close();
  const incompatible = new DatabaseSync(path);
  incompatible.exec('PRAGMA user_version=99');
  incompatible.close();
  const bytes = await readFile(path);
  await assert.rejects(new ExecutionJournal(home, 'p').open(), /版本不兼容/);
  assert.deepEqual(await readFile(path), bytes);
});

test('one-window execution graph is durable, deduplicated and advances dependencies only after evidence review', async () => {
  const f = await executionFixture();
  try {
    const id = f.w.focused,
      plan = planFor(f.w, [id, id]),
      tasks = await f.w.taskEngine.executePlan(id, plan);
    assert.equal(tasks.length, 2);
    await until(() => tasks[0].status === 'needs_review');
    assert.equal(tasks[1].status, 'queued');
    assert.equal(f.writes(), 1);
    await f.w.taskEngine.review(tasks[0].id, true, '读取实际文件并确认内容正确');
    await until(() => tasks[1].status === 'needs_review');
    assert.equal(f.writes(), 2);
    assert.equal((await f.w.taskEngine.executePlan(id, plan))[0].id, tasks[0].id);
    assert.equal(f.w.taskEngine.state.tasks.length, 2);
    assert.equal(f.w.taskEngine.journal.effects(tasks[0].id)[0].state, 'returned');
    await writeFile(join(f.cwd, 'result.txt'), 'external modification');
    await assert.rejects(f.w.taskEngine.review(tasks[1].id, true, 'old proof'), /产物.*修改/);
    assert.ok(f.w.taskEngine.journal.events().length);
    assert.equal(tasks[0].workflow?.stage, 'Execution');
  } finally {
    await f.close();
  }
});

test('invalid graph rolls back all tasks; cyclic durable snapshots cannot be loaded', async () => {
  const f = await executionFixture();
  try {
    const p = planFor(f.w, [f.w.focused, f.w.focused]);
    p.steps[1].session = 'stale';
    await assert.rejects(f.w.taskEngine.executePlan(f.w.focused, p), /绑定已变化/);
    assert.equal(f.w.taskEngine.state.tasks.length, 0);
    assert.equal(f.writes(), 0);
    const tasks = await f.w.taskEngine.executePlan(f.w.focused, planFor(f.w, [f.w.focused, f.w.focused]));
    const saved = structuredClone(f.w.taskEngine.state);
    Object.assign(saved.tasks[0], { dependsOn: [tasks[1].id] });
    assert.equal(taskStateSchema.safeParse(saved).success, false);
  } finally {
    await f.close();
  }
});

test('same-project attempts serialize; queued recovery needs a native decision and cannot reuse stale permission approval', async () => {
  const f = await executionFixture();
  try {
    const a = await f.w.split('row'),
      b = await f.w.split('row');
    const one = await f.w.taskEngine.enqueue(a.id, a.id, 'one', 'fixture:write');
    const two = await f.w.taskEngine.enqueue(b.id, b.id, 'two', 'fixture:write');
    await until(() => one.status === 'succeeded' && two.status === 'succeeded');
    assert.ok(two.startedAt! >= one.endedAt!);
    const stalled = await f.w.taskEngine.enqueue(b.id, b.id, 'pending', 'fixture:write', [two.id]);
    f.w.taskEngine.pause(true);
    await until(() => stalled.status === 'queued');
    Object.assign(stalled, { status: 'interrupted' });
    await f.w.save();
    const recovery = f.w.taskEngine.recover(stalled.id, b.id, '已确认原任务没有发生副作用');
    await until(() => !!b.controller!.pending);
    assert.equal(b.controller!.pending!.options[0].value, 'n');
    assert.equal(a.controller!.pending, undefined);
    b.controller!.setPermissionMode('plan');
    assert.equal(await recovery, undefined);
    assert.equal(
      f.w.taskEngine.state.tasks.some((t) => t.recoveryOf === stalled.id),
      false,
    );
  } finally {
    await f.close();
  }
});

test('hard process death after an actual write retains unknown effect and never replays before explicit reconciliation', async () => {
  const home = await mkdtemp(join(tmpdir(), 'emergence-hard-crash-'));
  const child = fork(resolve('tests/fixtures/core-crash.ts'), [home], {
    execPath: process.execPath,
    execArgv: ['--import', 'tsx'],
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let errors = '';
  child.stderr?.on('data', (b) => {
    errors += String(b);
  });
  const death = once(child, 'exit');
  try {
    await new Promise<void>((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error('crash fixture timeout: ' + errors)), 10000);
      child.once('message', () => {
        clearTimeout(timer);
        resolveReady();
      });
      child.once('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    child.kill();
    await death;
    assert.equal(await readFile(join(home, 'project/result.txt'), 'utf8'), 'persisted actual effect');
    const f = await executionFixture(home);
    try {
      const c = f.w.taskEngine,
        old = c.state.tasks[0];
      assert.equal(old.status, 'interrupted');
      assert.equal(old.recovery, 'uncertain');
      assert.equal(f.provider.calls, 0);
      assert.equal(f.writes(), 0);
      const facts = await c.recoveryFacts(old.id);
      assert.equal(facts.effects[0].state, 'started');
      assert.equal(facts.observations.length, 1);
      assert.ok(
        [...f.w.panes.values()].every((p) => p.controller),
        JSON.stringify([...f.w.panes.values()].map((p) => ({ id: p.id, error: p.error }))),
      );
      const source = f.w.panes.get(old.issuer)!.controller!;
      const pending = c.recover(old.id, old.issuer, '已核对现有文件，只允许重新验证并继续原任务');
      await until(() => !!source.pending);
      source.pending!.respond('y');
      const retry = await pending;
      assert.ok(retry);
      assert.equal(retry.recoveryOf, old.id);
      assert.deepEqual(retry.permission, old.permission);
      assert.deepEqual(retry.targetPermission, old.targetPermission);
      assert.equal(retry.recoveryCount, 1);
      assert.notEqual(retry.id, old.id);
      await until(() => retry.status === 'needs_review');
      assert.equal(f.writes(), 1);
      assert.equal(c.task(old.id).recovery, 'reconciled');
    } finally {
      await f.close();
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await death;
    }
  }
});

test('recovery approval becomes invalid when observed files change; unreadable artifacts cannot be accepted', async () => {
  const f = await executionFixture();
  try {
    const c = f.w.taskEngine,
      task = (await c.executePlan(f.w.focused, planFor(f.w, [f.w.focused])))[0];
    await until(() => task.status === 'needs_review');
    Object.assign(task, { recovery: 'uncertain' });
    await assert.rejects(c.review(task.id, true, '尚未核对，不能直接验收'), /副作用结果不确定/);
    await assert.rejects(c.repair(task.id, '尚未核对，不能自动修复'), /副作用结果不确定/);
    Object.assign(task, { recovery: undefined });
    task.artifactVersions[0].hash = 'unknown:over-budget';
    await assert.rejects(c.review(task.id, true, '不能把未知摘要当成成功验收'), /无法读取/);
    Object.assign(task, { status: 'interrupted' });
    Object.assign(task, { recovery: 'uncertain' });
    await f.w.save();
    const decision = c.recover(task.id, task.issuer, '已经核对文件，可以创建一次新尝试');
    await until(() => !!f.w.current.controller!.pending);
    await writeFile(join(f.cwd, 'result.txt'), 'changed after prompt');
    f.w.current.controller!.pending!.respond('y');
    await assert.rejects(decision, /事实已变化/);
    assert.equal(c.state.tasks.length, 1);
    assert.equal(f.writes(), 1);
  } finally {
    await f.close();
  }
});

test('legacy JSON is backed up before import; restored SQLite snapshot stays authoritative and shutdown cancels recovery dialogs', async () => {
  const f = await executionFixture();
  let restored: WorkspaceController | undefined;
  try {
    const p = await f.w.split('row');
    f.w.taskEngine.pause(true);
    const snapshot = structuredClone(f.w.taskEngine.state);
    snapshot.tasks = [];
    await f.w.save();
    const layout = f.w.path,
      db = f.w.taskEngine.journal.path;
    await f.w.close();
    const legacy = JSON.parse(await readFile(layout, 'utf8'));
    legacy.collaboration = snapshot;
    const bytes = JSON.stringify(legacy);
    await writeFile(layout, bytes);
    await unlink(db);
    restored = new WorkspaceController(f.ctx, f.launch);
    await restored.initialize();
    const backups = (await readdir(join(f.home, 'core/execution'))).filter((n) => n.includes('.legacy-'));
    assert.ok(backups.length);
    assert.equal(await readFile(join(f.home, 'core/execution', backups.at(-1)!), 'utf8'), bytes);
    assert.ok(
      [...restored.panes.values()].every((p) => p.controller),
      JSON.stringify([...restored.panes.values()].map((p) => ({ id: p.id, error: p.error }))),
    );
    const blocker = await restored.taskEngine.enqueue(p.id, p.id, 'blocker', 'fixture:write', [], {
      role: 'developer',
      scope: ['result.txt'],
      acceptance: ['核对内容'],
    });
    await until(() => blocker.status === 'needs_review');
    const task = await restored.taskEngine.enqueue(p.id, p.id, 'hold', 'fixture:write', [blocker.id]);
    restored.taskEngine.pause(true);
    Object.assign(task, { status: 'interrupted' });
    await restored.save();
    const command = restored.send(
      task.issuer,
      `/recover retry ${task.id} "已核对任务没有执行，可以创建新尝试"`,
    );
    await until(() => !!restored!.panes.get(task.issuer)!.controller!.pending);
    await restored.close();
    await command;
  } finally {
    await restored?.close();
    await f.close();
  }
});

test('the selected model can submit a ready plan to the durable scheduler without repeating inline effects', async () => {
  const f = await executionFixture();
  try {
    f.ctx.effect(() =>
      f.ctx.tools.register(
        defineTool({
          name: 'read',
          description: 'fixture source',
          parameters: {},
          output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
          async execute() {
            return 'project facts';
          },
        }),
      ),
    );
    const original = f.provider.stream.bind(f.provider),
      plan = planFor(f.w, [f.w.focused]);
    plan.evidence = ['planning-1'];
    let step = 0;
    f.provider.stream = async function* (options): AsyncIterable<StreamChunk> {
      if (options.messages.some((m) => JSON.stringify(m.content).includes('[Emergence task '))) {
        yield* original(options);
        return;
      }
      if (step >= 4) {
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }
      const n = step++,
        id = ToolCallId('planning-' + n),
        name = ['emergence_analyze', 'read', 'emergence_plan', 'emergence_execute_plan'][n];
      const c = f.w.current.controller!;
      const args =
          n === 0
            ? {
                objective: plan.objective,
                constraints: plan.constraints,
                acceptance: plan.acceptance,
                nonGoals: plan.nonGoals,
                reason: plan.reason,
                intent: 'execute',
                route: 'planned',
              }
            : n === 1
              ? {}
              : n === 2
                ? { plan: propose(plan, c.planning.intake()!.requirements!) }
                : { plan_id: digest(c.planning.snapshot(c.agent)!.plan!) },
        raw = JSON.stringify(args);
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: raw };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: raw } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    };
    await f.w.send(f.w.focused, '规划并执行当前项目修改');
    await until(() => f.w.taskEngine.state.tasks[0]?.status === 'needs_review');
    assert.equal(f.writes(), 1);
    assert.equal(f.w.taskEngine.state.tasks.length, 1);
    assert.equal(f.w.taskEngine.journal.effects(f.w.taskEngine.state.tasks[0].id).length, 1);
    assert.ok((await f.w.current.controller!.planning.describe()).includes('实际写文件并验收'));
  } finally {
    await f.close();
  }
});
