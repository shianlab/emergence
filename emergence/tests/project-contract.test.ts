import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { contractSchema } from '../src/core/domain/orchestration.ts';
import { taskSchema } from '../src/core/domain/task.ts';
import { establishRequirements } from '../src/core/domain/requirements.ts';
import { materializeProposal, workProposalSchema } from '../src/core/domain/plan-proposal.ts';
import { planSchema } from '../src/core/domain/planning.ts';
import {
  assertPlanAdmission,
  planTaskContract,
  auditTaskContract,
} from '../src/core/application/task-admission.ts';
import {
  bindProjectContract,
  projectRef,
  assertProjectBinding,
  projectViolation,
} from '../src/core/application/project-contract.ts';
import {
  freezeVerification,
  prepareVerification,
  verificationCovered,
  verificationGaps,
  verificationRequirements,
} from '../src/core/application/verification.ts';
import { captureToolEvidence, evidenceIsCurrent } from '../src/core/application/tool-evidence.ts';
import { directoryObservation } from '../src/core/application/execution-evidence.ts';
import { tasksConflict, allocationViolation } from '../src/core/application/task-allocation.ts';
import { executionFixture } from './fixtures/core-execution.ts';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import type { EvidenceReceipt } from '../src/core/domain/assurance.ts';
import { isSuccessfulObservation, isSuccessfulExecutionCheck } from '../src/core/domain/assurance.ts';

async function projects() {
  const root = await mkdtemp(join(tmpdir(), 'emergence-r2-'));
  const a = join(root, 'a'),
    b = join(root, 'b');
  await mkdir(a);
  await mkdir(b);
  for (const cwd of [a, b]) {
    await writeFile(join(cwd, 'result.txt'), 'good\n');
    await writeFile(
      join(cwd, 'verify.cjs'),
      "if(require('fs').readFileSync('result.txt','utf8')!=='good\\n')process.exit(7);console.log('verified');",
    );
  }
  return { root, a, b };
}
function bound(cwd: string, extras: string[] = []) {
  const step = {
    project: cwd,
    scope: ['result.txt'],
    acceptance: ['本项目 result.txt 为 good'],
    capabilities: ['tool:write', 'tool:pwsh'],
    readProjects: extras,
    localCriteria: [{ requirementId: 'a1', text: '本项目 result.txt 为 good' }],
    verifications: [
      {
        id: 'check',
        tool: 'pwsh' as const,
        command: 'node verify.cjs',
        cwd: '.',
        criteria: [0],
        inputs: ['result.txt'],
        configuration: ['verify.cjs'],
      },
    ],
  };
  return contractSchema.parse({
    scope: step.scope,
    acceptance: step.acceptance,
    binding: bindProjectContract(step),
  });
}
function task(cwd: string, contract: ReturnType<typeof contractSchema.parse>) {
  return taskSchema.parse({
    id: 'audit',
    requestKey: 'audit-1',
    objective: '独立检查',
    issuer: 'master',
    issuerSession: 'master-session',
    target: 'worker',
    targetSession: 'audit-session',
    cwd,
    modelId: 'fixture',
    dependsOn: [],
    status: 'running',
    progress: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    contract,
    runId: 'run-1',
    assessment: { subject: 'implementation', kind: 'verify', version: 'v1' },
  });
}

