import { advanceClock, budgetExceeded, budgetReasons, orchestrationLimits } from '../domain/run-budget.ts';
import { settledTaskStatuses as terminal, type TaskRecord } from '../domain/task.ts';
import type { WorkspacePort as WorkspaceController } from './runtime-ports.ts';
import { phaseLabels } from '../domain/run-diagnostics.ts';

/** One timer for the existing scheduler; owns clocks, never a second task queue. */
export class TaskBudgetMonitor {
  private budgetTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private readonly expiring = new Set<string>();
  constructor(
    private workspace: WorkspaceController,
    private isAdmitting: (task: TaskRecord) => boolean,
    private track: (job: Promise<unknown>) => void,
  ) {}
  account(task: TaskRecord) {
    let mode: 'paused' | 'waiting' | 'queued' | 'active' = 'active';
    if (terminal.has(task.status)) mode = 'paused';
    else if (task.status === 'waiting_user') mode = 'waiting';
    else if (task.status === 'queued') {
      const suspended = this.workspace.taskEngine.state.paused;
      const awaitingApproval =
        this.workspace.panes.get(task.issuer)?.controller?.pending ||
        this.workspace.panes.get(task.target)?.controller?.pending ||
        dependencyAwaitingApproval(task, this.workspace.taskEngine.state.tasks);
      mode = suspended ? 'paused' : awaitingApproval ? 'waiting' : 'queued';
    }
    this.workspace.taskEngine.lifecycle.clock(
      task,
      advanceClock(task.timing, Date.parse(task.createdAt), mode, Date.now()),
    );
  }
  watch() {
    if (
      this.stopped ||
      this.budgetTimer ||
      !this.workspace.taskEngine.state.tasks.some((t) => !terminal.has(t.status))
    )
      return;
    this.budgetTimer = setTimeout(() => {
      this.budgetTimer = undefined;
      for (const task of this.workspace.taskEngine.state.tasks) {
        if (terminal.has(task.status) || this.isAdmitting(task) || this.expiring.has(task.id)) continue;
        this.account(task);
        const reason = budgetExceeded(
          task.timing!,
          Date.parse(task.createdAt),
          task.contract?.maxDurationMs ?? orchestrationLimits.taskExecutionMs,
          this.workspace.launch.appConfig.orchestration.budgets,
          Date.now(),
        );
        if (!reason) continue;
        this.track(this.expire(task, budgetReasons[reason], reason));
      }
      this.workspace.taskEngine.kick();
    }, orchestrationLimits.pollMs);
    this.budgetTimer.unref();
  }
  async expire(task: TaskRecord, detail: string, reason: NonNullable<TaskRecord['timeout']> = 'execution') {
    if (terminal.has(task.status) || this.expiring.has(task.id)) return;
    this.workspace.taskEngine.lifecycle.timeout(task, reason);
    const run = this.workspace.panes.get(task.target)?.controller?.diagnostics.snapshot;
    if (run?.task === task.id) detail += '；停止时阶段：' + phaseLabels[run.phase];
    this.expiring.add(task.id);
    try {
      if (!terminal.has(task.status)) await this.workspace.taskEngine.cancel(task.id, detail);
    } finally {
      this.expiring.delete(task.id);
    }
  }
  close() {
    this.stopped = true;
    clearTimeout(this.budgetTimer);
  }
}

/** Approval waiting propagates through dependent tasks in the same session. */
function dependencyAwaitingApproval(task: TaskRecord, tasks: readonly TaskRecord[]): boolean {
  const records = new Map(tasks.map((record) => [record.id, record]));
  const pending = [...task.dependsOn];
  const visited = new Set<string>([task.id]);
  while (pending.length) {
    const id = pending.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const dependency = records.get(id);
    if (!dependency) continue;
    if (dependency.status === 'waiting_user') return true;
    if (!terminal.has(dependency.status)) pending.push(...dependency.dependsOn);
  }
  return false;
}
