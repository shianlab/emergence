import { defineTool, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  canonicalPermissionPath,
  evaluatePermissions,
  permissionFingerprint,
} from '../adapters/permissions.ts';
import { safeError } from '../adapters/redaction.ts';
import { isSuccessfulExecutionCheck, isSuccessfulObservation } from '../domain/assurance.ts';
import { unresolvedTaskErrors } from '../domain/task-failure.ts';
import { isReadOnlyTask, type TaskRecord } from '../domain/task.ts';
import { toolContract } from '../domain/tool-contract.ts';
import { digest, stableDigest } from '../storage/execution-journal.ts';
import { completionArtifacts } from './completion-evidence.ts';
import { fileFingerprint } from './execution-evidence.ts';
import { mountInspection } from './inspection.ts';
import type { TaskEngine } from './task-engine.ts';
import { resolvedEvidenceCurrent } from './task-failures.ts';
import { captureToolEvidence, evidenceIsCurrent } from './tool-evidence.ts';
import { prepareVerification, verificationCovered, verificationRequirements } from './verification.ts';

/** Shared version identity for live assurance and read-only evidence replay. */
export function subjectEvidenceVersion(task: TaskRecord, files: Array<{ path: string; hash: string }>) {
  return stableDigest({
    rules: 'emergence-assurance-v2',
    task: task.id,
    run: task.runId,
    session: task.targetSession,
    contract: task.contract,
    permission: task.permission,
    followup: task.followup,
    result: task.result,
    files,
  });
}

