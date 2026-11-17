import type { Agent } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PlanningRequests } from '../src/core/application/planning-requests.ts';
import { planningConfigSchema } from '../src/core/domain/planning.ts';
import { PlanStore } from '../src/core/storage/plan-store.ts';

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'emergence-planning-state-'));
  const agent = { session: { id: 'planning-owner' } } as Agent;
  const host = {
    enabled: true,
    config: planningConfigSchema.parse({}),
    directory: home,
    cwd() {
      return this.directory;
    },
    inherited() {
      return false;
    },
    register() {},
    changed() {},
  };
  const state = new PlanningRequests(host, new PlanStore(home));
  const admit = (text: string) =>
    state.admit(agent, [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })]);
  await admit('请规划并重构代码，然后验证');
  return { state, host, agent, admit };
}
const analysis = () => ({
  route: 'planned' as const,
  objective: '重构代码',
  reason: '用户请求实施',
  intent: 'execute' as const,
  constraints: ['不发布'],
  acceptance: ['检查通过'],
});

test('request snapshots, analysis input and admission results cannot mutate authoritative state', async () => {
  const f = await fixture();
  try {
    const input = analysis();
    await f.state.analyze(f.agent, input);
    input.constraints.push('外部修改');
    f.state.view(f.agent)!.value.analysis!.constraints!.push('投影修改');
    const result = await f.state.revise(f.agent, async (draft) => {
      draft.issues = ['建议'];
      return draft;
    });
    result.issues.push('回执修改');
    const current = f.state.view(f.agent)!.value;
    assert.deepEqual(current.analysis!.constraints, ['不发布']);
    assert.deepEqual(current.issues, ['建议']);
  } finally {
    await f.state.close();
  }
});

for (const fail of [false, true])
  test(`late ${fail ? 'failed' : 'successful'} admission cannot replace or block a newer request`, async () => {
    const f = await fixture(),
      entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    try {
      const pending = f.state.revise(f.agent, async (draft) => {
        entered.resolve();
        await release.promise;
        if (fail) throw new Error('old failure');
        draft.status = 'ready';
      });
      const rejected = assert.rejects(pending, /旧规划结果已失效/);
      await entered.promise;
      await f.admit('请分析另一个数据任务，生成结果');
      const current = f.state.view(f.agent);
      release.resolve();
      await rejected;
      assert.deepEqual(f.state.view(f.agent), current);
    } finally {
      release.resolve();
      await f.state.close();
    }
  });

test('directory changes invalidate ready-plan leases and in-flight admission', async () => {
  const f = await fixture(),
    release = Promise.withResolvers<void>(),
    entered = Promise.withResolvers<void>();
  try {
    const lease = await f.state.lease(f.agent);
    const pending = f.state.revise(f.agent, async () => {
      entered.resolve();
      await release.promise;
    });
    const rejected = assert.rejects(pending, /工作目录已变化/);
    await entered.promise;
    f.host.directory = join(f.host.directory, 'other');
    const current = await f.state.read(f.agent);
    assert.equal(current.value.status, 'blocked');
    assert.throws(() => lease.commitExecutions(['old-task']), /工作目录已变化/);
    release.resolve();
    await rejected;
    assert.deepEqual(f.state.view(f.agent), current);
  } finally {
    release.resolve();
    await f.state.close();
  }
});

test('read budgets and successful receipts survive admission; old-request receipts are discarded', async () => {
  const f = await fixture(),
    entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  try {
    f.host.config.researchCalls = 1;
    const pending = f.state.revise(f.agent, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    f.state.observeCall(f.agent, 'read-1');
    const finish = f.state.beginRead(f.agent, 'read-1');
    assert.throws(() => f.state.beginRead(f.agent, 'read-2'), /预算已用完/);
    f.state.recordReceipt(f.agent, 'read-1', 'read', true);
    f.state.finishCall(f.agent, 'read-1');
    finish?.();
    release.resolve();
    await pending;
    assert.equal(f.state.view(f.agent)!.value.research, 1);
    assert.deepEqual(
      f.state.view(f.agent)!.value.receipts.map((r) => r.id),
      ['read-1'],
    );
    f.state.observeCall(f.agent, 'late-read');
    await f.admit('请规划并实施另一个新项目');
    f.state.recordReceipt(f.agent, 'late-read', 'read', true);
    f.state.finishCall(f.agent, 'late-read');
    assert.deepEqual(f.state.view(f.agent)!.value.receipts, []);
  } finally {
    release.resolve();
    await f.state.close();
  }
});

test('execution receipts bind their original request and close rejects late mutations', async () => {
  const f = await fixture();
  const lease = await f.state.lease(f.agent);
  await f.admit('请规划另外一个独立任务');
  assert.throws(() => lease.commitExecutions(['old-task']), /旧规划结果已失效/);
  assert.equal(f.state.view(f.agent)!.value.executions, undefined);
  await f.state.close();
  await assert.rejects(f.admit('请继续实施'), /规划服务已关闭/);
  assert.throws(() => f.state.beginRead(f.agent, 'read'), /规划服务已关闭/);
});
