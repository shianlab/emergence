import { ToolCallId, createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import UserApproval from '@deepseek-ai/dsh-user-approval';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { HistoricalOrchestrationWorkspace as WorkspaceController } from './fixtures/historical-orchestration.ts';
import { AuditCapacityError } from '../src/core/application/audit-allocation.ts';
import { executionFixture, until } from './fixtures/core-execution.ts';
import { workProposalSchema } from '../src/core/domain/plan-proposal.ts';
import type { z } from 'zod';

async function* call(name: string, args: unknown, id = randomUUID()): AsyncIterable<StreamChunk> {
  const raw = JSON.stringify(args),
    key = ToolCallId(id);
  yield { type: 'block-start', index: 0, blockType: 'tool-call' };
  yield { type: 'tool-call-delta', index: 0, id: key, name, argumentsDelta: raw };
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: key, name, arguments: raw } };
  yield { type: 'finish', reason: { kind: 'tool-calls' } };
}
async function setup(
  options: {
    submission?: 'steps' | 'whole';
    omittedVerification?: boolean;
    bad?: boolean;
    alwaysBad?: boolean;
    noEvidence?: boolean;
    blockedEvidence?: boolean;
    research?: boolean;
    dependent?: boolean;
    sharedArtifact?: boolean;
    redundantAudit?: boolean;
    crossProject?: boolean;
    integration?: boolean;
    integrationRole?: 'researcher' | 'verifier';
    hold?: () => Promise<void>;
  } = {},
) {
  const f = await executionFixture();
  f.config.core.planning.submission = options.submission ?? 'whole';
  const artifact = (step?: string) =>
    step === 'second' && !options.sharedArtifact ? 'second.txt' : 'result.txt';
  await f.ctx.plugin(UserApproval);
  const root = f.w.current;
  root.controller!.launch.appConfig.core.planning.submission = options.submission ?? 'whole';
  await f.w.split('row');
  await f.w.setMaster(root.id);
  await writeFile(join(f.cwd, 'source.txt'), '实现 result.txt 为 good');
  const other = join(f.home, 'other-project');
  if (options.crossProject) {
    await mkdir(other);
    for (const dir of [f.cwd, other])
      await writeFile(
        join(dir, 'verify.cjs'),
        "process.exit(require('fs').readFileSync(process.argv[2],'utf8').trim()==='good'?0:7)",
      );
    const model = { ...f.config.models[0], id: 'fixture-other', model: 'fixture-alternate-model' };
    f.config.models.push(model);
    root.controller!.launch.appConfig.models.push(model);
    f.ctx.effect(() => f.ctx.llm.registerAdapter(['fixture-other'], f.provider));
    await f.w.split('row', other, 'fixture-other');
  }
  if (options.research) await writeFile(join(f.cwd, 'result.txt'), 'good');
  f.ctx.effect(() =>
    f.ctx.tools.register(
      defineTool({
        name: 'read',
        description: 'actual file read',
        parameters: { file_path: { type: 'string', required: true } },
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
        execute: (args, exec) =>
          readFile(resolve(f.ctx.workingDirectory.get(exec.agent!.session), args.file_path), 'utf8'),
      }),
    ),
  );
  f.ctx.effect(() =>
    f.ctx.tools.register(
      defineTool({
        name: 'pwsh',
        description: 'fixed real process verification',
        parameters: { command: { type: 'string', required: true } },
        output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
        execute: async (args, exec) => {
          assert.ok(['check result.txt', 'check second.txt'].includes(args.command));
          try {
            await promisify(execFile)(
              process.execPath,
              options.crossProject
                ? ['verify.cjs', args.command.slice(6)]
                : [
                    '-e',
                    "process.exit(require('fs').readFileSync(process.argv[1],'utf8').trim()==='good'?0:7)",
                    args.command.slice(6),
                  ],
              { cwd: f.ctx.workingDirectory.get(exec.agent!.session), windowsHide: true },
            );
            return { exitCode: 0 };
          } catch {
            return { exitCode: 7 };
          }
        },
      }),
    ),
  );
  let step = 0;
  const readId = randomUUID();
  let summaries = 0;
  let pendingDraft: z.infer<typeof workProposalSchema> | undefined;
  async function* nextDraft(): AsyncIterable<StreamChunk> {
    assert.equal(f.w.collaboration.state.tasks.length, 0, 'drafts cannot dispatch');
    assert.equal(f.writes(), 0, 'drafts cannot write');
    const state = root.controller!.planning.intake()!;
    const refs = {
      requirementRevision: state.requirements!.revision,
      draftRevision: state.draft!.draftRevision,
    };
    const step = pendingDraft!.steps.shift();
    if (step) {
      yield* call('emergence_plan_step', {
        ...refs,
        step: {
          ...step,
          project: step.project ?? f.cwd,
          localCriteria: step.localCriteria ?? [{ requirementId: 'a1', text: 'result.txt 为 good' }],
        },
      });
    } else {
      const { reason, evidence, assumptions } = pendingDraft!;
      pendingDraft = undefined;
      yield* call('emergence_plan_commit', { ...refs, reason, evidence, assumptions });
    }
  }
  f.provider.stream = async function* (request): AsyncIterable<StreamChunk> {
    const messages = request.messages.map((m) => ({
      role: m.role,
      text: m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n'),
    }));
    const index = messages.findLastIndex((m) => m.role === 'user' && m.text.startsWith('[Emergence task '));
    if (index >= 0) {
      const id = messages[index].text.match(/\[Emergence task ([^\]]+)\]/)![1],
        t = f.w.collaboration.task(id);
      const n = messages.slice(index + 1).filter((m) => m.role === 'tool').length;
      const subject = t.assessment ? f.w.collaboration.task(t.assessment.subject) : t;
      if (subject.workflow?.step === 'integration') {
        assert.ok(
          !request.tools?.some((t) => ['pwsh', 'write', 'edit'].includes(t.name)),
          'read-only integration and its audits expose a consistent tool menu',
        );
        if (n < 2)
          yield* call('read', { file_path: n === 0 ? join(f.cwd, 'result.txt') : join(other, 'second.txt') });
        else if (t.assessment && n === 2) yield* call('emergence_receipts', {});
        else if (t.assessment && n === 3) {
          const ledger = JSON.parse(messages.filter((m) => m.role === 'tool').at(-1)!.text);
          yield* call('emergence_assess', {
            checks: [
              {
                criterion: 0,
                passed: true,
                receipts: ledger.own.map((r: { id: string }) => r.id),
                note: '独立读取两个已声明项目，产物均为 good',
              },
            ],
          });
        } else if (n === (t.assessment ? 4 : 2))
          yield* call('emergence_report', {
            outcome: 'success',
            summary: '两个声明项目的产物一致',
            artifacts: [],
          });
        else yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }
      if (t.assessment) {
        const file = artifact(f.w.collaboration.task(t.assessment.subject).workflow?.step);
        const good = (await readFile(join(t.cwd, file), 'utf8')).trim() === 'good';
        if (options.omittedVerification && t.assessment.kind === 'verify') {
          if (n === 0) yield* call('read', { file_path: file });
          else if (n === 1) yield* call('pwsh', { command: 'check ' + file });
          else if (n === 2) yield* call('emergence_receipts', {});
          else if (n === 3) {
            const ledger = JSON.parse(messages.filter((m) => m.role === 'tool').at(-1)!.text);
            assert.equal(ledger.verificationRequirements[0].receipts[0], ledger.own[1].id);
            yield* call('emergence_assess', {
              checks: [
                {
                  criterion: 0,
                  passed: true,
                  receipts: [ledger.own[0].id],
                  note: '只引用文件读取，遗漏契约的命令引用',
                },
              ],
            });
          } else if (n === 4) {
            const text = messages.filter((m) => m.role === 'tool').at(-1)!.text;
            const detail = JSON.parse(text.slice(text.indexOf('{')));
            assert.equal(detail.code, 'VERIFICATION_EVIDENCE_REQUIRED');
            assert.equal(detail.gaps[0].criterion, 0);
            assert.equal(detail.gaps[0].candidates.length, 1);
            yield* call('emergence_assess', {
              checks: [
                {
                  criterion: 0,
                  passed: true,
                  receipts: detail.gaps[0].candidates,
                  note: '按宿主返回的精确缺口引用已成功命令，无需重跑',
                },
              ],
            });
          } else if (n === 5)
            yield* call('emergence_report', {
              outcome: 'success',
              summary: '已补齐真实证据引用',
              artifacts: [],
            });
          else yield { type: 'finish', reason: { kind: 'stop' } };
          return;
        }
        const readOnly = t.assessment.kind === 'review' || options.research;
        if (!n)
          yield* call(
            readOnly ? 'read' : 'pwsh',
            readOnly ? { file_path: file } : { command: 'check ' + file },
          );
        else if (n === 1 && !options.noEvidence) yield* call('emergence_receipts', {});
        else if (n === 2 && !options.noEvidence) {
          const ledger = JSON.parse(messages.filter((m) => m.role === 'tool').at(-1)!.text);
          yield* call('emergence_assess', {
            checks: [
              {
                criterion: 0,
                passed: good && !options.blockedEvidence,
                ...(options.blockedEvidence ? { blocked: true } : {}),
                receipts: [ledger.own[0].id],
                note: options.blockedEvidence
                  ? '文件本身符合要求，但缺少外部基线，不能证明额外要求'
                  : good
                    ? '实际文件内容满足 good 验收要求'
                    : '实际文件内容是 bad，需要改为 good',
              },
            ],
          });
        } else if (n === (options.noEvidence ? 1 : 3))
          yield* call('emergence_report', {
            outcome: good ? 'success' : 'failed',
            summary: good ? '检查结束' : '实际发现缺陷',
            artifacts: [],
          });
        else yield { type: 'finish', reason: { kind: 'stop' } };
      } else {
        if (!n) {
          await options.hold?.();
          yield* call(
            options.research ? 'read' : 'write',
            options.research
              ? { file_path: 'result.txt' }
              : {
                  file_path: artifact(t.workflow?.step),
                  content:
                    options.alwaysBad || (options.bad && !t.repairOf)
                      ? 'bad'
                      : options.sharedArtifact && t.workflow?.step === 'second'
                        ? 'good\n'
                        : 'good',
                },
          );
        } else if (n === 1)
          yield* call('emergence_report', {
            outcome: 'success',
            summary: '已写入等待检查',
            artifacts: [artifact(t.workflow?.step)],
          });
        else yield { type: 'finish', reason: { kind: 'stop' } };
      }
      return;
    }
    if (messages.some((m) => m.role === 'user' && m.text.includes('这是宿主基于实际回执生成的最终状态'))) {
      summaries++;
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    if (pendingDraft) {
      yield* nextDraft();
      return;
    }
    const n = step++;
    if (n === 0)
      yield* call('emergence_analyze', {
        objective: '实现并核对文件',
        reason: '有实际文件交付',
        route: 'planned',
        intent: 'execute',
        acceptance: [
          options.crossProject ? '两个项目分别交付自己的文件为 good' : 'result.txt 为 good',
          ...(options.integration ? ['两个项目交付内容一致'] : []),
        ],
        constraints: ['只处理任务指定文件'],
      });
    else if (n === 1) yield* call('read', { file_path: 'source.txt' }, readId);
    else if (n === 2 || (n === 3 && options.redundantAudit)) {
      const item = {
        id: 'first',
        objective: options.research ? '读取 result.txt，核对原文事实' : '写入 result.txt',
        role: options.research ? 'researcher' : 'developer',
        purpose: options.research ? 'user-check' : 'delivery',
        capabilities: options.crossProject
          ? ['tool:write', 'tool:pwsh']
          : [options.research ? 'tool:read' : 'tool:write'],
        scope: ['result.txt'],
        requirementIds: ['a1'],
        dependsOn: [] as string[],
        ...(options.crossProject
          ? {
              project: f.cwd,
              localCriteria: [{ requirementId: 'a1', text: '本项目 result.txt 的内容为 good' }],
              verifications: [
                {
                  id: 'local-check',
                  tool: 'pwsh',
                  command: 'check result.txt',
                  cwd: '.',
                  criteria: [0],
                  inputs: ['result.txt'],
                  configuration: ['verify.cjs'],
                },
              ],
            }
          : {}),
      };
      const work = workProposalSchema.parse({
        requirementRevision: root.controller!.planning.intake()!.requirements!.revision,
        unknowns: [],
        assumptions: [],
        options: [],
        reason: '小范围任务',
        evidence: [readId],
        steps: [
          item,
          ...(options.dependent
            ? [
                {
                  ...item,
                  id: 'second',
                  objective: '随后写入 second.txt',
                  scope: [artifact('second')],
                  dependsOn: ['first'],
                },
              ]
            : options.crossProject
              ? [
                  {
                    ...item,
                    id: 'second',
                    project: other,
                    objective: '另一项目写入 second.txt',
                    scope: ['second.txt'],
                    localCriteria: [{ requirementId: 'a1', text: '本项目 second.txt 的内容为 good' }],
                    verifications: [
                      {
                        id: 'local-check',
                        tool: 'pwsh',
                        command: 'check second.txt',
                        cwd: '.',
                        criteria: [0],
                        inputs: ['second.txt'],
                        configuration: ['verify.cjs'],
                      },
                    ],
                  },
                ]
              : []),
          ...(options.integration
            ? [
                {
                  id: 'integration',
                  project: f.cwd,
                  objective: '读取两个已声明项目核对交付内容一致',
                  role: options.integrationRole ?? 'researcher',
                  purpose: 'user-check',
                  capabilities: ['tool:read'],
                  scope: ['.'],
                  readProjects: [other],
                  dependsOn: ['first', 'second'],
                  requirementIds: ['a2'],
                  localCriteria: [
                    {
                      requirementId: 'a2',
                      text: '读取本项目 result.txt 和声明项目 second.txt，核对内容一致',
                    },
                  ],
                },
              ]
            : []),
          ...(options.redundantAudit && n === 2
            ? [
                {
                  ...item,
                  id: 'duplicate-check',
                  purpose: 'assurance',
                  subject: 'first',
                  role: 'verifier',
                  objective: '完成后再次核验',
                  dependsOn: ['first'],
                },
              ]
            : []),
        ],
      });
      if (options.submission === 'steps') {
        pendingDraft = work;
        yield* nextDraft();
      } else yield* call('emergence_plan_work', { work });
    } else yield { type: 'finish', reason: { kind: 'stop' } };
  };
  const start = async () => {
    await f.w.send(
      root.id,
      options.research ? '研究说明文件内容并核对来源' : '实现说明文件中的任务并核对结果',
    );
    await until(() => !!f.w.team.records.at(-1)?.followthrough);
  };
  const record = () => f.w.team.records.at(-1)!;
  const finished = async () => {
    await until(() => {
      // Approve only fixture verification and the known second-project write; no orchestration calls are driven by the test.
      for (const p of f.w.panes.values())
        if (p.controller?.pending) {
          const t = f.w.collaboration.current(p.id);
          if (
            t?.assessment?.kind === 'verify' ||
            (options.crossProject && t?.workflow?.step === 'second' && !t.assessment)
          )
            p.controller.pending.respond('y');
        }
      return ['completed', 'blocked', 'cancelled'].includes(record().phase);
    });
    return record();
  };
  return {
    ...f,
    root,
    start,
    record,
    finished,
    summaries: () => summaries,
    useWorkspace: (w: WorkspaceController) => {
      f.w = w;
    },
  };
}

