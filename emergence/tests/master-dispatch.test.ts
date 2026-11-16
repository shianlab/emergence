import { propose } from './fixtures/plan-proposal.ts';
import { ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import UserApproval from '@deepseek-ai/dsh-user-approval';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { ZodError } from 'zod';
import { automaticPlanningContext } from '../src/core/application/coordinator-context.ts';
import { tasksConflict } from '../src/core/application/task-allocation.ts';
import { allocateWork } from '../src/core/application/work-allocation.ts';
import type { PlanningState } from '../src/core/domain/planning.ts';
import { executionFixture, until } from './fixtures/core-execution.ts';

async function* call(name: string, args: unknown, id: string = randomUUID()): AsyncIterable<StreamChunk> {
  const raw = JSON.stringify(args),
    key = ToolCallId(id);
  yield { type: 'block-start', index: 0, blockType: 'tool-call' };
  yield { type: 'tool-call-delta', index: 0, id: key, name, argumentsDelta: raw };
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: key, name, arguments: raw } };
  yield { type: 'finish', reason: { kind: 'tool-calls' } };
}
function draft(files = ['a.txt', 'b.txt'], evidence: string[] = []) {
  return {
    objective: '完成说明文件',
    constraints: ['仅指定文件'],
    acceptance: ['内容正确'],
    nonGoals: [],
    unknowns: [],
    assumptions: [],
    options: [],
    reason: '任务可以独立实现',
    evidence,
    steps: files.map((file, i) => ({
      id: 'step' + i,
      objective: '完成 ' + file,
      role: 'developer',
      capabilities: ['tool:write'],
      scope: [file],
      acceptance: ['写入完成'],
      dependsOn: [] as string[],
    })),
  };
}
async function setup(workers = 2) {
  const f = await executionFixture(),
    main = f.w.current;
  // Keep the existing whole-proposal compatibility matrix; incremental admission
  // has its own end-to-end cases and is the production default.
  f.config.core.planning.submission = 'whole';
  main.controller!.launch.appConfig.core.planning.submission = 'whole';
  for (let i = 0; i < workers; i++) await f.w.split('row');
  await f.w.setMaster(main.id);
  // Isolate the dispatch boundary; master-followthrough.test.ts exercises the real automatic assurance loop.
  f.w.team.followthrough.advance = async () => {};
  await writeFile(join(f.cwd, 'source.txt'), '任务背景');
  f.ctx.effect(() =>
    f.ctx.tools.register(
      defineTool({
        name: 'read',
        description: 'read real source',
        parameters: { file_path: { type: 'string', required: true } },
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
        execute: (args) => readFile(join(f.cwd, args.file_path), 'utf8'),
      }),
    ),
  );
  return { ...f, main, c: main.controller! };
}
function drive(
  f: Awaited<ReturnType<typeof setup>>,
  options: {
    files?: string[];
    intent?: 'execute' | 'discuss';
    hold?: () => Promise<void>;
    wrongPath?: boolean | string;
    reference?: boolean;
    dependent?: boolean;
    expire?: 'time' | 'steps';
    revise?: boolean;
    invalidRequirement?: boolean;
  } = {},
) {
  let master = 0;
  const started = new Set<string>(),
    readId = 'source-' + randomUUID();
  f.provider.stream = async function* (request): AsyncIterable<StreamChunk> {
    const index = request.messages.findLastIndex(
      (m) =>
        m.role === 'user' &&
        m.content.some((b) => b.type === 'text' && b.text.startsWith('[Emergence task ')),
    );
    if (index >= 0) {
      const user = request.messages[index],
        text = user.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join(''),
        file = /完成 ([ab]\.txt)/.exec(text)?.[1] ?? 'a.txt';
      const count = request.messages.slice(index + 1).filter((m) => m.role === 'tool').length;
      if (!count) {
        started.add(file);
        await options.hold?.();
        yield* call('write', {
          file_path:
            typeof options.wrongPath === 'string'
              ? options.wrongPath
              : options.wrongPath
                ? 'outside.txt'
                : file,
          content: '已完成 ' + file,
        });
      } else if (count === 1)
        yield* call('emergence_report', { outcome: 'success', summary: '已写入', artifacts: [file] });
      else yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    const step = master++;
    if (step === 0) {
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    } // Host must recover a premature stop.
    if (step === 1) {
      yield* call('emergence_analyze', {
        objective: '完成两个说明文件',
        reason: '相互独立',
        route: 'planned',
        intent: options.intent ?? 'execute',
        constraints: ['仅指定文件'],
        acceptance: ['写入正确'],
        questions: [],
      });
      return;
    }
    if (step === 2) {
      yield* call('read', { file_path: 'source.txt' }, readId);
      return;
    }
    if (step === 3) {
      const plan = draft(options.files, [readId]);
      if (options.reference) {
        plan.steps[0].scope.push('protected.txt');
        plan.steps[0].capabilities.push('tool:read');
      }
      if (options.dependent && plan.steps[1]) plan.steps[1].dependsOn = ['step0'];
      const budget = f.c.planning.intake()!.autonomy!;
      if (options.expire === 'time') budget.startedAt = Date.now() - 252000;
      if (options.expire === 'steps') budget.steps = 24;
      const work = propose(plan, f.c.planning.intake()!.requirements!);
      if (options.invalidRequirement) work.steps[0].requirementIds = ['a99'];
      yield* call('emergence_plan_work', { work });
      return;
    }
    if (step === 4 && options.revise) {
      yield* call('emergence_plan_work', {
        work: propose(draft(['a.txt'], [readId]), f.c.planning.intake()!.requirements!),
      });
      return;
    }
    yield { type: 'finish', reason: { kind: 'stop' } };
  };
  return { started, calls: () => master };
}

test('a natural request survives an early stop, matches two workers, starts concurrent real writes and deduplicates dispatch', async () => {
  const f = await setup();
  let release = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  try {
    const model = drive(f, { hold: () => held });
    await f.w.send(f.main.id, '把两份说明分别写好');
    await until(() => model.started.size === 2);
    assert.equal(
      f.w.collaboration.state.tasks.filter((t) => t.status === 'running').length,
      2,
      'disjoint paths in one project really run concurrently',
    );
    assert.equal(new Set(f.w.collaboration.state.tasks.map((t) => t.target)).size, 2);
    assert.ok(f.w.collaboration.state.tasks.every((t) => t.allocation?.paths?.length));
    assert.equal(f.c.planning.intake()?.autonomy?.nudges, 1);
    assert.equal(f.c.planning.intake()?.executions.length, 2);
    release();
    await until(() => f.w.collaboration.state.tasks.every((t) => t.status === 'needs_review'));
    assert.equal(await readFile(join(f.cwd, 'a.txt'), 'utf8'), '已完成 a.txt');
    assert.equal(await readFile(join(f.cwd, 'b.txt'), 'utf8'), '已完成 b.txt');
    await f.c.agent.whenIdle();
    assert.equal(model.calls(), 4, 'valid plan dispatches without a fifth model response');
    await f.c.planning.run(true);
    assert.equal(f.w.collaboration.state.tasks.length, 2);
    assert.equal(f.writes(), 2);
    assert.equal(f.w.team.records.at(-1)?.phase, 'dispatched');
    assert.equal(f.w.team.records.at(-1)?.assignments?.length, 2);
  } finally {
    release();
    await f.close();
  }
});

test('one worker processes independent steps in sequence without a second user instruction', async () => {
  const f = await setup(1);
  try {
    drive(f);
    await f.w.send(f.main.id, '把两份说明分别写好');
    await until(
      () =>
        f.w.collaboration.state.tasks.length === 2 &&
        f.w.collaboration.state.tasks.every((t) => t.status === 'needs_review'),
    );
    assert.equal(new Set(f.w.collaboration.state.tasks.map((t) => t.target)).size, 1);
    assert.equal(f.writes(), 2);
  } finally {
    await f.close();
  }
});

test('discussion generates no effects; repeated missing decisions stop at the host correction budget', async () => {
  const f = await setup();
  try {
    drive(f, { intent: 'discuss' });
    await f.w.send(f.main.id, '先讨论两份说明，不要实施');
    await f.c.agent.whenIdle();
    assert.equal(f.w.collaboration.state.tasks.length, 0);
    assert.equal(f.writes(), 0);
    let calls = 0;
    f.provider.stream = async function* (): AsyncIterable<StreamChunk> {
      calls++;
      yield { type: 'finish', reason: { kind: 'stop' } };
    };
    await f.w.send(f.main.id, '实现一个页面');
    await f.c.agent.whenIdle();
    assert.equal(calls, 3);
    assert.equal(f.c.planning.intake()?.autonomy?.decision, 'blocked');
    assert.equal(f.w.team.records.at(-1)?.phase, 'blocked');
  } finally {
    await f.close();
  }
});

test('approval cancellation prevents host automatic dispatch', async () => {
  const f = await setup();
  await f.ctx.plugin(UserApproval);
  try {
    f.c.launch.appConfig.permissions.rules.push({ tool: 'emergence_dispatch', effect: 'ask' });
    drive(f);
    await f.w.send(f.main.id, '完成两份说明');
    await until(() => !!f.c.pending);
    f.c.pending!.respond('n');
    await f.c.agent.whenIdle();
    assert.equal(f.w.collaboration.state.tasks.length, 0);
    assert.equal(f.writes(), 0);
    assert.match(f.c.planning.intake()?.autonomy?.reason ?? '', /未获批准/);
  } finally {
    await f.close();
  }
});

test('scoped worker cannot escape its paths; dependencies wait for actual acceptance', async () => {
  const f = await setup();
  try {
    drive(f, { wrongPath: true, dependent: true });
    await f.w.send(f.main.id, '完成两份说明');
    await until(() => f.w.collaboration.state.tasks[0]?.status === 'needs_review');
    assert.equal(f.writes(), 0);
    await assert.rejects(readFile(join(f.cwd, 'outside.txt')));
    assert.ok(f.w.collaboration.state.tasks[0].result?.errors.length);
    assert.equal(f.w.collaboration.state.tasks[1].status, 'queued');
  } finally {
    await f.close();
  }
});

test('matching respects project, role preference and unavailable windows; overlapping paths retain a lock', async () => {
  const f = await setup();
  try {
    const workers = [...f.w.panes.values()].filter((p) => p.id !== f.main.id);
    await f.w.team.setPreference(workers[1].id, 'developer');
    const inventory = await f.c.planning.inventory();
    const plan = allocateWork(draft(['a.txt']), inventory, f.cwd, 'a'.repeat(64), () => undefined);
    assert.equal(plan.steps[0].window, workers[1].id);
    assert.match(plan.steps[0].allocation!.reason, /符合角色偏好/);
    const wrongCapability = draft(['a.txt']);
    wrongCapability.steps[0].capabilities = ['shell:write'];
    assert.throws(
      () => allocateWork(wrongCapability, inventory, f.cwd, 'a'.repeat(64), () => undefined),
      /shell:write（该窗口实际登记：tool:write）/,
      'An invalid capability stays rejected, with the actual registered ID for revision',
    );
    assert.deepEqual(wrongCapability.steps[0].capabilities, ['shell:write']);
    assert.throws(
      () =>
        allocateWork({ ...draft(['a.txt']), ready: true }, inventory, f.cwd, 'a'.repeat(64), () => undefined),
      (error: unknown) =>
        error instanceof ZodError &&
        error.issues.some((issue) => issue.code === 'unrecognized_keys' && issue.keys.includes('ready')),
      'Readiness must be computed by the host, never accepted from the model',
    );
    inventory.windows.find((w) => w.id === workers[1].id)!.dispatchable = false;
    assert.equal(
      allocateWork(draft(['a.txt']), inventory, f.cwd, 'a'.repeat(64), () => undefined).steps[0].window,
      workers[0].id,
    );
    const other = join(f.home, 'other');
    await mkdir(other);
    const wrong = { ...draft(['a.txt']), steps: [{ ...draft(['a.txt']).steps[0], project: other }] };
    assert.throws(() => allocateWork(wrong, inventory, f.cwd, 'a'.repeat(64), () => undefined), /项目不匹配/);
    const outside = {
      ...draft(['a.txt']),
      steps: [{ ...draft(['a.txt']).steps[0], scope: ['../escape.txt'] }],
    };
    assert.throws(
      () => allocateWork(outside, inventory, f.cwd, 'a'.repeat(64), () => undefined),
      /超出目标项目/,
    );
    const task = (paths?: string[]) =>
      ({ cwd: f.cwd, allocation: paths ? { reason: 'test', paths } : undefined }) as Parameters<
        typeof tasksConflict
      >[0];
    assert.ok(tasksConflict(task([join(f.cwd, 'a.txt')]), task([join(f.cwd, 'a.txt')])));
    assert.ok(tasksConflict(task(), task([join(f.cwd, 'a.txt')])));
    assert.equal(tasksConflict(task([join(f.cwd, 'a.txt')]), task([join(f.cwd, 'b.txt')])), false);
  } finally {
    await f.close();
  }
});

test('Plan mode can prepare matched work but cannot dispatch or write', async () => {
  const f = await setup();
  try {
    f.c.setPermissionMode('plan');
    drive(f);
    await f.w.send(f.main.id, '完成两份说明');
    await f.c.agent.whenIdle();
    assert.equal(f.c.planning.intake()?.status, 'ready');
    assert.equal(f.w.collaboration.state.tasks.length, 0);
    assert.equal(f.writes(), 0);
    await assert.rejects(f.c.planning.run(true), /计划模式/);
    assert.equal(f.w.collaboration.state.tasks.length, 0);
  } finally {
    await f.close();
  }
});

test('read-only reference paths do not block another scoped edit; actual writes to the protected path remain denied', async () => {
  for (const escape of [false, true]) {
    const f = await setup(1);
    try {
      const protectedPath = join(f.cwd, 'protected.txt');
      await writeFile(protectedPath, 'immutable');
      f.c.launch.appConfig.permissions.rules.push({ tool: 'write', path: protectedPath, effect: 'deny' });
      drive(f, { files: ['a.txt'], reference: true, wrongPath: escape ? 'protected.txt' : false });
      await f.w.send(f.main.id, '完成说明并保持参考文件不变');
      await until(() => f.w.collaboration.state.tasks[0]?.status === 'needs_review');
      assert.equal(f.writes(), escape ? 0 : 1);
      assert.equal(await readFile(protectedPath, 'utf8'), 'immutable');
      if (escape) assert.ok(f.w.collaboration.state.tasks[0].result?.errors.length);
    } finally {
      await f.close();
    }
  }
});

test('a model stuck in tool calls hits the native step budget rather than looping forever', async () => {
  const f = await setup();
  try {
    let calls = 0;
    f.provider.stream = async function* (): AsyncIterable<StreamChunk> {
      calls++;
      yield* call('read', { file_path: 'source.txt' });
    };
    await f.w.send(f.main.id, '实现一个页面');
    await f.c.agent.whenIdle();
    assert.equal(calls, 24);
    assert.equal(f.c.planning.intake()?.autonomy?.decision, 'blocked');
    assert.match(f.c.planning.intake()?.autonomy?.reason ?? '', /预算/);
    assert.equal(f.writes(), 0);
    assert.equal(f.w.collaboration.state.tasks.length, 0);
  } finally {
    await f.close();
  }
});

test('a ready plan at the planning limit still dispatches through the normal gate', async () => {
  for (const expire of ['time', 'steps'] as const) {
    const f = await setup();
    try {
      drive(f, { expire });
      await f.w.send(f.main.id, '完成两份说明');
      await until(
        () =>
          f.w.collaboration.state.tasks.length === 2 &&
          f.w.collaboration.state.tasks.every((t) => t.status === 'needs_review'),
      );
      await f.c.agent.whenIdle();
      assert.equal(f.writes(), 2);
      assert.equal(f.c.planning.intake()?.executions.length, 2);
      assert.notEqual(f.c.planning.intake()?.autonomy?.decision, 'blocked');
    } finally {
      await f.close();
    }
  }
});

test('a ready plan at the time limit still respects Plan mode and denied approval', async () => {
  for (const mode of ['plan', 'denied'] as const) {
    const f = await setup();
    try {
      if (mode === 'plan') f.c.setPermissionMode('plan');
      else {
        await f.ctx.plugin(UserApproval);
        f.c.launch.appConfig.permissions.rules.push({ tool: 'emergence_dispatch', effect: 'ask' });
      }
      drive(f, { expire: 'time' });
      await f.w.send(f.main.id, '完成两份说明');
      if (mode === 'denied') {
        await until(() => !!f.c.pending);
        f.c.pending!.respond('n');
      }
      await f.c.agent.whenIdle();
      assert.equal(f.writes(), 0);
      assert.equal(f.w.collaboration.state.tasks.length, 0);
      if (mode === 'denied') assert.match(f.c.planning.intake()?.autonomy?.reason ?? '', /未获批准/);
      else assert.equal(f.c.planning.intake()?.status, 'ready');
    } finally {
      await f.close();
    }
  }
});

test('automatic dispatch also checks the expanded plan context budget after window matching', async () => {
  const f = await setup();
  try {
    const observed: string[] = [];
    f.c.on('change', () => {
      const status = f.c.planning.intake()?.status;
      if (status) observed.push(status);
    });
    f.c.launch.appConfig.core.planning = { ...f.c.launch.appConfig.core.planning, contextChars: 6000 };
    drive(f, { files: Array.from({ length: 12 }, (_, i) => `f${i}.txt`) });
    await f.w.send(f.main.id, '实现一组说明文件');
    await f.c.agent.whenIdle();
    assert.match(f.c.planning.intake()?.autonomy?.reason ?? '', /绑定后的计划超过/);
    assert.equal(f.w.collaboration.state.tasks.length, 0);
    assert.equal(f.writes(), 0);
    assert.ok(!observed.includes('ready'), 'oversized expanded plan must never be acknowledged ready');
  } finally {
    await f.close();
  }
});

test('a rejected expanded plan can be revised and actually dispatched within the same turn', async () => {
  const f = await setup();
  try {
    f.c.launch.appConfig.core.planning = { ...f.c.launch.appConfig.core.planning, contextChars: 6000 };
    drive(f, { files: Array.from({ length: 12 }, (_, i) => `f${i}.txt`), revise: true });
    await f.w.send(f.main.id, '实现一组说明文件');
    await f.c.agent.whenIdle();
    await until(() => f.w.collaboration.state.tasks.some((t) => t.status === 'needs_review'));
    assert.match(await f.c.planning.describe(), /修订：2\/4/);
    assert.equal(f.w.collaboration.state.tasks.length, 1);
    assert.equal(f.writes(), 1);
    assert.equal(f.c.planning.intake()?.status, 'ready');
  } finally {
    await f.close();
  }
});

test('a taken-over worker is awaited without reserving a task and automatically receives work after release', async () => {
  const f = await setup(1);
  try {
    const worker = [...f.w.panes.values()].find((pane) => pane.id !== f.main.id)!;
    await f.w.collaboration.takeover(worker.id);
    drive(f, { files: ['a.txt'] });
    await f.w.send(f.main.id, '完成说明文件');
    await until(() => f.c.notice.startsWith('等待资源：'));
    assert.equal(f.w.collaboration.state.tasks.length, 0);
    assert.equal(f.writes(), 0);
    f.w.collaboration.release(worker.id);
    await until(() => f.w.collaboration.state.tasks[0]?.status === 'needs_review');
    assert.equal(f.w.collaboration.state.tasks[0].target, worker.id);
    assert.equal(f.c.planning.state(f.c.agent).value.attempts, 1);
    assert.equal(f.writes(), 1);
  } finally {
    await f.close();
  }
});

test('cancelling a resource wait cannot restart dispatch when the worker is released', async () => {
  const f = await setup(1);
  try {
    const worker = [...f.w.panes.values()].find((pane) => pane.id !== f.main.id)!;
    await f.w.collaboration.takeover(worker.id);
    drive(f, { files: ['a.txt'] });
    await f.w.send(f.main.id, '完成说明文件');
    await until(() => f.c.notice.startsWith('等待资源：'));
    await f.c.cancel();
    f.w.collaboration.release(worker.id);
    await f.c.agent.whenIdle();
    assert.equal(f.w.collaboration.state.tasks.length, 0);
    assert.equal(f.writes(), 0);
  } finally {
    await f.close();
  }
});

test('a worker doing independent work is not occupied; the master waits and dispatches after it finishes', async () => {
  const f = await setup(1);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const worker = [...f.w.panes.values()].find((pane) => pane.id !== f.main.id)!;
    drive(f, { files: ['a.txt'] });
    const original = f.provider.stream;
    f.provider.stream = async function* (request) {
      const relevant = request.messages
        .filter((message) => message.role === 'user')
        .map((message) =>
          message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n'),
        )
        .filter((text) => text.includes('PRIVATE_REQUEST') || text.includes('[Emergence task '))
        .at(-1);
      if (relevant?.includes('PRIVATE_REQUEST') && !relevant.includes('[Emergence task ')) {
        await held;
        yield { type: 'finish', reason: { kind: 'stop' } };
      } else yield* original.call(this, request);
    };
    await worker.controller!.send('PRIVATE_REQUEST 独立问答');
    await until(() => worker.controller!.busy);
    await f.w.send(f.main.id, '完成说明文件');
    await until(() => f.c.notice.startsWith('等待资源：'));
    assert.equal(f.w.collaboration.state.tasks.length, 0);
    assert.match(f.c.notice, /独立工作/);
    release();
    await until(() => f.w.collaboration.state.tasks[0]?.status === 'needs_review');
    assert.equal(f.writes(), 1);
  } finally {
    release();
    await f.close();
  }
});

