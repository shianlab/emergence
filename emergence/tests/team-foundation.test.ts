import { ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { HistoricalOrchestrationWorkspace as WorkspaceController } from './fixtures/historical-orchestration.ts';
import { PlanStore, planScope } from '../src/core/storage/plan-store.ts';
import { executionFixture, until } from './fixtures/core-execution.ts';

test('live team distinguishes model/project, permission, role preference and changing membership', async () => {
  const f = await executionFixture();
  try {
    const main = f.w.current;
    const project = join(f.home, 'second-project');
    await mkdir(project);
    f.w.launch.appConfig.models.push({ ...f.config.models[0], id: 'other', model: 'different-model' });
    f.ctx.effect(() => f.ctx.llm.registerAdapter(['other'], f.provider));
    const worker = await f.w.split('row', project, 'other');
    await f.w.setMaster(main.id);
    assert.equal(f.w.team.records.length, 0, 'selecting a master does not replay chat or create work');
    await f.w.team.setPreference(worker.id, 'reviewer');
    worker.controller!.setPermissionMode('plan');
    const snapshot = await f.w.team.snapshot(),
      member = snapshot.members.find((p) => p.id === worker.id)!;
    assert.equal(member.project, project);
    assert.equal(member.model, 'other');
    assert.equal(member.preference, 'reviewer');
    assert.equal(member.permission?.mode, 'plan');
    assert.equal(member.dispatchable, true);
    assert.equal(member.capabilities.find((c) => c.id === 'tool:write')?.callable, false);
    assert.ok(member.capabilities.every((c) => !c.verified));
    await assert.rejects(f.w.team.setPreference(worker.id, 'invented'), /角色不存在/);
    await assert.rejects(f.w.send(main.id, '/team'), /已移除/);
    assert.match(await f.w.team.describe(), /second-project/);
    f.w.collaboration.takeover(worker.id);
    assert.equal(f.w.team.roster().find((p) => p.id === worker.id)?.state, 'human-controlled');
    assert.equal(f.w.team.roster().find((p) => p.id === worker.id)?.queueable, false);
    f.w.collaboration.release(worker.id);
    const extra = await f.w.split('column');
    assert.equal(f.w.team.roster().find((p) => p.id === extra.id)?.queueable, true);
    await f.w.send(extra.id, '/close');
    assert.ok(!f.w.team.roster().some((p) => p.id === extra.id));
    f.w.collaboration.pause(true);
    assert.ok(f.w.team.roster().every((p) => !p.queueable));
  } finally {
    await f.close();
  }
});

test('an independent busy worker is not assignable and becomes available after its own turn', async () => {
  const f = await executionFixture();
  let release: (() => void) | undefined;
  try {
    const main = f.w.current,
      worker = await f.w.split('row');
    await f.w.setMaster(main.id);
    f.provider.stream = async function* (): AsyncIterable<StreamChunk> {
      await new Promise<void>((done) => {
        release = done;
      });
      yield { type: 'finish', reason: { kind: 'stop' } };
    };
    await f.w.send(worker.id, '解释闭包');
    await until(() => !!release);
    const member = f.w.team.roster().find((p) => p.id === worker.id)!;
    assert.equal(member.state, 'busy');
    assert.equal(member.queueable, false);
    assert.equal(
      main.controller!.planning.environment!().windows.find((w) => w.id === worker.id)?.dispatchable,
      false,
    );
    assert.equal(f.w.team.records.length, 0, 'worker input is not a new master objective');
    release!();
    await worker.controller!.agent.whenIdle();
    assert.equal(f.w.team.roster().find((p) => p.id === worker.id)?.dispatchable, true);
  } finally {
    release?.();
    await f.close();
  }
});

test('native accepted input is deduplicated; clarification stays attached; new objective gets a new record', async () => {
  const f = await executionFixture();
  try {
    const main = f.w.current;
    await f.w.split('row');
    await f.w.setMaster(main.id);
    let n = 0,
      clarify = true;
    f.provider.stream = async function* (): AsyncIterable<StreamChunk> {
      if (n++) {
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }
      const id = ToolCallId('analysis-' + clarify),
        name = 'emergence_analyze',
        raw = JSON.stringify({
          objective: '规划登录体验',
          reason: '确定使用人群',
          route: 'planned',
          intent: clarify ? 'clarify' : 'discuss',
          constraints: ['只讨论'],
          acceptance: ['方案说明清楚'],
          questions: clarify ? ['面向谁？'] : [],
        });
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: raw };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: raw } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    };
    await f.w.send(main.id, '整体规划登录体验');
    await main.controller!.agent.whenIdle();
    const original = f.w.team.records[0];
    assert.ok(original);
    assert.equal(original.phase, 'waiting-input');
    assert.equal(original.teamAtIntake.length, 2);
    const store = new PlanStore(f.home);
    await main.controller!.planning.settle();
    const state = (await store.read(planScope(main.controller!.id!, main.cwd)))!;
    f.w.team.sync(main.id, state);
    f.w.team.sync(main.id, state);
    assert.equal(f.w.team.records.length, 1);
    clarify = false;
    n = 0;
    await f.w.send(main.id, '面向首次使用者，只讨论');
    await main.controller!.agent.whenIdle();
    assert.equal(f.w.team.records.length, 1);
    assert.equal(f.w.team.records[0].id, original.id);
    assert.equal(f.w.team.records[0].requestIds.length, 2);
    assert.equal(f.w.team.records[0].phase, 'discussion');
    assert.deepEqual(f.w.team.records[0].teamAtIntake, original.teamAtIntake);
    assert.match(f.w.team.records[0].request, /用户补充/);
    await f.w.send(main.id, '规划搜索功能');
    await main.controller!.agent.whenIdle();
    assert.equal(f.w.team.records.length, 2);
    assert.equal(f.w.collaboration.state.tasks.length, 0);
    const saved = f.w.collaboration.journal.load() as { coordinations: unknown[] };
    assert.equal(saved.coordinations.length, 2);
  } finally {
    await f.close();
  }
});

