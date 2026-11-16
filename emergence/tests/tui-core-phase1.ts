import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { createTestRenderer } from '@opentui/core/testing';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  commandHelp,
  homeCommands,
  normalizeHelp,
  slashSuggestions,
  workspaceCommands,
} from '../src/app/commands.ts';
import { activityColor } from '../src/app/tui/composer.ts';
import { mountHome, type HomeRequest } from '../src/app/tui/home.ts';
import { mountWorkspaceUI } from '../src/app/workspace-ui.ts';
import { WorkspaceController } from '../src/app/workspace.ts';
import { defaultConfig } from '../src/core/domain/configuration.ts';
import { harness } from './fixtures/harness.ts';

const dir = resolve('../artifacts/core-phase1');
await mkdir(dir, { recursive: true });
const root = await mkdtemp(join(dir, 'native-')),
  config = structuredClone(defaultConfig);
config.models[0].apiKeyEnv = 'CORE_PHASE1_TEST_KEY';
const previous = process.env.CORE_PHASE1_TEST_KEY;
process.env.CORE_PHASE1_TEST_KEY = 'local-fixture';
const launch = { home: root, cwd: root, modelId: config.defaultModel, appConfig: config };
const opened: HomeRequest[] = [],
  checks: Record<string, boolean> = {},
  frames: Record<string, string> = {};
const test = await createTestRenderer({ width: 120, height: 40, kittyKeyboard: true });
let home: ReturnType<typeof mountHome> | undefined;
let workspace: WorkspaceController | undefined, ui: ReturnType<typeof mountWorkspaceUI> | undefined;
let release: (() => void) | undefined,
  called = 0;
const pause = (signal?: AbortSignal) =>
  new Promise<void>((done) => {
    const finish = () => {
      signal?.removeEventListener('abort', finish);
      release = undefined;
      done();
    };
    release = finish;
    if (signal?.aborted) finish();
    else signal?.addEventListener('abort', finish, { once: true });
  });
