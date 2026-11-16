import BasicCompaction from '@deepseek-ai/dsh-compaction-basic';
import { ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm';
import * as MCP from '@deepseek-ai/dsh-mcp-client';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import UserApproval from '@deepseek-ai/dsh-user-approval';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { executionFixture } from './fixtures/core-execution.ts';

test('real MCP timeout ends with an error receipt and releasing the server removes its tools', async () => {
  const f = await executionFixture();
  await f.ctx.plugin(UserApproval);
  const fiber = f.ctx.plugin(
    MCP,
    MCP.Config({
      serverName: 'timeout',
      transport: 'stdio',
      command: process.execPath,
      args: [resolve('tests/fixtures/mcp.cjs'), '--hang-call'],
      toolCallTimeoutMs: 100,
      failOnStartupError: true,
    }),
  );
  try {
    await fiber;
    f.w.current.controller!.launch.approvedCommands = [];
    f.w.current.controller!.launch.appConfig.permissions.rules.push({
      tool: 'mcp__timeout__echo',
      effect: 'allow',
    });
    f.w.current.controller!.setPermissionMode('auto');
    let n = 0;
    f.provider.stream = async function* (): AsyncIterable<StreamChunk> {
      if (n++) {
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }
      const id = ToolCallId('timeout-call'),
        name = 'mcp__timeout__echo',
        raw = '{"value":"bounded"}';
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: raw };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: raw } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    };
    const started = performance.now();
    await f.w.send(f.w.focused, '本地超时检查');
    await f.w.current.controller!.agent.whenIdle();
    assert.ok(performance.now() - started < 5000);
    const result = f.w.current
      .controller!.agent.session.snapshotEvents()
      .find((e) => e.type === 'tool/result');
    assert.equal(result?.type === 'tool/result' && result.data.message.isError, true);
    await fiber.dispose();
    assert.ok(
      !f.ctx.tools.definitions(f.w.current.controller!.agent).some((t) => t.name === 'mcp__timeout__echo'),
    );
  } finally {
    await fiber.dispose();
    await f.close();
  }
});

test('actual Harness compaction preserves durable history, permissions and approved-memory recall', async () => {
  const f = await executionFixture();
  try {
    await f.ctx.plugin(TokenMeter);
    await f.ctx.plugin(BasicCompaction, {
      thresholdRatio: 0.95,
      headroomTokens: 0,
      maxTokens: 128,
      retainTokens: 64,
    });
    const c = f.w.current.controller!,
      identity = await c.memory.identity(),
      entry = await c.memory.propose('project', 'fact', 'COMPACTION_MEMORY_REFERENCE');
    await c.memory.store.change(identity, entry.id, 1, 'approve', c.id!);
    let summary = false;
    const captured: string[] = [];
    f.provider.stream = async function* (options): AsyncIterable<StreamChunk> {
      captured.push(JSON.stringify(options));
      const text = summary ? 'CONTEXT_SUMMARY: 保留用户目标和当前边界' : '已收到 ' + '历史内容 '.repeat(120);
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    };
    for (let i = 0; i < 8; i++) {
      await f.w.send(f.w.focused, '历史任务 ' + i + ' 背景说明'.repeat(120));
      await c.agent.whenIdle();
    }
    const before = c.agent.session.snapshotEvents().length;
    summary = true;
    const result = await f.ctx.compaction.compactNow(c.agent, AbortSignal.timeout(10000));
    assert.ok(result, 'must actually commit compaction');
    assert.ok(c.agent.session.snapshotEvents().length > before, 'compaction preserves append-only evidence');
    assert.ok(c.agent.session.snapshotEvents().some((e) => e.type === 'compaction/end'));
    c.setPermissionMode('plan');
    await f.w.send(f.w.focused, '压缩后继续只读讨论');
    await c.agent.whenIdle();
    assert.ok(captured.at(-1)!.includes('COMPACTION_MEMORY_REFERENCE'));
    assert.ok(captured.at(-1)!.includes('CONTEXT_SUMMARY'));
    assert.equal(c.permissionMode, 'plan');
  } finally {
    await f.close();
  }
});
