import type { SessionEvent } from '@deepseek-ai/dsh-session';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageProjection } from '../src/app/tui/message-model.ts';

const event = (type: string, seq: number, data: unknown) => ({ type, seq, time: 1, data }) as SessionEvent;
const result = (id: string, text: string, isError = false) => ({
  turn: 0,
  step: 0,
  message: {
    id: 'result-' + id,
    role: 'tool',
    source: { kind: 'tool', callId: id },
    toolCallId: id,
    isError,
    content: [{ type: 'text', text }],
  },
});

test('UI tools pair by call identity even when same-name results finish out of order', () => {
  const projection = new MessageProjection('session-a');
  const events = [
    event('tool/call', 0, { callId: 'one', name: 'read', arguments: '{"path":"one"}' }),
    event('tool/call', 1, { callId: 'two', name: 'read', arguments: '{"path":"two"}' }),
    event('tool/result', 2, result('two', 'second error', true)),
    event('tool/result', 3, result('one', '# literal **tool result**')),
  ];
  projection.load(events);
  projection.append(events[3]);
  assert.equal(projection.items.length, 2);
  const [one, two] = projection.items;
  assert.ok(one.kind === 'tool' && two.kind === 'tool');
  assert.equal(one.result, '# literal **tool result**');
  assert.equal(one.status, 'done');
  assert.equal(two.result, 'second error');
  assert.equal(two.status, 'error');
  assert.equal(one.id, 'session-a:0');
  assert.equal(two.id, 'session-a:1');
});

test('message roles come from structured events; Markdown-looking user/context text stays verbatim', () => {
  const raw = '# 涨价 **不要解析**\nC:\\项目\\file.ts';
  const projection = new MessageProjection('session-b').load([
    event('user/message', 0, { source: { kind: 'user' }, content: [{ type: 'text', text: raw }] }),
    event('user/message', 1, {
      source: { kind: 'emergence-task', taskId: 'task-1' },
      content: [{ type: 'text', text: raw }],
    }),
    event('assistant/message', 2, { message: { content: [{ type: 'text', text: raw }] }, interrupted: true }),
  ]);
  assert.deepEqual(
    projection.items.map((item) => item.kind),
    ['user', 'context', 'assistant'],
  );
  assert.ok(projection.items.every((item) => item.kind !== 'tool' && item.text === raw));
  assert.ok(projection.items[1].kind === 'context' && projection.items[1].label?.includes('task-1'));
  assert.ok(projection.items[2].kind === 'assistant' && projection.items[2].interrupted);
});

test('bounded message projection preserves source events and never confuses sessions or duplicate delivery', () => {
  const events = Array.from({ length: 205 }, (_, seq) =>
    event('user/message', seq, {
      source: { kind: 'user' },
      content: [{ type: 'text', text: `message ${seq}` }],
    }),
  );
  const before = JSON.stringify(events),
    projection = new MessageProjection('one').load(events);
  assert.equal(projection.items.length, 200);
  assert.equal(projection.omitted, 5);
  assert.equal(projection.items[0].seq, 5);
  projection.append(events[204]);
  assert.equal(projection.items.length, 200);
  assert.equal(JSON.stringify(events), before);
  assert.notEqual(projection.items[0].id, new MessageProjection('two').load(events).items[0].id);
});
