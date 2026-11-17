import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { scopeTarget } from '@deepseek-ai/dsh-scope';
import UserApproval from '@deepseek-ai/dsh-user-approval';
import { createTestRenderer } from '@opentui/core/testing';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { historyEntries } from '../src/app/tui/navigation.ts';
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
const dir = resolve('../artifacts/experience-e5');
await mkdir(dir, { recursive: true });
const home = await mkdtemp(join(dir, 'native-'));
const ctx = await harness(home, ['deepseek', 'alternate'], new Provider());
await ctx.plugin(UserApproval);
const config = structuredClone(defaultConfig);
config.models[0].apiKeyEnv = 'E5_TEST_KEY';
process.env.E5_TEST_KEY = 'local-fixture';
config.models.push({ ...config.models[0], id: 'alternate', model: 'alternate' });
const w = new WorkspaceController(ctx, {
  home,
  cwd: home,
  modelId: 'deepseek',
  fresh: true,
  appConfig: config,
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
  w.focus(a.id);
  ui = mountWorkspaceUI(native.renderer, w, () => {});
  await flush();
  const view = ui.views.get(a.id)!;
  await w.send(a.id, '历史中文🙂\n第二行');
  await a.controller!.agent.whenIdle();
  view.input.setText('原草稿');
  native.mockInput.pressKey('r', { ctrl: true });
  await flush();
  assert.ok(native.captureCharFrame().includes('输入历史'));
  ui.commandInput.setText('中文');
  await flush();
  const before = a.controller!.agent.session.snapshotEvents().length;
  native.mockInput.pressEnter();
  native.mockInput.pressEnter();
  await flush();
  assert.equal(view.input.plainText, '历史中文🙂\n第二行');
  assert.equal(a.controller!.agent.session.snapshotEvents().length, before);
  checks.historyRestoresWithoutSending = true;
  await delay(400);
  native.mockInput.pressKey('r', { ctrl: true });
  await flush();
  ui.commandInput.setText('not present');
  await flush();
  native.mockInput.pressEnter();
  await flush();
  assert.equal(view.input.plainText, '历史中文🙂\n第二行');
  native.mockInput.pressEscape();
  await flush();
  checks.emptySearchAndEscapePreserveDraft = true;
  view.input.setText('/task a');
  await flush();
  assert.ok(view.commands.box.visible);
  native.mockInput.pressTab();
  await flush();
  assert.equal(w.focused, a.id);
  assert.equal(view.input.plainText, '/task accept ');
  checks.tabCompletesMultiwordWithoutDispatch = true;
  view.input.setText('模型切换草稿');
  await w.send(a.id, '/model');
  await flush();
  ui.commandInput.setText('alternate');
  await flush();
  native.mockInput.pressEnter();
  await delay(80);
  await flush();
  assert.equal(a.modelId, 'alternate');
  assert.equal(view.input.plainText, '模型切换草稿');
  checks.modelPickerIsPerPane = true;
  await delay(400);
  const roleDraft = view.input.plainText;
  await w.send(a.id, '/roles');
  await flush();
  assert.equal(ui.commandInput.visible, false);
  assert.equal(view.input.plainText, roleDraft);
  assert.equal(w.taskEngine.state.tasks.length, 0);
  checks.rolesAreInformationalWithoutDispatch = true;
  await delay(400);
  const task = await w.taskEngine.enqueue(
    a.id,
    a.id,
    'nav',
    'navigation fixture',
    [],
    undefined,
    undefined,
    {},
  );
  await w.send(a.id, '/tasks');
  await flush();
  assert.ok(native.captureCharFrame().includes(task.id));
  native.mockInput.pressArrow('right');
  await flush();
  assert.equal(w.focused, a.id);
  checks.taskNavigatesToItsOwnSession = true;
  w.focus(b.id);
  await w.send(b.id, '/history');
  await flush();
  assert.ok(!ui.commandList.selected);
  native.mockInput.pressEscape();
  checks.historyIsSessionScoped = true;
  w.focus(a.id);
  await w.send(a.id, '/history');
  await flush();
  w.focus(b.id);
  await flush();
  assert.equal(ui.commandInput.visible, false);
  checks.focusChangeInvalidatesSelection = true;
  w.focus(a.id);
  await w.send(a.id, '/history');
  await flush();
  const agent = a.controller!.agent;
  const approval = ctx.waterfall(
    scopeTarget(agent, agent),
    'approval/request',
    { agent, toolName: 'pwsh', reason: 'E5 inert approval' },
    async () => 'unavailable' as const,
  );
  await delay(40);
  await flush();
  assert.equal(ui.commandInput.visible, false);
  assert.ok(a.controller!.pending);
  const request = a.controller!.pending!;
  a.controller!.respondInteraction(request.id, request.version, { action: 'cancel' });
  assert.equal(await approval, 'cancelled');
  checks.approvalReclaimsFocusSafely = true;
  native.resize(62, 22);
  await w.send(a.id, '/model');
  await flush();
  ui.commandInput.setText('alternate');
  await flush();
  assert.ok(native.captureCharFrame().includes('alternate'));
  native.mockInput.pressEscape();
  checks.narrowPicker = true;
  const expectedHistory = historyEntries(w, a.id);
  const savedSession = a.controller!.id;
  ui.dispose();
  ui = undefined;
  await w.close();
  const restored = new WorkspaceController(ctx, { home, cwd: home, modelId: 'deepseek', appConfig: config });
  try {
    await restored.initialize();
    assert.equal(restored.panes.get(a.id)?.controller?.id, savedSession);
    assert.deepEqual(historyEntries(restored, a.id), expectedHistory);
    checks.historyRestoresFromExistingSessionLog = true;
  } finally {
    await restored.close();
  }
  await writeFile(
    join(dir, 'native.json'),
    JSON.stringify({ passed: true, checks, frame: native.captureCharFrame() }, null, 2),
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
  delete process.env.E5_TEST_KEY;
}