test('restart restores preferences and durable intake paused without running or duplicating old objectives', async () => {
  const f = await executionFixture();
  let restored: WorkspaceController | undefined;
  try {
    const main = f.w.current,
      worker = await f.w.split('row');
    await f.w.setMaster(main.id);
    await f.w.team.setPreference(worker.id, 'developer');
    await f.w.send(main.id, '规划一个登录模块');
    await main.controller!.agent.whenIdle();
    const ids = f.w.team.records.map((r) => r.id);
    assert.equal(ids.length, 1);
    await f.w.save();
    const disk = JSON.parse(await readFile(f.w.path, 'utf8'));
    assert.equal(disk.panes.find((p: { id: string }) => p.id === worker.id).rolePreference, 'developer');
    const calls = f.provider.calls;
    await f.w.close();
    restored = new WorkspaceController(f.ctx, f.launch);
    await restored.initialize();
    assert.equal(restored.team.active, false);
    assert.ok(restored.team.roster().every((p) => !p.queueable));
    assert.equal(f.provider.calls, calls);
    assert.deepEqual(
      restored.team.records.map((r) => r.id),
      ids,
    );
    assert.equal(restored.panes.get(worker.id)?.rolePreference, 'developer');
    await restored.setMaster(main.id);
    assert.equal(restored.team.active, true);
    assert.equal(f.provider.calls, calls);
    assert.deepEqual(
      restored.team.records.map((r) => r.id),
      ids,
    );
  } finally {
    await restored?.close();
    await f.close();
  }
});

test('intake persistence failure rolls back coordination and prevents the model turn', async () => {
  const f = await executionFixture();
  const original = f.w.collaboration.checkpoint.bind(f.w.collaboration);
  try {
    const main = f.w.current;
    await f.w.split('row');
    await f.w.setMaster(main.id);
    await f.w.save();
    f.w.collaboration.checkpoint = () => {
      throw new Error('fixture journal failure');
    };
    await f.w.send(main.id, '规划整个功能');
    await main.controller!.agent.whenIdle();
    assert.equal(f.w.team.records.length, 0);
    assert.equal(f.provider.calls, 0);
    assert.equal(f.writes(), 0);
  } finally {
    f.w.collaboration.checkpoint = original;
    await f.close();
  }
});