for (const crossProject of [false, true])
  test(`incremental draft commits once and completes actual ${crossProject ? 'cross-project' : 'dependent'} deliveries and host checks`, async () => {
    const f = await setup({ submission: 'steps', crossProject, dependent: !crossProject });
    try {
      await f.start();
      const record = await f.finished();
      assert.equal(record.phase, 'completed', record.blockReason);
      assert.equal(f.w.collaboration.state.tasks.length, 6);
      assert.equal(f.writes(), 2);
      const intake = f.root.controller!.planning.intake()!;
      assert.equal(intake.draft!.status, 'sealed');
      assert.equal(intake.draft!.draftRevision, 2);
      assert.equal(intake.executions!.length, 2);
      assert.equal(await readFile(join(f.cwd, 'result.txt'), 'utf8'), 'good');
      assert.equal(
        await readFile(join(crossProject ? join(f.home, 'other-project') : f.cwd, 'second.txt'), 'utf8'),
        'good',
      );
    } finally {
      await f.close();
    }
  });

test('verification feedback names exact missing criteria and receipts; corrected submission closes without rerunning effects', async () => {
  const f = await setup({ submission: 'steps', crossProject: true, omittedVerification: true });
  try {
    await f.start();
    const record = await f.finished();
    assert.equal(record.phase, 'completed', record.blockReason);
    assert.equal(f.writes(), 2);
    const verifiers = f.w.collaboration.state.tasks.filter((t) => t.assessment?.kind === 'verify');
    assert.equal(verifiers.length, 2);
    for (const t of verifiers) {
      assert.equal(t.receipts.filter((r) => r.kind === 'command').length, 1);
      assert.equal(t.result!.failures!.length, 1);
      assert.equal(t.result!.failures![0].resolution?.kind, 'submission');
      assert.deepEqual(t.result!.errors, []);
    }
  } finally {
    await f.close();
  }
});

