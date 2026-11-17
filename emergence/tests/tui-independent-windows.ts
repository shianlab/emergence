import { LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { createTestRenderer } from '@opentui/core/testing';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkspaceController } from '../src/app/workspace.ts';
import { mountWorkspaceUI } from '../src/app/workspace-ui.ts';
import { defaultConfig } from '../src/core/domain/configuration.ts';
import { harness } from './fixtures/harness.ts';

const output = resolve('../artifacts/independent-windows-20261116');
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(output, 'native-'));
const config = structuredClone(defaultConfig);
config.models[0].apiKeyEnv = 'INDEPENDENT_TUI_FIXTURE';
const previous = process.env.INDEPENDENT_TUI_FIXTURE;
process.env.INDEPENDENT_TUI_FIXTURE = 'local-fixture';
class Provider extends LlmAdapter {
  async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, defaultMaxTokens: 512 };
  }
  async *stream(): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
const ctx = await harness(root, ['deepseek'], new Provider());
const w = new WorkspaceController(ctx, { home: root, cwd: root, modelId: 'deepseek', appConfig: config });
await w.initialize();
const t = await createTestRenderer({ width: 150, height: 44, kittyKeyboard: true });
const ui = mountWorkspaceUI(t.renderer, w, () => {});
const flush = async () => {
  await t.flush();
  await t.renderOnce();
  await t.flush();
};
const checks: string[] = [];
try {
  const first = w.current,
    second = await w.split('row');
  w.focus(first.id);
  await flush();
  const frame = t.captureCharFrame();
  assert.doesNotMatch(frame, /主控|协作模式|执行窗口/);
  assert.match(frame, /独立模式/);
  assert.equal('teamBar' in ui, false);
  checks.push('independent panes, no master marker or coordination bar');
  const view = ui.views.get(first.id)!;
  view.input.setText('保留独立草稿');
  await t.mockMouse.click(view.box.x + 2, view.box.y, 2);
  await flush();
  const menu = t.captureCharFrame();
  assert.match(menu, /窗口操作/);
  assert.match(menu, /向右分屏/);
  assert.doesNotMatch(menu, /设为主窗口|查看团队|接管此窗口|交回自动/);
  checks.push('right click exposes only independent window actions');
  t.mockInput.pressEnter();
  for (let i = 0; i < 50 && w.panes.size < 3; i++) await delay(30);
  await flush();
  assert.equal(w.panes.size, 3);
  assert.equal('master' in w.taskEngine.state, false);
  assert.equal('workers' in w.taskEngine.state, false);
  assert.equal(ui.views.get(first.id)!.input.plainText, '保留独立草稿');
  checks.push('menu split opens independent session and preserves existing draft');
  await w.closePane(second.id);
  await flush();
  assert.equal(w.panes.size, 2);
  t.resize(60, 24);
  await flush();
  assert.doesNotMatch(t.captureCharFrame(), /主控|协作模式/);
  checks.push('close and narrow layout still work');
  await writeFile(
    join(output, 'native-ui.json'),
    JSON.stringify({ passed: true, checks, frame, menu }, null, 2),
  );
  console.log(JSON.stringify({ passed: true, checks }));
} catch (error) {
  await writeFile(
    join(output, 'native-ui.json'),
    JSON.stringify({ passed: false, checks, error: String(error), frame: t.captureCharFrame() }, null, 2),
  );
  throw error;
} finally {
  ui.dispose();
  await w.close();
  await ctx.fiber.dispose();
  await t.dispose();
  if (previous === undefined) delete process.env.INDEPENDENT_TUI_FIXTURE;
  else process.env.INDEPENDENT_TUI_FIXTURE = previous;
}
