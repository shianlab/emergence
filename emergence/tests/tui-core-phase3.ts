import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { createTestRenderer } from '@opentui/core/testing';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { mountWorkspaceUI } from '../src/app/workspace-ui.ts';
import { WorkspaceController } from '../src/app/workspace.ts';
import { defaultConfig } from '../src/core/domain/configuration.ts';
import { harness } from './fixtures/harness.ts';

const dir = resolve('../artifacts/core-phase3');
await mkdir(dir, { recursive: true });
const root = await mkdtemp(join(dir, 'native-')),
  config = structuredClone(defaultConfig);
config.models[0].apiKeyEnv = 'CORE_PHASE3_TEST_KEY';
const previous = process.env.CORE_PHASE3_TEST_KEY;
process.env.CORE_PHASE3_TEST_KEY = 'local-fixture';
let calls = 0;
class Provider extends LlmAdapter {
  async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, defaultMaxTokens: 256 };
  }
  async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    calls++;
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
const ctx = await harness(root, ['deepseek'], new Provider()),
  w = new WorkspaceController(ctx, { home: root, cwd: root, modelId: 'deepseek', appConfig: config });
await w.initialize();
const test = await createTestRenderer({ width: 120, height: 40, kittyKeyboard: true }),
  ui = mountWorkspaceUI(test.renderer, w, () => {});
const checks: Record<string, boolean> = {},
  frames: Record<string, string> = {};
try {
  const first = w.current,
    view = ui.views.get(first.id)!;
  view.input.setText('/规划');
  await test.flush();
  assert.equal(view.commands.selected?.command, '/plan');
  test.mockInput.pressEnter();
  await test.flush();
  assert.ok(w.overlay.includes('任务规划'));
  assert.ok(w.overlay.includes('尚未提交任务'));
  assert.equal(calls, 0);
  frames.idle = test.captureCharFrame();
  checks.chineseSlashPlanAndLocalReadout = true;
  await w.send(first.id, '规划多窗口任务');
  await first.controller!.agent.whenIdle();
  await w.send(first.id, '/plan');
  await test.flush();
  assert.equal(calls, 1);
  assert.ok(w.overlay.includes('结构化规划'));
  assert.ok(w.overlay.includes('等待方案'));
  frames.planning = test.captureCharFrame();
  await w.send(first.id, '/capabilities');
  await test.flush();
  assert.ok(w.overlay.includes('未验证'));
  assert.ok(w.overlay.includes('method:meta-conductor'));
  frames.capabilities = test.captureCharFrame();
  checks.realRouteAndHonestCapabilities = true;
  const second = await w.split('row');
  await w.send(second.id, '/plan');
  assert.ok(w.overlay.includes('尚未提交任务'));
  test.resize(60, 24);
  await test.flush();
  assert.ok(test.captureCharFrame().includes('任务规划'));
  frames.narrow = test.captureCharFrame();
  checks.paneIsolationAndNarrowReadout = true;
  await writeFile(join(dir, 'native.json'), JSON.stringify({ passed: true, checks, frames }, null, 2));
  console.log(JSON.stringify(checks));
} catch (error) {
  await writeFile(
    join(dir, 'native.json'),
    JSON.stringify(
      { passed: false, error: String(error), checks, frames, frame: test.captureCharFrame() },
      null,
      2,
    ),
  );
  throw error;
} finally {
  ui.dispose();
  await w.close();
  await test.dispose();
  await ctx.fiber.dispose();
  if (previous === undefined) delete process.env.CORE_PHASE3_TEST_KEY;
  else process.env.CORE_PHASE3_TEST_KEY = previous;
}
