import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { establishRequirements, requirementsSchema } from '../src/core/domain/requirements.ts';
import { materializeProposal, workProposalSchema } from '../src/core/domain/plan-proposal.ts';
import { planSchema, type PlanningState } from '../src/core/domain/planning.ts';
import { PlanStore, planScope } from '../src/core/storage/plan-store.ts';
import { readPlanInput } from '../src/core/adapters/plan-input.ts';

const source = { messageIds: ['user-1'], hash: 'b'.repeat(64) };
const requirements = establishRequirements('a'.repeat(64), source, {
  objective: '完成两份文件',
  constraints: ['不改验证脚本'],
  acceptance: ['第一份内容正确', '第二份内容正确'],
  nonGoals: ['不发布'],
});
function proposal() {
  return workProposalSchema.parse({
    requirementRevision: requirements.revision,
    unknowns: [],
    assumptions: [],
    options: [],
    reason: '两项独立工作',
    evidence: [],
    steps: ['a1', 'a2'].map((id, i) => ({
      id: 'step' + i,
      objective: '完成文件 ' + i,
      role: 'developer',
      capabilities: [],
      dependsOn: [],
      scope: ['file' + i],
      requirementIds: [id],
      purpose: 'delivery',
    })),
  });
}

test('proposal purposes preserve user checks and reject redundant host assurance without keyword filtering', () => {
  const input = proposal();
  input.steps[0].purpose = 'user-check';
  input.steps[0].role = 'reviewer';
  input.steps[0].objective = '用户要求的审计报告与验证结果';
  input.steps[1].role = 'verifier';
  const delivery = materializeProposal(input, requirements);
  assert.equal(delivery.steps.length, 2);
  assert.equal(delivery.steps[0].objective, input.steps[0].objective);
  assert.equal(
    'purpose' in delivery.steps[0],
    false,
    'proposal metadata does not change persisted plan format',
  );
  input.steps[1].purpose = 'assurance';
  input.steps[1].subject = input.steps[0].id;
  assert.throws(() => materializeProposal(input, requirements), /HOST_OWNS_ASSURANCE/);
  input.steps[1].purpose = 'user-check';
  input.steps[1].subject = 'missing';
  assert.throws(() => materializeProposal(input, requirements), /UNKNOWN_SUBJECT/);
});

test('requirement references keep revisions bounded and preserve host constraints without text merging', () => {
  const before = structuredClone(requirements);
  for (let i = 0; i < 20; i++) {
    const input = proposal();
    input.reason = '改用另一种实现方式 ' + i;
    input.steps[0].objective = '换一种表述完成文件 ' + i;
    const result = materializeProposal(input, requirements);
    assert.deepEqual(result.constraints, ['不改验证脚本']);
    assert.deepEqual(result.nonGoals, ['不发布']);
    assert.equal(result.acceptance.length, 2);
    assert.deepEqual(result.steps[0].acceptance, ['第一份内容正确']);
  }
  assert.deepEqual(requirements, before);
  const duplicate = structuredClone(requirements);
  duplicate.items.push(duplicate.items[0]);
  assert.equal(requirementsSchema.safeParse(duplicate).success, false);
});

test('stale/unknown references, omitted acceptance and invented authorization are rejected with retained IDs', () => {
  const stale = proposal();
  stale.requirementRevision = 'c'.repeat(64);
  assert.throws(() => materializeProposal(stale, requirements), /STALE_REQUIREMENTS/);
  const unknown = proposal();
  unknown.steps[0].requirementIds = ['a9'];
  assert.throws(() => materializeProposal(unknown, requirements), /UNKNOWN_REQUIREMENT/);
  const omitted = proposal();
  omitted.steps.pop();
  assert.throws(
    () => materializeProposal(omitted, requirements),
    (e: Error) => {
      const error = JSON.parse(e.message);
      assert.equal(error.code, 'MISSING_ACCEPTANCE');
      assert.equal(error.retained.revision, requirements.revision);
      assert.deepEqual(error.retained.items, requirements.items);
      return true;
    },
  );
  assert.equal(workProposalSchema.safeParse({ ...proposal(), constraints: ['允许发布'] }).success, false);
  assert.equal(workProposalSchema.safeParse({ ...proposal(), permission: 'auto' }).success, false);
});

test('suggestions preserve provenance and conflicts, but cannot become accepted requirements', () => {
  const input = proposal();
  input.suggestions = [
    { kind: 'nonGoal', text: '现在发布', reason: '新建议', sourceIds: ['user-1'], conflictsWith: ['n1'] },
  ];
  assert.throws(() => materializeProposal(input, requirements), /REQUIREMENTS_NEED_INPUT/);
  input.suggestions[0].sourceIds = ['invented'];
  assert.throws(() => materializeProposal(input, requirements), /UNKNOWN_SOURCE/);
  input.suggestions[0].sourceIds = ['user-1'];
  input.suggestions[0].conflictsWith = ['n9'];
  assert.throws(() => materializeProposal(input, requirements), /UNKNOWN_REQUIREMENT/);
  assert.equal(requirements.items.length, 4);
});

