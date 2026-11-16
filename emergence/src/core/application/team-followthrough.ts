import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { evaluatePermissions, permissionFingerprint } from '../adapters/permissions.ts';
import { safeError } from '../adapters/redaction.ts';
import { advanceClock, budgetExceeded, budgetReasons } from '../domain/run-budget.ts';
import type { TaskRecord } from '../domain/task.ts';
import { settledTaskStatuses as terminal } from '../domain/task.ts';
import { settledCoordinationPhases as done, type CoordinationRecord } from '../domain/team.ts';
import { AuditCapacityError } from './audit-allocation.ts';
import type { WorkspacePort as WorkspaceController } from './runtime-ports.ts';
import { unresolvedTaskErrors } from '../domain/task-failure.ts';

/** Reconciles durable facts inside Collaboration's single pump. Never executes tools or owns a task queue. */
export class TeamFollowthrough {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private approvals = new Set<string>();
  private pending = new Set<string>();
  private summaries = new Map<string, { id: string; steps: number }>();
  constructor(private w: WorkspaceController) {}
  private get c() {
    return this.w.collaboration;
  }
  private get records() {
    return this.w.team.records;
  }
  related(r: CoordinationRecord): TaskRecord[] {
    const ids = new Set(r.executions);
    for (let n = 0; n < 16; n++) {
      const before = ids.size;
      for (const t of this.c.state.tasks) {
        // A user-approved /recover after closure is a separate manual recovery attempt, not resurrection of the old objective.
        if (t.recoveryOf && done.has(r.phase)) continue;
        if ([t.repairOf, t.recoveryOf, t.assessment?.subject].some((id) => id && ids.has(id))) ids.add(t.id);
      }
      if (ids.size === before) break;
    }
    return this.c.state.tasks.filter((t) => ids.has(t.id));
  }
  owner(id: string) {
    return this.records.find((r) => r.followthrough && this.related(r).some((t) => t.id === id));
  }
  manages(id: string) {
    return !!this.owner(id);
  }
  claimed(session: string, source: { kind: string; taskId?: string }) {
    if (
      source.kind === 'emergence-receipt' &&
      this.records.some((r) => r.id === source.taskId && r.session === session && r.followthrough?.summary)
    )
      this.summaries.set(session, { id: source.taskId!, steps: 0 });
    else if (['user', 'emergence-task'].includes(source.kind)) this.summaries.delete(session);
  }
  summaryStep(session: string) {
    const summary = this.summaries.get(session);
    if (summary && summary.steps++ >= 4)
      throw new Error('最终汇报达到 4 步上限；真实汇总已保存在 /team，未启动新的工作');
  }
  allows(id: string) {
    const r = this.owner(id);
    return !r || (!done.has(r.phase) && this.valid(r));
  }
  private valid(r: CoordinationRecord) {
    const p = this.w.panes.get(r.master),
      s = this.c.state;
    return (
      !this.stopped &&
      this.records.includes(r) &&
      !done.has(r.phase) &&
      s.mode === 'collaborate' &&
      !s.paused &&
      s.master === r.master &&
      !s.owned.includes(r.master) &&
      this.w.available(r.master) &&
      p?.controller?.id === r.session &&
      p.controller.cwd === r.project
    );
  }
  private phase(
    r: CoordinationRecord,
    phase: CoordinationRecord['phase'],
    reason?: string,
    waitReason?: CoordinationRecord['waitReason'],
  ) {
    if (r.phase === phase && r.blockReason === reason && r.waitReason === waitReason) return;
    r.phase = phase;
    r.waitReason = waitReason;
    r.blockReason = reason?.slice(0, 1000);
    r.updatedAt = new Date().toISOString();
    this.c.checkpoint();
    this.w.changed();
  }
  private async end(r: CoordinationRecord, phase: 'blocked' | 'cancelled', reason: string) {
    if (done.has(r.phase)) return;
    this.phase(r, phase, reason);
    // Mark the objective first: cancellation callbacks and late receipts cannot revive it.
    for (const t of this.related(r)) if (!terminal.has(t.status)) await this.c.cancel(t.id, reason);
    this.summary(r);
  }
  async cancel(master: string, reason = '用户停止主控总任务') {
    for (const r of this.records.filter((r) => r.master === master && r.followthrough && !done.has(r.phase)))
      await this.end(r, 'cancelled', reason);
  }
  async cancelTask(id: string, reason: string) {
    const r = this.owner(id);
    if (r && !done.has(r.phase)) await this.end(r, 'cancelled', reason);
  }
  async failTask(id: string, reason: string) {
    const r = this.owner(id);
    if (r && !done.has(r.phase)) await this.end(r, 'blocked', reason);
  }
  clockChanged() {
    for (const record of this.records)
      if (record.followthrough && !done.has(record.phase)) this.budget(record);
  }
  private budget(record: CoordinationRecord) {
    const followthrough = record.followthrough!;
    const waiting =
      this.related(record).some((task) => task.status === 'waiting_user') ||
      !!this.w.panes.get(record.master)?.controller?.pending;
    const mode = !this.valid(record)
      ? 'paused'
      : waiting
        ? 'waiting'
        : record.waitReason === 'audit-resource'
          ? 'queued'
          : 'active';
    followthrough.timing = advanceClock(followthrough.timing, followthrough.startedAt, mode, Date.now());
    return budgetExceeded(
      followthrough.timing,
      followthrough.startedAt,
      followthrough.maxDurationMs,
      this.w.launch.appConfig.orchestration.budgets,
      Date.now(),
    );
  }
  assertStep(task: TaskRecord) {
    const r = this.owner(task.id);
    if (!r) return;
    if (done.has(r.phase)) throw new Error('总任务已经结束，禁止继续执行');
    if (this.budget(r) || this.related(r).reduce((n, t) => n + t.steps, 0) >= r.followthrough!.maxSteps)
      throw new Error('主控总任务的时长或模型步数预算已耗尽');
  }
  private summary(r: CoordinationRecord) {
    const f = r.followthrough!;
    if (f.summary) return;
    f.summary = (
      `主控总任务 ${r.id.slice(0, 8)} · ${r.phase === 'completed' ? '已通过独立审查与验证' : r.phase === 'cancelled' ? '已取消' : '未完成，协调受阻'}\n目标：${r.analysis?.objective ?? r.request}\n${r.blockReason ?? ''}\n` +
      this.related(r)
        .map(
          (t) =>
            `${t.id} · ${t.assessment?.kind ?? (t.repairOf ? '修复' : '执行')} · ${t.status}\n${t.objective.slice(0, 350)}\n产物：${this.artifacts(t)}\n${t.assessment?.checks?.map((c) => `验收项 ${c.criterion + 1} ${c.passed ? '通过' : '未通过'}：${c.note}；回执 ${c.receipts.join(',')}`).join('\n') ?? t.review?.evidence ?? t.progress}`,
        )
        .join('\n\n') +
      `\n模型步骤：${this.related(r).reduce((n, t) => n + t.steps, 0)}/${f.maxSteps}；协调动作：${f.actions}/${f.maxActions}；Token / 费用：未知。`
    ).slice(0, 24000);
    this.c.checkpoint();
    this.w.notice = f.summary.split('\n')[0];
    this.w.changed();
  }
  private artifacts(task: TaskRecord) {
    const data = this.c.assurance.dataDeliveries(task);
    const files = new Map(
      [...task.artifactVersions, ...data.runs.flatMap((run) => run.files)].map((file) => [
        file.path,
        file.hash,
      ]),
    );
    return (
      [...files].map(([path, hash]) => path + ' sha256:' + hash).join('；') +
        (data.omitted ? '；更早的分析产物见任务回执' : '') || '无文件产物'
    );
  }
  private deliver(r: CoordinationRecord) {
    const f = r.followthrough,
      c = this.w.panes.get(r.master)?.controller;
    if (
      !f?.summary ||
      f.notified ||
      !c ||
      c.id !== r.session ||
      c.busy ||
      c.pending ||
      !this.w.available(r.master) ||
      !this.w.team.active ||
      this.c.state.master !== r.master
    )
      return;
    // Summary is durable even if shutdown occurs between this checkpoint and inbox injection.
    f.notified = true;
    this.c.checkpoint();
    const message = createUserMessage({
      source: { kind: 'emergence-receipt', taskId: r.id },
      content: [
        {
          type: 'text',
          text:
            f.summary +
            '\n这是宿主基于实际回执生成的最终状态。请简洁汇报已完成和未完成项；不要重新派发、重新验收或把受阻写成成功。',
        },
      ],
    });
    if (r.phase === 'cancelled') c.agent.inject(message);
    else c.agent.followup(message);
  }
  private async authorize(
    r: CoordinationRecord,
    task: TaskRecord,
    name: string,
    action: () => Promise<unknown>,
  ) {
    const c = this.w.panes.get(r.master)!.controller!;
    const policies = () => [
      c.permissionSnapshot(),
      ...c.permissionConstraints(c.agent),
      ...(task.permission ? [task.permission] : []),
    ];
    const stamp = permissionFingerprint(policies()),
      key = [r.id, task.id, name, stamp].join(':');
    const decision = evaluatePermissions(policies(), {
      name,
      arguments: { task_id: task.id },
      cwd: c.cwd,
      actor: c.agent.id,
    });
    if (decision.effect === 'deny') {
      await this.end(r, 'blocked', `原任务或当前权限禁止 ${name}：${decision.reason}`);
      return;
    }
    if (decision.effect === 'ask' && !this.approvals.has(key)) {
      this.phase(r, 'waiting-input', `等待批准 ${name}：${task.objective.slice(0, 300)}`);
      if (this.pending.has(key) || c.pending) return;
      this.pending.add(key);
      void c
        .confirmDecision(
          `主控自动跟进需要 ${name}：\n${task.objective}\n保持原目标和权限范围。`,
          () => this.valid(r) && permissionFingerprint(policies()) === stamp,
        )
        .then(async (accepted) => {
          if (!this.valid(r)) return;
          if (accepted && permissionFingerprint(policies()) === stamp) this.approvals.add(key);
          else await this.end(r, 'blocked', '跟进操作未获批准；已停止本总任务');
        })
        .catch((error) => {
          this.w.notice = '跟进审批失败：' + safeError(error);
        })
        .finally(() => {
          this.pending.delete(key);
          this.c.kick();
        });
      return;
    }
    if (!this.valid(r)) return;
    if (r.followthrough!.actions >= r.followthrough!.maxActions) {
      await this.end(r, 'blocked', '总任务协调动作预算已耗尽');
      return;
    }
    await action();
    r.followthrough!.actions++;
    this.c.checkpoint();
    this.c.kick();
  }
  private async reconcile(r: CoordinationRecord) {
    const f = r.followthrough!;
    if (done.has(r.phase)) {
      this.summary(r);
      this.deliver(r);
      return;
    }
    const exceeded = this.budget(r);
    if (exceeded) {
      await this.end(r, 'blocked', '主控总任务：' + budgetReasons[exceeded]);
      return;
    }
    if (!this.valid(r)) {
      this.phase(r, 'paused', '协作暂停、主控变更或用户接管；不会自动重放');
      return;
    }
    const all = this.related(r);
    if (all.reduce((n, t) => n + t.steps, 0) >= f.maxSteps || f.actions >= f.maxActions) {
      await this.end(r, 'blocked', '总任务时间、步骤或协调预算已耗尽');
      return;
    }
    const latest = r.executions.map((id) => {
      let t = this.c.task(id);
      for (let n = 0; n < 12; n++) {
        const child = all.find((a) => a.repairOf === t.id || a.recoveryOf === t.id);
        if (!child) break;
        t = child;
      }
      return t;
    });
    const bad =
      all.find((t) => t.recovery === 'uncertain' || ['cancelled', 'interrupted'].includes(t.status)) ??
      latest.find((t) => ['failed', 'blocked'].includes(t.status));
    if (bad) {
      await this.end(
        r,
        'blocked',
        `任务 ${bad.id} ${bad.status}，${bad.recovery === 'uncertain' ? '副作用结果不确定，须先核对' : '不能盲目重试或当作完成'}。${bad.progress}`,
      );
      return;
    }
    if (all.some((t) => t.status === 'waiting_user') || this.w.panes.get(r.master)?.controller?.pending) {
      this.phase(r, 'waiting-input', '等待所属窗口的审批或必要回答');
      return;
    }
    if (this.w.panes.get(r.master)!.controller!.busy) {
      this.phase(r, 'waiting', '主控正在处理消息，回执已保存在任务记录中');
      return;
    }
    if (latest.every((t) => t.status === 'succeeded' && t.review?.accepted)) {
      if (all.some((task) => !terminal.has(task.status))) {
        this.phase(r, 'reviewing', '等待已派发的核验结束，不能提前宣布完成');
        return;
      }
      try {
        await this.c.assurance.completion(latest);
      } catch (error) {
        if (this.valid(r)) await this.end(r, 'blocked', safeError(error));
        return;
      }
      if (!this.valid(r)) return;
      this.phase(r, 'completed');
      this.summary(r);
      this.deliver(r);
      return;
    }
    for (const t of latest) {
      if (t.status !== 'needs_review') continue;
      if (!t.contract || !t.report || t.report.outcome !== 'success' || unresolvedTaskErrors(t).length) {
        await this.end(r, 'blocked', `任务 ${t.id} 缺少成功回执或存在执行错误，需要核对实际影响；未自动重跑`);
        return;
      }
      const status = await this.c.assurance.status(t.id);
      if (!this.valid(r)) return;
      if (status.stale) {
        await this.end(r, 'blocked', `任务 ${t.id} 的产物证据失效：${status.stale}`);
        return;
      }
      const audits = all.filter((a) => a.assessment?.subject === t.id);
      if (audits.some((a) => !terminal.has(a.status))) {
        this.phase(r, 'reviewing');
        continue;
      }
      // Hash checks await I/O. An audit may finish while that snapshot is being
      // built; do not combine its old running status with today's terminal task.
      if (status.entries.some((e) => this.c.task(e.id).status !== e.status)) {
        this.phase(r, 'reviewing');
        return;
      }
      const rejection = status.entries.find((e) => e.current && e.checks.some((c) => !c.passed));
      if (rejection || t.review?.accepted === false) {
        if (!rejection) {
          await this.end(r, 'blocked', '任务被手动拒绝，需要明确缺陷证据后另行处理');
          return;
        }
        const audit = this.c.task(rejection.id),
          negative = rejection.checks.filter((c) => !c.passed);
        if (
          negative.some(
            (c) =>
              c.blocked ||
              !c.receipts.some((id) =>
                audit.receipts.some(
                  (r) =>
                    r.id === id &&
                    (r.ok || (r.kind === 'command' && r.exitCode !== undefined && r.exitCode !== 0)),
                ),
              ),
          ) ||
          (unresolvedTaskErrors(audit).length &&
            !audit.receipts.some((r) => r.kind === 'command' && r.exitCode !== undefined && r.exitCode !== 0))
        ) {
          await this.end(
            r,
            'blocked',
            `审查 ${audit.id} 证据不足或工具出错，不能当作已确认缺陷自动修复。${negative.map((c) => c.note).join('；')}`,
          );
          return;
        }
        if (t.repairCount >= t.contract.maxRepairs || all.filter((a) => a.repairOf).length >= f.maxRepairs) {
          await this.end(r, 'blocked', `任务 ${t.id} 修复预算耗尽，仍有未通过的验收项`);
          return;
        }
        if (this.c.state.owned.includes(t.target)) {
          this.phase(r, 'paused', '修复窗口已由用户接管');
          return;
        }
        const feedback = rejection.checks
          .filter((c) => !c.passed)
          .map((c) => `验收项 ${c.criterion + 1}：${c.note}；实际回执 ${c.receipts.join(',')}`)
          .join('\n')
          .slice(0, 3500);
        await this.authorize(r, t, 'emergence_repair', async () => {
          this.phase(r, 'repairing');
          if (!t.review) await this.c.review(t.id, false, feedback, 'model', () => this.valid(r));
          if (this.valid(r))
            await this.c.repair(
              t.id,
              `先读取当前产物并核对以下缺陷，只在原任务范围内修复；不执行旧操作的盲目重放。\n${feedback}`,
            );
        });
        return;
      }
      if (status.review && status.verification) {
        await this.authorize(r, t, 'emergence_review', async () => {
          await this.c.review(
            t.id,
            true,
            '独立审查和验证均有当前版本证据：' +
              status.entries
                .filter((e) => e.passed)
                .map((e) => e.id)
                .join(', '),
            'model',
            () => this.valid(r),
          );
        });
        return;
      }
      // Runtime checks precede read-only review, so a reviewer can inspect independent verification
      // evidence without trying to run forbidden shell commands to re-prove the same criterion.
      for (const kind of ['verify', 'review'] as const) {
        if (kind === 'review' ? status.review : status.verification) continue;
        if (audits.some((a) => a.assessment?.kind === kind)) {
          await this.end(
            r,
            'blocked',
            `任务 ${t.id} 的 ${kind} 未提交有效通过证据；不会伪造通过或重复消耗模型调用`,
          );
          return;
        }
        await this.authorize(r, t, 'emergence_audit', async () => {
          this.phase(r, 'reviewing');
          await this.c.assurance.request(t.id, kind, r.master, undefined, () => this.valid(r));
        });
        return;
      }
    }
    if (!latest.some((t) => t.status === 'needs_review'))
      this.phase(r, latest.some((t) => t.repairOf && t.status !== 'succeeded') ? 'repairing' : 'waiting');
  }
  async advance() {
    if (this.stopped) return;
    for (const r of this.records.filter((r) => r.followthrough)) {
      try {
        await this.reconcile(r);
      } catch (error) {
        if (this.valid(r)) {
          if (error instanceof AuditCapacityError && error.retryable)
            this.phase(r, 'waiting', error.message, 'audit-resource');
          else await this.end(r, 'blocked', '自动跟进受阻：' + safeError(error));
        }
      }
    }
    clearTimeout(this.timer);
    if (this.records.some((r) => r.followthrough && (!done.has(r.phase) || !r.followthrough.notified))) {
      this.timer = setTimeout(() => this.c.kick(), 1000);
      this.timer.unref();
    }
  }
  close() {
    this.stopped = true;
    clearTimeout(this.timer);
  }
}
