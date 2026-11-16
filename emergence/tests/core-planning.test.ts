import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import Skills from '@deepseek-ai/dsh-skill';
import { defineTool } from '@deepseek-ai/dsh-tools';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { SessionController } from '../src/app/controller.ts';
import { HistoricalOrchestrationWorkspace as WorkspaceController } from './fixtures/historical-orchestration.ts';
import { defaultConfig } from '../src/core/domain/configuration.ts';
import {
  planSchema,
  routeRequest,
  validatePlan,
  type Inventory,
  type PlanningState,
  type TaskPlan,
} from '../src/core/domain/planning.ts';
import { digest } from '../src/core/storage/execution-journal.ts';
import { PlanStore, planScope } from '../src/core/storage/plan-store.ts';
import { harness } from './fixtures/harness.ts';
import { propose } from './fixtures/plan-proposal.ts';

type Action = { name: string; args?: object } | undefined;
class Provider extends LlmAdapter {
  captured: GenerateOptions[] = [];
  action: (index: number, options: GenerateOptions) => Promise<Action> | Action = () => undefined;
  async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, defaultMaxTokens: 2048 };
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const index = this.captured.length;
    this.captured.push(options);
    const action = await this.action(index, options);
    if (action) {
      const id = ToolCallId('receipt-' + index),
        raw = JSON.stringify(action.args ?? {});
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id, name: action.name, argumentsDelta: raw };
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id, name: action.name, arguments: raw },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: '本轮结束' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '本轮结束' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
}
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'emergence-planner-')),
    cwd = join(home, 'project');
  await mkdir(cwd);
  const provider = new Provider(),
    ctx = await harness(home, ['deepseek'], provider),
    config = structuredClone(defaultConfig);
  config.models[0].apiKeyEnv = 'EMERGENCE_PLANNER_TEST';
  const before = process.env.EMERGENCE_PLANNER_TEST;
  process.env.EMERGENCE_PLANNER_TEST = 'fixture-only';
  const calls: string[] = [];
  for (const name of ['read', 'write'])
    ctx.effect(() =>
      ctx.tools.register(
        defineTool({
          name,
          description: 'inert local fixture',
          parameters: { file_path: { type: 'string' }, content: { type: 'string' } },
          output: { schema: { type: 'string' }, render: (_a, value) => [{ type: 'text', text: value }] },
          async execute() {
            calls.push(name);
            return 'fixture source';
          },
        }),
      ),
    );
  const w = new WorkspaceController(ctx, { home, cwd, modelId: 'deepseek', appConfig: config });
  await w.initialize();
  const c = w.current.controller!;
  return {
    home,
    cwd,
    ctx,
    config,
    provider,
    w,
    c,
    calls,
    async run(text = '请规划并重构这个项目，然后验证') {
      await c.send(text);
      await c.agent.whenIdle();
      assert.equal(c.lastError, undefined);
    },
    async close() {
      await w.close();
      await ctx.fiber.dispose();
      if (before === undefined) delete process.env.EMERGENCE_PLANNER_TEST;
      else process.env.EMERGENCE_PLANNER_TEST = before;
    },
  };
}
function makePlan(i: Inventory, evidence: string[] = []): TaskPlan {
  const w = i.windows.find((w) => w.id === i.currentWindow)!;
  return {
    objective: '修复项目并验证',
    constraints: ['仅当前项目'],
    acceptance: ['相关检查通过'],
    nonGoals: ['不发布'],
    unknowns: [],
    assumptions: [],
    options: [{ name: '最小修改', tradeoff: '保留现有框架' }],
    conflicts: [],
    reason: '减少无关改动',
    evidence,
    steps: [
      {
        id: 'fix',
        objective: '修改并检查',
        window: w.id,
        session: w.session,
        project: w.project,
        model: w.model,
        role: 'developer',
        capabilities: ['tool:write'],
        dependsOn: [],
        scope: ['当前项目'],
        acceptance: ['相关检查通过'],
      },
    ],
  };
}
const results = (c: SessionController) =>
  c.agent.session.snapshotEvents().flatMap((e) => (e.type === 'tool/result' ? [e.data.message] : []));

