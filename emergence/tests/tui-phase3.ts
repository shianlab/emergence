import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { scopeTarget } from '@deepseek-ai/dsh-scope';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createTestRenderer } from '@opentui/core/testing';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { workspaceCommands } from '../src/app/commands.ts';
import { composerHint } from '../src/app/tui/composer.ts';
import { mountWorkspaceUI } from '../src/app/workspace-ui.ts';
import { WorkspaceController } from '../src/app/workspace.ts';
import { defaultConfig } from '../src/core/domain/configuration.ts';
import { harness } from './fixtures/harness.ts';

const dir = resolve('../artifacts/tui-phase3');
await mkdir(dir, { recursive: true });
const root = await mkdtemp(join(dir, 'native-')),
  config = structuredClone(defaultConfig);
config.models[0].apiKeyEnv = 'TUI_PHASE3_KEY';
const previous = process.env.TUI_PHASE3_KEY;
process.env.TUI_PHASE3_KEY = 'local-fixture';
const checks: Record<string, boolean> = {},
  frames: Record<string, string> = {};
async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error('Native state timeout');
}
let release: (() => void) | undefined, releaseTool: (() => void) | undefined;
class Provider extends LlmAdapter {
  calls: string[] = [];
  async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, defaultMaxTokens: 256 };
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const index = options.messages.findLastIndex(
      (message) =>
        message.role === 'user' &&
        /hold-stream|tool-wait|queued-one|queued-two|must-discard/.test(JSON.stringify(message)),
    );
    const text = JSON.stringify(options.messages[index]);
    this.calls.push(text);
    if (
      text.includes('tool-wait') &&
      !options.messages.slice(index + 1).some((message) => message.role === 'tool')
    ) {
      const id = ToolCallId('phase3-read'),
        args = '{"file_path":"src/中文文件.ts"}';
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id, name: 'read', argumentsDelta: args };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'read', arguments: args } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: '**正在输出** PHASE3_LIVE' };
    if (text.includes('hold-stream'))
      await new Promise<void>((done) => {
        const finish = () => {
          options.signal?.removeEventListener('abort', finish);
          release = undefined;
          done();
        };
        release = finish;
        if (options.signal?.aborted) finish();
        else options.signal?.addEventListener('abort', finish, { once: true });
      });
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '**已完成** PHASE3_DONE' } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
const provider = new Provider(),
  ctx = await harness(root, ['deepseek'], provider);
