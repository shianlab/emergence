import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import UserApproval from '@deepseek-ai/dsh-user-approval';
import { establishRequirements } from '../src/core/domain/requirements.ts';
import {
  composeWorkDraft,
  draftProgress,
  draftStepSchema,
  editWorkDraft,
  newWorkDraft,
} from '../src/core/domain/work-draft.ts';
import { executionFixture, until } from './fixtures/core-execution.ts';
import { PlanStore } from '../src/core/storage/plan-store.ts';

const requirements = establishRequirements(
  'a'.repeat(64),
  { messageIds: ['user-1'], hash: 'b'.repeat(64) },
  {
    objective: '交付两个文件',
    acceptance: ['第一文件正确', '第二文件正确'],
    constraints: ['只改指定文件'],
  },
);
const step = (id = 'first', requirementId = 'a1', dependsOn: string[] = []) =>
  draftStepSchema.parse({
    id,
    objective: '写入指定文件',
    project: 'C:/fixture',
    purpose: 'delivery',
    role: 'developer',
    capabilities: ['tool:write'],
    scope: [id + '.txt'],
    requirementIds: [requirementId],
    localCriteria: [{ requirementId, text: id + ' 文件正确' }],
    dependsOn,
  });
test('draft updates are versioned, expose incomplete coverage and preserve canonical requirements', () => {
  const empty = newWorkDraft(requirements);
  const first = editWorkDraft(empty, requirements, {
    requirementRevision: requirements.revision,
    draftRevision: 0,
    step: step('first', 'a1', ['second']),
  });
  assert.deepEqual(draftProgress(first, requirements).uncovered, ['a2']);
  assert.deepEqual(draftProgress(first, requirements).missingDependencies, ['second']);
  assert.equal(empty.steps.length, 0);
  assert.throws(
    () =>
      editWorkDraft(first, requirements, {
        requirementRevision: requirements.revision,
        draftRevision: 0,
        id: 'first',
      }),
    /STALE_DRAFT/,
  );
  assert.throws(
    () =>
      composeWorkDraft(first, requirements, {
        requirementRevision: requirements.revision,
        draftRevision: 1,
        reason: '交付',
        evidence: [],
        assumptions: [],
      }),
    /a2|覆盖/,
  );
  const full = editWorkDraft(first, requirements, {
    requirementRevision: requirements.revision,
    draftRevision: 1,
    step: step('second', 'a2'),
  });
  assert.deepEqual(draftProgress(full, requirements).uncovered, []);
  assert.deepEqual(draftProgress(full, requirements).missingDependencies, []);
  const proposal = composeWorkDraft(full, requirements, {
    requirementRevision: requirements.revision,
    draftRevision: 2,
    reason: '分两项交付',
    evidence: [],
    assumptions: [],
  });
  assert.equal(proposal.requirementRevision, requirements.revision);
  assert.deepEqual(
    requirements.items.map((r) => r.text),
    ['只改指定文件', '第一文件正确', '第二文件正确'],
  );
  const removed = editWorkDraft(full, requirements, {
    requirementRevision: requirements.revision,
    draftRevision: 2,
    id: 'second',
  });
  assert.deepEqual(draftProgress(removed, requirements).missingDependencies, ['second']);
  assert.throws(
    () =>
      editWorkDraft({ ...full, status: 'sealed' }, requirements, {
        requirementRevision: requirements.revision,
        draftRevision: 2,
        id: 'second',
      }),
    /DRAFT_SEALED/,
  );
});
test('partial admission rejects stale requirements, invalid criteria and unbounded edits', () => {
  const draft = newWorkDraft(requirements),
    ref = { requirementRevision: requirements.revision, draftRevision: 0 };
  assert.throws(
    () => editWorkDraft(draft, requirements, { ...ref, requirementRevision: 'c'.repeat(64), step: step() }),
    /STALE_REQUIREMENTS/,
  );
  assert.throws(
    () => editWorkDraft(draft, requirements, { ...ref, step: step('first', 'a3') }),
    /UNKNOWN_REQUIREMENT/,
  );
  assert.throws(
    () =>
      editWorkDraft(draft, requirements, {
        ...ref,
        step: { ...step(), localCriteria: [{ requirementId: 'a2', text: '错误' }] },
      }),
    /INVALID_LOCAL_CRITERION/,
  );
  assert.throws(
    () => editWorkDraft(draft, requirements, { ...ref, step: step('first', 'a1', ['first']) }),
    /SELF_DEPENDENCY/,
  );
  assert.throws(
    () => editWorkDraft({ ...draft, edits: 48 }, requirements, { ...ref, step: step() }),
    /DRAFT_EDIT_BUDGET/,
  );
  assert.throws(() => draftStepSchema.parse({ ...step(), purpose: 'assurance' }));
});

