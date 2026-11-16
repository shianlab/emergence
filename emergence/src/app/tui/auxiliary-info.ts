/** Only known routine receipts expire. Unknown notices, errors and conflicts stay visible. */
const receipts: Record<string, [string, string]> = {
  已提交: ['已提交', 'Submitted'],
  本轮已完成: ['✓ 本轮已完成', '✓ Turn completed'],
  已创建新会话: ['已创建新会话', 'New session created'],
  已恢复会话: ['已恢复会话', 'Session restored'],
};
export interface ReceiptClock {
  session: string;
  value: string;
  since: number;
}
export function auxiliaryInfo(
  input: {
    session: string;
    notice?: string;
    globalNotice?: string;
    busy: boolean;
    pending: boolean;
    queued: number;
    error?: string;
    shared: number;
    expanded: boolean;
    en: boolean;
    now: number;
  },
  previous?: ReceiptClock,
) {
  const value = input.notice ?? '';
  const clock =
    previous?.session === input.session && previous.value === value
      ? previous
      : { session: input.session, value, since: input.now };
  const routine = Object.hasOwn(receipts, value) ? receipts[value] : undefined;
  const active = input.busy || input.pending || input.queued > 0 || Boolean(input.error);
  const receipt = routine && !active && input.now - clock.since < 4000 ? routine[input.en ? 1 : 0] : '';
  // Initial placeholder is already in the input; queued/submitted state is represented by the live status.
  const redundant = new Set(['输入任务开始工作，/help 查看命令', '已加入队列，当前任务结束后处理']);
  const persistent = [
    ...new Set(
      [input.error, value, input.globalNotice].filter(
        (item): item is string =>
          Boolean(item) &&
          (item === input.error || (!Object.hasOwn(receipts, item!) && !redundant.has(item!))),
      ),
    ),
  ].join('\n');
  const shared =
    input.shared > 0
      ? input.en
        ? `Shared project · ${input.shared} other sessions · [${input.expanded ? 'Less' : 'Details'}]`
        : `共享项目 · 另有 ${input.shared} 个会话 · [${input.expanded ? '收起' : '详情'}]`
      : '';
  const details =
    input.expanded && shared
      ? input.en
        ? '\nThese sessions use the same directory. Coordinate edits to the same files.'
        : '\n这些会话使用同一目录，修改同一文件时需协调。'
      : '';
  return {
    clock,
    receipt,
    persistent,
    shared: shared + details,
    mergeReady: Boolean(shared) && !active && !receipt && !persistent && !input.expanded,
  };
}
