import type { SessionEvent } from '@deepseek-ai/dsh-session';

/** Session-local accounting from settled provider receipts, never text estimates. */
export class SessionUsage {
  private sequence = -1;
  total = 0;
  reported = 0;
  missing = 0;
  append(event: SessionEvent) {
    if (event.seq <= this.sequence) return;
    this.sequence = event.seq;
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return;
    const last = event.data.stream?.findLast(
      (record) => record.type === 'chunk' && record.chunk.type === 'usage',
    );
    const usage =
      (event.type === 'assistant/message' ? event.data.usage : undefined) ??
      (last?.type === 'chunk' && last.chunk.type === 'usage' ? last.chunk.usage : undefined);
    const valid = (value: unknown): value is number =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
    const parts = usage && [
      usage.inputTokens,
      usage.outputTokens,
      usage.cacheReadTokens ?? 0,
      usage.cacheWriteTokens ?? 0,
    ];
    // Reasoning tokens are a subset of output, not an additional charge here.
    const total = valid(usage?.totalTokens)
      ? usage.totalTokens
      : parts?.every(valid)
        ? parts.reduce((a, b) => a + b, 0)
        : undefined;
    if (!valid(total)) {
      this.missing++;
      return;
    }
    this.total += total;
    this.reported++;
  }
  label(en = false) {
    if (!this.reported && this.missing) return en ? 'Tokens — (unreported)' : 'Tokens —（未返回）';
    return `Tokens ${this.missing ? '≥' : ''}${this.total.toLocaleString('en-US')}${this.missing ? (en ? ' (partial)' : '（部分）') : ''}`;
  }
}