async function* call(name: string, args: unknown, id: string = randomUUID()): AsyncIterable<StreamChunk> {
  const raw = JSON.stringify(args),
    key = ToolCallId(id);
  yield { type: 'block-start', index: 0, blockType: 'tool-call' };
  yield { type: 'tool-call-delta', index: 0, id: key, name, argumentsDelta: raw };
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: key, name, arguments: raw } };
  yield { type: 'finish', reason: { kind: 'tool-calls' } };
}
async function pausedDraft() {
  const f = await executionFixture(),
    main = f.w.current,
    c = main.controller!;
  assert.equal(f.config.core.planning.submission, 'steps', 'production uses incremental planning by default');
  await f.w.split('row');
  await f.w.setMaster(main.id);
  f.w.team.followthrough.advance = async () => {};
  await writeFile(join(f.cwd, 'source.txt'), 'result.txt 应有内容');
  f.ctx.effect(() =>
    f.ctx.tools.register(
      defineTool({
        name: 'read',
        description: 'actual read',
        parameters: { file_path: { type: 'string', required: true } },
        output: { schema: { type: 'string' }, render: (_a, value) => [{ type: 'text', text: value }] },
        execute: (args) => readFile(join(f.cwd, args.file_path), 'utf8'),
      }),
    ),
  );
  const original = f.provider.stream.bind(f.provider);
  let count = 0;
  f.provider.stream = async function* (request): AsyncIterable<StreamChunk> {
    if (JSON.stringify(request.messages).includes('[Emergence task ')) {
      yield* original(request);
      return;
    }
    const n = count++;
    if (n === 0)
      yield* call('emergence_analyze', {
        objective: '交付说明文件',
        route: 'planned',
        intent: 'execute',
        reason: '用户要求交付',
        acceptance: ['文件有内容'],
        constraints: ['只写 result.txt'],
      });
    else if (n === 1) yield* call('read', { file_path: 'source.txt' }, 'source-read');
    else if (n === 2) {
      const state = c.planning.intake()!;
      yield* call('emergence_plan_step', {
        requirementRevision: state.requirements!.revision,
        draftRevision: 0,
        step: { ...step(), project: f.cwd, scope: ['result.txt'] },
      });
    } else if (n === 3) yield { type: 'finish', reason: { kind: 'max-tokens' } };
    else if (n === 4) {
      const s = c.planning.intake()!;
      yield* call('emergence_plan_commit', {
        requirementRevision: s.requirements!.revision,
        draftRevision: s.draft!.draftRevision,
        reason: '继续已保存的交付',
        evidence: ['source-read'],
      });
    } else yield { type: 'finish', reason: { kind: 'stop' } };
  };
  await f.w.send(main.id, '按说明实现文件');
  await c.agent.whenIdle();
  return { ...f, main, c, count: () => count };
}