test('R2 global criteria are preserved once and localized contributions cannot disappear or be copied across projects', async () => {
  const { a, b } = await projects();
  const requirements = establishRequirements(
    'a'.repeat(64),
    { messageIds: ['user'], hash: 'b'.repeat(64) },
    { objective: '修改两个项目', acceptance: ['两个项目均通过验证'], constraints: ['不修改验证脚本'] },
  );
  const proposal = workProposalSchema.parse({
    requirementRevision: requirements.revision,
    reason: '各自实现、主控汇总',
    unknowns: [],
    assumptions: [],
    options: [],
    evidence: [],
    steps: [a, b].map((project, i) => ({
      id: 's' + i,
      project,
      role: 'developer',
      purpose: 'delivery',
      objective: '修改本项目',
      capabilities: ['tool:write'],
      scope: ['result.txt'],
      dependsOn: [],
      requirementIds: ['a1'],
      localCriteria: [{ requirementId: 'a1', text: `项目 ${i} 的 result.txt 完成并通过该项目验证` }],
    })),
  });
  const materialized = materializeProposal(proposal, requirements);
  const plan = planSchema.parse({
    ...materialized,
    steps: materialized.steps.map((s, i) => ({
      ...s,
      window: 'w' + i,
      session: 'session' + i,
      model: 'model' + i,
    })),
  });
  assert.doesNotThrow(() => assertPlanAdmission(plan, 16000));
  assert.equal(plan.goalContract!.criteria[0].contributors.length, 2);
  for (const step of plan.steps) {
    const contract = planTaskContract(plan, step);
    assert.deepEqual(
      contract.acceptance,
      step.localCriteria!.map((c) => c.text),
    );
    assert.equal(JSON.parse(contract.context).acceptance, undefined);
    assert.deepEqual(
      auditTaskContract(task(step.project, contract), 'verify').acceptance,
      contract.acceptance,
    );
  }
  const omitted = structuredClone(plan);
  omitted.goalContract!.criteria[0].contributors.pop();
  assert.throws(() => assertPlanAdmission(omitted, 16000), /归属/);
  const copied = structuredClone(proposal);
  copied.steps[0].localCriteria![0].text = '两个项目均通过验证';
  assert.throws(() => materializeProposal(copied, requirements), /GLOBAL_CRITERION_COPIED/);
  const missing = structuredClone(proposal);
  delete missing.steps[0].localCriteria;
  assert.throws(() => materializeProposal(missing, requirements), /LOCAL_CRITERIA_REQUIRED/);
  const foreign = structuredClone(proposal);
  foreign.steps[0].localCriteria![0].requirementId = 'a9';
  assert.throws(() => materializeProposal(foreign, requirements), /INVALID_LOCAL_CRITERION/);
});

