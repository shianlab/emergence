import type { SessionEvent } from '@deepseek-ai/dsh-session';
import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionUsage } from '../src/app/tui/session-usage.ts';

const event = (seq: number, usage?: object, stream: unknown[] = [], type = 'assistant/message') =>
  ({ type, seq, time: 1, data: { usage, stream } }) as SessionEvent;

test('session tokens sum receipts, include cached input, and do not double-count reasoning or replay', () => {
  const usage = new SessionUsage();
  assert.equal(usage.label(), 'Tokens 0');
  const first = event(1, {
    inputTokens: 100,
    outputTokens: 40,
    cacheReadTokens: 80,
    cacheWriteTokens: 10,
    reasoningTokens: 30,
  });
  usage.append(first);
  usage.append(first);
  usage.append(event(2, { inputTokens: 1, outputTokens: 1, totalTokens: 300 }));
  assert.equal(usage.total, 530);
  const restored = new SessionUsage();
  [first, event(2, { inputTokens: 1, outputTokens: 1, totalTokens: 300 })].forEach((e) => restored.append(e));
  assert.equal(restored.label(), usage.label());
  assert.equal(new SessionUsage().total, 0);
});

test('missing and invalid receipts remain unknown, partial accounting is labelled', () => {
  const usage = new SessionUsage();
  usage.append(event(1));
  assert.equal(usage.label(), 'Tokens —（未返回）');
  usage.append(event(2, { inputTokens: NaN, outputTokens: -1 }));
  usage.append(event(3, { inputTokens: 1000, outputTokens: 200 }));
  assert.equal(usage.label(), 'Tokens ≥1,200（部分）');
});

test('failed attempts use only the last cumulative stream usage receipt', () => {
  const usage = new SessionUsage();
  usage.append(
    event(
      1,
      undefined,
      [
        { type: 'chunk', time: 1, chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 1 } } },
        { type: 'chunk', time: 2, chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } } },
      ],
      'assistant/attempt',
    ),
  );
  assert.equal(usage.total, 15);
  assert.equal(usage.missing, 0);
});