test('output truncation preserves a durable draft and explicit resume commits without reanalysis or duplicate effects', async () => {
  const f = await pausedDraft();
  try {
    assert.equal(f.count(), 4);
    const before = f.c.planning.intake()!;
    assert.equal(before.draft!.draftRevision, 1);
    assert.match(f.c.lastError!, /已保存.*1|1.*草稿/);
    assert.equal(f.w.collaboration.state.tasks.length, 0);
    assert.equal(f.writes(), 0);
    const runtime = f.c.planning.state(f.c.agent);
    await runtime.write;
    assert.equal(runtime.storageError, undefined);
    const persisted = await new PlanStore(f.home).read(runtime.value.scope);
    assert.deepEqual(persisted!.draft, runtime.value.draft);
    await assert.rejects(f.c.planning.readyPlan());
    await f.w.send(f.main.id, '继续规划');
    await until(() => f.w.collaboration.state.tasks[0]?.status === 'needs_review');
    assert.equal(f.c.planning.intake()!.requirements!.revision, before.requirements!.revision);
    assert.equal(f.c.planning.intake()!.draft!.status, 'sealed');
    assert.equal(f.writes(), 1);
    assert.equal(f.w.collaboration.state.tasks.length, 1);
    await assert.rejects(
      f.c.planning.drafts.commit(
        f.c.agent,
        {
          requirementRevision: before.requirements!.revision,
          draftRevision: 1,
          reason: '重复',
          evidence: ['source-read'],
        },
        new AbortController().signal,
      ),
      /已经派发/,
    );
  } finally {
    await f.close();
  }
});

test('a new objective invalidates saved draft; cancelled writes and storage errors cannot admit work', async () => {
  const f = await pausedDraft();
  try {
    const r = f.c.planning.state(f.c.agent),
      refs = { requirementRevision: r.value.requirements!.revision, draftRevision: 1 };
    const args = { ...refs, step: { ...step(), project: f.cwd, scope: ['result.txt'] } };
    await assert.rejects(f.c.planning.drafts.edit(f.c.agent, args, AbortSignal.abort()), /abort/i);
    r.storageError = 'fixture storage failure';
    await assert.rejects(
      f.c.planning.drafts.commit(
        f.c.agent,
        { ...refs, reason: '交付', evidence: ['source-read'] },
        new AbortController().signal,
      ),
      /storage failure/,
    );
    r.storageError = undefined;
    f.provider.stream = async function* (): AsyncIterable<StreamChunk> {
      yield { type: 'finish', reason: { kind: 'max-tokens' } };
    };
    await f.w.send(f.main.id, '新目标：研究资料，不再修改文件');
    await f.c.agent.whenIdle();
    assert.equal(f.c.planning.intake()!.draft, null);
    assert.equal(f.writes(), 0);
    assert.equal(f.w.collaboration.state.tasks.length, 0);
  } finally {
    await f.close();
  }
});

for (const permission of ['plan', 'reject'] as const)
  test(`incremental commit preserves ${permission} permission boundary`, async () => {
    const f = await pausedDraft();
    try {
      await f.ctx.plugin(UserApproval);
      if (permission === 'plan') f.c.setPermissionMode('plan');
      else f.c.launch.appConfig.permissions.rules.push({ tool: 'emergence_dispatch', effect: 'ask' });
      await f.w.send(f.main.id, '继续规划');
      if (permission === 'reject') {
        await until(() => !!f.c.pending);
        f.c.pending!.respond('n');
      }
      await f.c.agent.whenIdle();
      assert.equal(f.c.planning.intake()!.draft!.status, 'sealed');
      assert.equal(f.w.collaboration.state.tasks.length, 0);
      assert.equal(f.writes(), 0);
    } finally {
      await f.close();
    }
  });