test('routing keeps simple questions and specific fixes light; plans reject invented bindings, cycles and evidence', () => {
  assert.equal(routeRequest('你好').route, 'direct');
  assert.equal(routeRequest('修复 app.ts 中的拼写错误').route, 'focused');
  assert.equal(routeRequest('什么是 Agent 架构？').route, 'direct');
  assert.equal(routeRequest('解释架构并规划修改').route, 'planned');
  assert.equal(routeRequest('规划两个不同项目的实现').route, 'planned');
  const i: Inventory = {
    mode: 'independent',
    currentWindow: 'p',
    diagnostics: [],
    windows: [
      { id: 'p', session: 's', project: 'p', model: 'm', dispatchable: false, capabilities: ['tool:write'] },
    ],
    capabilities: ['tool:write', 'model:m', 'role:developer'].map((id) => ({
      id,
      kind: 'tool',
      registered: true,
      connected: null,
      callable: true,
      verified: false,
      detail: '',
    })),
  };
  const p = makePlan(i, ['r']);
  assert.deepEqual(validatePlan(p, i, [{ id: 'r', tool: 'read', read: true }]), []);
  p.steps[0].dependsOn = ['fix'];
  p.steps[0].capabilities.push('tool:invented');
  p.steps[0].session = 'stale';
  const issues = validatePlan(p, i, []);
  assert.ok(issues.some((v) => v.includes('成环')));
  assert.ok(issues.some((v) => v.includes('失效')));
  assert.ok(issues.some((v) => v.includes('不可调用')));
  assert.ok(issues.some((v) => v.includes('证据')));
  assert.equal(planSchema.safeParse({ ...p, grant: 'auto' }).success, false);
});

test('actual Harness blocks premature writes, discovers real capabilities, reads, validates plan, then executes under original permissions', async () => {
  const f = await fixture();
  try {
    f.provider.action = async (n) => {
      if (n === 0 || n === 4) return { name: 'write', args: { file_path: 'result.txt', content: 'x' } };
      if (n === 1) return { name: 'emergence_capabilities' };
      if (n === 2) return { name: 'read', args: { file_path: 'source.ts' } };
      if (n === 3)
        return {
          name: 'emergence_plan',
          args: { plan_json: JSON.stringify(makePlan(await f.c.planning.inventory(), ['receipt-2'])) },
        };
    };
    await f.run();
    assert.deepEqual(f.calls, ['read', 'write']);
    assert.equal(results(f.c)[0].isError, true);
    assert.ok((await f.c.planning.describe()).includes('方案已检查'));
    assert.ok(
      f.provider.captured.slice(1).every((o) => JSON.stringify(o.messages).includes('Emergence 内置规划')),
    );
    const inventory = await f.c.planning.inventory();
    assert.ok(inventory.capabilities.find((c) => c.id === 'tool:read')!.verified);
    assert.equal(inventory.capabilities.find((c) => c.id === 'model:deepseek')!.verified, false);
    assert.equal(inventory.capabilities.find((c) => c.id === 'method:meta-conductor')!.callable, false);
    await f.w.send(f.w.focused, '/plan');
    assert.ok(f.w.overlay.includes('不发布'));
    await f.w.send(f.w.focused, '/capabilities');
    assert.ok(f.w.overlay.includes('注册 ≠ 连接'));
    await f.c.planning.settle();
    const saved = await new PlanStore(f.home).read(planScope(f.c.id!, f.cwd));
    assert.equal(saved?.status, 'ready');
    const oldId = f.c.id!;
    await f.w.close();
    const restored = new SessionController(f.ctx, {
      home: f.home,
      cwd: f.cwd,
      modelId: 'deepseek',
      appConfig: f.config,
    });
    try {
      await restored.open(oldId);
      assert.ok((await restored.planning.describe()).includes('修复项目并验证'));
    } finally {
      await restored.close();
    }
  } finally {
    await f.close();
  }
});

