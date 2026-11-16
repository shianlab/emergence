import assert from 'node:assert/strict';
import { test } from 'node:test';
import { approvalEvents } from './fixtures/approval-events.ts';
const call = (id: string) => ({ type: 'tool/call', data: { callId: id, name: 'pwsh', arguments: '{}' } });
const ask = (id: string, callId: string) => ({
  type: 'approval/asked',
  time: 1,
  data: { id, callId, toolName: 'pwsh' },
});
const decide = (id: string, outcome: string) => ({ type: 'approval/decided', data: { id, outcome } });
const journal = (...events: unknown[]) => events.map((e) => JSON.stringify(e)).join('\n') + '\n';
test('native approval identity survives concurrent calls, decisions and partial tail', () => {
  const events = journal(call('a'), call('b'), ask('one', 'a'), ask('two', 'b'), decide('one', 'rejected'));
  const result = approvalEvents(events + '{"type":');
  assert.deepEqual(
    result.pending.map((p) => [p.id, p.call.callId]),
    [['two', 'b']],
  );
  assert.equal(result.decisions.get('one'), 'rejected');
  assert.equal(approvalEvents(events + journal(decide('two', 'allowed-once'))).pending.length, 0);
});
test('window journals isolate identical call IDs and reject unbound approvals', () => {
  const first = approvalEvents(journal(call('a'), ask('one', 'a'), decide('one', 'allowed-once')));
  const second = approvalEvents(journal(call('a'), ask('two', 'a')));
  assert.equal(first.pending.length, 0);
  assert.equal(second.pending[0].id, 'two');
  assert.throws(() => approvalEvents(journal(ask('missing', 'unknown'))));
  assert.throws(() => approvalEvents('{bad}\n'));
});
