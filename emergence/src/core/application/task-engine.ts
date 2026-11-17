import type { TaskState } from '../domain/task-state.ts';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { taskDiagnostics } from '../domain/task-diagnostics.ts';
import { mountTaskTools } from '../adapters/task-tools.ts';
import { evaluatePermissions, permissionFingerprint } from '../adapters/permissions.ts';
import { safeError } from '../adapters/redaction.ts';
import { unresolvedTaskErrors } from '../domain/task-failure.ts';
import { resolvedEvidenceCurrent } from './task-failures.ts';
import { TaskExecution } from '../adapters/task-execution.ts';
import { contractSchema, roles } from '../domain/orchestration.ts';
import { planSchema, type TaskPlan } from '../domain/planning.ts';
import { advanceClock } from '../domain/run-budget.ts';
import {
  activeTaskStatuses as activeStatus,
  taskLabels,
  taskSchema,
  settledTaskStatuses as terminal,
  type TaskRecord,
} from '../domain/task.ts';
import { ExecutionJournal, digest } from '../storage/execution-journal.ts';
import { CoreAssurance } from './assurance.ts';
import { fileFingerprint } from './execution-evidence.ts';
import type { WorkspacePort as WorkspaceController } from './runtime-ports.ts';
import { assertPlanAdmission, planTaskContract } from './task-admission.ts';
import { TaskBudgetMonitor } from './task-budgets.ts';
import { TaskLifecycle } from './task-lifecycle.ts';
import { TaskRecovery } from './task-recovery.ts';
import { TaskScheduler } from './task-scheduler.ts';
import { observeDispatch, executionGraphKey, AllocationChanged } from './dispatch-admission.ts';
import { allocationRevision } from './allocation-snapshot.ts';
import { assertProjectBinding, bindProjectContract } from './project-contract.ts';
import { freezeVerification } from './verification.ts';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'emergence-task': { kind: 'emergence-task'; taskId: string };
    'emergence-receipt': { kind: 'emergence-receipt'; taskId: string };
    'emergence-note': { kind: 'emergence-note'; taskId: string };
  }
}

const now = () => new Date().toISOString();
const bounded = (value: unknown, length = 1000) => safeError(value).slice(0, length);

/** Owns durable task identity and admission; Harness owns turns, tools and their settlement. */
export class TaskEngine extends EventEmitter {
  readonly lifecycle: TaskLifecycle;
  readonly scheduler: TaskScheduler;
  readonly execution: TaskExecution;
  readonly recovery: TaskRecovery;
  get state() {
    return this.lifecycle.state;
  }
  get active() {
    return this.scheduler.active;
  }
  set state(value: TaskState) {
    this.lifecycle.state = value;
  }
  get journalReady() {
    return this.lifecycle.journalReady;
  }