test('draft CAS serializes overlapping edits and final admission rejects cycles and missing projects', async () => {
  const f = await pausedDraft();
  try {
    const r = f.c.planning.state(f.c.agent);
    r.value.autonomy = { steps: 0, nudges: 0, startedAt: Date.now() };
    const refs = { requirementRevision: r.value.requirements!.revision, draftRevision: 1 };
    const args = {
      ...refs,
      step: { ...step('first', 'a1', ['second']), project: f.cwd, scope: ['result.txt'] },
    };
    const signal = new AbortController().signal;
    const edits = await Promise.allSettled([
      f.c.planning.drafts.edit(f.c.agent, args, signal),
      f.c.planning.drafts.edit(f.c.agent, args, signal),
    ]);
    assert.equal(edits.filter((v) => v.status === 'fulfilled').length, 1);
    assert.match(
      String((edits.find((v) => v.status === 'rejected') as PromiseRejectedResult).reason),
      /STALE_DRAFT/,
    );
    await f.c.planning.drafts.edit(
      f.c.agent,
      {
        ...refs,
        draftRevision: 2,
        step: { ...step('second', 'a1', ['first']), project: f.cwd, scope: ['second.txt'] },
      },
      signal,
    );
    await assert.rejects(
      f.c.planning.drafts.commit(
        f.c.agent,
        { ...refs, draftRevision: 3, reason: '交付', evidence: ['source-read'] },
        signal,
      ),
      /循环|cycle|依赖/,
    );
    await assert.rejects(
      f.c.planning.drafts.edit(
        f.c.agent,
        { ...refs, draftRevision: 3, step: { ...step(), project: join(f.home, 'not-registered') } },
        signal,
      ),
      /PROJECT_CHANGED/,
    );
    assert.equal(f.w.collaboration.state.tasks.length, 0);
    assert.equal(f.writes(), 0);
    const budget = f.c.planning.drafts.budget(f.c.agent);
    assert.equal(budget.outputTokens, f.c.model.maxTokens);
    assert.equal(budget.planningMs, f.c.launch.appConfig.orchestration.budgets.planningMs);
    assert.ok(budget.stepChars <= 4000);
  } finally {
    await f.close();
  }
});

test('invalid immutable configuration is correctable before sealing and preflight still respects read denial', async () => {
  const f = await pausedDraft();
  try {
    const r = f.c.planning.state(f.c.agent);
    r.value.autonomy = { steps: 0, nudges: 0, startedAt: Date.now() };
    await writeFile(join(f.cwd, 'verify.cjs'), 'process.exit(0)');
    const args = {
      requirementRevision: r.value.requirements!.revision,
      draftRevision: 1,
      step: {
        ...step(),
        project: f.cwd,
        capabilities: ['tool:write', 'tool:pwsh'],
        scope: ['result.txt'],
        verifications: [
          {
            id: 'check',
            tool: 'pwsh' as const,
            command: 'node verify.cjs',
            cwd: '.',
            criteria: [0],
            inputs: ['result.txt'],
            configuration: ['verify.cjs（SHA256 abc，不得改动）'],
          },
        ],
      },
    };
    const signal = new AbortController().signal;
    await assert.rejects(f.c.planning.drafts.edit(f.c.agent, args, signal), /不是可完整观察的普通文件/);
    assert.equal(r.value.draft!.revision, 1, 'rejected proposal leaves prior draft unchanged');
    args.step.verifications[0].configuration = ['verify.cjs'];
    const saved = await f.c.planning.drafts.edit(f.c.agent, args, signal);
    assert.equal(saved.draftRevision, 2);
    f.c.launch.appConfig.permissions.rules.push({ tool: 'read', effect: 'deny' });
    await assert.rejects(
      f.c.planning.drafts.commit(
        f.c.agent,
        {
          requirementRevision: args.requirementRevision,
          draftRevision: 2,
          reason: '交付',
          evidence: ['source-read'],
        },
        signal,
      ),
      /读取权限不足/,
    );
    assert.equal(r.value.draft!.status, 'editing');
    assert.equal(f.writes(), 0);
    assert.equal(f.w.collaboration.state.tasks.length, 0);
  } finally {
    await f.close();
  }
});
