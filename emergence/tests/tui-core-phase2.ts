import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { createTestRenderer } from '@opentui/core/testing';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { mountWorkspaceUI } from '../src/app/workspace-ui.ts';
import { WorkspaceController } from '../src/app/workspace.ts';
import { defaultConfig } from '../src/core/domain/configuration.ts';
import { harness } from './fixtures/harness.ts';

const dir = resolve('../artifacts/core-phase2');
await mkdir(dir, { recursive: true });
const root = await mkdtemp(join(dir, 'native-')),
  config = structuredClone(defaultConfig);
config.models[0].apiKeyEnv = 'CORE_PHASE2_TEST_KEY';
const previous = process.env.CORE_PHASE2_TEST_KEY;
process.env.CORE_PHASE2_TEST_KEY = 'local-fixture';
let calls = 0;
class Provider extends LlmAdapter {
  async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, defaultMaxTokens: 256 };
  }
  async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    calls++;
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: 'CORE2_OK' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'CORE2_OK' } };
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
  view.input.setText('/核心');
  await test.flush();
  assert.equal(view.commands.selected?.command, '/core');
  test.mockInput.pressEnter();
  await test.flush();
  assert.ok(w.overlay.includes('观察模式'));
  assert.ok(test.captureCharFrame().includes('9 个治理角色'));
  assert.equal(calls, 0);
  frames.status = test.captureCharFrame();
  for (const [command, expected] of [
    ['roles', '质量裁决'],
    ['workflow', '十一阶段业务流程'],
    ['coverage', '持久计划执行与人工恢复：已接入'],
    ['instructions', '不能扩大运行时权限'],
  ]) {
    await w.send(first.id, '/core ' + command);
    assert.ok(w.overlay.includes(expected), `/core ${command}: expected ${expected}`);
  }
  checks.menuAndChineseCoreViewsAreLocal = true;
  const initialMode = first.controller!.permissionMode;
  await w.send(first.id, '/core off');
  assert.equal(first.controller!.core.mode, 'off');
  assert.equal(JSON.parse(await readFile(join(root, 'config.json'), 'utf8')).core.mode, 'off');
  const before = first.controller!.core.inspect().snapshot!.lastSequence;
  await w.send(first.id, 'hello');
  await first.controller!.agent.whenIdle();
  assert.equal(first.controller!.core.inspect().snapshot!.lastSequence, before);
  assert.equal(first.controller!.permissionMode, initialMode);
  checks.offPreservesNormalConversationAndPermissions = true;
  await w.send(first.id, '/core observe');
  const second = await w.split('row');
  assert.equal(second.controller!.core.mode, 'observe');
  const firstBefore = first.controller!.core.inspect().snapshot!.lastSequence;
  await w.send(second.id, 'second');
  await second.controller!.agent.whenIdle();
  await second.controller!.core.settle();
  assert.equal(first.controller!.core.inspect().snapshot!.lastSequence, firstBefore);
  assert.notEqual(
    first.controller!.core.inspect().snapshot!.scopeKey,
    second.controller!.core.inspect().snapshot!.scopeKey,
  );
  await w.send(second.id, '/core events');
  assert.ok(w.overlay.includes('model-step'));
  await test.flush();
  frames.events = test.captureCharFrame();
  test.resize(60, 24);
  await test.flush();
  assert.ok(test.captureCharFrame().includes('观察模式'));
  checks.newPaneInheritsModeAndEventsRemainIsolated = true;
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
  if (previous === undefined) delete process.env.CORE_PHASE2_TEST_KEY;
  else process.env.CORE_PHASE2_TEST_KEY = previous;
}
