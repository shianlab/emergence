import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { scopeTarget } from '@deepseek-ai/dsh-scope';
import { TextAttributes } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fitCells, taskCounts, taskState } from '../src/app/tui/workspace-chrome.ts';
import { mountWorkspaceUI } from '../src/app/workspace-ui.ts';
import { WorkspaceController } from '../src/app/workspace.ts';
import { defaultConfig } from '../src/core/domain/configuration.ts';
import { contractSchema } from '../src/core/domain/orchestration.ts';
import { taskSchema } from '../src/core/domain/task.ts';
import { harness } from './fixtures/harness.ts';

const dir = resolve('../artifacts/tui-phase4');
await mkdir(dir, { recursive: true });
const root = await mkdtemp(join(dir, 'native-')),
  cwd = join(root, '中文 项目🙂');
await mkdir(cwd);
const config = structuredClone(defaultConfig);
config.models[0].apiKeyEnv = 'TUI_PHASE4_KEY';
const previous = process.env.TUI_PHASE4_KEY;
process.env.TUI_PHASE4_KEY = 'local-fixture';
class Provider extends LlmAdapter {
  calls = 0;
  async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, defaultMaxTokens: 256 };
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls++;
    const long = JSON.stringify(options.messages).includes('long-history');
    const text = long
      ? Array.from({ length: 80 }, (_, index) => `历史 ${index} **结构化** 内容`).join('\n\n')
      : '## 已读取\n\n**内容保持分层**。';
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
const provider = new Provider(),
  ctx = await harness(root, ['deepseek'], provider);
const workspace = new WorkspaceController(ctx, {
  home: root,
  cwd,
  modelId: 'deepseek',
  appConfig: config,
  fresh: true,
});
await workspace.initialize();
const test = await createTestRenderer({ width: 160, height: 46, kittyKeyboard: true });
const ui = mountWorkspaceUI(test.renderer, workspace, () => {});
const checks: Record<string, boolean> = {},
  frames: Record<string, string> = {};