test('R2 project identity supports plain folders/aliases and rejects stale junctions, IDs and escaping scopes', async () => {
  const { root, a, b } = await projects();
  await assert.rejects(readFile(join(a, '.git')));
  assert.equal(projectRef(a).id, projectRef(join(a, '.')).id);
  if (process.platform === 'win32') assert.equal(projectRef(a).id, projectRef(a.toUpperCase()).id);
  const contract = bound(a);
  const wrong = structuredClone(contract);
  wrong.binding!.project.id = projectRef(b).id;
  assert.throws(() => assertProjectBinding(wrong, a, [a, b]), /绑定/);
  assert.throws(
    () =>
      bindProjectContract({
        project: a,
        projectId: projectRef(b).id,
        scope: ['result.txt'],
        acceptance: ['ok'],
        capabilities: [],
      }),
    /ID/,
  );
  assert.throws(
    () =>
      bindProjectContract({ project: a, scope: ['../b/result.txt'], acceptance: ['ok'], capabilities: [] }),
    /范围超出/,
  );
  const alias = join(root, 'alias');
  await symlink(a, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(projectRef(alias).id, projectRef(a).id);
  const saved = bound(alias);
  await unlink(alias);
  await symlink(b, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => assertProjectBinding(saved, alias, [a, b]), /绑定/);
});

test('R2 local tasks reject other projects; explicit integration reads registered projects without writes or permission grants', async () => {
  const { a, b } = await projects(),
    local = task(a, bound(a));
  assert.match(projectViolation(local, 'read', { file_path: join(b, 'result.txt') })!, /超出/);
  assert.match(projectViolation(local, 'pwsh', { command: 'node verify.cjs', workdir: b })!, /超出/);
  assert.match(projectViolation(local, 'read', { file_path: 'result.txt' }, b)!, /实际目录/);
  assert.match(projectViolation(local, 'working_directory', { cd: b })!, /不能改变/);
  const integration = task(a, bound(a, [b]));
  assert.doesNotThrow(() => assertProjectBinding(integration.contract!, a, [a, b]));
  assert.equal(projectViolation(integration, 'read', { file_path: join(b, 'result.txt') }), undefined);
  assert.match(projectViolation(integration, 'write', { file_path: join(b, 'result.txt') })!, /不授权写入/);
  assert.throws(() => assertProjectBinding(integration.contract!, a, [a]), /未登记/);
  const writer = task(b, bound(b));
  writer.allocation = { reason: '目标项目写入', paths: [join(b, 'result.txt')], access: 'write' };
  assert.equal(tasksConflict(local, writer), false);
  assert.equal(tasksConflict(integration, writer), true);
});

test('R2 exact verification binds real process exit, project and input versions; foreign or stale receipts fail', async () => {
  const { a, b } = await projects();
  const contract = await freezeVerification(bound(a), () => true),
    t = task(a, contract);
  const args = { command: 'node verify.cjs', workdir: a };
  const prepared = (await prepareVerification(t, 'pwsh', args, () => true))!;
  let receipt!: EvidenceReceipt;
  const result = await captureToolEvidence(
    {
      taskId: t.id,
      runId: t.runId,
      sessionId: t.targetSession,
      callId: 'real-check',
      name: 'pwsh',
      arguments: args,
      cwd: a,
      signal: AbortSignal.timeout(5000),
      verification: prepared.identity,
      verificationInputs: prepared.inputs,
    },
    async () => {
      const result = await promisify(execFile)(process.execPath, ['verify.cjs'], {
        cwd: a,
        windowsHide: true,
      });
      return { value: { exitCode: 0, stdout: result.stdout }, isError: false };
    },
    async (value) => {
      receipt = value;
    },
  );
  assert.equal(result.isError, false);
  assert.equal(receipt.exitCode, 0);
  assert.equal(isSuccessfulObservation(receipt, true), true);
  assert.equal(
    isSuccessfulObservation(receipt, false),
    false,
    'a successful arbitrary shell is not read-only computation evidence',
  );
  assert.ok(receipt.manifest!.checks.some((c) => c.kind === 'input-version' && c.passed));
  assert.equal(receipt.verification!.projectId, projectRef(a).id);
  assert.equal(await evidenceIsCurrent(receipt), true);
  const checks = [{ criterion: 0, passed: true, receipts: [receipt.id], note: '实际进程与版本核对' }];
  assert.equal(verificationCovered(contract, checks, [receipt]), true);
  const native = structuredClone(receipt);
  native.kind = 'read';
  native.tool = 'emergence_verify_file';
  delete native.exitCode;
  delete native.verification;
  native.manifest!.contract.output = 'file-check';
  native.manifest!.inputs = native.manifest!.inputs.slice(0, 1);
  assert.equal(isSuccessfulExecutionCheck(native), true);
  assert.equal(
    verificationCovered(contract, checks, [native]),
    false,
    'Native file checks cannot satisfy an explicit program-test specification',
  );
  native.tool = 'read';
  assert.equal(isSuccessfulExecutionCheck(native), false, 'Ordinary reads are not executable checks');
  const omitted = [{ ...checks[0], receipts: ['read-only-evidence'] }];
  assert.deepEqual(verificationGaps(contract, omitted, [receipt]), [
    { criterion: 0, specification: 'check', candidates: [receipt.id] },
  ]);
  assert.deepEqual(verificationRequirements(contract, [receipt])[0].receipts, [receipt.id]);
  const foreign = structuredClone(receipt);
  foreign.verification!.projectId = projectRef(b).id;
  assert.equal(verificationCovered(contract, checks, [foreign]), false);
  assert.deepEqual(verificationGaps(contract, omitted, [foreign])[0].candidates, []);
  const empty = structuredClone(receipt);
  delete empty.verification;
  assert.equal(verificationCovered(contract, checks, [empty]), false);
  const incomplete = structuredClone(receipt);
  incomplete.manifest!.inputs.pop();
  assert.equal(verificationCovered(contract, checks, [incomplete]), false);
  await writeFile(join(a, 'result.txt'), 'new version');
  assert.equal(await evidenceIsCurrent(receipt), false);
  await writeFile(join(a, 'verify.cjs'), 'process.exit(0)');
  await assert.rejects(
    prepareVerification(t, 'pwsh', args, () => true),
    /脚本或配置已改变/,
  );
  await assert.rejects(
    freezeVerification(bound(a), () => false),
    /读取权限/,
  );
  assert.match(projectViolation(t, 'edit', { file_path: 'verify.cjs' })!, /超出|冻结/);
  assert.match(projectViolation(t, 'pwsh', { command: 'node verify.cjs; echo done' })!, /精确检查/);
});

test('read-only authority applies without parallel path locks and includes restored cross-project contracts', async () => {
  const { a, b } = await projects();
  const declared = { ...task(a, bound(a)), allocation: { access: 'read' as const, reason: '宿主只读分工' } };
  const restored = task(a, bound(a, [b]));
  for (const current of [declared, restored]) {
    assert.match(allocationViolation(current, 'pwsh', { command: 'node verify.cjs' })!, /只读/);
    assert.match(
      allocationViolation(current, 'write', { file_path: 'result.txt', content: 'changed' })!,
      /只读/,
    );
    assert.match(allocationViolation(current, 'subagent', {})!, /只读/);
    assert.equal(allocationViolation(current, 'read', { file_path: 'result.txt' }), undefined);
    assert.equal(allocationViolation(current, 'emergence_report', {}), undefined);
  }
});

test('R2 inspection uses native bytes/listing and obeys ordinary read denial in independent sessions', async () => {
  const f = await executionFixture();
  try {
    const agent = f.w.current.controller!.agent;
    await writeFile(join(f.cwd, 'bytes.txt'), Buffer.from([239, 187, 191, 65, 13, 10]));
    const inspect = async (path: string, checks?: object[]) => {
      const toolSet = await f.ctx.tools.resolve({
        agent,
        modelSelection: agent.model.current()!,
        signal: AbortSignal.timeout(5000),
      });
      try {
        return (
          await f.ctx.tools.execute({
            agent,
            toolSet,
            signal: AbortSignal.timeout(5000),
            calls: [
              {
                type: 'tool-call',
                id: ToolCallId('inspect-' + Math.random()),
                name: checks ? 'emergence_verify_file' : 'emergence_inspect',
                arguments: JSON.stringify({ file_path: path, ...(checks ? { checks } : {}) }),
              },
            ],
          })
        ).results[0].result;
      } finally {
        toolSet.dispose();
      }
    };
    const result = await inspect('bytes.txt');
    assert.equal(result.isError, false);
    const value = result.value as {
      fileSize: number;
      utf8Bom: boolean;
      utf8Valid: boolean;
      trailingNewline: string;
    };
    assert.deepEqual(
      [value.fileSize, value.utf8Bom, value.utf8Valid, value.trailingNewline],
      [6, true, true, 'CRLF'],
    );
    const directory = await directoryObservation(f.cwd);
    assert.ok(directory.entries.some((e) => e.name === 'bytes.txt'));
    assert.equal((await inspect('.')).isError, false);
    const checks = [{ property: 'fileSize', operator: 'equals', expectedNumber: 6 }];
    assert.equal((await inspect('bytes.txt', checks)).isError, false);
    assert.equal((await inspect('bytes.txt', [])).isError, true, 'An empty check list cannot pass');
    assert.equal(
      (await inspect('bytes.txt', [{ ...checks[0], expectedText: '6' }])).isError,
      true,
      'Ambiguous expected types cannot pass',
    );
    f.w.current.controller!.launch.appConfig.permissions.rules.push({
      tool: 'read',
      effect: 'deny',
      path: join(f.cwd, 'bytes.txt'),
    });
    assert.equal((await inspect('bytes.txt')).isError, true);
    assert.equal(
      (await inspect('bytes.txt', checks)).isError,
      true,
      'Native verification also obeys read deny',
    );
    assert.equal(f.w.collaboration.state.tasks.length, 0);
    assert.equal(f.w.collaboration.state.mode, 'independent');
  } finally {
    await f.close();
  }
});
