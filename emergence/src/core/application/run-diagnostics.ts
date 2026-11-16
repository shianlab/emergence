import { randomUUID } from 'node:crypto';
import {
  chargeRun,
  phaseLabels,
  phaseLimits,
  type RunDiagnostic,
  type RunPhase,
} from '../domain/run-diagnostics.ts';
import type { BudgetPolicy, BudgetReason } from '../domain/run-budget.ts';
import { RunDiagnosticsStore } from '../storage/run-diagnostics-store.ts';

/** One wall-clock partition per session turn, independent of concurrent tool count. */
export class RunDiagnostics {
  private runs: RunDiagnostic[] = [];
  private session = '';
  private tools = new Set<string>();
  private stream?: 'model-wait' | 'model-output';
  private approval = false;
  private waitingResource = false;
  private timer?: ReturnType<typeof setTimeout>;
  private saving = Promise.resolve();
  private savedAt = 0;
  private storageError?: string;
  private writeError?: string;
  private stopping?: Promise<void>;
  private ending?: 'cancelled' | 'deadline';
  constructor(
    private store: RunDiagnosticsStore,
    private policy: () => BudgetPolicy,
    private expire: (reason: string, kind: BudgetReason) => Promise<void>,
    private now = Date.now,
  ) {}
  async bind(session: string) {
    await this.close();
    this.session = session;
    this.storageError = undefined;
    this.writeError = undefined;
    try {
      this.runs = await this.store.read(session);
    } catch {
      this.runs = [];
      this.storageError = '阶段计时文件不可读取；保留原文件，当前只显示内存计时';
    }
    for (const run of this.runs)
      if (run.outcome === 'running') {
        run.outcome = 'interrupted';
        run.endedAt = run.at;
        run.reason = '上次进程在此采样后中断；离线时间与未记录阶段未知，未自动重试';
      }
  }
  start() {
    if (!this.session || this.current?.outcome === 'running') return;
    const at = this.now();
    this.tools.clear();
    this.stream = undefined;
    this.approval = false;
    this.waitingResource = false;
    this.ending = undefined;
    this.runs.push({
      id: randomUUID(),
      session: this.session,
      startedAt: at,
      at,
      phase: 'host',
      durations: { host: 0, 'model-wait': 0, 'model-output': 0, tool: 0, approval: 0, resource: 0 },
      requests: 0,
      outcome: 'running',
    });
    this.runs = this.runs.slice(-32);
    this.watch();
  }
  assign(task?: string) {
    if (this.current?.outcome === 'running') this.current.task = task;
  }
  get current() {
    return this.runs.at(-1);
  }
  forTask(task: string) {
    this.tick();
    return this.runs.filter((run) => run.task === task).map((run) => structuredClone(run));
  }
  get snapshot() {
    this.tick();
    return this.current && structuredClone(this.current);
  }
  get error() {
    return this.storageError ?? this.writeError;
  }
  private phase(): RunPhase {
    return this.approval
      ? 'approval'
      : this.waitingResource
        ? 'resource'
        : this.tools.size
          ? 'tool'
          : (this.stream ?? 'host');
  }
  private change(action: () => void) {
    this.tick();
    action();
    this.tick();
  }
  pending(value: boolean) {
    this.change(() => {
      this.approval = value;
    });
  }
  resource(value: boolean) {
    this.change(() => {
      this.waitingResource = value;
    });
  }
  tool(id: string, active: boolean) {
    this.change(() => {
      if (active) this.tools.add(id);
      else this.tools.delete(id);
    });
  }
  model(event: 'start' | 'output' | 'end' | 'retry') {
    this.change(() => {
      if (event === 'start') {
        this.stream = 'model-wait';
        if (this.current) this.current.requests++;
      } else if (event === 'retry') this.stream = 'model-wait';
      else if (event === 'end') this.stream = undefined;
      else {
        this.stream = 'model-output';
        if (this.current) this.current.lastOutputAt = this.now();
      }
    });
  }
  tick() {
    const run = this.current;
    if (!run || run.outcome !== 'running') return;
    const now = this.now(),
      phase = this.phase();
    chargeRun(run, phase, now);
  }
  deadline() {
    this.tick();
    const run = this.current;
    if (!run || run.outcome !== 'running') return;
    const phase = run.phase;
    if (run.at - run.startedAt >= this.policy().totalMs)
      return '整体历时上限已到（包含等待）；未自动重试或切换模型';
    if (run.durations[phase] >= phaseLimits(this.policy())[phase])
      return `${phaseLabels[phase]}达到阶段期限（${Math.round(run.durations[phase] / 1000)} 秒）；持续输出不延长期限。检查 /tasks 或当前窗口；副作用不明时先 /recover inspect，未自动重试或切换模型。`;
  }
  end(outcome: RunDiagnostic['outcome'] = 'ended', reason?: string) {
    this.tick();
    const run = this.current;
    if (run?.outcome === 'running') {
      run.outcome = this.ending ?? outcome;
      run.endedAt = run.at;
      if (reason) run.reason = reason.slice(0, 1000);
    }
    clearTimeout(this.timer);
    this.timer = undefined;
    this.save();
  }
  cancelling() {
    this.tick();
    this.ending ??= 'cancelled';
    clearTimeout(this.timer);
    this.timer = undefined;
  }
  private save() {
    if (!this.session || this.storageError) return;
    const session = this.session,
      runs = structuredClone(this.runs);
    this.saving = this.saving
      .then(() => this.store.write(session, runs))
      .then(() => {
        this.writeError = undefined;
      })
      .catch(() => {
        // A failed write must not permanently stop later snapshots or the final
        // flush. Unreadable input remains protected by storageError above.
        this.writeError = '阶段计时保存失败；保留内存计时，下次采样再保存；执行记录仍以任务台账为准';
      });
    this.savedAt = this.now();
  }
  private watch() {
    if (this.timer || this.current?.outcome !== 'running') return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const reason = this.deadline();
      if (reason) {
        const run = this.current!;
        const kind =
          run.at - run.startedAt >= this.policy().totalMs
            ? 'overall'
            : run.phase === 'approval'
              ? 'approval'
              : run.phase === 'resource'
                ? 'queue'
                : 'execution';
        this.ending = 'deadline';
        run.reason = reason.slice(0, 1000);
        this.save();
        this.stopping = this.expire(reason, kind).catch(() => {
          this.storageError = '阶段期限已到，但停止失败，须核对执行状态';
        });
      } else {
        if (this.now() - this.savedAt >= 1000) this.save();
        this.watch();
      }
    }, 250);
    this.timer.unref();
  }
  async close() {
    this.end('cancelled');
    await this.stopping;
    await this.saving;
  }
}