test('a read-only cross-project check assigned to verifier is independently audited without impossible shell evidence', async () => {
  const f = await setup({
    submission: 'steps',
    crossProject: true,
    integration: true,
    integrationRole: 'verifier',
  });
  try {
    await f.start();
    const record = await f.finished();
    assert.equal(record.phase, 'completed', record.blockReason);
    const tasks = f.w.collaboration.state.tasks;
    assert.equal(tasks.length, 9);
    const integration = tasks.find((t) => t.workflow?.step === 'integration' && !t.assessment)!;
    assert.equal(integration.role!.id, 'verifier');
    for (const task of tasks.filter(
      (t) => t.id === integration.id || t.assessment?.subject === integration.id,
    )) {
      assert.equal(task.status, 'succeeded');
      assert.equal(
        task.receipts.some((r) => r.kind === 'command'),
        false,
      );
    }
    assert.equal(f.writes(), 2);
  } finally {
    await f.close();
  }
});

test('natural objective automatically rejects, repairs, verifies with a real process, accepts dependencies and emits one durable summary', async () => {
  const f = await setup({ bad: true, dependent: true });
  try {
    await f.start();
    const r = await f.finished();
    assert.equal(r.phase, 'completed', r.blockReason);
    const tasks = f.w.collaboration.state.tasks,
      repairs = tasks.filter((t) => t.repairOf);
    assert.equal(repairs.length, 2); // each original bad implementation receives one bounded repair
    assert.equal(await readFile(join(f.cwd, 'result.txt'), 'utf8'), 'good');
    assert.equal(await readFile(join(f.cwd, 'second.txt'), 'utf8'), 'good');
    assert.ok(
      tasks
        .filter((t) => t.assessment?.kind === 'verify' && t.status === 'succeeded')
        .every((t) => t.receipts.some((r) => r.kind === 'command' && r.exitCode === 0)),
    );
    assert.ok(
      tasks.some((t) => t.assessment?.kind === 'verify' && t.receipts.some((r) => r.exitCode === 7)),
      'a real failed process discovered the defect before repair',
    );
    for (const t of repairs) {
      const original = f.w.collaboration.task(t.repairOf!);
      assert.deepEqual(t.permission, original.permission);
      assert.deepEqual(t.allocation, original.allocation);
    }
    const first = repairs.find((t) => t.workflow?.step === 'first')!,
      second = tasks.find((t) => t.workflow?.step === 'second' && !t.repairOf)!;
    assert.ok(
      second.startedAt! >= first.review!.at,
      'dependencies wait for actual acceptance of repaired attempt',
    );
    await until(() => f.summaries() === 1);
    const count = tasks.length;
    for (let i = 0; i < 30; i++) f.w.collaboration.kick();
    await delay(80);
    assert.equal(tasks.length, count);
    assert.equal(f.summaries(), 1);
    assert.match(r.followthrough!.summary!, /回执/);
  } finally {
    await f.close();
  }
});

