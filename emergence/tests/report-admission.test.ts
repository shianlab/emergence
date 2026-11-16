import { ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executionFixture, until } from './fixtures/core-execution.ts';

test('an invalid artifact report stays correctable in the current turn without replaying completed writes', async () => {
  const f = await executionFixture();
  try {
    const main = f.w.current,
      worker = await f.w.split('row');
    main.controller!.setPermissionMode('auto');
    f.w.collaboration.configure(main.id, [worker.id]);
    let request = 0;
    f.provider.stream = async function* (): AsyncIterable<StreamChunk> {
      const n = request++;
      if (n > 2) throw new Error('A valid report should conclude the turn');
      if (n === 2) {
        const task = f.w.collaboration.current(worker.id)!;
        assert.equal(task.report, undefined, 'invalid paths never enter durable report state');
        assert.equal(task.status, 'running');
        assert.equal(f.writes(), 1);
      }
      const name = n === 0 ? 'write' : 'emergence_report';
      const args =
        n === 0
          ? { file_path: 'result.txt', content: 'actual effect' }
          : {
              outcome: 'success',
              summary: '完成',
              artifacts: n === 1 ? ['../wrong-project/result.txt', 'result.txt'] : ['result.txt'],
            };
      const id = ToolCallId(`report-${n}`),
        raw = JSON.stringify(args);
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: raw };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: raw } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    };
    const task = await f.w.collaboration.enqueue(
      main.id,
      worker.id,
      'report-admission',
      'write and report',
      [],
      {
        role: 'developer',
        scope: ['result.txt'],
        acceptance: ['实际写入完成'],
      },
    );
    await until(() => task.status === 'needs_review');
    assert.deepEqual(task.result?.artifacts, ['result.txt']);
    assert.deepEqual(task.result?.errors, []);
    assert.equal(f.writes(), 1);
    assert.equal(request, 3);
    assert.ok(await f.w.collaboration.assurance.version(task));
    const events = JSON.stringify(worker.controller!.agent.session.snapshotEvents());
    assert.match(events, /INVALID_REPORT_ARTIFACTS/);
    assert.match(events, /artifacts.0/);
  } finally {
    await f.close();
  }
});
