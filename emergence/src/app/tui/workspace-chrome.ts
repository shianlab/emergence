import stringWidth from 'string-width';
import { safeError } from '../../core/adapters/redaction.ts';
import type { TaskRecord } from '../../core/domain/task.ts';
import type { PaneState, WorkspaceController } from '../workspace.ts';

const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'grapheme' });
export function fitCells(value: string, width: number, tail = false, redact = safeError) {
  const text = redact(value).replace(/\s+/g, ' ');
  if (stringWidth(text) <= width) return text;
  if (width <= 1) return width ? '…' : '';
  const parts = [...segmenter.segment(text)].map((part) => part.segment);
  let result = '',
    size = 1;
  for (const part of tail ? parts.reverse() : parts) {
    const length = stringWidth(part);
    if (size + length > width) break;
    result = tail ? part + result : result + part;
    size += length;
  }
  return tail ? '…' + result : result + '…';
}
export function projectName(cwd: string) {
  return (
    cwd
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .at(-1) || cwd
  );
}
/** Prefer the usage value over its explanatory suffix when a pane gets narrow. */
export function sessionFooter(path: string, usage: string, width: number, redact = safeError) {
  const available = Math.max(0, width);
  const label = stringWidth(usage) + 7 > available ? usage.replace(/(?:（| \().*$/, '') : usage;
  if (stringWidth(label) + 4 > available) return fitCells(label, available, false, redact);
  return fitCells(path, available - stringWidth(label) - 3, true, redact) + ' · ' + label;
}
export function paneNumber(workspace: WorkspaceController, id: string) {
  return [...workspace.panes.keys()].indexOf(id) + 1;
}
export function paneState(pane: PaneState, en: boolean) {
  return pane.error
    ? en
      ? '× Unavailable'
      : '× 不可用'
    : pane.controller?.pending
      ? en
        ? '◇ Approval'
        : '◇ 待确认'
      : pane.controller?.busy
        ? en
          ? '● Working'
          : '● 工作中'
        : en
          ? '○ Ready'
          : '○ 就绪';
}
export const taskStateLabels: Record<TaskRecord['status'], [string, string, string]> = {
  queued: ['·', '排队', 'Queued'],
  dispatching: ['…', '准备派发', 'Dispatching'],
  running: ['●', '执行中', 'Running'],
  waiting_user: ['◇', '等待用户', 'Awaiting answer'],
  needs_review: ['?', '待检查', 'Needs review'],
  succeeded: ['✓', '已完成', 'Succeeded'],
  failed: ['×', '失败', 'Failed'],
  cancelled: ['■', '已取消', 'Cancelled'],
  blocked: ['!', '依赖阻塞', 'Blocked'],
  interrupted: ['■', '已中断', 'Interrupted'],
};
export function taskState(task: TaskRecord, en: boolean) {
  const label = taskStateLabels[task.status];
  return `${label[0]} ${label[en ? 2 : 1]}`;
}
export function taskCounts(tasks: readonly TaskRecord[], en: boolean) {
  const count = (statuses: TaskRecord['status'][]) =>
    tasks.filter((task) => statuses.includes(task.status)).length;
  return [
    [en ? 'Running' : '运行', count(['dispatching', 'running'])],
    [en ? 'Queued' : '排队', count(['queued'])],
    [en ? 'Answer' : '待回答', count(['waiting_user'])],
    [en ? 'Review' : '待检查', count(['needs_review'])],
    [en ? 'Succeeded' : '完成', count(['succeeded'])],
    [en ? 'Issues' : '异常', count(['failed', 'blocked', 'interrupted'])],
  ]
    .map(([label, value]) => `${label} ${value}`)
    .join(' · ');
}
