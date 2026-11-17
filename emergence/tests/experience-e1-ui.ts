import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { scopeTarget } from '@deepseek-ai/dsh-scope';
import UserApproval from '@deepseek-ai/dsh-user-approval';
import UserQuestions from '@deepseek-ai/dsh-user-questions';
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
    return { provider, id: model, name: model, defaultMaxTokens: 512 };
  }
  async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
const dir = resolve('../artifacts/experience-e1');
await mkdir(dir, { recursive: true });
const root = await mkdtemp(join(dir, 'native-')),
  home = join(root, 'home');
await mkdir(home);
const ctx = await harness(home, ['deepseek'], new Provider());
await ctx.plugin(UserApproval);
await ctx.plugin(UserQuestions);
const w = new WorkspaceController(ctx, {
  home,
  cwd: root,
  modelId: 'deepseek',
  fresh: true,
  appConfig: structuredClone(defaultConfig),
});
const native = await createTestRenderer({ width: 120, height: 38, exitOnCtrlC: false });
let ui: ReturnType<typeof mountWorkspaceUI> | undefined,
  exits = 0;
const checks: Record<string, boolean> = {};
const flush = async () => {
  await native.flush();
  await native.renderOnce();
};
const ready = async () => {
  await delay(370);
  await flush();
};
try {
  await w.initialize();
  const a = w.current,
    b = await w.split('row');
  ui = mountWorkspaceUI(native.renderer, w, () => {
    exits++;
  });
  await flush();
  const av = ui.views.get(a.id)!,
    bv = ui.views.get(b.id)!;
  av.input.setText('窗口 A 的草稿🙂');
  bv.input.setText('窗口 B 的草稿');
  await flush();
  av.input.cursorOffset = 5;
  av.input.setSelection(1, 5);
  const initialSelection = av.input.getSelection();
  const ask = (pane = a, signal?: AbortSignal) => {
    const agent = pane.controller!.agent;
    return ctx.waterfall(
      scopeTarget(agent, agent),
      'approval/request',
      { agent, toolName: 'pwsh', reason: 'E1 审批测试，无真实命令执行', signal },
      async () => 'unavailable' as const,
    );
  };
  const approval = ask();
  await ready();
  assert.equal(w.focused, b.id);
  assert.ok(bv.input.focused);
  assert.equal(bv.input.plainText, '窗口 B 的草稿');
  checks.backgroundDoesNotStealFocus = true;
  w.focus(a.id);
  await ready();
  await native.waitForFrame((frame) => frame.includes('允许本次'));
  await native.mockInput.pasteBracketedText('y\n/exit');
  await flush();
  assert.ok(a.controller!.pending);
  assert.equal(av.input.plainText, '窗口 A 的草稿🙂');
  checks.pasteCannotApproveOrOverwriteDraft = true;
  assert.equal(av.input.visible, false);
  native.mockInput.pressEnter();
  native.mockInput.pressEnter();
  await flush();
  assert.equal(await approval, 'allowed-once');
  assert.equal(av.input.plainText, '窗口 A 的草稿🙂');
  assert.equal(w.panes.get(a.id)!.draft, '窗口 A 的草稿🙂');
  assert.ok(av.input.focused);
  assert.deepEqual(av.input.getSelection(), initialSelection);
  av.input.clearSelection();
  checks.draftSelectionRestored = true;
  assert.equal(a.controller!.lastError, undefined);
  checks.enterApprovesAndRestoresDraft = true;
  const reject = ask();
  await ready();
  native.mockInput.pressArrow('down');
  native.mockInput.pressEnter();
  await flush();
  assert.equal(await reject, 'rejected');
  checks.arrowsReject = true;
  const first = ask(),
    second = ask();
  await ready();
  const old = a.controller!.pending!;
  native.mockInput.pressEnter();
  native.mockInput.pressEnter();
  await flush();
  assert.equal(await first, 'allowed-once');
  assert.ok(a.controller!.pending);
  assert.notEqual(a.controller!.pending!.id, old.id);
  assert.throws(
    () => a.controller!.respondInteraction(old.id, old.version, { action: 'submit', selected: ['allow'] }),
    /过期/,
  );
  await ready();
  native.mockInput.pressEscape();
  await flush();
  assert.equal(await second, 'cancelled');
  assert.equal(exits, 0);
  checks.doubleEnterDoesNotApproveNext = true;
  checks.escapeCancelsOnlyRequest = true;
  const multi = ctx.userQuestions.ask({
    agent: a.controller!.agent,
    questions: [
      {
        id: 'multi',
        question: '选择检查项',
        multiSelect: true,
        options: [{ label: '代码' }, { label: '测试' }, { label: '文档' }],
      },
    ],
  });
  await ready();
  native.mockInput.pressKey(' ');
  native.mockInput.pressArrow('down');
  native.mockInput.pressKey(' ');
  native.mockInput.pressEnter();
  await flush();
  assert.deepEqual((await multi).answers[0].selected, ['代码', '测试']);
  checks.multiChoice = true;
  const custom = ctx.userQuestions.ask({
    agent: a.controller!.agent,
    questions: [{ id: 'custom', question: '填写补充说明', options: [{ label: '默认' }] }],
  });
  await ready();
  native.mockInput.pressArrow('down');
  native.mockInput.pressEnter();
  await flush();
  await native.mockInput.pasteBracketedText('自己的回答🙂\n第二行');
  await flush();
  native.mockInput.pressEnter();
  await flush();
  assert.equal((await custom).answers[0].custom, '自己的回答🙂\n第二行');
  assert.equal(av.input.plainText, '窗口 A 的草稿🙂');
  checks.customAnswerSeparateFromDraft = true;
  const numeric = ctx.userQuestions.ask({
    agent: a.controller!.agent,
    questions: [{ id: 'number', question: '文字数字不能误选选项', options: [{ label: '默认' }] }],
  });
  await ready();
  native.mockInput.pressArrow('down');
  native.mockInput.pressEnter();
  await flush();
  await native.mockInput.typeText('1');
  native.mockInput.pressEnter();
  await flush();
  assert.deepEqual((await numeric).answers[0], { id: 'number', selected: [], custom: '1' });
  checks.customNumberRemainsText = true;
  const free = ctx.userQuestions.ask({
    agent: a.controller!.agent,
    questions: [{ id: 'text', question: '直接输入回答' }],
  });
  await ready();
  await native.mockInput.pasteBracketedText('纯文本');
  native.mockInput.pressEnter();
  await flush();
  assert.equal((await free).answers[0].custom, '纯文本');
  checks.freeText = true;
  const abort = new AbortController();
  const cancelled = ask(a, abort.signal);
  await ready();
  const cancelledRequest = a.controller!.pending!;
  abort.abort();
  await flush();
  assert.equal(await cancelled, 'cancelled');
  assert.throws(() => cancelledRequest.respond('y'), /过期/);
  assert.equal(av.input.plainText, '窗口 A 的草稿🙂');
  checks.abortRemovesRequest = true;
  const commandPending = ask();
  await ready();
  native.mockInput.pressKey('p', { ctrl: true });
  await flush();
  await native.mockInput.pasteBracketedText('/focus 2');
  native.mockInput.pressEnter();
  await flush();
  assert.equal(w.focused, b.id);
  assert.ok(a.controller!.pending);
  assert.equal(av.input.plainText, '窗口 A 的草稿🙂');
  w.focus(a.id);
  await ready();
  native.mockInput.pressEscape();
  await flush();
  assert.equal(await commandPending, 'cancelled');
  checks.commandEntryDuringApprovalPreservesDraft = true;
  native.mockInput.pressCtrlC();
  await flush();
  assert.equal(av.input.plainText, '');
  assert.equal(exits, 0);
  checks.ctrlCClearsDraft = true;
  let cancellations = 0;
  const originalCancel = w.cancelFocused.bind(w);
  const busy = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(a.controller!), 'busy')!;
  Object.defineProperty(a.controller!, 'busy', { configurable: true, get: () => true });
  w.cancelFocused = async () => {
    cancellations++;
  };
  native.mockInput.pressCtrlC();
  await flush();
  assert.equal(cancellations, 1);
  assert.equal(exits, 0);
  Object.defineProperty(a.controller!, 'busy', busy);
  w.cancelFocused = originalCancel;
  checks.ctrlCStopsFocusedTask = true;
  native.mockInput.pressCtrlC();
  await flush();
  assert.equal(exits, 0);
  assert.match(w.notice, /再次按/);
  native.mockInput.pressCtrlC();
  await flush();
  assert.equal(exits, 1);
  checks.idleDoubleCtrlCExits = true;
  const closing = ask(b);
  await ready();
  await w.closePane(b.id);
  assert.equal(await closing, 'cancelled');
  checks.closingPaneSettlesApproval = true;
  await flush();
  // Read the final native buffer only after rendering and output have settled.
  native.renderer.pause();
  await native.renderer.idle();
  await writeFile(
    join(dir, 'native.json'),
    JSON.stringify(
      { passed: true, timestamp: new Date().toISOString(), checks, root, frame: native.captureCharFrame() },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(checks));
} catch (error) {
  await writeFile(
    join(dir, 'native.json'),
    JSON.stringify(
      { passed: false, error: error instanceof Error ? error.stack : String(error), checks, root },
      null,
      2,
    ),
  );
  throw error;
} finally {
  ui?.dispose();
  await native.dispose();
  await w.close();
  assert.equal(ctx.agents.list().length, 0);
  await ctx.fiber.dispose();
}
