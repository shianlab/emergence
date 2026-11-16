import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WorkspaceController } from '../src/app/workspace.ts';
import { defaultConfig } from '../src/core/domain/configuration.ts';
import { harness } from './fixtures/harness.ts';
class Provider extends LlmAdapter {
  async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, defaultMaxTokens: 1024 };
  }
  async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const text = '并行输出 '.repeat(100);
    yield { type: 'block-start', index: 0, blockType: 'text' };
    for (let i = 0; i < 100; i++) {
      yield { type: 'text-delta', index: 0, text: '并行输出 ' };
      if (i % 10 === 0) await new Promise<void>((done) => setImmediate(done));
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
const home = await mkdtemp(join(tmpdir(), 'emergence-audit-stress-')),
  config = structuredClone(defaultConfig);
config.models[0].apiKeyEnv = 'AUDIT_STRESS_KEY';
const previous = process.env.AUDIT_STRESS_KEY;
process.env.AUDIT_STRESS_KEY = 'local-stress-fixture';
const ctx = await harness(home, [config.defaultModel], new Provider()),
  workspace = new WorkspaceController(ctx, {
    home,
    cwd: home,
    modelId: config.defaultModel,
    appConfig: config,
  });
const begin = performance.now(),
  memoryBefore = process.memoryUsage().rss;
let rounds = 0,
  messages = 0;
try {
  await workspace.initialize();
  for (let cycle = 0; cycle < 3; cycle++) {
    while (workspace.panes.size < 16) await workspace.split(workspace.panes.size % 2 ? 'row' : 'column');
    await assert.rejects(workspace.split('row'), /最多托管 16/);
    const active = [...workspace.panes.values()];
    for (let iteration = 0; iteration < 4; iteration++) {
      await Promise.all(active.map((pane) => workspace.send(pane.id, 'bounded stress')));
      await Promise.all(active.map((pane) => pane.controller!.agent.whenIdle()));
      rounds++;
      messages += active.length;
    }
    const keep = active[0];
    await Promise.all(active.slice(1).map((pane) => workspace.closePane(pane.id)));
    assert.equal(workspace.panes.size, 1);
    assert.equal(ctx.agents.list().length, 1);
    assert.equal(workspace.current.id, keep.id);
  }
  await workspace.close();
  assert.equal(ctx.agents.list().length, 0);
  await ctx.fiber.dispose();
  const dir = resolve('../artifacts/audit-2026-10-29');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'bounded-stress.json'),
    JSON.stringify(
      {
        passed: true,
        runtime: process.version,
        peakPaneCount: 16,
        rounds,
        messages,
        durationMs: Math.round(performance.now() - begin),
        memoryBefore,
        memoryAfter: process.memoryUsage().rss,
        registryEmpty: true,
        scope: '短时并发和创建/关闭循环；不是长时间性能验收，也不据此证明全部内存自然回收',
      },
      null,
      2,
    ),
  );
  console.log(`PASS ${messages} turns, 16 concurrent panes, 3 create/close cycles, registry empty`);
} finally {
  await workspace.close();
  await ctx.fiber.dispose();
  if (previous === undefined) delete process.env.AUDIT_STRESS_KEY;
  else process.env.AUDIT_STRESS_KEY = previous;
}
