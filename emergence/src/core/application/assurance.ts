import { schemaParameter, protocolInput, parseProtocol } from '../adapters/tool-protocol.ts';
import { defineTool, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import { isAbsolute, relative, resolve } from 'node:path';
import { canonicalPermissionPath } from '../adapters/permissions.ts';
import type { EvidenceReceipt } from '../domain/assurance.ts';
import {
  claimsSchema,
  isSuccessfulObservation,
  isSuccessfulExecutionCheck,
  type Assessment,
} from '../domain/assurance.ts';
import { roles } from '../domain/orchestration.ts';
import { isReadOnlyTask, type TaskRecord } from '../domain/task.ts';
import { toolContract } from '../domain/tool-contract.ts';
import { digest, stableDigest } from '../storage/execution-journal.ts';
import { AuditCapacityError, availableAuditContext, independentAuditContext } from './audit-allocation.ts';
import { fileFingerprint } from './execution-evidence.ts';
import { completionArtifacts } from './completion-evidence.ts';
import { auditInstructions, auditTaskContract } from './task-admission.ts';
import type { Collaboration } from './task-coordinator.ts';
import { captureToolEvidence, evidenceIsCurrent } from './tool-evidence.ts';
import { safeError } from '../adapters/redaction.ts';
import { evaluatePermissions, permissionFingerprint } from '../adapters/permissions.ts';
import {
  prepareVerification,
  verificationCovered,
  verificationGaps,
  verificationRequirements,
} from './verification.ts';
import { mountInspection } from './inspection.ts';
import { unresolvedTaskErrors } from '../domain/task-failure.ts';
import { resolvedEvidenceCurrent } from './task-failures.ts';

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
  private requesting = new Map<string, Promise<TaskRecord>>();
  private reserved = new Set<string>();
  private recording = new WeakMap<TaskRecord, number>();
  constructor(
    private c: Pick<
      Collaboration,
      'workspace' | 'state' | 'task' | 'configure' | 'enqueue' | 'current' | 'view' | 'lifecycle'
    >,
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
  async request(
    id: string,
    kind: Assessment['kind'],
    requester: string,
    target?: string,
    guard?: () => boolean,
  ): Promise<TaskRecord> {
    if (this.w.executionScope === 'session')
      throw new Error('跨窗口审查已移除；请在当前会话检查产物，或自行在另一窗口提交审查任务');
    const key = id + ':' + kind;
    const pending = this.requesting.get(key);
    if (pending) {
      await pending.catch(() => undefined);
      // Re-enter admission: joining a request never inherits another caller's authorization.
      return this.request(id, kind, requester, target, guard);
    }
    const request = this.requestOnce(id, kind, requester, target, guard);
    this.requesting.set(key, request);
    try {
      return await request;
    } finally {
      this.requesting.delete(key);
    }
  }
  private async requestOnce(
    id: string,
    kind: Assessment['kind'],
    requester: string,
    target?: string,
    guard?: () => boolean,
  ) {
    const valid = guard ?? (() => true);
    const initialMaster = this.c.state.master,
      initialMode = this.c.state.mode;
    const assertCoordinator = () => {
      // A completed local task may create its first independent audit window.
      // Existing coordination must not be silently reactivated or taken over.
      if (
        !valid() ||
        this.c.state.paused ||
        (initialMaster && initialMaster !== requester) ||
        this.c.state.master !== initialMaster ||
        this.c.state.mode !== initialMode
      )
        throw new Error('协调已暂停或取消，或主控已变化，未派发审查');
    };
    assertCoordinator();
    const subject = this.c.task(id),
      source = this.w.panes.get(requester)?.controller;
    if (!source?.core.enabled || requester !== subject.issuer || source.id !== subject.issuerSession)
      throw new Error('只能由原派发会话请求审查验证');
    if (
      !['review', 'verify'].includes(kind) ||
      !subject.contract ||
      subject.assessment ||
      !['needs_review', 'succeeded'].includes(subject.status) ||
      subject.recovery === 'uncertain'
    )
      throw new Error('任务尚不可审查验证；不能递归审查审查任务');
    const version = await this.version(subject),
      previous = this.c.state.tasks.filter((t) => t.assessment?.subject === id && t.assessment.kind === kind);
    assertCoordinator();
    const requestKey = 'audit-v2-' + digest({ id, kind, version });
    if (
      this.c.state.tasks.some(
        (task) =>
          task.issuerSession === subject.issuerSession &&
          task.requestKey === requestKey &&
          task.assessment?.version !== version,
      )
    )
      throw new Error('核验唯一键与版本记录冲突，需要核对历史记录');
    const existing = previous.find((task) => task.assessment!.version === version);
    if (existing) {
      if (target && target !== existing.target)
        throw new Error('同一版本已有独立核验，不能通过改窗口重复创建');
      const status = await this.status(id);
      assertCoordinator();
      const entry = status.entries.find((entry) => entry.id === existing.id);
      if (!entry?.current) throw new Error('核验回执已失效，需要核对变化并修复原任务，不能重复创建核验');
      return existing;
    }
    if (
      previous.some(
        (t) =>
          !['succeeded', 'failed', 'needs_review', 'cancelled', 'blocked', 'interrupted'].includes(t.status),
      ) ||
      previous.length >= 2
    )
      throw new Error('审查验证仍在进行或已达到每种两次上限');
    if (source.permissionMode === 'plan') throw new Error('计划模式不能派发审查任务');
    if (this.c.state.tasks.length >= 500)
      throw new Error('当前工作台已达到 500 条任务记录上限，请使用新工作台');
    // Validate all task data before allocating a session. The durable subject reference
    // supplies the original goal; host instructions are rendered separately from context.
    const contract = auditTaskContract(subject, kind);
    const objective = `独立${kind === 'review' ? '审查' : '验证'}任务 ${id}`;
    const model =
      roles(this.w.launch.appConfig.orchestration).find((r) => r.id === contract.role)?.modelId ??
      subject.modelId;
    const candidates = [...this.w.panes.values()].filter((p) =>
      independentAuditContext(this.w, p, subject, kind, model),
    );
    const reusable = candidates.find((p) => availableAuditContext(this.w, p, this.reserved));
    if (!target && !reusable && !this.w.paneCapacity.available) {
      const retryable = candidates.length > 0 || this.w.paneCapacity.pending > 0;
      throw new AuditCapacityError(
        retryable
          ? '独立审查窗口正忙，等待释放后自动继续'
          : '窗口已满且没有独立审查上下文；请释放一个窗口或新建空白会话',
        retryable,
      );
    }
    const focused = this.w.focused;
    let created: { id: string; session: string; sequence: number } | undefined;
    let reserved: string | undefined;
    try {
      const pane = target
        ? this.w.panes.get(target)
        : (reusable ?? (await this.w.split('row', subject.cwd, model)));
      if (!target && !reusable && pane?.controller?.id)
        created = {
          id: pane.id,
          session: pane.controller.id,
          sequence: pane.controller.agent.session.snapshotEvents().at(-1)?.seq ?? 0,
        };
      if (guard && pane && this.w.focused === pane.id && this.w.panes.has(focused)) {
        this.w.focused = focused;
        this.w.changed();
      }
      assertCoordinator();
      if (!pane?.controller || !independentAuditContext(this.w, pane, subject, kind, model))
        throw new Error(
          '需要同项目、匹配模型的独立审查上下文；不能复用实施或个人对话；审查与验证需要不同会话',
        );
      if (!availableAuditContext(this.w, pane, this.reserved))
        throw new AuditCapacityError('独立审查窗口正忙或已被用户接管，等待可用资源', true);
      this.reserved.add(pane.id);
      reserved = pane.id;
      if (!this.c.state.workers.includes(pane.id) || this.c.state.mode !== 'collaborate')
        this.c.configure(
          requester,
          [...new Set([...this.c.state.workers.filter((p) => p !== requester), pane.id])],
          this.c.state.autoWorkers,
        );
      return await this.c.enqueue(requester, pane.id, requestKey, objective, [], contract, undefined, {
        assessment: { subject: id, kind, version },
        permission: subject.permission,
        ...(isReadOnlyTask(subject)
          ? { allocation: { access: 'read' as const, reason: '继承原任务的只读执行契约' } }
          : {}),
      });
    } catch (error) {
      if (created) {
        try {
          await this.w.discardUnusedPane(created.id, created.session, created.sequence);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            '审查未派发，临时窗口回收失败；请核对窗口和存储状态',
          );
        }
      }
      throw error;
    } finally {
      if (reserved) this.reserved.delete(reserved);
    }
  }
  context(task: TaskRecord): string {
    if (!task.assessment) return '';
    const subject = this.c.task(task.assessment.subject);
    const source = this.w.panes.get(subject.issuer)?.controller;
    const methods = source?.core.catalog?.roles
      .filter((r) => ['meta-prism', 'meta-warden', 'meta-sentinel'].includes(r.id))
      .map((r) => ({
        name: r.name,
        responsibility: r.responsibility.slice(0, 180),
        boundary: r.boundary.slice(0, 120),
      }));
    return (
      auditInstructions(subject, task.assessment) +
      '\n治理职责参考（不授予权限）：' +
      JSON.stringify(methods ?? [])
    );
  }

  async submit(task: TaskRecord, input: unknown) {
    const a = task.assessment;
    if (!a || a.checks || this.c.current(task.target) !== task)
      throw new Error('当前没有可提交的独立审查验证');
    const subject = this.c.task(a.subject),
      checks = claimsSchema.parse(input);
    if ((await this.version(subject)) !== a.version) throw new Error('审查期间产物已变化，结论失效');
    if (
      checks.length !== subject.contract!.acceptance.length ||
      new Set(checks.map((c) => c.criterion)).size !== checks.length ||
      checks.some((c) => c.criterion >= checks.length)
    )
      throw new Error('必须逐项覆盖所有验收标准');
    for (const check of checks)
      for (const id of check.receipts) {
        const receipt = task.receipts.find((r) => r.id === id);
        if (!receipt || !['read', 'command'].includes(receipt.kind) || (check.passed && !receipt.ok))
          throw new Error(
            `验收项 ${check.criterion} 引用的读取或命令回执 ${id} 不存在、失败或不属于本审查上下文；用 emergence_receipts 的 own.id，不要手写或改动编号`,
          );
        if (!(await evidenceIsCurrent(receipt)))
          throw new Error(`回执 ${id} 的输入或产物已变化或无法核对，证据失效`);
      }
    const executionVerification = a.kind === 'verify' && !isReadOnlyTask(subject);
    const gaps = executionVerification ? verificationGaps(subject.contract, checks, task.receipts) : [];
    if (gaps.length)
      throw new Error(
        '局部验收缺少本项目对应 VerificationSpec 的成功回执；其他目录或任意成功命令不能代替\n' +
          JSON.stringify({
            code: 'VERIFICATION_EVIDENCE_REQUIRED',
            gaps,
            note: '每个缺口的 criterion 都须在自己的 receipts 数组引用对应成功候选；仅在另一个验收项或 note 中引用不算。候选提交时仍复核版本；不必重跑已经有效的命令。无候选时执行契约中的精确检查，或如实报告受阻。',
          }),
      );
    if (
      checks.some(
        (c) =>
          c.passed &&
          !c.receipts.some((id) => {
            const r = task.receipts.find((r) => r.id === id)!;
            return isSuccessfulObservation(r, executionVerification);
          }),
      )
    )
      throw new Error('通过的验收项缺少实际成功的读取或检查回执');
    // Every implementation needs an actual check. Native file predicates serve text artifacts;
    // explicit runtime specifications still require their matching command receipts above.
    if (
      executionVerification &&
      checks.every((c) => c.passed) &&
      !checks.some((c) =>
        c.receipts.some((id) => {
          const r = task.receipts.find((r) => r.id === id)!;
          return isSuccessfulExecutionCheck(r);
        }),
      )
    )
      throw new Error(
        '整体验证须引用实际成功检查：命令退出码为 0，或 emergence_verify_file 原生文件断言通过；普通 read/inspect 不能代替检查，VerificationSpec 仍须对应精确命令',
      );
    this.c.lifecycle.amend(task, { assessment: { ...a, checks, submittedAt: new Date().toISOString() } });
    await this.w.save();
    return '逐项证据已记录；请 emergence_report 结束任务。最终状态仍取决于实际工具回执。';
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
          let receipt: EvidenceReceipt | undefined;
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
              receipt = captured;
              this.c.lifecycle.recordReceipt(task, captured);
              await this.w.save();
            },
          );
          if (task.assessment && receipt && ['read', 'command'].includes(receipt.kind))
            return {
              ...result,
              content: [
                ...result.content,
                {
                  type: 'text' as const,
                  text:
                    '[Emergence 宿主实际回执] ' +
                    JSON.stringify(receipt) +
                    '；可用 emergence_receipts 查询；提交证据使用这里的 id。',
                },
              ],
            };
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
            '查询本独立审查会话的真实证据编号、文件字节大小/末尾换行/BOM与命令退出码；emergence_assess 只引用 own 中的 id。只读，不产生新证据。',
          parameters: {},
          output: {
            schema: { type: 'json' },
            render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }],
          },
          execute: async (_args, exec) => {
            const task = this.c.state.tasks.find(
              (t) =>
                t.assessment && t.targetSession === exec.agent?.session.id && this.c.current(t.target) === t,
            );
            if (!task) throw new Error('独立审查上下文失效');
            const subject = this.c.task(task.assessment!.subject);
            return JSON.parse(
              JSON.stringify({
                task: task.id,
                own: task.receipts,
                verificationRequirements:
                  task.assessment!.kind === 'verify' && !isReadOnlyTask(subject)
                    ? verificationRequirements(subject.contract, task.receipts)
                    : [],
                independentVerification: (await this.status(subject.id)).entries.filter(
                  (e) => e.kind === 'verify',
                ),
                implementation: {
                  task: subject.id,
                  dataDeliveries: this.dataDeliveries(subject),
                  artifacts: subject.artifactVersions,
                  receipts: subject.receipts,
                  errors: subject.result?.errors,
                  failures: subject.result?.failures,
                },
                meaning:
                  'receipts 字段仅引用 own.id。verificationRequirements 中每个 criteria 索引均须在自身 checks.receipts 引用对应匹配的命令回执，可同时引用读取证据；仅在另一个验收项引用不算。只读审查可以结合 independentVerification 中 passed=true 且 current=true 的独立验证结论判断运行类验收项，在 note 注明验证任务 ID；不需重新运行 Shell，也不能将其说成本会话执行。实施者回执不等于独立验证。文件字节信息对应读取时版本，提交时仍会检查变化。',
              }),
            );
          },
        }),
        {
          when: ({ agent }) =>
            this.c.state.tasks.some(
              (t) => t.assessment && t.targetSession === agent.session.id && this.c.current(t.target) === t,
            ),
        },
      ),
      ctx.tools.register(
        defineTool({
          name: 'emergence_assess',
          description:
            '独立审查/验证逐项证据：checks 为 [{criterion:0,passed:true,receipts:[emergence_receipts 的 own.id],note:说明}]。无法判定设置 passed:false,blocked:true；已观察到真实缺陷才仅 passed:false。不能猜测编号或伪造测试通过。',
          parameters: {
            checks: schemaParameter(claimsSchema),
            checks_json: { type: 'string', description: 'Deprecated v0.1 compatibility; use checks.' },
          },
          output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
          execute: async (args, exec) => {
            const task = this.c.state.tasks.find(
              (t) => t.targetSession === exec.agent?.session.id && this.c.current(t.target) === t,
            );
            if (!task) throw new Error('审查上下文失效');
            return this.submit(
              task,
              parseProtocol(claimsSchema, protocolInput(args, 'checks', 'checks_json')),
            );
          },
        }),
        {
          when: ({ agent }) =>
            this.c.state.tasks.some(
              (t) => t.assessment && t.targetSession === agent.session.id && this.c.current(t.target) === t,
            ),
        },
      ),
      ...(this.w.executionScope === 'workspace'
        ? [
            ctx.tools.register(
              defineTool({
                name: 'emergence_audit',
                description:
                  '为已结束的契约任务派发独立审查或验证。同一任务、产物版本、种类和规则版本只创建一次，重复请求返回原记录（包括失败）；修复后核验修复任务。验证命令仍须原权限审批。',
                parameters: {
                  task_id: { type: 'string', required: true },
                  kind: { type: 'string', enum: ['review', 'verify'], required: true },
                  target: { type: 'string' },
                },
                output: {
                  schema: { type: 'json' },
                  render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }],
                },
                execute: async (args, exec) => {
                  const pane = [...this.w.panes.values()].find(
                    (p) => p.controller?.id === exec.agent?.session.id,
                  );
                  if (!pane) throw new Error('会话失效');
                  return this.c.view(
                    await this.request(args.task_id, args.kind as Assessment['kind'], pane.id, args.target),
                  );
                },
              }),
              {
                when: ({ agent }) =>
                  this.w.executionScope === 'workspace' &&
                  this.c.state.tasks.some(
                    (t) =>
                      !t.assessment &&
                      t.contract &&
                      t.issuerSession === agent.session.id &&
                      ['needs_review', 'succeeded'].includes(t.status),
                  ),
              },
            ),
          ]
        : []),
    ];
  }
}