class Provider extends LlmAdapter {
  async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, defaultMaxTokens: 256 };
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    called++;
    await pause(options.signal);
    if (options.signal?.aborted) return;
    yield { type: 'block-start', index: 0, blockType: 'reasoning' };
    yield { type: 'reasoning-delta', index: 0, text: 'fixture reasoning' };
    await pause(options.signal);
    if (options.signal?.aborted) return;
    yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'fixture reasoning' } };
    yield { type: 'block-start', index: 1, blockType: 'text' };
    yield { type: 'text-delta', index: 1, text: '回复正文' };
    await pause(options.signal);
    if (options.signal?.aborted) return;
    yield { type: 'block-end', index: 1, block: { type: 'text', text: '回复正文' } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
const ctx = await harness(root, ['deepseek'], new Provider());
const esc = async () => {
  test.mockInput.pressEscape();
  await delay(100);
  await test.flush();
};
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error('state timeout');
}
const content = (node: { chunks: { text: string }[] }) => node.chunks.map((chunk) => chunk.text).join('');
try {
  home = mountHome(test.renderer, launch, false, {
    async open(request) {
      opened.push(request);
    },
    async sessions() {
      return [];
    },
    exit() {},
  });
  await test.flush();
  home.input.setText('/');
  await test.flush();
  assert.ok(home.commands.box.visible);
  assert.ok(test.captureCharFrame().includes('/model'));
  frames.home = test.captureCharFrame();
  home.input.setText('/模型');
  await test.flush();
  assert.equal(home.commands.selected?.command, '/model');
  test.mockInput.pressTab();
  await test.flush();
  assert.equal(home.input.plainText, '/model ');
  assert.equal(opened.length, 0);
  home.input.setText('/does-not-exist');
  await test.flush();
  assert.ok(test.captureCharFrame().includes('没有匹配项'));
  test.mockInput.pressEnter();
  await test.flush();
  assert.equal(opened.length, 0);
  await assert.rejects(home.submit('/does-not-exist'), /首页暂不支持/);
  checks.homeDiscoveryChineseSearchTabAndUnknownCommand = true;
  for (const [width, height] of [
    [40, 15],
    [80, 24],
    [120, 40],
  ]) {
    home.input.setText('/');
    test.resize(width, height);
    await test.flush();
    assert.ok(test.captureCharFrame().includes('/help'));
    assert.ok(home.input.y >= 0 && home.input.y + home.input.height <= height);
    assert.ok(test.captureCharFrame().includes('Enter'));
    frames[`commands-${width}`] = test.captureCharFrame();
  }
  await esc();
  assert.equal(home.input.plainText, '/');
  assert.ok(!home.commands.box.visible);
  home.input.setText('帮助');
  await home.submit('帮助');
  await test.flush();
  assert.ok(test.captureCharFrame().includes('涌现使用帮助'));
  await esc();
  assert.equal(home.input.plainText, '帮助');
  for (const text of ['/tmp/file', '/foo\nbar', '解释 /help'])
    assert.equal(slashSuggestions(text, homeCommands(false, false)), false);
  // Exercise real command lists for path and argument exclusions.
  const homeItems = homeCommands(false, false);
  assert.equal(slashSuggestions('/model deepseek', homeItems), false);
  assert.equal(normalizeHelp('请帮助我检查代码'), '请帮助我检查代码');
  await home.submit('请帮助我检查代码');
  assert.equal(opened.at(-1)?.prompt, '请帮助我检查代码');
  checks.homeHelpPreservesDraftAndNaturalLanguage = true;
  home.dispose();
  home = undefined;
  workspace = new WorkspaceController(ctx, launch);
  await workspace.initialize();
  ui = mountWorkspaceUI(test.renderer, workspace, () => {});
  await test.flush();
  const pane = workspace.current,
    view = ui.views.get(pane.id)!,
    controller = pane.controller!;
  view.input.setText('/模型');
  await test.flush();
  assert.equal(view.commands.selected?.command, '/model');
  test.mockInput.pressEnter();
  await test.flush();
  assert.ok(ui.commandList.box.visible);
  assert.equal(called, 0);
  await esc();
  view.input.setText('/foc');
  await test.flush();
  test.mockInput.pressEnter();
  await test.flush();
  assert.equal(view.input.plainText, '/focus ');
  assert.ok(!view.commands.box.visible);
  assert.equal(called, 0);
  await workspace.send(pane.id, '/帮助');
  assert.ok(workspace.overlay.includes('窗口与任务'));
  assert.ok(workspace.overlay.includes('首次使用'));
  await esc();
  config.ui.keys.close = 'F10';
  assert.ok(commandHelp(workspaceCommands(workspace, pane.id), config.ui).includes('F10'));
  checks.workspaceChinesePickerArgumentsAndHelp = true;
  await workspace.send(pane.id, '/activity motion reduced');
  assert.equal(config.ui.reducedMotion, true);
  await workspace.send(pane.id, '/activity color gray');
  assert.equal(config.ui.activityColor, 'gray');
  assert.equal(activityColor(config.ui, true), activityColor(config.ui, false));
  await workspace.send(pane.id, '/activity color amber');
  assert.ok(activityColor(config.ui, true).startsWith('#'));
  view.input.setText('');
  workspace.changed();
  await workspace.send(pane.id, 'status fixture');
  await until(() => Boolean(release));
  await test.flush();
  assert.ok(content(view.status).includes('等待模型响应'));
  assert.ok(!content(view.status).includes('正在思考'));
  await delay(1100);
  await until(() => !content(view.status).includes('已运行 0 秒'));
  await test.flush();
  assert.ok(content(view.status).startsWith('●'));
  frames.waiting = test.captureCharFrame();
  release!();
  await until(() => controller.activity.phase === 'reasoning');
  await test.flush();
  assert.ok(content(view.status).includes('正在思考'));
  release!();
  await until(() => controller.activity.phase === 'writing');
  await test.flush();
  assert.ok(content(view.status).includes('正在输出'));
  release!();
  await controller.agent.whenIdle();
  await test.flush();
  assert.equal(controller.busy, false);
  assert.ok(content(view.status).includes('本轮已完成'));
  assert.equal(controller.activity.startedAt, undefined);
  checks.realHarnessWaitingReasoningWritingIdleAndTimer = true;
  checks.liveActivityPreferences = true;
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
  home?.dispose();
  ui?.dispose();
  await workspace?.close();
  await test.dispose();
  await ctx.fiber.dispose();
  if (previous === undefined) delete process.env.CORE_PHASE1_TEST_KEY;
  else process.env.CORE_PHASE1_TEST_KEY = previous;
}