test('automatic admission rematches a changed worker within the original revision budget without another model call', async () => {
  const f = await setup(2);
  const execute = f.c.planning.onExecute!;
  try {
    let attempts = 0,
      taken = '';
    f.c.planning.onExecute = async (plan, model, signal) => {
      if (++attempts === 1) {
        taken = plan.steps[0].window;
        await f.w.collaboration.takeover(taken);
      }
      return execute(plan, model, signal);
    };
    drive(f, { files: ['a.txt'] });
    await f.w.send(f.main.id, '完成说明文件');
    await until(() => f.w.collaboration.state.tasks[0]?.status === 'needs_review');
    assert.equal(attempts, 2);
    assert.notEqual(f.w.collaboration.state.tasks[0].target, taken);
    assert.equal(f.w.collaboration.state.tasks.length, 1);
    assert.equal(f.c.planning.state(f.c.agent).value.attempts, 2);
    assert.equal(f.writes(), 1);
  } finally {
    f.c.planning.onExecute = execute;
    await f.close();
  }
});

test('an invalid requirement reference is corrected in the same user turn and reaches the real scheduler', async () => {
  const f = await setup();
  try {
    drive(f, { invalidRequirement: true, revise: true });
    await f.w.send(f.main.id, '实现说明文件，并核对实际写入');
    await f.c.agent.whenIdle();
    await until(() => f.w.collaboration.state.tasks.some((t) => t.status === 'needs_review'));
    const state = f.c.planning.state(f.c.agent).value;
    assert.equal(state.attempts, 2);
    assert.equal(state.requirements!.items.length, 2);
    assert.equal(f.w.collaboration.state.tasks.length, 1);
    assert.equal(f.writes(), 1);
    const results = f.c.agent.session.snapshotEvents().filter((e) => e.type === 'tool/result');
    assert.match(JSON.stringify(results), /UNKNOWN_REQUIREMENT/);
    assert.deepEqual(state.plan!.constraints, ['仅指定文件']);
    assert.deepEqual(state.plan!.steps[0].acceptance, ['写入正确']);
  } finally {
    await f.close();
  }
});

