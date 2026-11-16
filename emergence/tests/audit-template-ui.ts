import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { createTestRenderer } from '@opentui/core/testing';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { saveConfig } from '../src/app/config.ts';
import { mountWorkspaceUI } from '../src/app/workspace-ui.ts';
import { WorkspaceController } from '../src/app/workspace.ts';
import { defaultConfig } from '../src/core/domain/configuration.ts';
import { harness } from './fixtures/harness.ts';

class Provider extends LlmAdapter {
  async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, defaultMaxTokens: 512 };
  }
  async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const text = Array.from({ length: 100 }, (_, i) => `original history ${i}`).join('\n');
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
const dir = resolve('../artifacts/audit-2026-10-29');
await mkdir(dir, { recursive: true });
const root = await mkdtemp(join(dir, 'template-ui-')),
  home = join(root, 'home'),
  cwd = join(root, '项目');
await mkdir(home);
await mkdir(cwd);
const config = structuredClone(defaultConfig);
config.models[0].apiKeyEnv = 'AUDIT_TEMPLATE_KEY';
await saveConfig(home, config);
process.env.AUDIT_TEMPLATE_KEY = 'fixture-only';
const ctx = await harness(home, ['deepseek'], new Provider()),
  w = new WorkspaceController(ctx, { home, cwd, modelId: 'deepseek', fresh: true, appConfig: config });
const renderer = await createTestRenderer({ width: 120, height: 38 });
let ui: ReturnType<typeof mountWorkspaceUI> | undefined;
const checks: Record<string, boolean> = {};
try {
  await w.initialize();
  const first = w.focused;
  await w.split('row');
  await w.send(first, 'original history');
  await w.panes.get(first)!.controller!.agent.whenIdle();
  ui = mountWorkspaceUI(renderer.renderer, w, () => {});
  await renderer.renderOnce();
  await renderer.renderOnce();
  const view = ui.views.get(first)!;
  view.input.setText('DRAFT_ONLY_IN_ARCHIVE');
  view.scroll.scrollTo(12);
  await renderer.renderOnce();
  assert.ok(w.panes.get(first)!.scrollTop > 0);
  assert.equal(w.panes.get(first)!.draft, 'DRAFT_ONLY_IN_ARCHIVE');
  const old = w.panes.get(first)!.controller!,
    close = old.close.bind(old),
    previousId = old.id;
  let oldCloseStarted = false;
  old.close = async () => {
    oldCloseStarted = true;
    await delay(100);
    return close();
  };
  const loading = w.applyTemplate({
    version: 1,
    name: 'ui',
    focused: first,
    layout: structuredClone(w.layout),
    panes: [...w.panes.values()].map((p) => ({ id: p.id, cwd: p.cwd, modelId: p.modelId })),
    roles: { master: first, workers: [...w.panes.keys()].filter((id) => id !== first) },
  });
  for (let i = 0; !oldCloseStarted && i < 200; i++) await delay(5);
  assert.ok(oldCloseStarted);
  assert.notEqual(w.panes.get(first)!.sessionId, previousId);
  // Exercise a real native frame while old handles are still releasing.
  await renderer.renderOnce();
  assert.equal(view.input.plainText, '');
  assert.equal(w.panes.get(first)!.draft, '');
  await loading;
  await renderer.renderOnce();
  assert.equal(w.panes.get(first)!.scrollTop, 0);
  const archive = (await readdir(join(home, 'workspaces'))).find((name) =>
    name.includes('.before-template-'),
  )!;
  assert.match(await readFile(join(home, 'workspaces', archive), 'utf8'), /DRAFT_ONLY_IN_ARCHIVE/);
  checks.newBindingClearsEditorAndScroll = true;
  checks.slowReleaseCannotRestoreOldDraft = true;
  checks.originalDraftArchived = true;
  await writeFile(
    join(dir, 'template-ui.json'),
    JSON.stringify(
      { passed: true, timestamp: new Date().toISOString(), checks, frame: renderer.captureCharFrame(), root },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(checks));
} catch (error) {
  await writeFile(
    join(dir, 'template-ui.json'),
    JSON.stringify({ passed: false, error: String(error), checks, root }, null, 2),
  );
  throw error;
} finally {
  ui?.dispose();
  await renderer.dispose();
  await w.close();
  assert.equal(ctx.agents.list().length, 0);
  await ctx.fiber.dispose();
}