test('simple and focused requests take one model request; complex unknowns and capability gaps cannot allow writes', async () => {
  const f = await fixture();
  try {
    await f.run('你好');
    await f.run('修复 app.ts 的拼写错误');
    assert.equal(f.provider.captured.length, 2);
    assert.ok(!JSON.stringify(f.provider.captured[0].messages).includes('Emergence 内置规划'));
    f.provider.action = async (n) => {
      if (n === 2) {
        const p = makePlan(await f.c.planning.inventory());
        p.steps[0].capabilities = [];
        p.unknowns = [{ question: '需要处理哪个项目？', impact: 'route', blocking: true }];
        return { name: 'emergence_plan', args: { plan_json: JSON.stringify(p) } };
      }
      if (n === 3) return { name: 'write', args: { file_path: 'x' } };
    };
    await f.run('帮我规划一个应用');
    assert.ok(
      (await f.c.planning.describe()).includes('需要关键补充'),
      JSON.stringify({ description: await f.c.planning.describe(), results: results(f.c) }),
    );
    assert.deepEqual(f.calls, []);
    f.provider.action = async (n) => {
      if (n === 5) {
        const p = makePlan(await f.c.planning.inventory());
        p.steps[0].capabilities = ['mcp-tool:missing'];
        return { name: 'emergence_plan', args: { plan_json: JSON.stringify(p) } };
      }
      if (n === 6) return { name: 'write', args: { file_path: 'x' } };
    };
    await f.run('就是当前项目');
    assert.ok((await f.c.planning.describe()).includes('能力不可调用'));
    assert.deepEqual(f.calls, []);
    await f.c.planning.settle();
    const saved = await new PlanStore(f.home).read(planScope(f.c.id!, f.cwd));
    assert.ok(saved!.request.includes('帮我规划一个应用'));
    assert.ok(saved!.request.includes('当前项目'));
  } finally {
    await f.close();
  }
});

test('research and malformed-plan retries are bounded; denied reads cannot become evidence', async () => {
  const f = await fixture();
  try {
    f.c.launch.appConfig.core.planning.researchCalls = 1;
    f.c.launch.appConfig.core.planning.revisions = 1;
    f.provider.action = (n) =>
      n < 2
        ? { name: 'read', args: { file_path: 'source.ts' } }
        : n < 4
          ? { name: 'emergence_plan', args: { plan_json: '{}' } }
          : undefined;
    await f.run();
    assert.deepEqual(f.calls, ['read']);
    assert.equal(results(f.c).filter((r) => r.isError).length, 3);
    const i = await f.c.planning.inventory();
    const p = makePlan(i, ['receipt-1']);
    assert.ok(
      validatePlan(p, i, [{ id: 'receipt-0', tool: 'read', read: true }]).some((v) => v.includes('证据')),
    );
    await f.c.planning.settle();
    const s = await new PlanStore(f.home).read(planScope(f.c.id!, f.cwd));
    assert.equal(s!.attempts, 1);
    assert.equal(s!.research, 1);
  } finally {
    await f.close();
  }
});

test('multi-project plans bind real window identities; independent mode and inherited plan permission remain authoritative', async () => {
  const f = await fixture();
  try {
    const other = join(f.home, 'other');
    await mkdir(other);
    const p2 = await f.w.split('row');
    await f.w.send(p2.id, '/project ' + JSON.stringify(other));
    let i = await f.c.planning.inventory(),
      p = makePlan(i);
    const target = i.windows.find((w) => w.id === p2.id)!;
    p.steps[0] = {
      ...p.steps[0],
      window: target.id,
      session: target.session,
      project: target.project,
      model: target.model,
      capabilities: [],
    };
    assert.ok(validatePlan(p, i, []).some((v) => v.includes('不能派发')));
    f.w.collaboration.configure(i.currentWindow, [p2.id]);
    i = await f.c.planning.inventory();
    assert.deepEqual(validatePlan(p, i, []), []);
    f.c.permissionConstraints = () => [{ ...f.c.permissionSnapshot(), mode: 'plan' }];
    i = await f.c.planning.inventory();
    assert.ok(!i.windows.find((w) => w.id === i.currentWindow)!.capabilities.includes('tool:write'));
    f.provider.action = (n) => (n === 0 ? { name: 'write', args: { file_path: 'x' } } : undefined);
    await f.run();
    assert.deepEqual(f.calls, []);
    const current = await f.c.planning.describe(),
      second = await f.w.panes.get(p2.id)!.controller!.planning.describe();
    assert.ok(current.includes('结构化规划'));
    assert.ok(second.includes('尚未提交任务'));
  } finally {
    await f.close();
  }
});