test('two projects and model routes run concurrently and finish independent checks in their original bindings', async () => {
  let release = () => {};
  const hold = new Promise<void>((r) => (release = r)),
    f = await setup({ crossProject: true, hold: () => hold });
  try {
    await f.start();
    await until(
      () => f.w.collaboration.state.tasks.filter((t) => !t.assessment && t.status === 'running').length === 2,
    );
    release();
    const record = await f.finished();
    assert.equal(record.phase, 'completed', record.blockReason);
    const tasks = f.w.collaboration.state.tasks,
      implementations = tasks.filter((t) => !t.assessment);
    assert.equal(new Set(implementations.map((t) => t.cwd)).size, 2);
    assert.equal(new Set(implementations.map((t) => t.modelId)).size, 2);
    assert.equal(f.w.collaboration.state.goalContracts?.[0].goal.criteria[0].contributors.length, 2);
    for (const t of implementations) {
      assert.ok(t.contract!.binding!.project.id);
      assert.equal(JSON.parse(t.contract!.context).acceptance, undefined);
      assert.ok(!t.contract!.acceptance.some((c) => c.includes('两个项目')));
    }
    assert.equal(await readFile(join(f.cwd, 'result.txt'), 'utf8'), 'good');
    assert.equal(await readFile(join(f.home, 'other-project', 'second.txt'), 'utf8'), 'good');
    await assert.rejects(readFile(join(f.cwd, 'second.txt')));
    await assert.rejects(readFile(join(f.home, 'other-project', 'result.txt')));
    for (const t of tasks.filter((t) => t.assessment)) {
      const subject = f.w.collaboration.task(t.assessment!.subject);
      assert.equal(t.cwd, subject.cwd);
      assert.equal(t.modelId, subject.modelId);
      assert.notEqual(t.targetSession, subject.targetSession);
      assert.equal(t.status, 'succeeded');
      if (t.assessment!.kind === 'verify') {
        const receipt = t.receipts.find((r) => r.verification);
        assert.equal(receipt?.verification?.projectId, subject.contract!.binding!.project.id);
        assert.equal(receipt?.exitCode, 0);
        assert.equal(receipt?.manifest?.inputs.length, 2);
      }
    }
    assert.equal(tasks.length, 6);
    assert.equal(f.writes(), 2);
    const goals = f.w.collaboration.state.goalContracts;
    try {
      f.w.collaboration.state.goalContracts = undefined;
      await assert.rejects(f.w.collaboration.assurance.completion(implementations), /总目标契约缺失/);
    } finally {
      f.w.collaboration.state.goalContracts = goals;
    }
  } finally {
    release();
    await f.close();
  }
});

