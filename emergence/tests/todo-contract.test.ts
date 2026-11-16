import * as Todo from '@deepseek-ai/dsh-tool-todo';
import UserApproval from '@deepseek-ai/dsh-user-approval';
import { ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executionFixture } from './fixtures/core-execution.ts';
import { toolContract } from '../src/core/domain/tool-contract.ts';

test('native session todo control runs in Plan mode without approval, file effects or another session mutation', async () => {
  const f = await executionFixture();
  try {
    await f.ctx.plugin(UserApproval);
    await f.ctx.plugin(Todo, { allowParallelInProgress: false });
    const main = f.w.current,
      other = await f.w.split('row');
    main.controller!.setPermissionMode('plan');
    let n = 0;
    f.provider.stream = async function* (): AsyncIterable<StreamChunk> {
      if (n++) {
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }
      const id = ToolCallId('todo-control'),
        name = 'todo_write';
      const raw = JSON.stringify({ todos: [{ content: '检查本会话', status: 'in_progress' }] });
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: raw };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: raw } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    };
    await f.w.send(main.id, '列出检查步骤，不修改文件');
    await main.controller!.agent.whenIdle();
    assert.ok(!main.controller!.pending);
    const events = main.controller!.agent.session.snapshotEvents();
    assert.equal(events.filter((e) => e.type === 'todo/write').length, 1);
    assert.ok(!other.controller!.agent.session.snapshotEvents().some((e) => e.type === 'todo/write'));
    assert.equal(f.writes(), 0);
    assert.equal(toolContract('todo_write').operation, 'control');
    assert.equal(toolContract('todo_write').parallelFileTask, true);
    assert.equal(toolContract('invented_todo_writer').authority, 'unknown');
  } finally {
    await f.close();
  }
});