test('existing backlog outweighs role preference and new assignments are balanced', async () => {
  const f = await setup();
  try {
    const workers = [...f.w.panes.values()].filter((p) => p.id !== f.main.id);
    await f.w.team.setPreference(workers[0].id, 'developer');
    const inventory = await f.c.planning.inventory();
    const loaded = inventory.windows.find((w) => w.id === workers[0].id)!;
    loaded.profile!.queued = 3;
    loaded.profile!.running = 1;
    loaded.profile!.state = 'busy';
    const plan = allocateWork(draft(['a.txt', 'b.txt']), inventory, f.cwd, 'a'.repeat(64), () => undefined);
    assert.ok(plan.steps.every((step) => step.window === workers[1].id));
    assert.match(plan.steps[0].allocation!.reason, /已有队列\/运行 0/);
  } finally {
    await f.close();
  }
});

test('first master request has one automatic planning path before admission; workers start contracted', async () => {
  const f = await setup();
  try {
    drive(f);
    const stream = f.provider.stream;
    let inspectedMaster = false,
      inspectedWorker = false;
    f.provider.stream = async function* (request) {
      const assigned = request.messages.some(
        (m) =>
          m.role === 'user' &&
          m.content.some((b) => b.type === 'text' && b.text.startsWith('[Emergence task ')),
      );
      const text = request.messages
        .flatMap((m) => m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])))
        .join('\n');
      const names = new Set(request.tools?.map((t) => t.name));
      if (!assigned && !inspectedMaster) {
        inspectedMaster = true;
        assert.match(text, /Emergence 自动主控入口/);
        assert.match(text, /emergence_plan_work/);
        assert.doesNotMatch(
          text,
          /Use emergence_dispatch with|复杂请求先用 emergence_capabilities|ready 后使用 emergence_execute_plan/,
        );
        assert.ok(names.has('emergence_analyze') && !names.has('emergence_plan_work'));
        assert.doesNotMatch(text, /编码任务先定位实现、调用方与测试|跨项目步骤必须填写/);
        assert.ok(
          !names.has('emergence_plan') &&
            !names.has('emergence_execute_plan') &&
            !names.has('emergence_dispatch'),
        );
      }
      if (!assigned && f.c.planning.intake()?.analysis?.intent === 'execute') {
        assert.ok(names.has('emergence_plan_work'), 'work schema becomes available after intake');
        assert.match(text, /localCriteria/);
      }
      if (assigned && !inspectedWorker) {
        inspectedWorker = true;
        assert.match(text, /Emergence 契约执行/);
      }
      yield* stream.call(this, request);
    };
    await f.w.send(f.main.id, '把两份说明分别写好');
    await until(
      () =>
        f.w.collaboration.state.tasks.length === 2 &&
        f.w.collaboration.state.tasks.every((t) => t.status === 'needs_review'),
    );
    assert.ok(inspectedMaster && inspectedWorker);
    assert.equal(f.writes(), 2);
  } finally {
    await f.close();
  }
});

