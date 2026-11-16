import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WorkspaceController } from '../src/app/workspace.ts';
import { defaultConfig } from '../src/core/domain/configuration.ts';
import { harness } from './fixtures/harness.ts';

class Provider extends LlmAdapter {
  async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, defaultMaxTokens: 512 };
  }
  async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: '历史保留' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '历史保留' } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
test('close reveals a hidden survivor, retains history and drafts, persists removal, and cannot concurrently remove every pane', async () => {
  const home = await mkdtemp(join(tmpdir(), 'emergence-close-')),
    config = structuredClone(defaultConfig);
  config.models[0].apiKeyEnv = 'PANE_TEST_KEY';
  const previous = process.env.PANE_TEST_KEY;
  process.env.PANE_TEST_KEY = 'local-fixture';
  const ctx = await harness(home, [config.defaultModel], new Provider());
  const launch = { home, cwd: home, modelId: config.defaultModel, appConfig: config };
  let workspace = new WorkspaceController(ctx, launch);
  try {
    await workspace.initialize();
    const a = workspace.current,
      b = await workspace.split('row'),
      c = await workspace.split('column');
    for (const pane of [a, b, c]) {
      await workspace.send(pane.id, '保存历史');
      await pane.controller!.agent.whenIdle();
    }
    const histories = [a, b, c].map((p) => p.sessionId);
    workspace.updateView(b.id, '保留草稿', 3);
    workspace.hide(b.id);
    workspace.hide(c.id);
    assert.deepEqual(workspace.visible(), [a.id]);
    await workspace.closePane(a.id);
    assert.deepEqual(workspace.visible(), [b.id]);
    assert.equal(workspace.focused, b.id);
    assert.equal(workspace.current.draft, '保留草稿');
    await workspace.send(b.id, `/close ${c.id}`);
    assert.equal(workspace.panes.size, 1);
    assert.equal(workspace.current.id, b.id);
    await assert.rejects(workspace.closePane(), /最后一个窗口/);
    const sessions = await ctx.sessionPersistence.list();
    for (const id of histories) assert.ok(sessions.some((s) => s.header.id === id));
    await workspace.close();
    workspace = new WorkspaceController(ctx, launch);
    await workspace.initialize();
    assert.deepEqual([...workspace.panes.keys()], [b.id]);
    assert.equal(workspace.current.draft, '保留草稿');
    const d = await workspace.split('row'),
      e = await workspace.split('column');
    const results = await Promise.allSettled([
      workspace.closePane(d.id),
      workspace.closePane(e.id),
      workspace.closePane(b.id),
    ]);
    assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
    assert.equal(workspace.panes.size, 1);
    assert.deepEqual(workspace.visible(), [b.id]);
  } finally {
    await workspace.close();
    await ctx.fiber.dispose();
    if (previous === undefined) delete process.env.PANE_TEST_KEY;
    else process.env.PANE_TEST_KEY = previous;
  }
});