test('explicit integration reads both accepted project outputs through the same scheduler and independent audits', async () => {
  const f = await setup({ crossProject: true, integration: true });
  try {
    await f.start();
    const r = await f.finished();
    assert.equal(r.phase, 'completed', r.blockReason);
    const tasks = f.w.collaboration.state.tasks;
    const integration = tasks.find((t) => t.workflow?.step === 'integration')!;
    assert.equal(integration.contract!.binding!.readProjects.length, 1);
    assert.equal(integration.allocation?.paths, undefined);
    assert.equal(integration.dependsOn.length, 2);
    assert.equal(integration.status, 'succeeded');
    const audits = tasks.filter((t) => t.assessment?.subject === integration.id);
    assert.equal(audits.length, 2);
    for (const audit of audits) {
      assert.equal(audit.status, 'succeeded');
      assert.equal(audit.receipts.filter((r) => r.tool === 'read').length, 2);
      assert.equal(
        audit.receipts.some((r) => r.kind === 'command'),
        false,
      );
    }
    await assert.rejects(
      f.w.collaboration.assurance.completion(tasks.filter((t) => !t.assessment && t.id !== integration.id)),
      /缺少局部交付/,
    );
  } finally {
    await f.close();
  }
});

test('missing assessment evidence and exhausted repairs block instead of claiming success', async () => {
  for (const options of [{ noEvidence: true }, { alwaysBad: true }, { blockedEvidence: true }]) {
    const f = await setup(options);
    try {
      await f.start();
      const r = await f.finished();
      assert.equal(r.phase, 'blocked');
      assert.match(r.blockReason!, /证据|预算/);
      assert.ok(f.w.collaboration.state.tasks.filter((t) => t.repairOf).length <= 1);
      if ('blockedEvidence' in options)
        assert.equal(f.w.collaboration.state.tasks.filter((t) => t.repairOf).length, 0);
      assert.doesNotMatch(r.followthrough!.summary!, /· 已通过独立/);
    } finally {
      await f.close();
    }
  }
});

