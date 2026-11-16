import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createTestRenderer } from '@opentui/core/testing';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { harness } from './fixtures/harness.ts';
import { defaultConfig } from '../src/core/domain/configuration.ts';
import { WorkspaceController } from '../src/app/workspace.ts';
import { mountWorkspaceUI } from '../src/app/workspace-ui.ts';
const directory = resolve('../artifacts/tui-typography-phase4');
await mkdir(directory, { recursive: true });
const root = await mkdtemp(join(directory, 'audit-'));
const config = structuredClone(defaultConfig);
config.models[0].apiKeyEnv = 'TUI_TYPE_AUDIT_KEY';
const beforeKey = process.env.TUI_TYPE_AUDIT_KEY,
  beforeColor = process.env.NO_COLOR;
process.env.TUI_TYPE_AUDIT_KEY = 'local-fixture';
class Provider extends LlmAdapter {
  async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, defaultMaxTokens: 256 };
  }
  async *stream(): AsyncIterable<never> {
    throw new Error('Layout audit must not call models');
  }
}
const ctx = await harness(root, ['deepseek'], new Provider());
const workspace = new WorkspaceController(ctx, {
  home: root,
  cwd: root,
  modelId: 'deepseek',
  appConfig: config,
  fresh: true,
});
await workspace.initialize();
const test = await createTestRenderer({ width: 160, height: 40 });
const ui = mountWorkspaceUI(test.renderer, workspace, () => {});
const cases: Record<string, unknown>[] = [],
  failures: string[] = [];
try {
  const main = workspace.current;
  await workspace.split('row', root);
  workspace.focus(main.id);
  for (const pane of workspace.panes.values()) pane.controller!.notice = '';
  workspace.notice = '';
  const view = ui.views.get(main.id)!;
  view.input.setText('中文草稿🙂');
  for (const theme of ['dark', 'light'] as const)
    for (const en of [false, true]) {
      config.ui.theme = theme;
      config.ui.language = en ? 'en' : 'zh-CN';
      if (en) process.env.NO_COLOR = '1';
      else delete process.env.NO_COLOR;
      for (const [width, height] of [
        [32, 20],
        [48, 22],
        [80, 24],
        [160, 40],
      ])
        for (const expanded of [false, true]) {
          test.resize(width, height);
          view.sharedExpanded = expanded;
          ui.refresh();
          await test.flush();
          await test.renderOnce();
          await test.flush();
          const name = `${theme}-${en ? 'en-no-color' : 'zh'}-${width}x${height}-${expanded ? 'expanded' : 'compact'}`;
          const clipped =
            view.sharedInfo.visible && view.sharedInfo.virtualLineCount > view.sharedInfo.height;
          const outside =
            view.input.y + view.input.height > Math.min(rendererBottom(), view.box.y + view.box.height);
          const lostDraft = view.input.plainText !== '中文草稿🙂';
          cases.push({
            name,
            clipped,
            outside,
            lostDraft,
            sharedRows: view.sharedInfo.virtualLineCount,
            height: view.sharedInfo.height,
            inputY: view.input.y,
          });
          if (clipped || outside || lostDraft) failures.push(name);
          await writeFile(join(directory, `${name}.txt`), test.captureCharFrame());
        }
    }
  await writeFile(join(directory, 'matrix.json'), JSON.stringify({ cases, failures }, null, 2));
  assert.deepEqual(failures, [], 'shared details, input area and drafts must survive the layout matrix');
  console.log(`Typography layout matrix: ${cases.length} cases passed.`);
} finally {
  ui.dispose();
  await workspace.close();
  await ctx.fiber.dispose();
  await test.dispose();
  if (beforeKey === undefined) delete process.env.TUI_TYPE_AUDIT_KEY;
  else process.env.TUI_TYPE_AUDIT_KEY = beforeKey;
  if (beforeColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = beforeColor;
}
function rendererBottom() {
  return test.renderer.height;
}
