import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { scopeTarget } from '@deepseek-ai/dsh-scope';
import UserApproval from '@deepseek-ai/dsh-user-approval';
import { createTestRenderer } from '@opentui/core/testing';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { mountWorkspaceUI } from '../src/app/workspace-ui.ts';
import { WorkspaceController } from '../src/app/workspace.ts';
import { defaultConfig } from '../src/core/domain/configuration.ts';
import { harness } from './fixtures/harness.ts';
class Provider extends LlmAdapter {
  async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, defaultMaxTokens: 256 };
  }
  async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
const dir = resolve('../artifacts/experience-e2');
await mkdir(dir, { recursive: true });
const home = await mkdtemp(join(dir, 'native-'));
const ctx = await harness(home, ['deepseek'], new Provider());
await ctx.plugin(UserApproval);
const w = new WorkspaceController(ctx, {
  home,
  cwd: home,
  modelId: 'deepseek',
  fresh: true,
  appConfig: structuredClone(defaultConfig),
});
const native = await createTestRenderer({ width: 120, height: 38, kittyKeyboard: true, exitOnCtrlC: false });
let ui: ReturnType<typeof mountWorkspaceUI> | undefined;
const checks: Record<string, boolean> = {};
const flush = async () => {
  await native.flush();
  await native.renderOnce();
};
try {
  await w.initialize();
  const a = w.current,
    b = await w.split('row');
  ui = mountWorkspaceUI(native.renderer, w, () => {});
  await flush();
  const view = ui.views.get(b.id)!;
  view.input.setText('保留草稿🙂');
  view.input.cursorOffset = 3;
  view.input.setSelection(1, 3);
  const selection = view.input.getSelection();
  const history = b.controller!.agent.session.snapshotEvents().length;
  native.mockInput.pressTab({ shift: true });
  await flush();
  assert.equal(b.controller!.permissionMode, 'auto');
  assert.equal(a.controller!.permissionMode, 'edit');
  assert.equal(w.focused, b.id);
  assert.equal(view.input.plainText, '保留草稿🙂');
  assert.deepEqual(view.input.getSelection(), selection);
  assert.equal(b.controller!.agent.session.snapshotEvents().length, history);
  checks.shortcutIsPerPaneAndPreservesDraftHistory = true;
  native.mockInput.pressTab({ shift: true });
  await flush();
  assert.equal(b.controller!.permissionMode, 'plan');
  checks.fourModeCycle = true;
  native.mockInput.pressTab({ ctrl: true, shift: true });
  await flush();
  assert.equal(w.focused, a.id);
  checks.previousPaneShortcut = true;
  await w.send(a.id, '/permission');
  await flush();
  assert.ok(native.captureCharFrame().includes('执行权限'));
  native.mockInput.pressArrow('up');
  native.mockInput.pressEnter();
  await flush();
  assert.equal(a.controller!.permissionMode, 'ask');
  checks.arrowEnterModeMenu = true;
  await w.send(a.id, '/permission');
  await flush();
  native.mockInput.pressArrow('down');
  native.mockInput.pressEscape();
  await flush();
  assert.equal(a.controller!.permissionMode, 'ask');
  checks.escapeLeavesMode = true;
  const agent = a.controller!.agent;
  const approval = ctx.waterfall(
    scopeTarget(agent, agent),
    'approval/request',
    { agent, toolName: 'pwsh', reason: 'inert UI fixture' },
    async () => 'unavailable' as const,
  );
  await delay(400);
  await flush();
  native.mockInput.pressTab({ shift: true });
  await flush();
  assert.equal(await approval, 'cancelled');
  assert.equal(a.controller!.permissionMode, 'edit');
  checks.modeSwitchCancelsOldApproval = true;
  native.mockInput.pressKey('p', { ctrl: true });
  await flush();
  await native.mockInput.pasteBracketedText('/permission');
  native.mockInput.pressEnter();
  await flush();
  assert.ok(native.captureCharFrame().includes('执行权限'));
  native.mockInput.pressEscape();
  await flush();
  checks.commandPaletteOpensPicker = true;
  native.resize(64, 24);
  await flush();
  assert.ok(native.captureCharFrame().includes('自动编辑'));
  checks.narrowModeVisible = true;
  await writeFile(
    join(dir, 'native.json'),
    JSON.stringify(
      { passed: true, timestamp: new Date().toISOString(), checks, frame: native.captureCharFrame() },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(checks));
} catch (error) {
  await writeFile(
    join(dir, 'native.json'),
    JSON.stringify(
      { passed: false, checks, error: String(error), frame: native.captureCharFrame() },
      null,
      2,
    ),
  );
  throw error;
} finally {
  ui?.dispose();
  native.renderer.destroy();
  await w.close();
  await ctx.fiber.dispose();
}
