import { LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { createTestRenderer } from '@opentui/core/testing';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { defaultConfig } from '../src/core/domain/configuration.ts';
import { mountEntryUI } from '../src/app/tui/entry.ts';
import { UpdateService } from '../src/app/updates/service.ts';
import { WorkspaceController } from '../src/app/workspace.ts';
import { harness } from './fixtures/harness.ts';

const output = resolve('../artifacts/install-phase3-20261117');
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(output, 'ui-'));
await writeFile(join(root, 'installation.json'), JSON.stringify({ product: 'emergence', schema: 2 }));
const config = structuredClone(defaultConfig);
config.models[0].apiKeyEnv = 'UPDATE_UI_FIXTURE';
const previous = process.env.UPDATE_UI_FIXTURE;
process.env.UPDATE_UI_FIXTURE = 'local-fixture';
class Provider extends LlmAdapter {
  calls = 0;
  async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, defaultMaxTokens: 512 };
  }
  async *stream(): AsyncIterable<StreamChunk> {
    this.calls++;
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
const provider = new Provider(),
  ctx = await harness(root, ['deepseek'], provider);
const release = {
  schema: 1 as const,
  product: 'emergence' as const,
  platform: 'win32-x64' as const,
  version: '1.0.2',
  sequence: 1,
  minimumInstaller: 2 as const,
  publishedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 86400000).toISOString(),
  asset: { url: 'fixture', bytes: 1, sha256: 'a'.repeat(64) },
  notes: '更新说明：新增中文版本提醒',
  notesURL: 'fixture',
};
let installs = 0;
const updates = new UpdateService({ kind: 'managed', root }, '1.0.1', {
  request: async () => ({ payload: 'fixture' }),
  verify: () => release,
  install: async (_, progress) => {
    installs++;
    progress('正在校验更新');
    await writeFile(join(root, 'current.json'), JSON.stringify({ product: 'emergence', version: '1.0.2' }));
  },
});
await updates.check();
const t = await createTestRenderer({ width: 120, height: 38, kittyKeyboard: true });
let workspace: WorkspaceController | undefined;
const ui = await mountEntryUI(
  t.renderer,
  { home: root, cwd: root, modelId: 'deepseek', appConfig: config },
  {
    updates,
    async sessions() {
      return [];
    },
    exit() {},
    async open(launch) {
      workspace = new WorkspaceController(ctx, launch);
      await workspace.initialize();
      return workspace;
    },
  },
);
const flush = async () => {
  await delay(80);
  await t.flush();
  await t.renderOnce();
  await t.flush();
};
const checks: string[] = [];
try {
  await flush();
  assert.match(t.captureCharFrame(), /发现新版本 1.0.2/);
  assert.equal(provider.calls, 0);
  await ui.home!.submit('/update');
  await flush();
  assert.match(t.captureCharFrame(), /检查更新/);
  t.mockInput.pressArrow('down');
  t.mockInput.pressEnter();
  await flush();
  assert.match(t.captureCharFrame(), /更新说明：新增中文版本提醒/);
  t.mockInput.pressEscape();
  await delay(400);
  await ui.home!.submit('/update');
  await flush();
  assert.match(t.captureCharFrame(), /检查更新/);
  const dismissal = once(updates, 'change', { signal: AbortSignal.timeout(7000) });
  t.mockInput.pressEscape();
  await dismissal;
  await flush();
  assert.equal(updates.snapshot.dismissed, '1.0.2');
  checks.push('home menu, notes and Esc defer without model requests');
  await ui.home!.submit('/new');
  await ui.opening;
  await flush();
  const w = workspace!,
    view = ui.workspaceView!.views.get(w.focused)!;
  view.input.setText('必须保留的任务草稿');
  await w.send(w.focused, '/update');
  await flush();
  assert.match(t.captureCharFrame(), /立即更新/);
  t.mockInput.pressArrow('down');
  t.mockInput.pressArrow('down');
  t.mockInput.pressEnter();
  await flush();
  assert.equal(installs, 1);
  assert.equal(updates.snapshot.status, 'ready');
  assert.equal(view.input.plainText, '必须保留的任务草稿');
  assert.equal(provider.calls, 0);
  checks.push('workspace Enter installs once, preserves draft and keeps Agent idle');
  await delay(400);
  await w.split('row');
  await w.send(w.focused, '/update');
  await flush();
  assert.match(t.captureCharFrame(), /检查更新/);
  assert.equal(w.updates, updates);
  t.resize(55, 22);
  await flush();
  assert.match(t.captureCharFrame(), /检查更新/);
  t.mockInput.pressEscape();
  await flush();
  checks.push('independent panes share one service and narrow menu remains usable');
  ui.dispose();
  assert.equal(updates.listenerCount('change'), 0);
  checks.push('view disposal removes update observers');
  await writeFile(join(output, 'tui-validation.json'), JSON.stringify({ passed: true, checks }, null, 2));
  console.log(JSON.stringify({ passed: true, checks }));
} catch (error) {
  await writeFile(
    join(output, 'tui-validation.json'),
    JSON.stringify({ passed: false, checks, error: String(error), frame: t.captureCharFrame() }, null, 2),
  );
  throw error;
} finally {
  ui.dispose();
  await workspace?.close();
  await ctx.fiber.dispose();
  await t.dispose();
  if (previous === undefined) delete process.env.UPDATE_UI_FIXTURE;
  else process.env.UPDATE_UI_FIXTURE = previous;
}