/** Evidence is recorded by the host; a model can cite it but cannot manufacture a receipt. */
export class CoreAssurance {
  private recording = new WeakMap<TaskRecord, number>();
  constructor(
    private c: Pick<TaskEngine, 'workspace' | 'state' | 'task' | 'current' | 'view' | 'lifecycle'>,
  ) {}
  private get w() {
    return this.c.workspace;
  }
  dataDeliveries(task: TaskRecord) {
    const receipts = task.receipts.filter(
      (r) => r.tool === 'emergence_data_analyze' && r.ok && r.manifest?.contract.authority === 'host',
    );
    return {
      omitted: receipts.length > 4,
      runs: receipts.slice(-4).map((r) => ({
        receipt: r.id,
        argumentsHash: r.argumentsHash,
        inputs: r.manifest!.inputs,
        files: r.manifest!.outputs.filter((o) =>
          /[\\/](request|result|manifest|definition)\.json$|[\\/]report\.html$/.test(o.path),
        ),
      })),
    };
  }
  async version(task: TaskRecord) {
    return this.subjectVersion(task);
  }
  private artifactPath(task: TaskRecord, path: string, nativeOutputs: Set<string>) {
    const root = canonicalPermissionPath(task.cwd, task.cwd),
      physical = canonicalPermissionPath(path, task.cwd),
      rel = relative(root, physical);
    if (
      !nativeOutputs.has(path) &&
      (isAbsolute(rel) || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../'))
    )
      throw new Error('产物超出任务项目，不能作为项目内证据');
    return physical;
  }
  reportArtifactIssues(task: TaskRecord, paths: string[]) {
    const nativeOutputs = new Set(
      task.receipts
        .filter(
          (r) => r.tool === 'emergence_data_analyze' && r.ok && r.manifest?.contract.authority === 'host',
        )
        .flatMap((r) => r.manifest!.outputs.map((output) => output.path)),
    );
    return paths.flatMap((path, index) => {
      try {
        this.artifactPath(task, resolve(task.cwd, path), nativeOutputs);
        return [];
      } catch (error) {
        return [{ path: `artifacts.${index}`, message: safeError(error) }];
      }
    });
  }
  private async subjectVersion(task: TaskRecord, superseded = new Map<string, string>()) {
    if (!(await resolvedEvidenceCurrent(task))) throw new Error('失败的替代证据已经失效，需要重新核对');
    const dataReceipts = task.receipts.filter(
      (r) => r.tool === 'emergence_data_analyze' && r.ok && r.manifest?.contract.authority === 'host',
    );
    for (const receipt of dataReceipts)
      if (!(await evidenceIsCurrent(receipt))) throw new Error('数据输入或交付产物已变化，旧分析证据失效');
    const nativeOutputs = new Set(dataReceipts.flatMap((r) => r.manifest!.outputs.map((o) => o.path)));
    const paths = [
      ...new Set([
        ...nativeOutputs,
        ...task.artifactVersions.map((a) => a.path),
        ...(task.result?.artifacts ?? []).map((p) => resolve(task.cwd, p)),
      ]),
    ];
    if (paths.length > 60) throw new Error('产物超过核对预算，请拆分任务');
    const files = [];
    for (const path of paths) {
      const physical = this.artifactPath(task, path, nativeOutputs);
      const hash = superseded.get(physical) ?? (await fileFingerprint(path));
      if (hash.startsWith('unknown:')) throw new Error('产物无法可靠核对');
      const original = task.artifactVersions.find((v) => v.path === path);
      if (original && original.hash !== hash)
        throw new Error('产物已改变，旧任务证据失效，请先修复或重新执行');
      files.push({ path, hash });
    }
    return subjectEvidenceVersion(task, files);
  }
  async status(id: string) {
    return this.inspect(id);
  }
  private async inspect(id: string, superseded = new Map<string, string>()) {
    const subject = this.c.task(id);
    let version = '',
      stale = '';
    try {
      version = await this.subjectVersion(subject, superseded);
    } catch (e) {
      stale = String(e);
    }
    const entries = await Promise.all(
      this.c.state.tasks
        .filter((t) => t.assessment?.subject === id)
        .map(async (t) => {
          const cited = new Set(t.assessment!.checks?.flatMap((c) => c.receipts) ?? []);
          const receipts = t.receipts.filter((r) => cited.has(r.id));
          const observed = await Promise.all(
            receipts.map((receipt) => evidenceIsCurrent(receipt, superseded)),
          );
          const current =
            !!version &&
            t.assessment!.version === version &&
            receipts.length === cited.size &&
            observed.every(Boolean) &&
            (await resolvedEvidenceCurrent(t)) &&
            receipts.every(
              (receipt) =>
                receipt.manifest?.taskId === t.id &&
                receipt.manifest.runId === t.runId &&
                receipt.manifest.sessionId === t.targetSession,
            );
          const checks = t.assessment!.checks ?? [];
          const complete =
            checks.length === subject.contract?.acceptance.length &&
            new Set(checks.map((check) => check.criterion)).size === checks.length &&
            checks.every(
              (check) =>
                check.criterion < checks.length &&
                check.passed &&
                check.receipts.some((id) =>
                  receipts.some(
                    (receipt) =>
                      receipt.id === id &&
                      isSuccessfulObservation(
                        receipt,
                        t.assessment!.kind === 'verify' && !isReadOnlyTask(subject),
                      ),
                  ),
                ),
            ) &&
            (t.assessment!.kind !== 'verify' ||
              isReadOnlyTask(subject) ||
              (receipts.some(isSuccessfulExecutionCheck) &&
                verificationCovered(subject.contract, checks, receipts)));
          return {
            id: t.id,
            kind: t.assessment!.kind,
            session: t.targetSession,
            status: t.status,
            current,
            passed:
              t.status === 'succeeded' &&
              t.report?.outcome === 'success' &&
              !!t.result &&
              current &&
              !unresolvedTaskErrors(t).length &&
              t.recovery !== 'uncertain' &&
              t.targetSession !== subject.targetSession &&
              !!checks.length &&
              complete,
            checks: t.assessment!.checks ?? [],
          };
        }),
    );
    return {
      task: id,
      version,
      stale,
      execution: subject.endedAt ? '已结束' : '未结束',
      review: entries.some((e) => e.kind === 'review' && e.passed),
      verification: entries.some((e) => e.kind === 'verify' && e.passed),
      userAcceptance: subject.review?.actor === 'user' ? subject.review.accepted : null,
      entries,
    };
  }
  async completion(tasks: TaskRecord[]) {
    if (!tasks.length) throw new Error('没有可验收的交付任务');
    for (const plan of new Set(tasks.flatMap((t) => (t.workflow ? [t.workflow.plan] : [])))) {
      const goal = this.c.state.goalContracts?.find((g) => g.plan === plan)?.goal;
      if (!goal) {
        if (tasks.some((t) => t.workflow?.plan === plan && t.contract?.binding?.criterionIds.length))
          throw new Error('总目标契约缺失，不能用局部成功替代整体完成');
        continue;
      }
      for (const criterion of goal.criteria)
        for (const contribution of criterion.contributors) {
          const task = tasks.find((t) => t.workflow?.plan === plan && t.workflow.step === contribution.step);
          if (!task || task.contract?.binding?.criterionIds[contribution.criterion] !== criterion.id)
            throw new Error(`总目标 ${criterion.id} 缺少局部交付 ${contribution.step}，不能汇总为通过`);
        }
    }
    const facts = () =>
      digest([
        ...tasks,
        ...(this.c.state.goalContracts ?? []).filter((g) => tasks.some((t) => t.workflow?.plan === g.plan)),
        ...this.c.state.tasks.filter((audit) => tasks.some((task) => task.id === audit.assessment?.subject)),
      ]);
    const snapshot = facts();
    const { final, superseded } = completionArtifacts(tasks, this.c.state.tasks);
    for (const task of tasks) {
      if (
        task.status !== 'succeeded' ||
        !task.review?.accepted ||
        task.recovery === 'uncertain' ||
        task.report?.outcome !== 'success' ||
        !task.result ||
        unresolvedTaskErrors(task).length
      )
        throw new Error(`任务 ${task.id} 尚未成功交付并验收`);
      const status = await this.inspect(task.id, superseded.get(task.id));
      if (!status.review || !status.verification)
        throw new Error(
          `任务 ${task.id} 缺少最终版本的独立审查与验证证据：${status.stale || '回执失效或不完整'}`,
        );
    }
    for (const [path, hash] of final)
      if (hash.startsWith('unknown:') || (await fileFingerprint(path)) !== hash)
        throw new Error('最终产物发生变化或无法读取：' + path);
    if (facts() !== snapshot) throw new Error('验收期间任务或核验记录发生变化，不能宣布完成');
  }
  async proof(id: string, requester: string) {
    const task = this.c.task(id),
      pane = this.w.panes.get(requester);
    if (
      !pane?.controller ||
      canonicalPermissionPath(pane.controller.cwd, pane.controller.cwd) !==
        canonicalPermissionPath(task.cwd, task.cwd)
    )
      throw new Error('经验来源不属于当前项目或任务会话');
    const status = await this.status(id);
    if (
      !status.review ||
      !status.verification ||
      task.recovery === 'uncertain' ||
      task.review?.accepted === false ||
      unresolvedTaskErrors(task).length
    )
      throw new Error('经验缺少当前版本的独立审查与验证');
    return digest({
      version: status.version,
      evidence: status.entries.filter((e) => e.passed).map((e) => e.id),
    });
  }
  mount() {
    const ctx = this.w.ctx;
    return [
      ...mountInspection(this.w),
      ctx.on('tools/execute', async (exec, next) => {
        const task = this.c.state.tasks.find(
          (t) => t.targetSession === exec.agent?.session.id && this.c.current(t.target) === t,
        );
        if (!task || !exec.agent || toolContract(exec.name, exec.arguments).evidence === 'none')
          return next();
        const recording = this.recording.get(task) ?? 0;
        if (task.receipts.length + recording >= 128)
          throw new Error('任务证据预算已耗尽，请结束本次任务或拆分工作');
        this.recording.set(task, recording + 1);
        try {
          const runId = task.runId;
          const owner = this.w.panes.get(task.target)?.controller;
          if (!owner) throw new Error('证据工具所属窗口已不存在');
          const permissionVersion = () =>
            permissionFingerprint([owner.permissionSnapshot(), ...owner.permissionConstraints(exec.agent)]);
          const beforePermission = permissionVersion();
          const verification = await prepareVerification(
            task,
            exec.name,
            exec.arguments,
            (file_path) =>
              evaluatePermissions([owner.permissionSnapshot(), ...owner.permissionConstraints(exec.agent)], {
                name: 'read',
                arguments: { file_path },
                cwd: task.cwd,
                actor: exec.agent!.id,
              }).effect === 'allow',
          );
          exec.signal.throwIfAborted();
          if (
            this.c.current(task.target) !== task ||
            task.runId !== runId ||
            this.w.panes.get(task.target)?.controller !== owner ||
            permissionVersion() !== beforePermission
          )
            throw new Error('证据准备期间执行归属或权限已变化，未执行工具');
          const contract = toolContract(exec.name, exec.arguments);
          const definition =
            contract.operation === 'read' && !contract.sideEffect
              ? ctx.tools.executable(exec.name, exec.agent, exec.toolSet)
              : undefined;
          // Observe the same native schema; only its typed INVALID_ARGS result can confirm rejection.
          const invalidInput =
            !!definition && validateJsonSchemaValue(definition.parameters, exec.arguments).length > 0;
          const result = await captureToolEvidence(
            {
              callId: exec.callId,
              name: exec.name,
              arguments: exec.arguments,
              cwd: this.w.ctx.workingDirectory.get(exec.agent.session),
              taskId: task.id,
              runId,
              sessionId: exec.agent.session.id,
              modelId: task.modelId,
              signal: exec.signal,
              verification: verification?.identity,
              verificationInputs: verification?.inputs,
              invalidInput,
            },
            next,
            async (captured) => {
              if (task.runId !== runId) throw new Error('执行归属已变化，不能把旧回执写入新运行');
              this.c.lifecycle.recordReceipt(task, captured);
              await this.w.save();
            },
          );
          return result;
        } finally {
          const remaining = (this.recording.get(task) ?? 1) - 1;
          if (remaining) this.recording.set(task, remaining);
          else this.recording.delete(task);
        }
      }),
      ctx.tools.register(
        defineTool({
          name: 'emergence_receipts',
          description:
            '查询当前计划任务由宿主记录的真实工具回执、文件信息和验证规格。只读；不产生新证据或验收结论。',
          parameters: {},
          output: {
            schema: { type: 'json' },
            render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }],
          },
          execute: async (_args, exec) => {
            const task = this.c.state.tasks.find(
              (t) => t.targetSession === exec.agent?.session.id && this.c.current(t.target) === t,
            );
            if (!task) throw new Error('当前没有正在执行的计划任务');
            return JSON.parse(
              JSON.stringify({
                task: task.id,
                own: task.receipts,
                verificationRequirements: verificationRequirements(task.contract, task.receipts),
                dataDeliveries: this.dataDeliveries(task),
              }),
            );
          },
        }),
        {
          when: ({ agent }) =>
            this.c.state.tasks.some(
              (t) => t.targetSession === agent.session.id && this.c.current(t.target) === t,
            ),
        },
      ),
    ];
  }
}
