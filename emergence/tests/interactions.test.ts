import assert from 'node:assert/strict';
import test from 'node:test';
import { InteractionQueue, type InteractionSpec } from '../src/app/interactions.ts';

const spec: InteractionSpec = {
  kind: 'permission',
  title: 'Run command?',
  sessionId: 'session-a',
  agentId: 'agent-a',
  allowCustom: false,
  options: [
    { id: 'allow', label: 'Allow', value: 'y' },
    { id: 'deny', label: 'Deny', value: 'n' },
  ],
};

test('responses are single-use, queue-bound, and validate before side effects', async () => {
  const queue = new InteractionQueue(() => {});
  let executions = 0;
  const one = queue.request(spec, (text) => {
    executions++;
    return text;
  });
  const old = queue.pending!;
  const two = queue.request(spec, (text) => {
    executions++;
    return text;
  });
  assert.throws(() => queue.answer(old.id, 2, { action: 'submit', selected: ['allow'] }), /过期/);
  assert.throws(() => queue.answer(old.id, 1, { action: 'submit', text: 'y' }), /有效回答/);
  assert.throws(() => queue.answer(old.id, 1, { action: 'submit', selected: ['unknown'] }), /失效/);
  assert.equal(executions, 0);
  queue.answer(old.id, 1, { action: 'submit', selected: ['allow'] });
  assert.equal(await one, 'y');
  assert.throws(() => old.respond('y'), /过期/);
  assert.throws(() => queue.answer(old.id, 1, { action: 'cancel' }), /过期/);
  assert.equal(executions, 1);
  queue.pending!.respond('n');
  assert.equal(await two, 'n');
});

test('abort and close settle every request and cannot approve the next request', async () => {
  const queue = new InteractionQueue(() => {}),
    abort = new AbortController();
  const first = queue.request(
    spec,
    (value) => value,
    abort.signal,
    () => 'cancelled',
  );
  const old = queue.pending!;
  const second = queue.request(
    spec,
    (value) => value,
    undefined,
    () => 'cancelled',
  );
  abort.abort();
  assert.equal(await first, 'cancelled');
  assert.throws(() => old.respond('y'), /过期/);
  assert.ok(queue.pending);
  queue.cancelAll();
  assert.equal(await second, 'cancelled');
  assert.equal(queue.pending, undefined);
  const rejected = queue.request(spec, (value) => value, abort.signal);
  await assert.rejects(rejected, /取消/);
});

test('multi-choice and free text preserve explicit answer types and validation failures remain answerable', async () => {
  const queue = new InteractionQueue(() => {});
  const promise = queue.request({ ...spec, kind: 'multiChoice', allowCustom: true }, (value) => value);
  const request = queue.pending!;
  assert.throws(
    () => queue.answer(request.id, 1, { action: 'submit', selected: ['allow', 'allow'] }),
    /有效选项/,
  );
  queue.answer(request.id, 1, { action: 'submit', selected: ['deny', 'allow'] });
  assert.equal(await promise, 'n,y');
  const text = queue.request({ ...spec, kind: 'text', options: [], allowCustom: true }, (value) => value);
  queue.answer(queue.pending!.id, 1, { action: 'submit', text: '中文🙂\n下一行' });
  assert.equal(await text, '中文🙂\n下一行');
});

test('queued requests are discoverable but cannot be answered out of order; stale lifetime cancels without consuming the next request', async () => {
  const q = new InteractionQueue(() => {});
  let current = true;
  const first = q.request(
    spec,
    (value) => value,
    undefined,
    () => 'cancelled',
    undefined,
    () => current,
  );
  const second = q.request(
    spec,
    (value) => value,
    undefined,
    () => 'cancelled',
  );
  assert.equal(q.all.length, 2);
  const [a, b] = q.all;
  assert.throws(() => q.answer(b.id, b.version, { action: 'submit', selected: ['allow'] }), /过期/);
  current = false;
  assert.throws(() => a.respond('y'), /归属/);
  assert.equal(await first, 'cancelled');
  assert.equal(q.pending!.id, b.id);
  q.answer(b.id, b.version, { action: 'submit', selected: ['deny'] });
  assert.equal(await second, 'n');
});
