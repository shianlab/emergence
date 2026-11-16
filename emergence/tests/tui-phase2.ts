import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { scopeTarget } from '@deepseek-ai/dsh-scope';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { ScrollBoxRenderable, TextAttributes } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MessageProjection } from '../src/app/tui/message-model.ts';
import { mountMessages } from '../src/app/tui/message-view.ts';
import { mountWorkspaceUI } from '../src/app/workspace-ui.ts';
import { WorkspaceController } from '../src/app/workspace.ts';
import { defaultConfig } from '../src/core/domain/configuration.ts';
import { palettes } from '../src/core/domain/ui-preferences.ts';
import { harness } from './fixtures/harness.ts';
import { richReply } from './fixtures/tui-rich-content.ts';

const dir = resolve('../artifacts/tui-phase2');
await mkdir(dir, { recursive: true });
const frames: Record<string, string> = {},
  checks: Record<string, boolean> = {};
const event = (type: string, seq: number, data: unknown) => ({ type, seq, time: 1, data }) as SessionEvent;
const assistant = (seq: number, text: string) =>
  event('assistant/message', seq, { message: { content: [{ type: 'text', text }] } });
const test = await createTestRenderer({ width: 120, height: 72 });
const scroll = new ScrollBoxRenderable(test.renderer, { width: '100%', height: '100%', scrollY: true });
const feed = mountMessages(test.renderer, scroll, () => {});
scroll.add(feed.box);
test.renderer.root.add(scroll);
const projection = new MessageProjection('render-fixture').load([
  event('user/message', 0, {
    source: { kind: 'user' },
    content: [{ type: 'text', text: '# USER_RAW **verbatim**' }],
  }),
  assistant(1, richReply),
]);
let workspace: WorkspaceController | undefined, workspaceUI: ReturnType<typeof mountWorkspaceUI> | undefined;
let context: Awaited<ReturnType<typeof harness>> | undefined;
const previousKey = process.env.TUI_PHASE2_KEY;
process.env.TUI_PHASE2_KEY = 'local-model-fixture';
try {
  feed.update(projection, '', palettes.dark, 116, false);
  await test.flush();
  let frame = test.captureCharFrame();
  frames.rich = frame;
  assert.ok(frame.includes('已完成首轮检查'));
  assert.ok(!frame.includes('# 已完成首轮检查'));
  assert.ok(frame.includes('加粗重点'));
  assert.ok(!frame.includes('**加粗重点**'));
  assert.ok(frame.includes('**literal_code**'));
  assert.ok(frame.includes('# not a heading'));
  assert.ok(frame.includes('提醒：待确认操作'));
  assert.ok(frame.includes('# USER_RAW **verbatim**'));
  assert.ok(frame.includes('PHASE2_RICH_COMPLETE'));
  assert.ok(
    test
      .captureSpans()
      .lines.some((line) =>
        line.spans.some(
          (span) => span.text.includes('加粗重点') && Boolean(span.attributes & TextAttributes.BOLD),
        ),
      ),
  );
  checks.structuredMarkdownAndLiteralUserCode = true;
  const userHeading = feed.rows.get('render-fixture:0')!.heading;
  assert.ok(
    userHeading.chunks.some(
      (chunk) => chunk.text.includes('你') && Boolean((chunk.attributes ?? 0) & TextAttributes.BOLD),
    ),
  );
  assert.ok(
    userHeading.chunks.some(
      (chunk) => chunk.text.includes('#0') && !((chunk.attributes ?? 0) & TextAttributes.BOLD),
    ),
  );
  checks.speakerHasWeightWithoutEmphasizingSequence = true;
  const raw = projection.items[1];
  assert.ok(raw.kind === 'assistant');
  const source = raw.text;
  feed.command('raw', 1);
  await test.flush();
  assert.ok(test.captureCharFrame().includes('# 已完成首轮检查'));
  assert.ok(test.captureCharFrame().includes('**加粗重点**'));
  feed.command('render', 1);
  await test.flush();
  assert.equal(raw.text, source);
  checks.sourceToggleIsLossless = true;
  const assistantRow = feed.rows.get(raw.id)!;
  await test.mockMouse.click(assistantRow.action.x + 1, assistantRow.action.y);
  await test.flush();
  assert.equal(assistantRow.raw, true);
  feed.command('render', 1);
  await test.flush();
  checks.sourceMouseAction = true;

  test.resize(42, 90);
  feed.update(projection, '', palettes.dark, 38, false);
  await test.flush();
  frame = test.captureCharFrame();
  frames.narrow = frame;
  assert.ok(frame.includes('名称  首页'));
  assert.ok(frame.includes('状态  已完成'));
  assert.ok(frame.includes('消息排版'));
  assert.ok(frame.includes('**literal_code**'));
  checks.narrowTableAndUnicode = true;
  test.resize(120, 72);
  feed.update(projection, '', palettes.light, 116, true);
  await test.flush();
  assert.ok(test.captureCharFrame().includes('Emergence'));
  checks.lightThemeAndEnglishLabels = true;
  feed.update(projection, '# 流式标题\n\n首段 **稳定**。\n\n```ts\nconst value =', palettes.dark, 116, false);
  await test.flush();
  const liveRow = feed.rows.get('render-fixture:live')!,
    stableBlock = liveRow.rich!.markdown.getChildren()[0];
  assert.ok(test.captureCharFrame().includes('const value ='));
  feed.update(
    projection,
    '# 流式标题\n\n首段 **稳定**。\n\n```ts\nconst value = 42;\n```\n\n下一段',
    palettes.dark,
    116,
    false,
  );
  await test.flush();
  assert.equal(liveRow.rich!.markdown.getChildren()[0], stableBlock);
  assert.ok(test.captureCharFrame().includes('const value = 42;'));
  checks.streamingKeepsStableBlocksAndShowsUnfinishedCode = true;

  projection.append(
    event('tool/call', 2, {
      callId: 'fixture-call',
      name: 'read',
      arguments: '{"path":"C:\\\\项目\\\\file.md"}',
    }),
  );
  projection.append(
    event('tool/result', 3, {
      message: {
        source: { callId: 'fixture-call' },
        content: [{ type: 'text', text: '# TOOL_RAW **verbatim**\nSECOND_TOOL_LINE' }],
      },
    }),
  );
  projection.append(
    event('tool/call', 4, { callId: 'failed-call', name: 'write', arguments: '{"path":"blocked.txt"}' }),
  );
  projection.append(
    event('tool/result', 5, {
      message: {
        source: { callId: 'failed-call' },
        isError: true,
        content: [{ type: 'text', text: 'ERROR_DETAIL_VISIBLE' }],
      },
    }),
  );
  feed.update(projection, '', palettes.dark, 116, false);
  await test.flush();
  assert.ok(test.captureCharFrame().includes('ERROR_DETAIL_VISIBLE'));
  assert.ok(test.captureCharFrame().includes('# TOOL_RAW **verbatim**'));
  feed.command('tools', 2);
  await test.flush();
  assert.ok(test.captureCharFrame().includes('SECOND_TOOL_LINE'));
  assert.ok(test.captureCharFrame().includes('参数'));
  checks.toolDetailsAreLiteralAndErrorsOpen = true;
  projection.append(assistant(6, 'long '.repeat(4000) + 'TAIL_NOT_LOST'));
  feed.update(projection, '', palettes.dark, 116, false);
  await test.flush();
  assert.ok(feed.rows.get('render-fixture:6')!.more.visible);
  feed.command('more', 6);
  await test.flush();
  scroll.scrollTo(scroll.scrollHeight);
  await test.flush();
  assert.ok(test.captureCharFrame().includes('TAIL_NOT_LOST'));
  checks.longContentCanBeExpanded = true;
  feed.dispose();
  scroll.destroyRecursively();

  const root = await mkdtemp(join(dir, 'native-')),
    config = structuredClone(defaultConfig);
  config.models[0].apiKeyEnv = 'TUI_PHASE2_KEY';
  let release: (() => void) | undefined;
  class Provider extends LlmAdapter {
    async resolveModel(provider: string, model: string) {
      return { provider, id: model, name: model, defaultMaxTokens: 512 };
    }
    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      const input = JSON.stringify(options.messages.at(-1));
      const wait = input.includes('controlled-stream');
      const prefix = wait ? '# 实时标题\n\n首段 **稳定**。\n\n' : richReply;
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: prefix };
      if (wait) {
        await new Promise<void>((done) => {
          release = done;
        });
        yield { type: 'text-delta', index: 0, text: 'LIVE_FINAL' };
      }
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'text', text: prefix + (wait ? 'LIVE_FINAL' : '') },
      };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  context = await harness(root, ['deepseek'], new Provider());
  workspace = new WorkspaceController(context, {
    home: root,
    cwd: root,
    modelId: 'deepseek',
    appConfig: config,
  });
  await workspace.initialize();
  workspaceUI = mountWorkspaceUI(test.renderer, workspace, () => {});
  test.resize(120, 40);
  await test.flush();
  const pane = workspace.current,
    view = workspaceUI.views.get(pane.id)!;
  await workspace.send(pane.id, 'native-rich');
  await pane.controller!.agent.whenIdle();
  await test.flush();
  assert.ok(test.captureCharFrame().includes('PHASE2_RICH_COMPLETE'));
  checks.actualHarnessMessagesUseRichView = true;
  await workspace.send(pane.id, '/view raw');
  await test.flush();
  assert.equal([...view.messages.rows.values()].findLast((row) => row.item.kind === 'assistant')?.raw, true);
  await workspace.send(pane.id, '/view render');
  await test.flush();
  view.input.setText('中文草稿🙂');
  view.scroll.scrollTop = 0;
  await test.flush();
  const offset = view.scroll.scrollTop;
  await workspace.send(pane.id, 'controlled-stream');
  for (let i = 0; i < 100 && !release; i++) await delay(5);
  assert.ok(release);
  await test.flush();
  assert.equal(view.scroll.scrollTop, offset);
  assert.equal(view.input.plainText, '中文草稿🙂');
  assert.ok(view.jump.visible);
  assert.ok(
    view.jump.chunks
      .map((chunk) => chunk.text)
      .join('')
      .includes('有新内容'),
  );
  release!();
  await pane.controller!.agent.whenIdle();
  await test.flush();
  assert.equal(view.scroll.scrollTop, offset);
  await workspace.send(pane.id, '/view latest');
  await test.flush();
  await test.renderOnce();
  await test.flush();
  assert.ok(test.captureCharFrame().includes('LIVE_FINAL'));
  assert.equal(view.input.plainText, '中文草稿🙂');
  checks.historyReadingIsNotHijackedAndLatestKeepsDraft = true;
  const finalProjection = pane.controller!.displayMessages()!;
  assert.ok(
    finalProjection.items.some((item) => item.kind === 'assistant' && item.text.includes('LIVE_FINAL')),
  );
  assert.ok(pane.controller!.transcript().some((line) => line.includes('**稳定**')));
  checks.persistedTranscriptRemainsRaw = true;
  frames.workspace = test.captureCharFrame();
  view.scroll.scrollTop = 0;
  await test.flush();
  const beforeApproval = view.scroll.scrollTop;
  const agent = pane.controller!.agent;
  const approval = context.waterfall(
    scopeTarget(agent, agent),
    'approval/request',
    { agent, toolName: 'pwsh', reason: 'PHASE2_PENDING_COMMAND **literal** · 完整命令与当前会话' },
    async () => 'unavailable' as const,
  );
  for (let i = 0; i < 100 && !pane.controller!.pending; i++) await delay(5);
  await test.flush();
  await test.renderOnce();
  await test.flush();
  assert.ok(test.captureCharFrame().includes('PHASE2_PENDING_COMMAND **literal**'));
  assert.ok(view.messages.box.visible);
  assert.equal(view.input.plainText, '中文草稿🙂');
  assert.equal(workspace.focused, pane.id);
  frames.approval = test.captureCharFrame();
  const request = pane.controller!.pending!;
  pane.controller!.respondInteraction(request.id, request.version, { action: 'cancel' });
  assert.equal(await approval, 'cancelled');
  await test.flush();
  await test.renderOnce();
  assert.equal(view.scroll.scrollTop, beforeApproval);
  assert.equal(view.input.plainText, '中文草稿🙂');
  checks.approvalShowsFullLiteralDetailsAndRestoresReading = true;
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
  workspaceUI?.dispose();
  feed.dispose();
  await workspace?.close();
  await context?.fiber.dispose();
  await test.dispose();
  if (previousKey === undefined) delete process.env.TUI_PHASE2_KEY;
  else process.env.TUI_PHASE2_KEY = previousKey;
}