const flush = async () => {
  await test.flush();
  await test.renderOnce();
  await test.flush();
};
const escape = async () => {
  test.mockInput.pressEscape();
  await delay(90);
  await flush();
};
const text = (node: { chunks: { text: string }[] }) => node.chunks.map((chunk) => chunk.text).join('');
let waiting: Promise<unknown> | undefined;
try {
  await flush();
  const main = workspace.current,
    mainView = ui.views.get(main.id)!;
  assert.equal(mainView.box.border, false);
  assert.ok(text(mainView.title).includes('1 会话'));
  checks.singleSessionUsesOpenReadingArea = true;
  await mkdir(join(root, 'other'));
  const worker = await workspace.split('row', cwd);
  await workspace.split('column', join(root, 'other'));
  workspace.focus(main.id);
  await flush();
  assert.ok(text(mainView.title).includes('1 会话'));
  assert.ok(text(ui.views.get(worker.id)!.title).includes('2 会话'));
  assert.doesNotMatch(test.captureCharFrame(), /主控|执行窗口|协作模式/);
  assert.ok(mainView.title.attributes & TextAttributes.BOLD);
  assert.equal(ui.views.get(worker.id)!.title.attributes, 0);
  frames.multi = test.captureCharFrame();
  checks.independentSessionsAndFocusHaveDistinctWeightAndBorders = true;
  assert.equal(mainView.sharedInfo.visible, true);
  assert.equal(mainView.sharedInfo.height, 1);
  assert.equal(mainView.status.visible, false, 'idle status merges with shared-project row');
  const focusBeforeDetails = workspace.focused;
  await test.mockMouse.click(mainView.sharedInfo.x + 2, mainView.sharedInfo.y);
  await flush();
  assert.match(text(mainView.sharedInfo), /同一目录/);
  assert.equal(workspace.focused, focusBeforeDetails);
  await test.mockMouse.click(mainView.sharedInfo.x + 2, mainView.sharedInfo.y);
  await flush();
  assert.equal(mainView.sharedInfo.height, 1);
  checks.sharedProjectDetailsExpandWithoutChangingSession = true;
  mainView.input.setText('会话草稿🙂');
  mainView.input.setSelection(0, 2);
  const selection = mainView.input.getSelection();
  const workerTab = ui.tabs.get(worker.id)!;
  await test.mockMouse.click(workerTab.x + 2, workerTab.y);
  await flush();
  assert.equal(workspace.focused, worker.id);
  workspace.focus(main.id);
  await flush();
  assert.deepEqual(mainView.input.getSelection(), selection);
  workspace.hide(worker.id);
  await flush();
  assert.ok(text(ui.tabs.get(worker.id)!).includes('后台'));
  const hiddenTab = ui.tabs.get(worker.id)!;
  await test.mockMouse.click(hiddenTab.x + 2, hiddenTab.y);
  await flush();
  assert.equal(workspace.focused, worker.id);
  assert.ok(workspace.visible().includes(worker.id));
  checks.sessionTabsFocusAndRevealWithoutLosingSelection = true;
  workspace.focus(main.id);
  await workspace.send(main.id, 'long-history');
  await main.controller!.agent.whenIdle();
  await flush();
  mainView.scroll.scrollTop = 5;
  mainView.input.setText('保留草稿🙂\n第二行');
  mainView.input.setSelection(0, 4);
  await flush();
  const scroll = mainView.scroll.scrollTop,
    draft = mainView.input.plainText,
    selected = mainView.input.getSelection(),
    beforeCalls = provider.calls;
  const at = new Date().toISOString(),
    record = taskSchema.parse({
      id: 'phase4-review',
      requestKey: 'fixture',
      objective: '核对界面与终端结果',
      issuer: worker.id,
      issuerSession: worker.controller!.id,
      target: worker.id,
      targetSession: worker.controller!.id,
      cwd: worker.cwd,
      modelId: worker.modelId,
      status: 'needs_review',
      progress: '执行完成，等待核对证据',
      createdAt: at,
      updatedAt: at,
      dependsOn: [],
      contract: contractSchema.parse({
        scope: [worker.cwd],
        acceptance: ['保留中文输入', '提供终端检查证据'],
        deliverables: ['src/ui.ts'],
      }),
      steps: 3,
      report: { outcome: 'success', summary: 'WORKER_CLAIM_ONLY', artifacts: [] },
      result: { summary: 'RECEIPT_READY', errors: [], artifacts: ['src/ui.ts'], fromSeq: 10, toSeq: 18 },
    });
  workspace.collaboration.state.tasks.push(record);
  workspace.changed();
  await workspace.send(main.id, '/task show ' + record.id);
  await flush();
  assert.ok(ui.inspector.opened && !ui.inspector.fullscreen);
  assert.equal(workspace.focused, main.id);
  assert.equal(provider.calls, beforeCalls);
  assert.equal(mainView.input.plainText, draft);
  assert.deepEqual(mainView.input.getSelection(), selected);
  assert.equal(mainView.scroll.scrollTop, scroll);
  assert.ok(text(ui.inspector.detail).includes('? 待检查'));
  assert.ok(text(ui.inspector.detail).includes('RECEIPT_READY'));
  assert.ok(text(ui.inspector.detail).includes('执行者自报'));
  assert.doesNotMatch(text(ui.inspector.detail), /主控/);
  assert.match(text(ui.inspector.detail), /发起会话/);
  assert.ok(
    test
      .captureSpans()
      .lines.some((line) =>
        line.spans.some(
          (span) => span.text.includes('目标') && Boolean(span.attributes & TextAttributes.BOLD),
        ),
      ),
  );
  frames.inspector = test.captureCharFrame();
  checks.taskDetailsUseReceiptsAndPreserveConversation = true;
  await test.mockInput.pasteBracketedText('不应进入隐藏的输入');
  test.mockInput.pressKey('y');
  await flush();
  assert.equal(mainView.input.plainText, draft);
  checks.taskInspectionNeverSubmitsOrAnswers = true;
  const cursor = mainView.input.cursorOffset;
  await test.mockMouse.click(mainView.input.x + 2, mainView.input.y);
  await flush();
  assert.ok(!ui.inspector.focused);
  assert.ok(mainView.input.focused);
  await test.mockInput.pasteBracketedText('继续编辑');
  await flush();
  assert.ok(mainView.input.plainText.includes('继续编辑'));
  assert.ok(ui.inspector.opened);
  mainView.input.setText(draft);
  mainView.input.cursorOffset = cursor;
  if (selected) mainView.input.setSelection(selected.start, selected.end);
  ui.inspector.open(record.id);
  await flush();
  checks.wideInspectorReturnsKeyboardToClickedEditor = true;
  test.resize(70, 26);
  await flush();
  assert.ok(ui.inspector.fullscreen);
  assert.ok([...ui.views.values()].every((view) => !view.box.visible));
  assert.ok(test.captureCharFrame().split('\n')[0].includes('[任务 1]'));
  assert.ok(test.captureCharFrame().includes('phase4-review'));
  frames.narrowTask = test.captureCharFrame();
  await escape();
  assert.equal(mainView.input.plainText, draft);
  assert.deepEqual(mainView.input.getSelection(), selected);
  assert.ok(mainView.box.visible);
  test.resize(160, 46);
  await flush();
  assert.equal(mainView.scroll.scrollTop, scroll);
  checks.narrowTaskPageReturnsToSameDraftSelectionAndScroll = true;
  await workspace.send(main.id, '/task show ' + record.id);
  await flush();
  ui.inspector.scroll.scrollTop = 3;
  await flush();
  record.status = 'succeeded';
  record.review = { accepted: true, evidence: '已核对实际终端检查', at };
  workspace.changed();
  await flush();
  assert.equal(ui.inspector.selected, record.id);
  assert.ok(text(ui.inspector.detail).includes('✓ 已完成'));
  assert.ok(text(ui.inspector.detail).includes('验收通过'));
  assert.equal(ui.inspector.scroll.scrollTop, 3);
  config.ui.keys.pageDown = 'F10';
  workspace.changed();
  await flush();
  test.mockInput.pressKey('F10');
  await flush();
  assert.ok(ui.inspector.scroll.scrollTop > 3);
  assert.ok(test.captureCharFrame().includes('PgUp/F10'));
  config.ui.keys.pageDown = 'PageDown';
  workspace.changed();
  await flush();
  checks.liveTaskUpdatesKeepSelectionAndDetailPosition = true;
  await escape();
  workspace.focus(worker.id);
  await worker.controller!.open();
  workspace.changed();
  workspace.focus(main.id);
  await workspace.send(main.id, '/task show ' + record.id);
  await flush();
  test.mockInput.pressEnter();
  await flush();
  assert.equal(workspace.focused, main.id);
  assert.ok(ui.inspector.opened);
  assert.match(workspace.notice, /替换|更换/);
  await escape();
  checks.staleTaskCannotJumpIntoReplacementSession = true;
  const agent = worker.controller!.agent;
  waiting = ctx.waterfall(
    scopeTarget(agent, agent),
    'approval/request',
    { agent, toolName: 'pwsh', reason: 'PHASE4_BACKGROUND_PENDING' },
    async () => 'unavailable' as const,
  );
  for (let i = 0; i < 100 && !worker.controller!.pending; i++) await delay(5);
  await flush();
  assert.equal(workspace.focused, main.id);
  assert.ok(text(ui.tabs.get(worker.id)!).includes('◇'));
  assert.equal(mainView.input.plainText, draft);
  checks.backgroundApprovalIsVisibleWithoutStealingFocus = true;
  const pending = worker.controller!.pending!;
  worker.controller!.respondInteraction(pending.id, pending.version, { action: 'cancel' });
  await waiting;
  waiting = undefined;
  for (let i = 0; i < 3; i++) {
    test.resize(48, 22);
    await flush();
    test.resize(160, 46);
    await flush();
  }
  assert.equal(mainView.input.plainText, draft);
  assert.deepEqual(mainView.input.getSelection(), selected);
  assert.equal(mainView.scroll.scrollTop, scroll);
  checks.repeatedFoldingRestoresPaneState = true;
  for (const status of [
    'queued',
    'dispatching',
    'running',
    'waiting_user',
    'needs_review',
    'failed',
    'blocked',
    'interrupted',
    'cancelled',
    'succeeded',
  ] as const) {
    const value = taskState({ ...record, status }, false);
    assert.ok(!value.includes('已完成') || status === 'succeeded');
  }
  assert.ok(taskCounts([record, { ...record, status: 'needs_review' }], false).includes('待检查 1'));
  checks.nonSuccessStatesNeverMasqueradeAsCompletion = true;
  config.ui.theme = 'light';
  config.ui.language = 'en';
  workspace.changed();
  await workspace.send(main.id, '/task show ' + record.id);
  await flush();
  assert.ok(text(ui.inspector.detail).includes('Succeeded'));
  assert.ok(text(ui.inspector.detail).includes('Ownership'));
  await escape();
  checks.lightThemeAndEnglishInspector = true;
  assert.ok(!/[\uD800-\uDBFF]$/.test(fitCells('中文🙂路径', 5)));
  assert.equal(fitCells('abcdef', 4, true), '…def');
  checks.widthFittingPreservesGraphemes = true;
  ui.inspector.open();
  await flush();
  ui.dispose();
  assert.equal(workspace.listenerCount('task-inspect'), 0);
  checks.inspectorLifecycleReleasesListeners = true;
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
  if (waiting) workerCleanup();
  await workspace.close();
  await ctx.fiber.dispose();
  await test.dispose();
  if (previous === undefined) delete process.env.TUI_PHASE4_KEY;
  else process.env.TUI_PHASE4_KEY = previous;
}
function workerCleanup() {
  for (const pane of workspace.panes.values()) {
    const pending = pane.controller?.pending;
    if (pending) pane.controller!.respondInteraction(pending.id, pending.version, { action: 'cancel' });
  }
}
