import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { WorkspaceController } from '../src/app/workspace.ts';
import { approvalFixture } from './fixtures/workspace-approvals.ts';
import { until } from './fixtures/core-execution.ts';
import { approvalIdentity } from '../src/core/adapters/approval-identity.ts';

test('R3 three real cross-project approval queues allow, reject and cancel by native identity, regardless of focus or task label', async () => {
  const f = await approvalFixture();
  try {
    const tasks = await f.start(),
      entries = f.w.interactions.list();
    assert.equal(entries.length, 3);
    for (const entry of entries) {
      const task = tasks.find((t) => t.target === entry.ref.pane)!;
      assert.equal(entry.request.binding!.taskId, task.id);
      assert.equal(entry.request.binding!.runId, task.runId);
      assert.equal(entry.request.id, entry.request.binding!.nativeId);
      const event = f.w.panes
        .get(entry.ref.pane)!
        .controller!.agent.session.snapshotEvents()
        .find((e) => e.type === 'approval/asked');
      assert.equal(event?.type === 'approval/asked' && event.data.id, entry.ref.id);
    }
    const [a, b, c] = entries;
    f.w.hide(f.workers[0].id);
    f.w.focus(f.master.id);
    assert.throws(
      () =>
        f.w.interactions.respond({ ...a.ref, pane: b.ref.pane }, { action: 'submit', selected: ['allow'] }),
      /过期/,
    );
    assert.throws(
      () =>
        f.w.interactions.respond(
          { ...a.ref, fingerprint: 'wrong' },
          { action: 'submit', selected: ['allow'] },
        ),
      /过期/,
    );
    await f.w.send(f.master.id, `/approval ${b.ref.id} ${b.ref.version} deny`);
    f.w.interactions.respond(a.ref, { action: 'submit', selected: ['allow'] });
    f.w.interactions.respond(c.ref, { action: 'cancel' });
    await until(() => tasks.every((t) => !!t.endedAt));
    assert.equal(f.writes(), 1);
    assert.equal(await readFile(join(f.workers[0].cwd, 'result.txt'), 'utf8'), 'persisted actual effect');
    for (const p of f.workers.slice(1)) await assert.rejects(readFile(join(p.cwd, 'result.txt')));
    for (const [i, outcome] of ['allowed-once', 'rejected', 'cancelled'].entries()) {
      const decisions = f.workers[i]
        .controller!.agent.session.snapshotEvents()
        .filter((e) => e.type === 'approval/decided');
      assert.equal(decisions.length, 1);
      assert.equal(decisions[0].data.id, entries[i].ref.id);
      assert.equal(decisions[0].data.outcome, outcome);
    }
    assert.equal(f.w.interactions.list().length, 0);
    assert.throws(() => f.w.interactions.respond(a.ref, { action: 'submit', selected: ['allow'] }), /过期/);
  } finally {
    await f.close();
  }
});

test('R3 stale approvals cannot survive permission changes, cancellation, window close or workspace restart', async () => {
  const f = await approvalFixture();
  let restored: WorkspaceController | undefined;
  try {
    await f.start();
    const [a, b, c] = f.w.interactions.list();
    f.workers[0].controller!.setPermissionMode('plan');
    await f.w.taskEngine.cancel(b.request.binding!.taskId!);
    await f.w.closePane(c.ref.pane);
    for (const entry of [a, b, c])
      assert.throws(
        () => f.w.interactions.respond(entry.ref, { action: 'submit', selected: ['allow'] }),
        /过期/,
      );
    assert.equal(f.writes(), 0);
    await f.w.save();
    await f.w.close();
    restored = new WorkspaceController(f.ctx, f.launch);
    await restored.initialize();
    assert.equal(restored.interactions.list().length, 0);
    assert.throws(
      () => restored!.interactions.respond(a.ref, { action: 'submit', selected: ['allow'] }),
      /过期/,
    );
    assert.equal(f.writes(), 0);
  } finally {
    await restored?.close();
    await f.close();
  }
});

test('R3 rejecting a tool prevents the model from re-asking the identical operation in the same turn', async () => {
  const f = await approvalFixture(1);
  try {
    let calls = 0;
    f.provider.stream = async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
      // A historical receipt may wake the issuer. Only the assigned worker participates in this fixture.
      if (
        !options.messages.some(
          (message) => message.role === 'user' && message.source?.kind === 'emergence-task',
        )
      ) {
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }
      if (++calls > 2) {
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }
      const id = ToolCallId('repeat-' + calls),
        name = 'write',
        args = JSON.stringify({ file_path: 'result.txt', content: 'should never write' });
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    };
    const tasks = await f.start(),
      entry = f.w.interactions.list()[0];
    f.w.interactions.respond(entry.ref, { action: 'submit', selected: ['deny'] });
    await until(() => !!tasks[0].endedAt);
    assert.equal(calls, 1, 'denial ends the dispatched task before another model request');
    assert.equal(tasks[0].status, 'cancelled');
    assert.equal(f.w.interactions.list().length, 0);
    assert.equal(f.writes(), 0);
    assert.equal(
      f.workers[0].controller!.agent.session.snapshotEvents().filter((e) => e.type === 'approval/asked')
        .length,
      1,
    );
  } finally {
    await f.close();
  }
});