test('queued followups do not replace the active goal before admission; a new direct task persists removal of the old plan', async () => {
  const f = await fixture();
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>((r) => {
      entered = r;
    }),
    held = new Promise<void>((r) => {
      release = r;
    });
  try {
    f.provider.action = async (n) => {
      if (n === 0) {
        entered();
        await held;
      }
      return undefined;
    };
    await f.c.send('规划一个应用');
    await ready;
    await f.c.send('你好');
    assert.ok((await f.c.planning.describe()).includes('结构化规划'));
    release();
    await f.c.agent.whenIdle();
    assert.ok((await f.c.planning.describe()).includes('直接处理'));
    await f.c.planning.settle();
    assert.equal((await new PlanStore(f.home).read(planScope(f.c.id!, f.cwd)))!.route, 'direct');
  } finally {
    release();
    await f.close();
  }
});

test('capability inventory honors live activation, model-invocable skills and actual MCP connect/disconnect', async () => {
  const f = await fixture();
  try {
    await f.ctx.plugin(Skills);
    for (const [name, modelInvocable] of [
      ['local-proof', true],
      ['human-only', false],
    ] as const)
      f.ctx.effect(() =>
        f.ctx.skills.register({
          name,
          description: 'fixture',
          source: 'runtime',
          content: 'fixture',
          invocation: { modelInvocable, userInvocable: true },
        }),
      );
    f.ctx.effect(() =>
      f.ctx.tools.register(
        defineTool({
          name: 'skill',
          description: 'fixture loader',
          parameters: {},
          output: { schema: { type: 'string' }, render: (_a, value) => [{ type: 'text', text: value }] },
          async execute() {
            return 'fixture';
          },
        }),
      ),
    );
    let i = await f.c.planning.inventory();
    assert.equal(i.capabilities.find((c) => c.id === 'tool:emergence_dispatch')?.callable, false);
    assert.equal(i.capabilities.find((c) => c.id === 'skill:local-proof')?.callable, true);
    assert.equal(i.capabilities.find((c) => c.id === 'skill:human-only')?.callable, false);
    const server = {
      serverName: 'planproof',
      transport: 'stdio' as const,
      command: process.execPath,
      args: [resolve('tests/fixtures/mcp.cjs')],
      enabled: true,
    };
    f.w.launch.appConfig.mcp.push(server);
    await f.w.capabilities.enable(server);
    i = await f.c.planning.inventory();
    assert.equal(i.capabilities.find((c) => c.id === 'mcp:planproof')?.connected, true);
    assert.equal(i.capabilities.find((c) => c.id === 'mcp-tool:mcp__planproof__echo')?.callable, true);
    assert.equal(i.capabilities.find((c) => c.id === 'mcp-tool:mcp__planproof__echo')?.verified, false);
    await f.w.capabilities.disable('planproof');
    i = await f.c.planning.inventory();
    assert.equal(i.capabilities.find((c) => c.id === 'mcp:planproof')?.connected, false);
    assert.equal(
      i.capabilities.some((c) => c.id === 'mcp-tool:mcp__planproof__echo'),
      false,
    );
  } finally {
    await f.close();
  }
});