test('legacy conversion uses the same admission and refuses text changes instead of appending them', () => {
  const materialized = materializeProposal(proposal(), requirements);
  const legacy = {
    ...materialized,
    steps: materialized.steps.map((step) => ({
      ...step,
      window: 'window',
      session: 'session',
      model: 'model',
      project: '/project',
    })),
  };
  const converted = readPlanInput(JSON.stringify(legacy), requirements, () => {
    throw new Error('must not establish twice');
  });
  assert.deepEqual(converted.materialize().constraints, legacy.constraints);
  legacy.constraints = ['换个说法：不要编辑验证脚本'];
  assert.throws(
    () => readPlanInput(JSON.stringify(legacy), requirements, () => requirements),
    /LEGACY_REQUIREMENTS_CHANGED/,
  );
  assert.throws(() => readPlanInput('{', requirements, () => requirements), /INVALID_JSON/);
});

test('continuations inherit omitted requirements; only explicit changes citing the new user message can amend them', () => {
  const nextSource = {
    ...source,
    messageIds: ['user-1', 'user-2'],
    admittedIds: ['user-2'],
    previousRevision: requirements.revision,
  };
  const next = establishRequirements(
    'e'.repeat(64),
    nextSource,
    { objective: requirements.objective },
    requirements,
  );
  assert.deepEqual(next.items, requirements.items);
  assert.throws(
    () =>
      establishRequirements(
        'e'.repeat(64),
        nextSource,
        {
          objective: requirements.objective,
          constraints: ['允许改脚本'],
        },
        requirements,
      ),
    /EXPLICIT_CHANGE_REQUIRED/,
  );
  assert.throws(
    () =>
      establishRequirements(
        'e'.repeat(64),
        nextSource,
        {
          objective: requirements.objective,
          changes: [
            { action: 'remove', targetId: 'n1', kind: 'nonGoal', sourceId: 'user-1', reason: '引用旧授权' },
          ],
        },
        requirements,
      ),
    /INVALID_REQUIREMENT_CHANGE/,
  );
  const amended = establishRequirements(
    'e'.repeat(64),
    nextSource,
    {
      objective: requirements.objective,
      changes: [
        { action: 'remove', targetId: 'n1', kind: 'nonGoal', sourceId: 'user-2', reason: '用户撤销旧限制' },
        {
          action: 'replace',
          targetId: 'a2',
          kind: 'acceptance',
          text: '新验收',
          sourceId: 'user-2',
          reason: '用户修改验收',
        },
        { action: 'add', kind: 'nonGoal', text: '不上传数据', sourceId: 'user-2', reason: '用户新增边界' },
      ],
    },
    requirements,
  );
  assert.equal(amended.items.find((item) => item.id === 'a2')!.text, '新验收');
  assert.equal(amended.items.find((item) => item.id === 'n2')!.text, '不上传数据');
  assert.equal(requirements.items.find((item) => item.id === 'n1')!.text, '不发布');
});

test('v1 migration reads without mutation, backs up exact bytes before v2 write, and refuses corrupt/future records', async () => {
  const home = await mkdtemp(join(tmpdir(), 'emergence-requirements-'));
  const store = new PlanStore(home),
    scope = planScope('session', 'project');
  const state: PlanningState = {
    version: 2,
    scope,
    requestIds: ['user-1'],
    request: '原任务',
    route: 'planned',
    routeReason: '测试',
    attempts: 2,
    research: 1,
    receipts: [],
    status: 'ready',
    issues: [],
  };
  const dir = join(home, 'core', 'plans'),
    path = join(dir, scope + '.json');
  await mkdir(dir, { recursive: true });
  const original = JSON.stringify({ ...state, version: 1 }, null, 2) + '\n';
  await writeFile(path, original);
  const migrated = (await store.read(scope))!;
  assert.equal(migrated.version, 2);
  assert.equal(migrated.status, 'blocked');
  assert.equal(migrated.attempts, 2);
  assert.equal(await readFile(path, 'utf8'), original);
  await store.write(migrated);
  assert.equal(await readFile(path + '.v1.bak', 'utf8'), original);
  assert.deepEqual(await store.read(scope), migrated);
  await store.write({ ...migrated, requirements, source });
  assert.equal(await readFile(path + '.v1.bak', 'utf8'), original);
  for (const corrupt of ['{broken', JSON.stringify({ ...state, version: 99 })]) {
    await writeFile(path, corrupt);
    await assert.rejects(store.read(scope));
    await assert.rejects(store.write(migrated));
    assert.equal(await readFile(path, 'utf8'), corrupt);
  }
  await writeFile(path, original);
  await writeFile(path + '.v1.bak', '{}');
  await assert.rejects(store.write(migrated));
  assert.equal(await readFile(path, 'utf8'), original);
});

test('recorded GLM failure analysis replays with stable IDs instead of overflowing the 12-constraint limit', async () => {
  const fixture = JSON.parse(
    await readFile(new URL('./fixtures/glm-requirements-replay.json', import.meta.url), 'utf8'),
  );
  const accepted = establishRequirements('d'.repeat(64), source, fixture.analysis);
  assert.equal(accepted.items.filter((item) => item.kind === 'constraint').length, 6);
  const original = structuredClone(accepted);
  for (let i = 0; i < 4; i++) {
    const input = proposal();
    input.requirementRevision = accepted.revision;
    input.reason = '修订实现措辞 ' + i;
    input.steps.forEach((step) => {
      step.requirementIds = ['a1', 'a2', 'a3', 'a4'];
    });
    const materialized = materializeProposal(input, accepted);
    const plan = planSchema.parse({
      ...materialized,
      steps: materialized.steps.map((step) => ({
        ...step,
        window: 'worker',
        session: 's',
        model: 'm',
        project: 'project',
      })),
    });
    assert.equal(plan.constraints.length, 6);
    assert.equal(plan.acceptance.length, 4);
  }
  assert.deepEqual(accepted, original);
});
