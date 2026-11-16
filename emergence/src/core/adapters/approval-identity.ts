import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-user-approval/types';

/** The pinned Harness does not pass approvalId to its waterfall. Join its committed audit pair by exact call identity. */
export function approvalIdentity(events: readonly SessionEvent[], tool: string, callId?: string) {
  const pending = new Map<string, { toolName: string; callId?: string }>();
  let turn: number | undefined;
  for (const event of events) {
    if (event.type === 'turn/start') {
      turn = event.seq;
      pending.clear();
    }
    if (event.type === 'turn/end') {
      turn = undefined;
      pending.clear();
    }
    if (event.type === 'approval/asked') pending.set(event.data.id, event.data);
    if (event.type === 'approval/decided') pending.delete(event.data.id);
  }
  const matches = [...pending].filter(([, p]) => p.toolName === tool && p.callId === callId);
  if (matches.length > 1) throw new Error('原生审批归属不唯一，不能推测批准对象');
  return { turn, nativeId: matches[0]?.[0] };
}