test('read-only research is independently checked against actual sources without adding command permission', async () => {
  const f = await setup({ research: true });
  try {
    await f.start();
    const r = await f.finished();
    assert.equal(r.phase, 'completed', r.blockReason);
    assert.equal(f.writes(), 0);
    const audit = f.w.collaboration.state.tasks.find((t) => t.assessment?.kind === 'verify')!;
    assert.equal(audit.status, 'succeeded');
    assert.ok(audit.receipts.some((r) => r.kind === 'read' && r.ok));
    assert.equal(
      audit.receipts.some((r) => r.kind === 'command'),
      false,
    );
  } finally {
    await f.close();
  }
});

test('pause retains receipts and resume completes without replay', async () => {
  let release = () => {};
  const hold = new Promise<void>((r) => (release = r));
  const f = await setup({ hold: () => hold });
  try {
    await f.start();
    await until(() => f.w.collaboration.state.tasks.some((t) => t.status === 'running'));
    f.w.collaboration.pause(true);
    release();
    await until(() => f.w.collaboration.state.tasks[0]?.status === 'needs_review');
    await delay(40);
    assert.equal(f.w.collaboration.state.tasks.length, 1);
    assert.equal(f.record().phase, 'paused');
    f.w.collaboration.pause(false);
    assert.equal((await f.finished()).phase, 'completed');
    assert.equal(f.writes(), 1);
  } finally {
    release();
    await f.close();
  }
});

test('busy master retains completion events and drains them once after its current turn', async () => {
  let releaseWorker = () => {},
    releaseMaster = () => {};
  const workerHold = new Promise<void>((r) => (releaseWorker = r)),
    masterHold = new Promise<void>((r) => (releaseMaster = r));
  const f = await setup({ hold: () => workerHold });
  try {
    await f.start();
    await f.root.controller!.agent.whenIdle();
    const original = f.provider.stream;
    f.provider.stream = async function* (req) {
      if (
        req.messages.findLast(
          (m) =>
            m.role === 'user' &&
            m.content.some((b) => b.type === 'text' && b.text.includes('busy-master-test')),
        ) &&
        !req.messages.some((m) =>
          m.content.some((b) => b.type === 'text' && b.text.includes('这是宿主基于实际回执生成的最终状态')),
        )
      ) {
        await masterHold;
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }
      yield* original.call(this, req);
    };
    f.root.controller!.agent.followup(
      createUserMessage({
        source: { kind: 'emergence-receipt', taskId: 'fixture' },
        content: [{ type: 'text', text: 'busy-master-test' }],
      }),
    );
    await until(() => f.root.controller!.busy);
    releaseWorker();
    await until(() => f.w.collaboration.state.tasks[0]?.status === 'needs_review');
    for (let n = 0; n < 20; n++) f.w.collaboration.kick();
    await delay(60);
    assert.equal(f.w.collaboration.state.tasks.length, 1);
    releaseMaster();
    assert.equal((await f.finished()).phase, 'completed');
    await until(() => f.summaries() === 1);
    assert.equal(f.writes(), 1);
  } finally {
    releaseWorker();
    releaseMaster();
    await f.close();
  }
});

test('host audit approval can be declined; resume does not reinterpret refusal as authorization', async () => {
  const f = await setup();
  try {
    f.root.controller!.launch.appConfig.permissions.rules.push({ tool: 'emergence_audit', effect: 'ask' });
    await f.start();
    await until(() => !!f.root.controller!.pending);
    assert.equal(f.record().phase, 'waiting-input');
    assert.equal(f.w.collaboration.state.tasks.length, 1);
    f.root.controller!.pending!.respond('n');
    assert.equal((await f.finished()).phase, 'blocked');
    f.w.collaboration.pause(true);
    f.w.collaboration.pause(false);
    await delay(50);
    assert.equal(f.w.collaboration.state.tasks.length, 1);
  } finally {
    await f.close();
  }
});

test('restart with an unreviewed result waits for explicit resume then audits without replaying implementation', async () => {
  let release = () => {};
  const hold = new Promise<void>((r) => (release = r));
  const f = await setup({ hold: () => hold });
  let restored: WorkspaceController | undefined;
  try {
    await f.start();
    await until(() => f.w.collaboration.state.tasks.some((t) => t.status === 'running'));
    f.w.collaboration.pause(true);
    release();
    await until(() => f.w.collaboration.state.tasks[0]?.status === 'needs_review');
    await f.w.close();
    restored = new WorkspaceController(f.ctx, f.launch);
    await restored.initialize();
    f.useWorkspace(restored);
    await delay(60);
    assert.equal(restored.collaboration.state.tasks.length, 1);
    assert.equal(restored.collaboration.state.mode, 'independent');
    restored.collaboration.configure(
      f.root.id,
      [...restored.panes.keys()].filter((id) => id !== f.root.id),
    );
    assert.equal((await f.finished()).phase, 'completed');
    assert.equal(f.writes(), 1);
  } finally {
    release();
    await restored?.close();
    await f.close();
  }
});

