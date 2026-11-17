import { emptyTaskState, taskStateSchema, type TaskState } from '../domain/task-state.ts';
import { storedTaskStateSchema } from '../storage/task-history.ts';
import { safeError } from '../adapters/redaction.ts';
import { assertTaskTransition } from '../domain/task-transitions.ts';
import { settledTaskStatuses as terminal, type TaskRecord } from '../domain/task.ts';
import { ExecutionJournal } from '../storage/execution-journal.ts';
import type { TaskEngine } from './task-engine.ts';
const now = () => new Date().toISOString();
const bounded = (value: unknown, length = 1000) => safeError(value).slice(0, length);

type Host = Pick<TaskEngine, 'workspace' | 'budgets' | 'changed'> & { journal: ExecutionJournal };
/** TaskLifecycle: one owner for this responsibility; shares the authoritative task graph. */
export class TaskLifecycle {
  /** Metadata/evidence updates cannot bypass the state machine. */
  amend(task: TaskRecord, changes: Partial<Omit<TaskRecord, 'status'>>) {
    if ('status' in changes) throw new Error('Use transition() to change task status');
    Object.assign(task, changes);
  }

  transition(task: TaskRecord, status: TaskRecord['status']) {
    assertTaskTransition(task.status, status);
    Object.assign(task, { status });
  }
  append<K extends 'receipts' | 'notes' | 'executionIssues'>(
    task: TaskRecord,
    field: K,
    value: TaskRecord[K][number],
  ) {
    Object.assign(task, { [field]: [...task[field], value] });
  }
  recordReceipt(task: TaskRecord, receipt: TaskRecord['receipts'][number]) {
    this.append(task, 'receipts', receipt);
  }
  recordReport(task: TaskRecord, report: NonNullable<TaskRecord['report']>) {
    this.amend(task, { report: report });
  }
  clock(task: TaskRecord, timing: TaskRecord['timing']) {
    this.amend(task, { timing: timing });
  }
  timeout(task: TaskRecord, reason: TaskRecord['timeout']) {
    this.amend(task, { timeout: reason });
  }
  state: TaskState = emptyTaskState();
  journalReady = false;
  journalSaved?: TaskState;
  readonly journal: ExecutionJournal;
  constructor(private host: Host) {
    this.journal = host.journal;
  }
  async initializeJournal() {
    await this.journal.open();
    const saved = this.journal.load();
    if (saved !== undefined) this.journalSaved = storedTaskStateSchema.parse(saved);
    else await this.journal.backupLegacy(this.host.workspace.path);
  }
  activateJournal() {
    this.journalReady = true;
    this.checkpoint();
  }
  get hasJournalHistory() {
    return !!(this.journalSaved?.tasks.length || this.journalSaved?.history?.coordinations?.length);
  }
  checkpoint() {
    if (this.journalReady) this.journal.commit(taskStateSchema.parse(this.state));
  }
  load(saved?: TaskState) {
    const legacy = !this.journalSaved && Boolean(saved?.tasks.length);
    saved = this.journalSaved ?? saved;
    if (!saved) {
      this.activateJournal();
      return;
    }
    this.state = structuredClone(saved);
    this.state.paused = false;
    for (const task of this.state.tasks)
      if (!terminal.has(task.status)) {
        this.transition(task, 'interrupted');
        this.amend(task, { endedAt: now() });
        this.amend(task, { updatedAt: now() });
        this.amend(task, { progress: '进程已重启，未自动重放；需要时请显式重新派发' });
      }
    for (const task of this.state.tasks.filter((t) => t.status === 'interrupted')) {
      if (task.recovery === 'reconciled') continue;
      const effects = this.journal.effects(task.id);
      this.amend(task, {
        recovery:
          (legacy && task.messageId) || effects.some((e) => ['started', 'uncertain'].includes(e.state))
            ? 'uncertain'
            : effects.length
              ? 'effects-returned'
              : task.messageId
                ? 'read-only'
                : 'not-started',
      });
      this.amend(task, {
        progress:
          task.recovery === 'uncertain'
            ? '副作用结果不确定，必须先 /recover inspect 核对；不会自动重试'
            : '执行已中断，/recover 查看事实并决定是否创建新尝试',
      });
    }
    for (const task of this.state.tasks.filter((t) => t.issuer !== t.target && t.status === 'interrupted'))
      this.amend(task, {
        progress: '历史跨窗口任务已停用，原始记录保留；如需继续，请在所需窗口单独提交新任务。',
      });
    this.activateJournal();
  }
  task(id: string) {
    const task = this.state.tasks.find((t) => t.id === id);
    if (!task) throw new Error('任务不存在，使用 /tasks 查看');
    return task;
  }
  update(task: TaskRecord, progress: string) {
    this.host.budgets.account(task);
    this.amend(task, { updatedAt: now() });
    this.amend(task, { progress: bounded(progress, 2000) });
    this.host.changed();
  }
}