  readonly budgets: TaskBudgetMonitor;
  stopped = false;
  readonly admitting = new Set<TaskRecord>();
  private readonly jobs = new Set<Promise<unknown>>();
  readonly disposers: Array<() => void> = [];
  readonly journal: ExecutionJournal;
  readonly assurance: CoreAssurance;
  batching = false;
  private batchToken?: symbol;
  private stagedTasks?: TaskRecord[];
  private readonly planSubmissions = new Map<string, Promise<TaskRecord[]>>();
  constructor(readonly workspace: WorkspaceController) {
    super();
    this.budgets = new TaskBudgetMonitor(
      workspace,
      (task) => this.admitting.has(task),
      (job) => this.track(job),
    );
    this.journal = new ExecutionJournal(
      workspace.launch.home,
      process.platform === 'win32' ? workspace.launch.cwd.toLowerCase() : workspace.launch.cwd,
    );
    this.assurance = new CoreAssurance(this);
    this.disposers.push(...this.assurance.mount());

    this.lifecycle = new TaskLifecycle(this);
    this.scheduler = new TaskScheduler(this);
    this.execution = new TaskExecution(this);
    this.recovery = new TaskRecovery(this);
    this.disposers.push(...this.execution.mount(), ...mountTaskTools(this));
  }
  track<T>(promise: Promise<T>) {
    this.jobs.add(promise);
    void promise.then(
      () => this.jobs.delete(promise),
      (error) => {
        this.jobs.delete(promise);
        this.workspace.notice = '任务状态保存失败，已暂停执行：' + bounded(error);
        this.state.paused = true;
        this.workspace.changed();
      },
    );
    return promise;
  }
  update(...args: Parameters<TaskLifecycle['update']>): ReturnType<TaskLifecycle['update']> {
    return this.lifecycle.update(...args);
  }
  changed() {
    if (this.batching) return;
    this.emit('change');
    this.workspace.changed();
  }
  initializeJournal(
    ...args: Parameters<TaskLifecycle['initializeJournal']>
  ): ReturnType<TaskLifecycle['initializeJournal']> {
    return this.lifecycle.initializeJournal(...args);
  }
  activateJournal(
    ...args: Parameters<TaskLifecycle['activateJournal']>
  ): ReturnType<TaskLifecycle['activateJournal']> {
    return this.lifecycle.activateJournal(...args);
  }
  get hasJournalHistory() {
    return this.lifecycle.hasJournalHistory;
  }
  checkpoint(...args: Parameters<TaskLifecycle['checkpoint']>): ReturnType<TaskLifecycle['checkpoint']> {
    return this.lifecycle.checkpoint(...args);
  }
  load(...args: Parameters<TaskLifecycle['load']>): ReturnType<TaskLifecycle['load']> {
    return this.lifecycle.load(...args);
  }
  task(...args: Parameters<TaskLifecycle['task']>): ReturnType<TaskLifecycle['task']> {
    return this.lifecycle.task(...args);
  }
  current(pane: string) {
    const task = this.active.get(pane);
    return task && !terminal.has(task.status) ? task : undefined;
  }
  view(task: TaskRecord) {
    return {
      id: task.id,
      requestKey: task.requestKey,
      objective: task.objective,
      issuer: task.issuer,
      issuerSession: task.issuerSession,
      target: task.target,
      targetSession: task.targetSession,
      cwd: task.cwd,
      modelId: task.modelId,
      dependsOn: task.dependsOn,
      status: task.status,
      assessment: task.assessment
        ? {
            ...task.assessment,
            checks:
              task.assessment.checks?.map((check) => ({ ...check, note: check.note.slice(0, 180) })) ?? [],
          }
        : null,
      timing: task.timing ?? null,
      diagnostic: this.diagnose(task),
      timeout: task.timeout ?? null,
      evidenceCount: task.receipts.length,
      progress: task.progress,
      followup: task.followup ?? null,
      priorResult:
        task.repairOf || task.recoveryOf
          ? (this.task((task.repairOf ?? task.recoveryOf)!).result ?? null)
          : null,
      contract: task.contract ?? null,
      role: task.role ? { ...task.role, modelId: task.role.modelId ?? null } : null,
      steps: task.steps,
      repairOf: task.repairOf ?? null,
      repairCount: task.repairCount,
      review: task.review ?? null,
      result: task.result ?? null,
      execution: {
        run: task.runId ?? null,
        fence: task.fence ?? null,
        workflow: task.workflow ?? null,
        recoveryOf: task.recoveryOf ?? null,
        recoveryCount: task.recoveryCount,
        recovery: task.recovery ?? null,
      },
      usage: { tokens: null, cost: null },
    };
  }
  pause(value: boolean) {
    this.state.paused = value;
    for (const task of this.state.tasks) if (!terminal.has(task.status)) this.budgets.account(task);
    this.changed();
    this.kick();
  }
  assertMutable(pane: string) {
    if (this.state.tasks.some((t) => !terminal.has(t.status) && (t.target === pane || t.issuer === pane)))
      throw new Error('该窗口有未结束任务，请先完成或取消任务');
  }
  async enqueue(
    issuer: string,
    target: string,
    requestKey: string,
    objective: string,
    dependsOn: string[] = [],
    contractInput?: unknown,
    repairOf?: string,
    execution?: {
      workflow?: TaskRecord['workflow'];
      recoveryOf?: string;
      batch?: symbol;
      allocation?: TaskRecord['allocation'];
      permission?: TaskRecord['permission'];
      followup?: string;
    },
  ) {
    if (this.batching && execution?.batch !== this.batchToken)
      throw new Error('另一个执行图正在提交，请稍后再派发');
    if (issuer !== target) throw new Error('多窗口协同已移除；不能向其他窗口派发任务');
    const source = this.workspace.panes.get(issuer),
      destination = this.workspace.panes.get(target);
    if (this.stopped || !source?.controller?.id) throw new Error('当前会话不可用，不能提交任务');
    if (source.controller.permissionMode === 'plan')
      throw new Error('计划模式不能派发执行任务，请先切换权限');
    const input = z
      .object({
        requestKey: z.string().trim().min(1).max(100),
        objective: z.string().trim().min(1).max(12000),
        dependsOn: z.array(z.string()).max(30),
      })
      .parse({ requestKey, objective, dependsOn });
    input.dependsOn = [...new Set(input.dependsOn)];
    // Execution data must retain its exact paths, identifiers and criteria. Diagnostic
    // redaction can change both JSON keys and valid values when a secret is a common word.
    let contract = contractInput === undefined ? undefined : contractSchema.parse(contractInput);
    if (contract && JSON.stringify(contract).length > 60000)
      throw new Error('任务契约超过 60000 字符预算，请缩小任务范围');
    if (contract && !contract.binding && destination?.controller)
      contract = {
        ...contract,
        binding: bindProjectContract({
          project: destination.controller.cwd,
          scope: contract.scope,
          acceptance: contract.acceptance,
          capabilities: [],
        }),
      };
    if (contract && destination?.controller)
      assertProjectBinding(
        contract,
        destination.controller.cwd,
        [...this.workspace.panes.values()].map((p) => p.cwd),
      );
    const followup = taskSchema.shape.followup.parse(
      execution?.followup === undefined ? undefined : safeError(execution.followup),
    );
    const parent =
      repairOf || execution?.recoveryOf ? this.task((repairOf ?? execution?.recoveryOf)!) : undefined;
    if (parent?.assessment) throw new Error('历史审查任务只能查看，不能派生执行');
    if (
      parent &&
      (parent.issuer !== issuer ||
        parent.target !== target ||
        parent.issuerSession !== source.controller.id ||
        parent.targetSession !== destination?.controller?.id ||
        parent.cwd !== destination?.controller?.cwd ||
        parent.modelId !== destination?.modelId)
    ) {
      throw new Error('原任务会话、目录或模型已变化；请按新范围显式派发任务');
    }
    const role = structuredClone(
      parent?.role ??
        (contract
          ? roles(this.workspace.launch.appConfig.orchestration).find((r) => r.id === contract?.role)
          : undefined),
    );
    if (contract && !role) throw new Error('任务角色不存在');
    if (role?.modelId && role.modelId !== destination?.modelId)
      throw new Error('目标窗口模型与角色要求不一致，请先 /model 切换');
    if (contract?.binding?.verifications.length && destination?.controller && !parent) {
      const admittedSource = source.controller,
        admittedTarget = destination.controller;
      const currentPolicies = () => [
        admittedSource.permissionSnapshot(),
        ...admittedSource.permissionConstraints(admittedSource.agent),
        admittedTarget.permissionSnapshot(),
        ...admittedTarget.permissionConstraints(admittedTarget.agent),
      ];
      const stamp = permissionFingerprint(currentPolicies());
      const policies = [
        source.controller.permissionSnapshot(),
        ...source.controller.permissionConstraints(source.controller.agent),
        destination.controller.permissionSnapshot(),
        ...destination.controller.permissionConstraints(destination.controller.agent),
        ...(role
          ? [
              {
                mode: role.mode,
                root: destination.controller.cwd,
                rules: role.rules,
                deny: role.deny,
                confirm: [],
              },
            ]
          : []),
      ];
      contract = await freezeVerification(
        contract,
        (file_path) =>
          evaluatePermissions(policies, {
            name: 'read',
            arguments: { file_path },
            cwd: destination.controller!.cwd,
            actor: destination.controller!.agent.id,
          }).effect === 'allow',
      );
      if (
        this.stopped ||
        source.controller !== admittedSource ||
        destination.controller !== admittedTarget ||
        this.workspace.panes.get(issuer) !== source ||
        this.workspace.panes.get(target) !== destination ||
        stamp !== permissionFingerprint(currentPolicies()) ||
        (this.batching && execution?.batch !== this.batchToken)
      )
        throw new Error('验证基线采集期间窗口或权限已变化，未派发任务');
      assertProjectBinding(
        contract,
        destination.controller.cwd,
        [...this.workspace.panes.values()].map((p) => p.cwd),
      );
    }
    const existing = [...this.state.tasks, ...(this.stagedTasks ?? [])].find(
      (t) => t.issuerSession === source.controller!.id && t.requestKey === input.requestKey,
    );
    if (existing && this.admitting.has(existing)) throw new Error('同一任务正在提交，请等待持久化完成后重试');
    if (existing) {
      const intent = (value: typeof contract) =>
        value && {
          ...value,
          binding: value.binding && {
            ...value.binding,
            verifications: value.binding.verifications.map(({ baseline: _baseline, ...spec }) => spec),
          },
        };
      if (
        existing.followup !== followup ||
        JSON.stringify(intent(existing.contract)) !== JSON.stringify(intent(contract)) ||
        existing.repairOf !== repairOf ||
        existing.recoveryOf !== execution?.recoveryOf ||
        existing.target !== target ||
        existing.objective !== bounded(input.objective, 12000) ||
        JSON.stringify(existing.dependsOn) !== JSON.stringify(input.dependsOn)
      )
        throw new Error('请求标识重复但参数不同，请使用新 request_key');
      if (!this.batching) await this.workspace.save();
      return existing;
    }
    if (!this.workspace.available(issuer) || !this.workspace.available(target))
      throw new Error('窗口正在切换或释放会话，任务未创建');
    if (!destination?.controller?.id) throw new Error('任务会话不可用');
    if (this.state.tasks.length + (this.stagedTasks?.length ?? 0) >= 500)
      throw new Error('当前工作台已达到 500 条任务记录上限，请使用新工作台');
    for (const id of input.dependsOn) {
      const dependency = this.stagedTasks?.find((task) => task.id === id) ?? this.task(id);
      if (dependency.target !== target || dependency.targetSession !== source.controller.id)
        throw new Error('任务依赖必须属于当前会话');
    }

    const time = now();
    const task: TaskRecord = {
      id: randomUUID().slice(0, 12),
      requestKey: input.requestKey,
      objective: bounded(input.objective, 12000),
      issuer,
      issuerSession: source.controller.id,
      target,
      targetSession: destination.controller.id,
      cwd: destination.controller.cwd,
      modelId: destination.modelId,
      timing: advanceClock(undefined, Date.parse(time), 'queued', Date.parse(time)),
      contract,
      role,
      followup,
      steps: 0,
      repairOf,
      repairCount: repairOf ? this.task(repairOf).repairCount + 1 : (parent?.repairCount ?? 0),
      recoveryOf: execution?.recoveryOf,
      recoveryCount: execution?.recoveryOf ? parent!.recoveryCount + 1 : (parent?.recoveryCount ?? 0),
      workflow: execution?.workflow ?? parent?.workflow,
      rolePermission: structuredClone(
        parent?.rolePermission ??
          (role
            ? {
                mode: role.mode,
                root: destination.controller.cwd,
                rules: role.rules,
                deny: role.deny,
                confirm: [],
              }
            : undefined),
      ),
      permission: structuredClone(
        parent?.permission ?? execution?.permission ?? source.controller.permissionSnapshot(),
      ),
      targetPermission: structuredClone(
        parent?.targetPermission ?? destination.controller.permissionSnapshot(),
      ),
      allocation: execution?.allocation ?? parent?.allocation,
      receipts: [],
      dependsOn: input.dependsOn,
      status: 'queued',
      progress: '等待执行窗口空闲或依赖完成',
      createdAt: time,
      updatedAt: time,
      fromSeq: 0,
      notified: false,
      notes: [],
      executionIssues: [],
      artifactVersions: [],
    };
    if (this.batching) {
      this.stagedTasks!.push(task);
      return task;
    }
    this.state.tasks.push(task);
    this.admitting.add(task);
    try {
      this.changed();
      await this.workspace.save();
    } catch (error) {
      // No scheduler can observe this as admitted until persistence succeeds.
      this.state.tasks = this.state.tasks.filter((candidate) => candidate !== task);
      this.state.paused = true;
      try {
        this.checkpoint();
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          '任务提交和回滚持久化均失败；已暂停派发，须核对存储',
        );
      }
      this.changed();
      throw error;
    } finally {
      this.admitting.delete(task);
    }
    this.kick();
    return task;
  }
  dependency(id: string): TaskRecord {
    let task = this.task(id);
    for (let i = 0; i < 12; i++) {
      const repair = this.state.tasks.find((t) => t.repairOf === task.id || t.recoveryOf === task.id);
      if (!repair) return task;
      task = repair;
    }
    return task;
  }
  async executePlan(issuer: string, plan: TaskPlan, model = false, signal?: AbortSignal) {
    if (plan.steps.some((step) => step.window !== issuer))
      throw new Error('多窗口协同已移除；执行计划只能使用当前窗口');
    const source = this.workspace.panes.get(issuer)?.controller;
    const latest = source?.agent.session
      .snapshotEvents()
      .findLast((event) => event.type === 'user/message' && event.data.source.kind === 'user');
    const request = plan.admission ?? (latest?.type === 'user/message' ? latest.data.id : undefined);
    const key = executionGraphKey(source?.id, request, planSchema.parse(plan));
    const pending = this.planSubmissions.get(key);
    if (pending) return pending;
    if (this.planSubmissions.size) throw new Error('另一个执行图正在提交，请稍后重试');
    const operation = this.submitPlan(issuer, plan, key, model, signal).finally(() =>
      this.planSubmissions.delete(key),
    );
    this.planSubmissions.set(key, operation);
    return operation;
  }
  private async submitPlan(
    issuer: string,
    plan: TaskPlan,
    admissionKey: string,
    model: boolean,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    plan = planSchema.parse(plan);
    assertPlanAdmission(plan, this.workspace.launch.appConfig.core.planning.contextChars);
    if (this.batching) throw new Error('计划正在提交');
    const source = this.workspace.panes.get(issuer)?.controller;
    const existing = plan.steps.map((step) =>
      this.state.tasks.find(
        (task) =>
          task.issuerSession === source?.id &&
          [admissionKey, digest(plan)].some(
            (key) => task.requestKey === `plan-${key.slice(0, 20)}-${step.id}`,
          ),
      ),
    );
    if (existing.every((task) => task !== undefined)) return existing as TaskRecord[];
    if (existing.some(Boolean)) throw new Error('执行图记录不完整；请先核对存储，不重复派发');
    if (!source || (!model && source.busy)) throw new Error('请等待当前窗口空闲后执行计划');
    if (this.current(issuer)) throw new Error('当前窗口正在执行既有任务，不能创建竞争执行图');
    const policies = [source.permissionSnapshot(), ...source.permissionConstraints(source.agent)],
      stamp = permissionFingerprint(policies);
    const decision = evaluatePermissions(policies, {
      name: 'emergence_execute_plan',
      arguments: {},
      cwd: source.cwd,
      actor: source.agent.id,
    });
    if (decision.effect === 'deny') throw new Error(decision.reason);
    const snapshot = await observeDispatch(this.workspace, issuer, plan, signal);
    snapshot.assertCurrent();
    if (
      decision.effect === 'ask' &&
      !(await source.confirmDecision(
        `准备执行 ${plan.steps.length} 个步骤：\n${plan.steps.map((s) => `${s.id} · ${s.window} · ${s.objective}`).join('\n')}`,
        () =>
          permissionFingerprint([
            source.permissionSnapshot(),
            ...source.permissionConstraints(source.agent),
          ]) === stamp,
      ))
    )
      return [];
    signal?.throwIfAborted();
    const confirmed = await observeDispatch(this.workspace, issuer, plan, signal);
    if (snapshot.revision !== confirmed.revision) throw new AllocationChanged('审批期间资源变化，请重新分配');
    confirmed.assertCurrent();
    const planId = digest(plan),
      original = [...this.state.tasks],
      originalGoals = this.state.goalContracts,
      mapped = new Map<string, TaskRecord>();
    this.batching = true;
    this.batchToken = Symbol('plan-transaction');
    this.stagedTasks = [];
    try {
      const waiting = [...plan.steps];
      while (waiting.length) {
        signal?.throwIfAborted();
        const index = waiting.findIndex((s) => s.dependsOn.every((d) => mapped.has(d)));
        if (index < 0) throw new Error('计划依赖成环或缺失');
        const step = waiting.splice(index, 1)[0],
          pane = this.workspace.panes.get(step.window);
        if (
          !pane?.controller ||
          pane.controller.id !== step.session ||
          pane.cwd !== step.project ||
          pane.modelId !== step.model
        )
          throw new Error('计划窗口绑定已变化');
        const task = await this.enqueue(
          issuer,
          step.window,
          `plan-${admissionKey.slice(0, 20)}-${step.id}`,
          step.objective,
          step.dependsOn.map((d) => mapped.get(d)!.id),
          planTaskContract(plan, step),
          undefined,
          {
            batch: this.batchToken,
            allocation: step.allocation,
            workflow: {
              plan: planId,
              step: step.id,
              stage: step.role === 'reviewer' ? 'Review' : 'Execution',
            },
          },
        );
        mapped.set(step.id, task);
      }
      confirmed.assertCurrent();
      signal?.throwIfAborted();
      this.state.tasks.push(...this.stagedTasks);
      if (plan.goalContract)
        this.state.goalContracts = [
          ...(this.state.goalContracts ?? []).filter((g) => g.plan !== planId),
          { plan: planId, goal: plan.goalContract },
        ];
      const committing = source.planning.environment && allocationRevision(source.planning.environment());
      await this.workspace.save();
      signal?.throwIfAborted();
      if (source.planning.environment && committing !== allocationRevision(source.planning.environment()))
        throw new AllocationChanged('持久化期间资源变化，已撤销此次提交');
    } catch (e) {
      this.state.tasks = original;
      this.state.goalContracts = originalGoals;
      try {
        this.checkpoint();
      } catch (rollback) {
        this.state.paused = true;
        throw new AggregateError([e, rollback], '执行图提交及回滚失败，已暂停派工，请核对存储');
      }
      throw e;
    } finally {
      this.batching = false;
      this.batchToken = undefined;
      this.stagedTasks = undefined;
    }
    this.changed();
    this.kick();
    return [...mapped.values()];
  }
  recoveryFacts(
    ...args: Parameters<TaskRecovery['recoveryFacts']>
  ): ReturnType<TaskRecovery['recoveryFacts']> {
    return this.recovery.recoveryFacts(...args);
  }
  recover(...args: Parameters<TaskRecovery['recover']>): ReturnType<TaskRecovery['recover']> {
    return this.recovery.recover(...args);
  }
  kick(...args: Parameters<TaskScheduler['kick']>): ReturnType<TaskScheduler['kick']> {
    return this.scheduler.kick(...args);
  }
  waiting(...args: Parameters<TaskScheduler['waiting']>): ReturnType<TaskScheduler['waiting']> {
    return this.scheduler.waiting(...args);
  }
  olderConflictingTask(
    ...args: Parameters<TaskScheduler['olderConflictingTask']>
  ): ReturnType<TaskScheduler['olderConflictingTask']> {
    return this.scheduler.olderConflictingTask(...args);
  }
  pump(...args: Parameters<TaskScheduler['pump']>): ReturnType<TaskScheduler['pump']> {
    return this.scheduler.pump(...args);
  }
  start(...args: Parameters<TaskExecution['start']>): ReturnType<TaskExecution['start']> {
    return this.execution.start(...args);
  }
  finish(...args: Parameters<TaskExecution['finish']>): ReturnType<TaskExecution['finish']> {
    return this.execution.finish(...args);
  }
  finishWithoutTurn(
    ...args: Parameters<TaskExecution['finishWithoutTurn']>
  ): ReturnType<TaskExecution['finishWithoutTurn']> {
    return this.execution.finishWithoutTurn(...args);
  }
  settled(...args: Parameters<TaskExecution['settled']>): ReturnType<TaskExecution['settled']> {
    return this.execution.settled(...args);
  }
  async review(
    id: string,
    accepted: boolean,
    evidence: string,
    actor: 'user' | 'model' = 'user',
    valid: () => boolean = () => true,
  ) {
    const task = this.task(id);
    if (accepted && actor === 'model') {
      const proof = await this.assurance.status(id);
      if (!proof.review || !proof.verification)
        throw new Error('模型验收需要当前版本的独立审查与验证证据；文字说明不能代替实际回执');
    }
    if (accepted && task.recovery === 'uncertain')
      throw new Error('副作用结果不确定，先用 /recover inspect 和 keep 核对；不能直接验收');
    if (!task.contract || task.status !== 'needs_review' || task.review)
      throw new Error('任务不处于可验收状态');
    if (
      accepted &&
      (!task.report ||
        task.report.outcome !== 'success' ||
        unresolvedTaskErrors(task).length ||
        !(await resolvedEvidenceCurrent(task)))
    )
      throw new Error('真实失败或缺失回执不能验收通过');
    if (accepted)
      for (const artifact of task.artifactVersions)
        if (artifact.hash.startsWith('unknown:') || artifact.hash !== (await fileFingerprint(artifact.path)))
          throw new Error('产物在执行后被修改或无法读取，原验收依据已失效；请重新检查或创建修复任务');
    if (!valid()) throw new Error('协调状态在验收期间改变，未提交验收');
    this.lifecycle.amend(task, {
      review: {
        accepted,
        actor,
        evidence: bounded(z.string().trim().min(1).max(8000).parse(evidence), 8000),
        at: now(),
      },
    });
    this.lifecycle.transition(task, accepted ? 'succeeded' : 'needs_review');
    this.lifecycle.amend(task, { notified: false });
    this.update(task, accepted ? '验收通过' : '验收未通过，需要修复');
    await this.settled(task);
  }
  async repair(id: string, feedback: string) {
    const task = this.task(id);
    if (task.assessment) throw new Error('审查验证任务不能派生修复循环；请修复实施任务并重新审查');
    if (task.recovery === 'uncertain')
      throw new Error('副作用结果不确定，先用 /recover inspect 和 keep 核对；不能自动修复');
    if (
      !task.contract ||
      !['failed', 'needs_review'].includes(task.status) ||
      task.review?.accepted ||
      task.repairCount >= task.contract.maxRepairs
    )
      throw new Error('任务不可修复或修复预算耗尽');
    if (this.state.tasks.some((t) => t.repairOf === id)) throw new Error('已创建修复任务，请检查其状态');
    const note = z.string().trim().min(1).max(4000).parse(feedback);
    return this.enqueue(
      task.issuer,
      task.target,
      'repair-' + id,
      task.objective,
      task.dependsOn,
      task.contract,
      id,
      { followup: `修复 ${id}：${note}` },
    );
  }
  async cancel(id: string, reason = '用户取消任务') {
    const task = this.task(id);
    if (terminal.has(task.status)) return;
    this.lifecycle.amend(task, { cancelReason: reason });
    this.update(task, '正在取消：' + reason);
    await this.workspace.save();
    if (this.active.get(task.target) === task) {
      await this.workspace.panes.get(task.target)?.controller?.cancel();
      if (!terminal.has(task.status)) await this.finishWithoutTurn(task, 'cancelled', reason);
    } else await this.finishWithoutTurn(task, 'cancelled', reason);
    this.kick();
  }
  async detach(pane: string) {
    for (const task of this.state.tasks)
      if (!terminal.has(task.status) && (task.target === pane || task.issuer === pane))
        await this.cancel(task.id, '关联窗口已终止');
  }
  async note(id: string, text: string) {
    const task = this.task(id);
    if (!activeStatus.has(task.status) || task.turn === undefined || task.cancelReason)
      throw new Error('只可向正在运行的任务补充指令');
    const note = z.string().trim().min(1).max(12000).parse(text);
    if (task.notes.length >= 50) throw new Error('该任务补充指令已达上限');
    this.lifecycle.append(task, 'notes', { at: now(), text: bounded(note, 12000) });
    await this.workspace.save();
    this.workspace.panes.get(task.target)!.controller!.agent.steer(
      createUserMessage({
        source: { kind: 'emergence-note', taskId: id },
        content: [{ type: 'text', text: `用户补充任务 ${id}：${bounded(note, 12000)}` }],
      }),
    );
  }
  async wait(ids: string[], signal: AbortSignal, timeout = 15000) {
    if (!ids.length || ids.length > 30) throw new Error('请选择 1 至 30 个任务');
    ids.forEach((id) => this.task(id));
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        this.off('change', check);
        signal.removeEventListener('abort', abort);
        resolve();
      };
      const abort = () => {
        clearTimeout(timer);
        this.off('change', check);
        signal.removeEventListener('abort', abort);
        reject(signal.reason);
      };
      const check = () => {
        if (
          ids.every((id) => terminal.has(this.task(id).status)) ||
          ids.some((id) => this.task(id).status === 'waiting_user') ||
          this.stopped
        )
          done();
      };
      const timer = setTimeout(done, Math.max(100, Math.min(30000, timeout)));
      this.on('change', check);
      signal.addEventListener('abort', abort, { once: true });
      check();
    });
    return ids.map((id) => this.view(this.task(id)));
  }
  diagnose(task: TaskRecord) {
    const controller = this.workspace.panes.get(task.target)?.controller;
    return (
      taskDiagnostics(
        task,
        controller?.id === task.targetSession ? controller.diagnostics.forTask(task.id) : [],
      ) + (controller?.diagnostics.error ? '\n' + controller.diagnostics.error : '')
    );
  }
  describe(id?: string) {
    return (
      (id ? [this.task(id)] : this.state.tasks.slice(-80))
        .map(
          (t) =>
            `${t.id} ${taskLabels[t.status]} · ${t.target} · ${t.modelId}\n${id ? t.objective : t.objective.slice(0, 600)}\n${t.cwd}\n${t.progress}${id ? '\n' + this.diagnose(t) : ''}${id ? `\n执行批次：${t.runId ?? '尚未开始'} · 租约版本：${t.fence ?? '未分配'}\n恢复尝试：${t.recoveryCount}/2 · ${t.recovery ?? '无待核对标记'}\nToken / 费用：未知${t.workflow ? '\n规划步骤：' + t.workflow.step + ' · ' + t.workflow.stage : ''}` : ''}${id && t.contract ? '\n任务契约：' + JSON.stringify(t.contract) + '\n模型步数：' + t.steps + '\n验收：' + JSON.stringify(t.review ?? null) : ''}${t.dependsOn.length ? '\n依赖：' + t.dependsOn.join(', ') : ''}${t.result ? '\n结果：' + (id ? t.result.summary : t.result.summary.slice(0, 800)) + (t.result.errors.length ? '\n失败回执：' + (id ? t.result.errors.join('\n') : t.result.errors.join('\n').slice(0, 1800)) : '') + `\n日志：${t.targetSession} seq ${t.result.fromSeq}–${t.result.toSeq}` : ''}`,
        )
        .join('\n\n') || '暂无计划任务'
    );
  }
  async close() {
    this.stopped = true;
    this.budgets.close();
    this.emit('change');
    await Promise.allSettled([...this.jobs]);
    for (const task of this.state.tasks)
      if (!terminal.has(task.status)) {
        this.lifecycle.transition(task, 'interrupted');
        this.lifecycle.amend(task, { endedAt: now() });
        this.update(task, '应用退出，未自动重放；需要时请重新派发');
      }
    this.execution.close();
    this.disposers.forEach((dispose) => dispose());
    this.removeAllListeners();
  }
}