test('a ready plan cannot bypass later permission changes or stale worker bindings', async () => {
  const f = await fixture();
  try {
    f.provider.action = async (n) => {
      if (n === 0) return { name: 'read', args: { file_path: 'source.ts' } };
      if (n === 1)
        return {
          name: 'emergence_plan',
          args: { plan_json: JSON.stringify(makePlan(await f.c.planning.inventory(), ['receipt-0'])) },
        };
      if (n === 2) {
        f.c.setPermissionMode('plan');
        return { name: 'write', args: { file_path: 'x' } };
      }
    };
    await f.run();
    assert.deepEqual(f.calls, ['read']);
    assert.equal(results(f.c).at(-1)!.isError, true);
    f.c.setPermissionMode('edit');
    const worker = await f.w.split('row');
    f.w.collaboration.configure([...f.w.panes.keys()][0], [worker.id]);
    // Exercise the explicit/manual plan API independently of automatic master admission.
    const environment = f.c.planning.environment!;
    f.c.planning.environment = () => ({ ...environment(), coordinating: false });
    f.provider.action = async (n) => {
      if (n === 4) return { name: 'read', args: { file_path: 'source.ts' } };
      if (n === 5) {
        const i = await f.c.planning.inventory(),
          p = makePlan(i, ['receipt-4']),
          w = i.windows.find((w) => w.id === worker.id)!;
        p.steps.push({
          ...p.steps[0],
          id: 'worker',
          window: w.id,
          session: w.session,
          model: w.model,
          project: w.project,
          capabilities: ['tool:read'],
          role: 'researcher',
        });
        return { name: 'emergence_plan', args: { plan_json: JSON.stringify(p) } };
      }
      if (n === 6) {
        await worker.controller!.open();
        return {
          name: 'emergence_execute_plan',
          args: { plan_id: 'stale-binding-must-be-rejected-before-execution' },
        };
      }
    };
    await f.run('重新规划多个窗口的任务');
    assert.deepEqual(f.calls, ['read', 'read']);
    assert.ok(JSON.stringify(results(f.c).at(-1)).includes('已变化'));
  } finally {
    await f.close();
  }
});

test('accepted multi-window plans dispatch through the existing scheduler without a second execution loop', async () => {
  const f = await fixture();
  try {
    const worker = await f.w.split('row'),
      master = [...f.w.panes.keys()][0];
    await worker.controller!.send('规划以前的个人任务');
    await worker.controller!.agent.whenIdle();
    assert.ok((await worker.controller!.planning.describe()).includes('结构化规划'));
    f.provider.captured = [];
    f.w.collaboration.configure(master, [worker.id]);
    // A host may use manual plan submission; automatic master flow is tested separately.
    const environment = f.c.planning.environment!;
    f.c.planning.environment = () => ({ ...environment(), coordinating: false });
    f.provider.action = async (n) => {
      if (n === 0) return { name: 'read', args: { file_path: 'source.ts' } };
      if (n === 1) {
        const i = await f.c.planning.inventory(),
          p = makePlan(i, ['receipt-0']),
          w = i.windows.find((w) => w.id === worker.id)!;
        p.steps[0] = {
          ...p.steps[0],
          window: w.id,
          session: w.session,
          project: w.project,
          model: w.model,
          capabilities: ['tool:read'],
          role: 'researcher',
        };
        return { name: 'emergence_plan', args: { plan_json: JSON.stringify(p) } };
      }
      if (n === 2)
        return {
          name: 'emergence_execute_plan',
          args: { plan_id: digest(f.c.planning.state(f.c.agent).value.plan!) },
        };
    };
    await f.run('规划并派发多窗口读取任务');
    for (
      let n = 0;
      n < 100 && !f.w.collaboration.state.tasks.some((t) => ['needs_review', 'failed'].includes(t.status));
      n++
    )
      await delay(10);
    const task = f.w.collaboration.state.tasks[0];
    assert.ok(task);
    assert.equal(task.target, worker.id);
    assert.equal(task.status, 'needs_review');
    assert.equal(task.contract?.role, 'researcher');
    assert.equal(task.targetSession, worker.controller!.id);
    assert.equal(f.w.collaboration.state.tasks.length, 1);
    assert.ok((await worker.controller!.planning.describe()).includes('已接到主控任务'));
  } finally {
    await f.close();
  }
});

