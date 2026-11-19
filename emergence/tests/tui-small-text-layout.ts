import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createTestRenderer } from '@opentui/core/testing';
import type { Renderable } from '@opentui/core';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { harness } from './fixtures/harness.ts';
import { defaultConfig } from '../src/core/domain/configuration.ts';
import { WorkspaceController } from '../src/app/workspace.ts';
import { mountWorkspaceUI } from '../src/app/workspace-ui.ts';
import { SmallText, smallTextFitsSixel } from '../src/app/tui/small-text.ts';

const directory = resolve('../artifacts/tui-small-text-2026-11-19');
await mkdir(directory, { recursive: true });
const root = await mkdtemp(join(directory, 'layout-'));
const previous = [process.env.NO_COLOR, process.env.TERM, process.env.EMERGENCE_NATIVE_TEXT];
delete process.env.NO_COLOR;
delete process.env.EMERGENCE_NATIVE_TEXT;
process.env.TERM = 'xterm-256color';
class Provider extends LlmAdapter {
  async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, defaultMaxTokens: 256 };
  }
  async *stream(): AsyncIterable<never> {
    throw new Error('Layout check must not call a model');
  }
}
const ctx = await harness(root, ['deepseek'], new Provider());
const workspace = new WorkspaceController(ctx, {
  home: root,
  cwd: root,
  modelId: 'deepseek',
  appConfig: structuredClone(defaultConfig),
  fresh: true,
});
await workspace.initialize();
const test = await createTestRenderer({ width: 120, height: 30 });
let cellHeight = 20;
Object.defineProperty(test.renderer, 'resolution', {
  configurable: true,
  get: () => ({
    width: test.renderer.terminalWidth * 10,
    height: test.renderer.terminalHeight * cellHeight,
  }),
});
const ui = mountWorkspaceUI(test.renderer, workspace, () => {});
function labels(node: Renderable): SmallText[] {
  return [...(node instanceof SmallText ? [node] : []), ...node.getChildren().flatMap(labels)];
}
let presented = 0;
test.renderer.addPostProcessFn(() => {
  // Inspect the composed layout BEFORE presentation; checking only after a frame
  // would miss the very first stale image during a resize.
  for (const label of labels(test.renderer.root)) {
    if (!label.image.visible) continue;
    let visible = label.visible;
    for (let parent = label.parent; parent && visible; parent = parent.parent) visible = parent.visible;
    if (!visible) continue;
    assert.ok(
      smallTextFitsSixel(label.y, cellHeight, cellHeight, test.renderer.terminalHeight),
      `Unsafe Sixel image at ${label.y} in ${test.renderer.terminalHeight} rows`,
    );
    presented++;
  }
});
try {
  for (const split of [false, true]) {
    if (split) await workspace.split('column', root);
    for (const [width, height, pixels] of [
      [120, 30, 20],
      [80, 24, 28],
      [48, 20, 24],
      [160, 46, 30],
    ]) {
      cellHeight = pixels;
      test.resize(width, height);
      ui.refresh();
      await test.flush();
      const all = labels(test.renderer.root);
      for (const label of all) label.image.protocol = 'sixel';
      const paneLabels = new Set(
        [...ui.views.values()].flatMap((v) => [v.modelLabel, v.meta, v.status, v.sharedInfo]),
      );
      const footer = all.find((label) => !paneLabels.has(label))!;
      assert.ok(footer, 'workspace has a global footer');
      const activeFooters = footer.visible
        ? [footer]
        : [...ui.views.values()].filter((v) => v.box.visible && v.meta.visible).map((v) => v.meta);
      assert.ok(activeFooters.length > 0);
      for (let i = 0; i < 150; i++) {
        await test.renderOnce();
        if (activeFooters.every((label) => label.image.visible)) break;
        await delay(20);
      }
      if (footer.visible) assert.equal(footer.y, height - 2, 'footer reserves a blank row beneath Sixel');
      for (const label of activeFooters)
        assert.equal(label.image.visible, true, 'small footer still renders with guard row');
      for (const view of ui.views.values()) {
        assert.ok(
          !view.modelLabel.chunks
            .map((c) => c.text)
            .join('')
            .includes(root),
        );
        if (view.box.visible)
          assert.ok(
            view.composer.y + view.composer.height <= (footer.visible ? footer.y : view.meta.y),
            'editor never overlaps footer',
          );
      }
    }
  }
  assert.ok(presented > 0);
  console.log(
    `Sixel composed workspace: 8 single/split layouts, resize and pre-presentation bounds passed (${presented} images).`,
  );
} finally {
  ui.dispose();
  await workspace.close();
  await ctx.fiber.dispose();
  await test.dispose();
  for (const [i, name] of ['NO_COLOR', 'TERM', 'EMERGENCE_NATIVE_TEXT'].entries()) {
    if (previous[i] === undefined) delete process.env[name];
    else process.env[name] = previous[i];
  }
}
