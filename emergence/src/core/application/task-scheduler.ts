import { taskLabels, settledTaskStatuses as terminal, type TaskRecord } from '../domain/task.ts';
import { tasksConflict } from './task-allocation.ts';
import type { TaskEngine } from './task-engine.ts';

type Host = Pick<
  TaskEngine,
  | 'budgets'
  | 'stopped'
  | 'batching'
  | 'track'
  | 'update'
  | 'state'
  | 'admitting'
  | 'workspace'
  | 'dependency'
  | 'finishWithoutTurn'
  | 'start'
>;
/** TaskScheduler: one owner for this responsibility; shares the authoritative task graph. */
export class TaskScheduler {
  pumping = false;
  repump = false;
  scheduled = false;
  readonly active = new Map<string, TaskRecord>();

  constructor(private host: Host) {}
  kick() {
    this.host.budgets.watch();
    if (this.pumping) {
      this.repump = true;
      return;
    }
    if (this.host.stopped || this.scheduled || this.host.batching) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (!this.host.stopped) void this.host.track(this.pump());
    });
  }
  waiting(task: TaskRecord, reason: string) {
    if (task.progress !== reason) this.host.update(task, reason);
  }
  olderConflictingTask(task: TaskRecord) {
    return this.host.state.tasks.slice(0, this.host.state.tasks.indexOf(task)).find((older) => {
      if (older.status !== 'queued' || this.host.admitting.has(older)) return false;
      if (this.host.state.paused) return false;
      if (!this.host.workspace.available(older.target)) return false;
      return (
        older.dependsOn.every((id) => this.host.dependency(id).status === 'succeeded') &&
        tasksConflict(older, task)
      );
    });
  }
  async pump() {
    if (this.pumping || this.host.stopped || this.host.batching) return;
    this.pumping = true;
    try {
      if (this.host.stopped || this.host.batching) return;
      for (const task of this.host.state.tasks) {
        if (this.host.batching || this.host.stopped) return;
        if (task.status !== 'queued' || this.host.admitting.has(task)) continue;
        const pendingReview = task.dependsOn.some((id) => {
          const d = this.host.dependency(id);
          return (
            d.contract && d.status === 'needs_review' && (!d.review || d.repairCount < d.contract.maxRepairs)
          );
        });
        if (pendingReview) {
          this.waiting(task, '等待依赖任务的独立验收');
          continue;
        }
        const bad = task.dependsOn
          .map((id) => this.host.dependency(id))
          .find((t) => terminal.has(t.status) && t.status !== 'succeeded');
        if (bad) {
          await this.host.finishWithoutTurn(
            task,
            'blocked',
            `依赖 ${bad.id} 为 ${taskLabels[bad.status]}，未执行`,
          );
          continue;
        }
        if (this.host.state.paused) {
          this.waiting(task, '任务队列已暂停，等待恢复');
          continue;
        }
        if (!this.host.workspace.available(task.target) || !this.host.workspace.available(task.issuer)) {
          this.waiting(task, '窗口绑定正在切换，等待稳定');
          continue;
        }
        if (task.dependsOn.some((id) => this.host.dependency(id).status !== 'succeeded')) {
          this.waiting(task, '等待依赖任务完成');
          continue;
        }
        if (task.assessment || task.issuer !== task.target || task.issuerSession !== task.targetSession) {
          await this.host.finishWithoutTurn(task, 'blocked', '历史跨窗口任务不能进入执行队列');
          continue;
        }
        if (this.active.has(task.target)) {
          this.waiting(task, '等待当前会话完成任务');
          continue;
        }
        if ([...this.active.values()].some((other) => tasksConflict(other, task))) {
          this.waiting(task, '等待重叠范围的读写资源释放');
          continue;
        }
        const older = this.olderConflictingTask(task);
        if (older) {
          this.waiting(task, '等待更早任务 ' + older.id + ' 优先取得重叠资源');
          continue;
        }
        const pane = this.host.workspace.panes.get(task.target);
        if (
          !pane?.controller ||
          pane.controller.id !== task.targetSession ||
          pane.cwd !== task.cwd ||
          pane.modelId !== task.modelId
        ) {
          await this.host.finishWithoutTurn(task, 'blocked', '执行窗口的会话、目录或模型已变化，未执行');
          continue;
        }
        if (
          pane.controller.busy ||
          pane.controller.pending ||
          this.host.workspace.ctx.agents
            .list()
            .some((a) => pane.controller!.owns(a) && a.status === 'running') ||
          this.active.size >= this.host.workspace.launch.appConfig.orchestration.maxConcurrent
        ) {
          this.waiting(
            task,
            pane.controller.pending
              ? '目标窗口正在等待用户回答'
              : pane.controller.busy
                ? '目标窗口正在处理其他工作'
                : '等待全局并发额度',
          );
          continue;
        }
        void this.host.track(this.host.start(task));
      }
    } finally {
      this.pumping = false;
      if (this.repump) {
        this.repump = false;
        this.kick();
      }
    }
  }
}