test('automatic context stays bounded without mutating the authoritative analysis or constraints', () => {
  const state: PlanningState = {
    version: 2,
    scope: 'fixture',
    requestIds: [],
    request: '原始任务',
    route: 'planned',
    routeReason: 'fixture',
    status: 'draft',
    attempts: 0,
    research: 0,
    issues: [],
    executions: [],
    analysis: {
      objective: '完整目标',
      intent: 'clarify',
      reason: '需要选择',
      constraints: ['user-specific-boundary-xyz'],
      questions: Array(4).fill('"'.repeat(1000)),
    },
    receipts: Array.from({ length: 24 }, (_, i) => ({
      id: String(i) + 'x'.repeat(190),
      tool: 'read',
      read: true,
    })),
  };
  const before = structuredClone(state);
  const text = automaticPlanningContext(state, false, 'plan', 6000);
  assert.ok(text.length <= 6000);
  assert.match(text, /当前仅讨论或存在关键待答问题/);
  assert.deepEqual(state, before);
  const fresh = automaticPlanningContext(state, true, 'plan', 6000);
  assert.match(fresh, /当前先调用 emergence_analyze/);
  assert.doesNotMatch(fresh, /完整目标|user-specific-boundary-xyz/);
});

test('master tool menu hides implementation before first model step and restores it in independent mode', async () => {
  const f = await setup();
  const menus: string[][] = [];
  try {
    let registeredLate = false;
    f.ctx.on('agent/inbox/claimed', () => {
      if (registeredLate) return;
      registeredLate = true;
      f.ctx.tools.register(
        defineTool({
          name: 'late_mutation',
          description: 'Registered after the coordinator menu is installed',
          parameters: {},
          output: { schema: { type: 'string' }, render: (_a, value) => [{ type: 'text', text: value }] },
          execute: async () => 'changed',
        }),
      );
    });
    f.ctx.effect(() =>
      f.ctx.tools.register(
        defineTool({
          name: 'todo_write',
          description: 'Update the current conversation checklist',
          parameters: {},
          output: { schema: { type: 'string' }, render: (_a, value) => [{ type: 'text', text: value }] },
          execute: async () => 'updated',
        }),
      ),
    );
    f.provider.stream = async function* (options): AsyncIterable<StreamChunk> {
      menus.push((options.tools ?? []).map((tool) => tool.name));
      yield { type: 'finish', reason: { kind: 'stop' } };
    };
    await f.w.send(f.main.id, '实现说明文件');
    await f.c.agent.whenIdle();
    assert.ok(menus.length > 0);
    assert.ok(menus.every((menu) => !menu.includes('write')));
    assert.ok(
      menus.every((menu) => !menu.includes('late_mutation')),
      'late global tools cannot bypass the coordinator restriction',
    );
    assert.ok(
      menus.every((menu) => !menu.includes('todo_write')),
      'metadata is not automatically a coordinator tool',
    );
    assert.ok(!menus[0].includes('emergence_plan_work'), 'intake does not expose the work-plan schema');
    assert.ok(menus.every((menu) => !menu.includes('emergence_code_work')));
    assert.ok(menus.every((menu) => !menu.includes('emergence_code_restore')));
    assert.ok(menus.every((menu) => !menu.includes('emergence_data_analyze')));
    f.w.collaboration.independent();
    menus.length = 0;
    await f.w.send(f.main.id, '什么是说明文件');
    await f.c.agent.whenIdle();
    assert.ok(menus[0].includes('write'));
    assert.ok(menus[0].includes('late_mutation'));
    assert.ok(menus[0].includes('todo_write'), 'independent sessions retain their checklist');
    assert.ok(menus[0].includes('emergence_code_work'), 'scoped execution tools return in independent mode');
  } finally {
    await f.close();
  }
});

