import { advanceClock, budgetReasons } from './run-budget.ts';
import { diagnosticText, type RunDiagnostic } from './run-diagnostics.ts';
import { settledTaskStatuses, type TaskRecord } from './task.ts';

export function taskDiagnostics(task: TaskRecord, runs: RunDiagnostic[], now = Date.now()) {
  const clock =
    task.timing &&
    advanceClock(
      structuredClone(task.timing),
      Date.parse(task.createdAt),
      task.timing.mode,
      settledTaskStatuses.has(task.status) ? task.timing.at : now,
    );
  const seconds = (ms: number | undefined) => (ms === undefined ? '未知' : (ms / 1000).toFixed(1) + ' 秒');
  return (
    `任务 ${task.id} · 窗口 ${task.target}\n${task.progress}\n` +
    `派发至执行${task.endedAt ? '结束' : '当前'}历时 ${seconds(Math.max(0, (task.endedAt ? Date.parse(task.endedAt) : now) - Date.parse(task.createdAt)))}\n` +
    `任务计时：执行 ${seconds(clock?.active)} · 审批 ${seconds(clock?.waiting)} · 排队 ${seconds(clock?.queued)} · 暂停 ${seconds(clock?.paused)}\n` +
    (task.timeout ? `生产预算：${budgetReasons[task.timeout]}\n` : '') +
    (runs.length ? runs.map(diagnosticText).join('\n') : diagnosticText(undefined)) +
    `\n处理：${task.status === 'waiting_user' ? '在所属窗口批准或拒绝；不更换窗口绕过审批' : task.status === 'queued' ? '检查依赖、资源占用或 /mode；可取消等待' : task.recovery === 'uncertain' || ['interrupted', 'blocked'].includes(task.status) ? '/recover inspect ' + task.id + '，先核对实际回执与产物' : '可查看 /tasks；取消不会自动重放历史写入'}`
  );
}
