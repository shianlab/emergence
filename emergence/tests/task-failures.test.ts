import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import UserApproval from '@deepseek-ai/dsh-user-approval';
import { executionFixture, until } from './fixtures/core-execution.ts';
import { unresolvedTaskErrors } from '../src/core/domain/task-failure.ts';
import { resolvedEvidenceCurrent } from '../src/core/application/task-failures.ts';
import { HistoricalOrchestrationWorkspace as WorkspaceController } from './fixtures/historical-orchestration.ts';

async function fixture({
  different = false,
  stale = false,
  failures = 1,
  command = false,
  invalidArgs = false,
} = {}) {
  const f = await executionFixture();
  await f.ctx.plugin(UserApproval);
  await writeFile(join(f.cwd, 'read.txt'), 'stable source');
  await writeFile(join(f.cwd, 'other.txt'), 'unrelated source');
  let attempts = 0;
  const name = command ? 'pwsh' : 'read';
  f.ctx.effect(() =>
    f.ctx.tools.register(
      defineTool({
        name,
        description: 'bounded recovery fixture',
        parameters: command
          ? { command: { type: 'string', required: true } }
          : { file_path: { type: 'string', required: true }, offset: { type: 'integer' } },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        async execute(args, exec) {
          attempts++;
          if (command) return { exitCode: attempts <= failures ? 7 : 0 };
          if (attempts <= (invalidArgs ? 0 : failures))
            throw new Error('fixture read temporarily unavailable');
          return readFile(
            join(f.ctx.workingDirectory.get(exec.agent!.session), String(args.file_path)),
            'utf8',
          );
        },
      }),
    ),
  );
  f.provider.stream = async function* (options): AsyncIterable<StreamChunk> {
    const messages = options.messages;
    const index = messages.findLastIndex(
      (m) => m.role === 'user' && JSON.stringify(m.content).includes('[Emergence task '),
    );
    if (index < 0) {
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    const n = messages.slice(index + 1).filter((m) => m.role === 'tool').length;
    if (n > failures + 1) {
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    if (stale && n === failures + 1) await writeFile(join(f.cwd, 'read.txt'), 'changed after replacement');
    const tool = n <= failures ? name : 'emergence_report';
    const args =
      n <= failures
        ? command
          ? { command: 'fixture-check' }
          : {
              file_path: different && n > 0 ? 'other.txt' : 'read.txt',
              ...(invalidArgs && n === 0 ? { offset: 'bad type' } : {}),
            }
        : { outcome: 'success', summary: '读取检查完成', artifacts: [] };
    const id = ToolCallId('recovery-' + n),
      raw = JSON.stringify(args);
    yield { type: 'block-start', index: 0, blockType: 'tool-call' };
    yield { type: 'tool-call-delta', index: 0, id, name: tool, argumentsDelta: raw };
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: tool, arguments: raw } };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  };
  const master = f.w.current,
    worker = await f.w.split('row');
  f.w.collaboration.configure(master.id, [worker.id]);
  const task = await f.w.collaboration.enqueue(master.id, worker.id, 'read-recovery', '检查当前文件');
  await until(() => {
    if (worker.controller?.pending) worker.controller.pending.respond('y');
    return !!task.endedAt;
  });
  return { ...f, task, worker, attempts: () => attempts };
}

test('R4 exact read recovery keeps the failed observation and binds its fresh replacement across restart', async () => {
  const f = await fixture();
  try {
    assert.equal(f.task.status, 'succeeded', JSON.stringify(f.task.result));
    assert.equal(f.task.result!.failures!.length, 1);
    assert.deepEqual(f.task.result!.failures![0].resolution, { kind: 'read-retry', by: 'recovery-1' });
    assert.equal(unresolvedTaskErrors(f.task).length, 0);
    assert.equal(f.task.receipts[0].ok, false, 'failed receipt remains immutable');
    assert.equal(await resolvedEvidenceCurrent(f.task), true);
    await f.w.close();
    const restored = new WorkspaceController(f.ctx, f.launch);
    try {
      await restored.initialize();
      const task = restored.collaboration.task(f.task.id);
      assert.deepEqual(task.result, f.task.result);
      await writeFile(join(f.cwd, 'read.txt'), 'new bytes');
      assert.equal(await resolvedEvidenceCurrent(task), false, 'old success is not current evidence');
      await assert.rejects(restored.collaboration.assurance.version(task), /替代证据/);
    } finally {
      await restored.close();
    }
  } finally {
    await f.close();
  }
});

test('R4 native input validation permits corrected read arguments without executing the rejected query', async () => {
  const f = await fixture({ invalidArgs: true });
  try {
    assert.equal(f.task.status, 'succeeded', JSON.stringify(f.task.result));
    assert.equal(f.attempts(), 1, 'the invalid input never reached the read body');
    assert.equal(f.task.receipts[0].failure, 'invalid-arguments');
    assert.notEqual(f.task.receipts[0].argumentsHash, f.task.receipts[1].argumentsHash);
    assert.equal(f.task.result!.failures![0].resolution?.by, f.task.receipts[1].id);
    assert.equal(await resolvedEvidenceCurrent(f.task), true);
  } finally {
    await f.close();
  }
});

test('R4 unrelated reads, stale replacements, exhausted safe attempts and true failed commands remain unresolved', async () => {
  for (const option of [{ different: true }, { stale: true }, { failures: 3 }, { command: true }]) {
    const f = await fixture(option);
    try {
      assert.equal(f.task.status, 'needs_review', JSON.stringify({ option, result: f.task.result }));
      assert.ok(unresolvedTaskErrors(f.task).length);
      assert.equal(f.w.collaboration.state.tasks.length, 1, 'no whole-task retries');
      assert.equal(f.worker.controller!.busy, false);
    } finally {
      await f.close();
    }
  }
});

test('R4 legacy failures remain blocking and a structured unresolved failure cannot be hidden by empty legacy errors', () => {
  assert.deepEqual(unresolvedTaskErrors({ result: { errors: ['old failure'] } }), ['old failure']);
  assert.deepEqual(
    unresolvedTaskErrors({ result: { errors: [], failures: [{ detail: 'actual failure' }] } }),
    ['actual failure'],
  );
});