for (const partialCall of [false, true])
  test(`coordinator stops a truncated ${partialCall ? 'tool call' : 'reasoning-only response'} without generic continuation or effects`, async () => {
    const f = await setup();
    let requests = 0;
    try {
      f.provider.stream = async function* (): AsyncIterable<StreamChunk> {
        requests++;
        if (partialCall) {
          yield { type: 'block-start', index: 0, blockType: 'tool-call' };
          yield {
            type: 'tool-call-delta',
            index: 0,
            id: ToolCallId('truncated'),
            name: 'emergence_analyze',
            argumentsDelta: '{"objective":',
          };
        } else {
          yield { type: 'block-start', index: 0, blockType: 'reasoning' };
          yield { type: 'reasoning-delta', index: 0, text: 'fixture reasoning' };
          yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'fixture reasoning' } };
        }
        yield { type: 'finish', reason: { kind: 'max-tokens' } };
      };
      await f.w.send(f.main.id, '实现两个说明文件');
      await f.c.agent.whenIdle();
      assert.equal(requests, 1, 'max-tokens must not spend the remaining planning budget on a generic nudge');
      assert.match(f.c.planning.intake()!.autonomy!.reason!, /输出额度耗尽/);
      assert.match(f.c.lastError!, /输出额度耗尽/);
      assert.match(f.c.diagnostics.snapshot!.reason!, /输出额度耗尽/);
      assert.equal(f.c.planning.intake()!.autonomy!.nudges, 0);
      assert.equal(f.w.collaboration.state.tasks.length, 0);
      assert.equal(f.writes(), 0);
      // A previous truncated finish cannot contaminate a later user turn.
      f.provider.stream = async function* (): AsyncIterable<StreamChunk> {
        yield* call('emergence_decide', { action: 'answer', reason: '直接事实问答' });
      };
      let followup = 0;
      const answer = f.provider.stream;
      f.provider.stream = async function* (request): AsyncIterable<StreamChunk> {
        if (followup++ === 0) yield* answer.call(this, request);
        else yield { type: 'finish', reason: { kind: 'stop' } };
      };
      await f.w.send(f.main.id, '你好');
      await f.c.agent.whenIdle();
      assert.equal(f.c.planning.intake()!.autonomy!.decision, 'answer');
    } finally {
      await f.close();
    }
  });