test('planning storage rejects corruption, wrong scope and junctions without overwriting source files', async () => {
  const home = await mkdtemp(join(tmpdir(), 'emergence-plan-store-')),
    store = new PlanStore(home),
    scope = planScope('s', 'p');
  const state: PlanningState = {
    version: 2,
    scope,
    requestIds: [],
    request: '目标',
    route: 'planned',
    routeReason: '测试',
    attempts: 0,
    research: 0,
    receipts: [],
    status: 'draft',
    issues: [],
  };
  await store.write(state);
  assert.deepEqual(await store.read(scope), state);
  const file = join(home, 'core', 'plans', scope + '.json');
  await writeFile(file, '{broken');
  await assert.rejects(store.read(scope));
  assert.equal(await readFile(file, 'utf8'), '{broken');
  const linked = await mkdtemp(join(tmpdir(), 'emergence-plan-link-'));
  await symlink(home, join(linked, 'core'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(new PlanStore(linked).write(state));
  await assert.rejects(store.read('../escape'));
});

test('only admitted user input changes requirement provenance; failed revisions do not reset budgets', async () => {
  const f = await fixture();
  try {
    const analysis = {
      objective: '修复项目',
      reason: '用户要求实施',
      intent: 'execute' as const,
      constraints: ['不发布'],
      acceptance: ['检查通过'],
      route: 'planned' as const,
    };
    let remaining = 2;
    f.provider.action = () => (remaining-- > 0 ? { name: 'emergence_analyze', args: analysis } : undefined);
    const input = '请规划并修复项目，不发布，并检查结果';
    await f.run(input);
    const runtime = f.c.planning.state(f.c.agent),
      first = structuredClone(runtime.value.requirements!);
    assert.equal(first.source.hash, createHash('sha256').update(input).digest('hex'));
    assert.match(JSON.stringify(results(f.c)), /已有目标分析/);
    const candidate = makePlan(await f.c.planning.inventory());
    candidate.steps[0].capabilities = [];
    const work = propose(candidate, first);
    await f.c.planning.submit(f.c.agent, work, new AbortController().signal);
    const invalid = { ...work, requirementRevision: 'f'.repeat(64) };
    await assert.rejects(
      f.c.planning.submit(f.c.agent, invalid, new AbortController().signal),
      /STALE_REQUIREMENTS/,
    );
    assert.equal(runtime.value.attempts, 2);
    assert.deepEqual(runtime.value.requirements, first);
    remaining = 1;
    await f.run('继续完成原任务');
    const second = runtime.value.requirements!;
    assert.notEqual(second.revision, first.revision);
    assert.equal(second.source.previousRevision, first.revision);
    assert.deepEqual(second.source.origin, { messageIds: first.source.messageIds, hash: first.source.hash });
    assert.ok(first.source.messageIds.every((id) => second.source.messageIds.includes(id)));
    await assert.rejects(
      f.c.planning.submit(f.c.agent, work, new AbortController().signal),
      /STALE_REQUIREMENTS/,
    );
    assert.equal(runtime.value.attempts, 1);
    await f.c.planning.submit(f.c.agent, propose(candidate, second), new AbortController().signal);
    runtime.value.plan!.constraints = [];
    await assert.rejects(f.c.planning.readyPlan(), /REQUIREMENT_INTEGRITY/);
  } finally {
    await f.close();
  }
});

test('a working-directory change preserves the goal but invalidates old project evidence and bindings', async () => {
  const f = await fixture();
  try {
    const other = join(f.home, 'other');
    await mkdir(other);
    f.provider.action = async (n) => {
      if (n === 0) return { name: 'read', args: { file_path: 'source.ts' } };
      if (n === 1)
        return {
          name: 'emergence_plan',
          args: { plan_json: JSON.stringify(makePlan(await f.c.planning.inventory(), ['receipt-0'])) },
        };
      if (n === 2) {
        await f.ctx.workingDirectory.set(f.c.agent, other);
        return { name: 'write', args: { file_path: 'x' } };
      }
    };
    await f.run();
    assert.deepEqual(f.calls, ['read']);
    assert.ok((await f.c.planning.describe()).includes('目录已变化'));
    await f.c.planning.settle();
    const s = await new PlanStore(f.home).read(planScope(f.c.id!, other));
    assert.equal(s!.status, 'blocked');
    assert.equal(s!.plan!.objective, '修复项目并验证');
    assert.deepEqual(s!.receipts, []);
  } finally {
    await f.close();
  }
});