test('lost worker, takeover and uncertain effects never create blind repairs', async () => {
  for (const mode of ['missing', 'takeover', 'uncertain'] as const) {
    let release = () => {};
    const hold = new Promise<void>((r) => (release = r));
    const f = await setup({ hold: () => hold });
    try {
      await f.start();
      await until(() => f.w.collaboration.state.tasks.some((t) => t.status === 'running'));
      const task = f.w.collaboration.state.tasks[0];
      f.w.collaboration.pause(true);
      release();
      await until(() => task.status === 'needs_review');
      if (mode === 'uncertain') Object.assign(task, { recovery: 'uncertain' });
      else if (mode === 'takeover') await f.w.collaboration.takeover(task.target);
      else {
        f.w.panes.get(task.target)!.modelId = 'changed-model';
        Object.assign(task, {
          review: { accepted: false, evidence: 'fixture rejected', at: new Date().toISOString() },
        });
      }
      f.w.collaboration.pause(false);
      if (mode === 'takeover') {
        // Taking over an already-finished window does not authorize reusing it for repairs.
        await f.w.team.followthrough.cancel(f.root.id);
        assert.equal(f.record().phase, 'cancelled');
      } else assert.equal((await f.finished()).phase, 'blocked');
      assert.equal(f.w.collaboration.state.tasks.filter((t) => t.repairOf).length, 0);
    } finally {
      release();
      await f.close();
    }
  }
});

test('cancelled objective cannot be revived by late results or repeated events', async () => {
  let release = () => {};
  const hold = new Promise<void>((r) => (release = r));
  const f = await setup({ hold: () => hold });
  try {
    await f.start();
    await until(() => f.w.collaboration.state.tasks.some((t) => t.status === 'running'));
    const cancel = f.w.team.followthrough.cancel(f.root.id);
    release();
    await cancel;
    await delay(80);
    assert.equal(f.record().phase, 'cancelled');
    for (let n = 0; n < 10; n++) f.w.collaboration.kick();
    await delay(60);
    assert.equal(f.w.collaboration.state.tasks.length, 1);
    assert.equal(f.w.collaboration.state.tasks.filter((t) => t.assessment).length, 0);
  } finally {
    release();
    await f.close();
  }
});

test('aggregate budget stops followthrough and actual permission denial cannot be bypassed', async () => {
  for (const mode of ['budget', 'deny'] as const) {
    let release = () => {};
    const hold = new Promise<void>((r) => (release = r));
    const f = await setup({ hold: () => hold });
    try {
      await f.start();
      if (mode === 'budget') f.record().followthrough!.maxActions = 1;
      else
        f.root.controller!.launch.appConfig.permissions.rules.push({
          tool: 'emergence_audit',
          effect: 'deny',
        });
      release();
      const r = await f.finished();
      assert.equal(r.phase, 'blocked');
      assert.match(r.blockReason!, mode === 'budget' ? /预算/ : /权限禁止/);
      if (mode === 'deny') assert.equal(f.w.collaboration.state.tasks.length, 1);
    } finally {
      release();
      await f.close();
    }
  }
});

test('wall-clock budget expires visibly even while the queue is paused', async () => {
  let release = () => {};
  const hold = new Promise<void>((r) => (release = r));
  const f = await setup({ hold: () => hold });
  try {
    await f.start();
    await until(() => f.w.collaboration.state.tasks[0]?.status === 'running');
    f.w.collaboration.pause(true);
    release();
    await until(() => f.w.collaboration.state.tasks[0]?.status === 'needs_review');
    f.record().followthrough!.startedAt = Date.now() - f.config.orchestration.budgets.totalMs - 1;
    f.w.collaboration.pause(false);
    assert.equal((await f.finished()).phase, 'blocked');
    assert.match(f.record().blockReason!, /上限/);
    assert.equal(f.writes(), 1);
  } finally {
    release();
    await f.close();
  }
});

test('temporary audit capacity waits and resumes without consuming failed coordination actions', async () => {
  const f = await setup();
  try {
    const original = f.w.collaboration.assurance.request.bind(f.w.collaboration.assurance);
    let attempts = 0;
    f.w.collaboration.assurance.request = async (...args) => {
      if (attempts++ < 2) throw new AuditCapacityError('独立审查窗口正忙，等待释放后自动继续', true);
      return original(...args);
    };
    await f.start();
    await until(() => f.record().phase === 'waiting' && !!f.record().blockReason?.includes('审查窗口'));
    assert.equal(f.record().followthrough!.actions, 0);
    const record = await f.finished();
    assert.equal(record.phase, 'completed', record.blockReason);
    assert.equal(f.writes(), 1);
  } finally {
    await f.close();
  }
});

test('cancellation during asynchronous proof validation cannot commit acceptance', async () => {
  const f = await setup();
  let release = () => {};
  const hold = new Promise<void>((r) => (release = r));
  let validating = false;
  const status = f.w.collaboration.assurance.status.bind(f.w.collaboration.assurance);
  f.w.collaboration.assurance.status = async (id) => {
    const value = await status(id);
    if (value.review && value.verification) {
      validating = true;
      await hold;
    }
    return value;
  };
  try {
    await f.start();
    await until(() => {
      for (const p of f.w.panes.values())
        if (p.controller?.pending && f.w.collaboration.current(p.id)?.assessment?.kind === 'verify')
          p.controller.pending.respond('y');
      return validating;
    });
    await f.w.team.followthrough.cancel(f.root.id);
    release();
    await delay(50);
    assert.equal(f.record().phase, 'cancelled');
    assert.equal(f.w.collaboration.state.tasks[0].review, undefined);
  } finally {
    release();
    await f.close();
  }
});