test('R3 native metadata follows read ask through the normal approval gate without running shell', async () => {
  const f = await approvalFixture(1);
  try {
    const p = f.workers[0];
    await writeFile(join(p.cwd, 'data.txt'), '数据\r\n');
    p.controller!.launch.appConfig.permissions.rules.push({ tool: 'read', effect: 'ask' });
    let calls = 0;
    f.provider.stream = async function* (): AsyncIterable<StreamChunk> {
      if (++calls > 1) {
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }
      const id = ToolCallId('metadata'),
        name = 'emergence_inspect',
        args = JSON.stringify({ file_path: 'data.txt' });
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    };
    const tasks = await f.start(),
      entry = f.w.interactions.list()[0];
    assert.equal(entry.request.binding!.tool, 'emergence_inspect');
    assert.ok(!entry.request.options.some((o) => o.id === 'session'));
    f.w.interactions.respond(entry.ref, { action: 'submit', selected: ['allow'] });
    await until(() => !!tasks[0].endedAt);
    assert.ok(tasks[0].receipts.some((r) => r.tool === 'emergence_inspect' && r.ok));
    assert.equal(
      tasks[0].receipts.some((r) => r.kind === 'command'),
      false,
    );
    assert.equal(f.writes(), 0);
  } finally {
    await f.close();
  }
});

test('R3 approval arguments remain immutable and changing the task run invalidates the pending decision before effects', async () => {
  for (const changed of ['arguments', 'run']) {
    let args: Record<string, unknown> | undefined;
    const f = await approvalFixture(1, (value) => {
      args = value;
    });
    try {
      const tasks = await f.start(),
        entry = f.w.interactions.list()[0];
      const events = f.workers[0].controller!.agent.session.snapshotEvents();
      const native = events.findLast((e) => e.type === 'approval/asked')!;
      assert.throws(
        () =>
          approvalIdentity(
            [...events, { ...native, data: { ...native.data, id: 'duplicate' } }] as typeof events,
            'write',
            entry.request.binding!.callId,
          ),
        /不唯一/,
      );
      if (changed === 'arguments') {
        assert.throws(() => {
          args!.file_path = 'unexpected.txt';
        }, /read only/);
        assert.throws(() => {
          Object.assign(entry.request.binding!, { fingerprint: 'forged' });
        }, /read only/);
        f.w.interactions.respond(entry.ref, { action: 'cancel' });
      } else {
        Object.assign(tasks[0], { runId: 'different-run' });
        assert.throws(
          () => f.w.interactions.respond(entry.ref, { action: 'submit', selected: ['allow'] }),
          /归属/,
        );
      }
      await until(() => !!tasks[0].endedAt);
      assert.equal(f.writes(), 0);
      assert.equal(f.w.interactions.list().length, 0);
      const decided = f.workers[0]
        .controller!.agent.session.snapshotEvents()
        .find((e) => e.type === 'approval/decided' && e.data.id === entry.ref.id);
      assert.equal(decided?.type === 'approval/decided' && decided.data.outcome, 'cancelled');
    } finally {
      await f.close();
    }
  }
});

test('R3 host decisions are discoverable without a running task and use the same identity command', async () => {
  const f = await approvalFixture(1);
  try {
    const c = f.workers[0].controller!;
    const answer = c.confirmDecision('测试决策', () => true);
    const entry = f.w.interactions.list()[0];
    assert.equal(f.w.taskEngine.state.tasks.length, 0);
    assert.equal(entry.request.binding, undefined);
    await f.w.send(f.master.id, `/approval ${entry.ref.id} ${entry.ref.version} allow`);
    assert.equal(await answer, true);
    const cancelled = c.confirmDecision('测试过期决策', () => false);
    const expired = f.w.interactions.list()[0];
    await assert.rejects(
      f.w.send(f.master.id, `/approval ${expired.ref.id} ${expired.ref.version} allow`),
      /归属/,
    );
    assert.equal(await cancelled, false);
    assert.equal(f.w.interactions.list().length, 0);
  } finally {
    await f.close();
  }
});