test('team query runs as a real read-only Harness tool in Plan mode without approval or task creation', async () => {
  const f = await executionFixture();
  try {
    const main = f.w.current;
    await f.w.split('row');
    await f.w.setMaster(main.id);
    main.controller!.setPermissionMode('plan');
    let n = 0;
    f.provider.stream = async function* (): AsyncIterable<StreamChunk> {
      if (n++) {
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }
      const id = ToolCallId('team-query'),
        name = 'emergence_team',
        raw = '{}';
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: raw };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: raw } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    };
    await f.w.send(main.id, '解释当前窗口能力');
    await main.controller!.agent.whenIdle();
    const result = main
      .controller!.agent.session.snapshotEvents()
      .find((e) => e.type === 'tool/result' && e.data.message.source.callId === 'team-query');
    assert.ok(result?.type === 'tool/result');
    assert.ok(!result.data.message.isError);
    const content = result.data.message.content.find((b) => b.type === 'text');
    assert.ok(content?.type === 'text');
    const page = JSON.parse(content.text);
    assert.equal(page.members.length, 2);
    assert.ok(
      page.members.every(
        (member: { capabilities: unknown[]; capabilitiesPageOnly: boolean }) =>
          member.capabilitiesPageOnly && member.capabilities.every((id) => typeof id === 'string'),
      ),
    );
    assert.ok(!content.text.includes('capabilityFacts'));
    assert.ok(content.text.length < 20000, 'team query uses the same compact capability projection');
    assert.ok(!main.controller!.pending);
    assert.equal(f.w.team.records.length, 0);
    assert.equal(f.w.collaboration.state.tasks.length, 0);
  } finally {
    await f.close();
  }
});

test('busy assigned worker can queue work and preference changes never rewrite its existing contract', async () => {
  const f = await executionFixture();
  let release: (() => void) | undefined;
  try {
    const main = f.w.current,
      worker = await f.w.split('row');
    await f.w.setMaster(main.id);
    main.controller!.setPermissionMode('auto');
    f.provider.stream = async function* (): AsyncIterable<StreamChunk> {
      await new Promise<void>((done) => {
        release = done;
      });
      yield { type: 'finish', reason: { kind: 'stop' } };
    };
    const task = await f.w.collaboration.enqueue(main.id, worker.id, 'role-freeze', '处理 result.txt', [], {
      role: 'developer',
      scope: ['result.txt'],
      acceptance: ['内容正确'],
    });
    await until(() => !!release);
    const member = f.w.team.roster().find((p) => p.id === worker.id)!;
    assert.equal(member.queueable, true);
    assert.equal(member.dispatchable, false);
    assert.equal(member.assignedRole, 'developer');
    await f.w.team.setPreference(worker.id, 'reviewer');
    assert.equal(task.contract?.role, 'developer');
    assert.equal(task.role?.id, 'developer');
    release!();
    await worker.controller!.agent.whenIdle();
  } finally {
    release?.();
    await f.close();
  }
});

test('a permission change during capability lookup discards the stale window facts', async () => {
  const f = await executionFixture();
  try {
    const main = f.w.current,
      worker = await f.w.split('row');
    await f.w.setMaster(main.id);
    const original = main.controller!.planning.inventory.bind(main.controller!.planning);
    main.controller!.planning.inventory = async () => {
      const inventory = await original();
      worker.controller!.setPermissionMode('plan');
      return inventory;
    };
    const data = await f.w.team.snapshot();
    assert.deepEqual(data.members.find((p) => p.id === worker.id)?.capabilities, []);
    assert.ok(data.diagnostics.some((line) => line.includes('丢弃旧能力')));
  } finally {
    await f.close();
  }
});