test('explicit recovery after interrupted closure remains usable without reviving the old objective', async () => {
  let release = () => {};
  const hold = new Promise<void>((r) => (release = r));
  const f = await setup({ hold: () => hold });
  try {
    await f.start();
    await until(() => f.w.collaboration.state.tasks[0]?.status === 'running');
    f.w.collaboration.pause(true);
    release();
    const original = f.w.collaboration.state.tasks[0];
    await until(() => original.status === 'needs_review');
    // Simulate a restored crash record only after the live task has finished
    // settling; otherwise its legitimate final updates invalidate recovery approval.
    await until(() => !f.w.collaboration.active.has(original.target));
    await f.w.panes.get(original.target)!.controller!.agent.whenIdle();
    Object.assign(original, { status: 'interrupted', recovery: 'effects-returned' }); // Inject a recovered crash record.
    f.w.collaboration.pause(false);
    assert.equal((await f.finished()).phase, 'blocked');
    const recovering = f.w.collaboration.recover(
      original.id,
      f.root.id,
      '已核对真实文件；只重做当前文件的幂等写入',
    );
    await until(() => !!f.root.controller!.pending);
    f.root.controller!.pending!.respond('y');
    const recovered = await recovering;
    assert.ok(recovered);
    await until(() => recovered.status === 'needs_review');
    assert.equal(f.writes(), 2);
    assert.equal(f.record().phase, 'blocked');
    assert.equal(
      f.w.team.followthrough.owner(recovered.id),
      undefined,
      'manual recovery is not a stale event reopening the closed automatic goal',
    );
  } finally {
    release();
    await f.close();
  }
});

test('restart remains paused, accepted work is retained and never repeated', async () => {
  const f = await setup();
  let restored: WorkspaceController | undefined;
  try {
    await f.start();
    assert.equal((await f.finished()).phase, 'completed');
    const count = f.w.collaboration.state.tasks.length;
    await f.w.close();
    restored = new WorkspaceController(f.ctx, f.launch);
    await restored.initialize();
    await delay(50);
    assert.equal(restored.collaboration.state.mode, 'independent');
    assert.equal(restored.collaboration.state.paused, true);
    assert.equal(restored.team.records.at(-1)?.phase, 'completed');
    assert.equal(restored.collaboration.state.tasks.length, count);
    assert.equal(f.writes(), 1);
  } finally {
    await restored?.close();
    await f.close();
  }
});

test('two dependent deliveries close with exactly four host checks, including a superseded artifact', async () => {
  const f = await setup({ dependent: true, sharedArtifact: true });
  try {
    await f.start();
    const record = await f.finished();
    assert.equal(record.phase, 'completed', record.blockReason);
    assert.equal(await readFile(join(f.cwd, 'result.txt'), 'utf8'), 'good\n');
    const tasks = f.w.collaboration.state.tasks;
    assert.equal(tasks.length, 6, 'two deliveries and one verify + review per delivery');
    for (const task of tasks.filter((task) => !task.assessment)) {
      assert.equal(tasks.filter((audit) => audit.assessment?.subject === task.id).length, 2);
      assert.equal(task.status, 'succeeded');
    }
    await until(() => f.summaries() === 1);
    for (let i = 0; i < 20; i++) f.w.collaboration.kick();
    await delay(60);
    assert.equal(tasks.length, 6);
    assert.equal(f.summaries(), 1);
  } finally {
    await f.close();
  }
});

test('a final artifact change blocks automatic closure instead of reporting historic success', async () => {
  const f = await setup();
  const original = f.w.collaboration.assurance.completion.bind(f.w.collaboration.assurance);
  f.w.collaboration.assurance.completion = async (tasks) => {
    await writeFile(join(f.cwd, 'result.txt'), 'external mutation after checks');
    return original(tasks);
  };
  try {
    await f.start();
    const record = await f.finished();
    assert.equal(record.phase, 'blocked');
    assert.match(record.blockReason!, /最终版本|变化/);
    assert.match(record.followthrough!.summary!, /未完成/);
    assert.equal(f.w.collaboration.state.tasks.length, 3);
  } finally {
    await f.close();
  }
});

test('planner receives redundant assurance feedback and resubmits only the delivery graph', async () => {
  const f = await setup({ redundantAudit: true });
  try {
    await f.start();
    const record = await f.finished();
    assert.equal(record.phase, 'completed', record.blockReason);
    assert.equal(f.w.collaboration.state.tasks.length, 3);
    assert.equal(f.writes(), 1);
    assert.ok(
      f.root
        .controller!.agent.session.snapshotEvents()
        .some(
          (event) =>
            event.type === 'tool/result' && JSON.stringify(event.data).includes('HOST_OWNS_ASSURANCE'),
        ),
    );
  } finally {
    await f.close();
  }
});
