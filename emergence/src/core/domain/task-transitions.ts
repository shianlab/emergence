import type { TaskRecord } from './task.ts';

type Status = TaskRecord['status'];
const finalStatuses: readonly Status[] = [
  'succeeded',
  'failed',
  'needs_review',
  'cancelled',
  'blocked',
  'interrupted',
];
const transitions: Record<Status, readonly Status[]> = {
  queued: ['dispatching', ...finalStatuses],
  dispatching: ['queued', 'running', 'waiting_user', ...finalStatuses],
  running: ['waiting_user', ...finalStatuses],
  waiting_user: ['running', ...finalStatuses],
  needs_review: ['succeeded'],
  succeeded: [],
  failed: [],
  cancelled: [],
  blocked: [],
  interrupted: [],
};

/** Recovery/repair creates a new attempt; a settled attempt cannot restart in place. */
export function assertTaskTransition(from: Status, to: Status): void {
  if (from !== to && !transitions[from].includes(to)) {
    throw new Error(`非法任务状态转换：${from} → ${to}`);
  }
}