ctx.effect(() =>
  ctx.tools.register(
    defineTool({
      name: 'read',
      description: 'Controlled read fixture',
      parameters: { file_path: { type: 'string' } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() {
        await new Promise<void>((done) => {
          releaseTool = done;
        });
        return 'literal tool result';
      },
    }),
  ),
);
const workspace = new WorkspaceController(ctx, {
  home: root,
  cwd: root,
  modelId: 'deepseek',
  appConfig: config,
});
await workspace.initialize();
const test = await createTestRenderer({ width: 120, height: 40, kittyKeyboard: true });
const ui = mountWorkspaceUI(test.renderer, workspace, () => {});
const pane = workspace.current,
  controller = pane.controller!,
  view = ui.views.get(pane.id)!;
const esc = async () => {
  test.mockInput.pressEscape();
  await delay(90);
  await test.flush();
};
const ctrlP = async () => {
  test.mockInput.pressKey('p', { ctrl: true });
  await test.flush();
};
const text = (node: { chunks: { text: string }[] }) => node.chunks.map((chunk) => chunk.text).join('');
try {
  await test.flush();
  assert.equal(view.input.height, 3);
  const draft = '中文草稿🙂\n第二行\n第三行\n第四行\n第五行\n第六行\n第七行\n第八行';
  await test.mockInput.pasteBracketedText(draft);
  await test.flush();
  assert.equal(view.input.plainText, draft);
  assert.ok(view.input.height > 3 && view.input.height <= 7);
  assert.equal(provider.calls.length, 0);
  view.input.gotoBufferEnd();
  await test.flush();
  assert.ok(test.captureCharFrame().includes('第八行'));
  checks.multilinePasteGrowsAndScrollsWithoutSubmission = true;
  const beforeResize = view.input.plainText;
  test.resize(48, 22);
  await test.flush();
  assert.equal(view.input.plainText, beforeResize);
  assert.ok(view.input.height <= 6);
  assert.ok(test.captureCharFrame().includes('Tokens'));
  assert.ok(!test.captureCharFrame().includes('Enter 发送'));
  test.resize(120, 40);
  view.input.setText('中文'.repeat(100));
  await test.flush();
  assert.ok(view.input.height > 3);
  checks.nativeWrappingAndResizeKeepDraft = true;
  view.input.setText('待发送草稿🙂');
  view.input.setSelection(0, 3);
  const selection = view.input.getSelection();
  await ctrlP();
  assert.ok(ui.commandList.box.visible);
  ui.commandInput.setText('模型');
  await test.flush();
  assert.equal(ui.commandList.selected?.command, '/model');
  assert.ok(test.captureCharFrame().includes('/models'));
  frames.palette = test.captureCharFrame();
  await esc();
  assert.equal(view.input.plainText, '待发送草稿🙂');
  assert.deepEqual(view.input.getSelection(), selection);
  checks.paletteSearchAndCancelKeepDraftSelection = true;
  await ctrlP();
  ui.commandInput.setText('/model');
  test.mockInput.pressEnter();
  await test.flush();
  assert.ok(test.captureCharFrame().includes('deepseek-flash'));
  assert.ok(ui.commandList.box.visible || workspace.overlay.includes('deepseek-flash'));
  assert.equal(provider.calls.length, 0);
  assert.equal(view.input.plainText, '待发送草稿🙂');
  await esc();
  checks.commandRunsWithoutSendingDraftOrCallingModel = true;
  await ctrlP();
  ui.commandInput.setText('/code');
  await test.flush();
  assert.equal(ui.commandList.selected?.command, '/code');
  test.mockInput.pressEnter();
  for (let attempt = 0; attempt < 100 && !workspace.overlay.includes('编程检查'); attempt++) {
    await delay(20);
    await test.flush();
  }
  await test.flush();
  assert.match(test.captureCharFrame(), /尚未完成验证/);
  assert.equal(provider.calls.length, 0);
  await esc();
  assert.equal(view.input.plainText, '待发送草稿🙂');
  assert.deepEqual(view.input.getSelection(), selection);
  checks.codeInspectionFromPalettePreservesDraftWithoutModelTurn = true;
  view.input.setText('/foc');
  await test.flush();
  assert.ok(view.commands.box.visible);
  test.mockInput.pressEnter();
  await test.flush();
  assert.equal(view.input.plainText, '/focus ');
  assert.ok(!view.commands.box.visible);
  assert.equal(provider.calls.length, 0);
  view.input.setText('/view');
  await test.flush();
  assert.ok(view.commands.box.visible);
  await esc();
  assert.ok(!view.commands.box.visible);
  view.input.setText('');
  await test.flush();
  view.input.setText('/view');
  await test.flush();
  assert.ok(view.commands.box.visible);
  await esc();
  view.input.setText('');
  checks.slashCompletionAndEscapeAreLocal = true;
  await workspace.extensions.enable(
    { id: 'phase3', module: 'fixture', enabled: true },
    {
      activate(api) {
        api.command('check', () => 'fixture');
      },
    },
  );
  assert.ok(workspaceCommands(workspace, pane.id).some((item) => item.command === '/x_phase3_check'));
  await workspace.extensions.disable('phase3');
  assert.ok(!workspaceCommands(workspace, pane.id).some((item) => item.command === '/x_phase3_check'));
  checks.extensionCommandsFollowLiveRegistration = true;
  delete process.env.TUI_PHASE3_KEY;
  const failed = '  失败后保留🙂\n  缩进和空白  ';
  view.input.setText(failed);
  view.input.cursorOffset = 4;
  view.input.setSelection(0, 3);
  const failedSelection = view.input.getSelection(),
    failedCursor = view.input.cursorOffset;
  view.submit();
  await delay(40);
  await test.flush();
  assert.equal(view.input.plainText, failed);
  assert.equal(view.input.cursorOffset, failedCursor);
  assert.deepEqual(view.input.getSelection(), failedSelection);
  process.env.TUI_PHASE3_KEY = 'local-fixture';
  checks.failedSendRestoresExactDraftCursorAndSelection = true;
  view.input.setText('hold-stream');
  view.submit();
  await until(() => Boolean(release));
  await test.flush();
  assert.ok(text(view.status).includes('正在输出'));
  assert.ok(!test.captureCharFrame().includes('Enter 排队'));
  assert.ok(test.captureCharFrame().includes('Tokens'));
  assert.ok(!workspaceCommands(workspace, pane.id).some((item) => item.command === '/new'));
  await workspace.send(pane.id, 'queued-one');
  await workspace.send(pane.id, 'queued-two');
  await test.flush();
  assert.equal(controller.activity.queued, 2);
  assert.ok(text(view.status).includes('排队 2'));
  frames.queued = test.captureCharFrame();
  release!();
  await controller.agent.whenIdle();
  await test.flush();
  assert.equal(controller.activity.queued, 0);
  assert.ok(text(view.status).includes('本轮已完成'));
  assert.equal(view.notice.visible, false, 'completion receipt must not duplicate the status');
  assert.ok(view.receiptClock);
  view.receiptClock!.since -= 5000;
  ui.refresh();
  await test.flush();
  assert.ok(text(view.status).includes('就绪'));
  checks.receiptExpiresWithoutDuplicatingStatus = true;
  checks.queueCountUsesLiveInboxAndClearsWhenClaimed = true;
  await workspace.send(pane.id, 'tool-wait');
  await until(() => Boolean(releaseTool));
  await test.flush();
  assert.ok(text(view.status).includes('工具 read'));
  assert.ok(text(view.status).includes('中文文件.ts'));
  assert.equal(controller.activity.tools.length, 1);
  frames.tool = test.captureCharFrame();
  releaseTool!();
  releaseTool = undefined;
  await controller.agent.whenIdle();
  await test.flush();
  assert.equal(controller.activity.tools.length, 0);
  checks.toolStatusTracksExecutionAndSettles = true;
  view.input.setText('确认期间的草稿');
  const agent = controller.agent;
  const approval = ctx.waterfall(
    scopeTarget(agent, agent),
    'approval/request',
    { agent, toolName: 'pwsh', reason: 'PHASE3_LITERAL_APPROVAL **command**' },
    async () => 'unavailable' as const,
  );
  await until(() => Boolean(controller.pending));
  await test.flush();
  assert.ok(text(view.status).includes('等待你的回答'));
  assert.ok(test.captureCharFrame().includes('Enter 确认'));
  assert.ok(!test.captureCharFrame().includes('Enter 排队'));
  assert.ok(
    workspaceCommands(workspace, pane.id).every(
      (item) => !['/new', '/resume', '/split right'].includes(item.command),
    ),
  );
  const pendingId = controller.pending!.id;
  await ctrlP();
  ui.commandInput.setText('/new');
  test.mockInput.pressEnter();
  await test.flush();
  assert.equal(controller.pending!.id, pendingId);
  assert.ok(controller.notice.includes('先完成或取消'));
  await esc();
  assert.equal(await approval, 'cancelled');
  assert.equal(view.input.plainText, '确认期间的草稿');
  checks.approvalOwnsHintsAndKeepsDraft = true;
  view.input.setText('');
  await workspace.send(pane.id, 'hold-stream');
  await until(() => Boolean(release));
  await workspace.send(pane.id, 'must-discard');
  let sawStopping = false;
  const changed = () => {
    if (controller.activity.stopping) sawStopping = true;
  };
  controller.on('change', changed);
  await esc();
  await controller.agent.whenIdle();
  await test.flush();
  controller.off('change', changed);
  assert.ok(sawStopping);
  assert.equal(controller.activity.queued, 0);
  assert.ok(!controller.busy);
  assert.ok(controller.notice.includes('已停止'));
  checks.stopDiscardsQueuedInputAndShowsTransition = true;
  config.ui.keys.escape = 'F9';
  workspace.changed();
  await test.flush();
  const custom = composerHint(config.ui, { busy: true }, true);
  assert.ok(custom.includes('F9 停止'));
  assert.ok(!custom.includes('Esc 停止'));
  config.ui.language = 'en';
  workspace.changed();
  await test.flush();
  assert.ok(text(view.status).includes('Ready'));
  assert.ok(test.captureCharFrame().includes('Tokens'));
  assert.ok(!test.captureCharFrame().includes('Enter send'));
  assert.ok(!test.captureCharFrame().includes('内置核心'));
  config.ui.statusBar.visible = false;
  workspace.changed();
  await test.flush();
  assert.ok(!test.captureCharFrame().includes('Tokens'));
  checks.customBindingsLanguageAndCleanStatusbar = true;
  frames.final = test.captureCharFrame();
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
  release?.();
  releaseTool?.();
  ui.dispose();
  await workspace.close();
  await ctx.fiber.dispose();
  await test.dispose();
  if (previous === undefined) delete process.env.TUI_PHASE3_KEY;
  else process.env.TUI_PHASE3_KEY = previous;
}
