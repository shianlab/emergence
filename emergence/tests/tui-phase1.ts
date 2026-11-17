import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { createTestRenderer } from '@opentui/core/testing';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { LaunchConfig } from '../src/app/session-config.ts';
import { mountEntryUI } from '../src/app/tui/entry.ts';
import { englishWordmark, homeLogo, smallHomeLogo, tinyHomeLogo } from '../src/app/tui/home-logo-data.ts';
import { homeLayout, snapshotPath } from '../src/app/tui/home-state.ts';
import { WorkspaceController } from '../src/app/workspace.ts';
import { defaultConfig } from '../src/core/domain/configuration.ts';
import { harness } from './fixtures/harness.ts';

class Provider extends LlmAdapter {
  calls: string[] = [];
  async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, defaultMaxTokens: 512 };
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(JSON.stringify(options.messages));
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: 'PHASE1_REPLY' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'PHASE1_REPLY' } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
const dir = resolve('../artifacts/tui-phase1');
await mkdir(dir, { recursive: true });
const root = await mkdtemp(join(dir, 'native-')),
  home = join(root, 'home'),
  cwd = join(root, '中文 项目');
await mkdir(home);
await mkdir(cwd);
const config = structuredClone(defaultConfig);
config.models[0].apiKeyEnv = 'TUI_PHASE1_TEST_KEY';
config.models.push({ ...config.models[0], id: 'alternate', model: 'alternate-model' });
const previous = process.env.TUI_PHASE1_TEST_KEY;
process.env.TUI_PHASE1_TEST_KEY = 'local-fixture';
const adapter = new Provider(),
  ctx = await harness(home, ['deepseek', 'alternate'], adapter);
const test = await createTestRenderer({ width: 160, height: 44 });
const launch: LaunchConfig = { home, cwd, modelId: 'deepseek', appConfig: config };
let workspace: WorkspaceController | undefined,
  ui: Awaited<ReturnType<typeof mountEntryUI>> | undefined,
  opens = 0,
  configurationOpens = 0;
const frames: Record<string, string> = {},
  checks: Record<string, boolean> = {};
const actions = {
  async open(options: LaunchConfig) {
    opens++;
    workspace = new WorkspaceController(ctx, options);
    await workspace.initialize();
    return workspace;
  },
  async sessions() {
    return (await ctx.sessionPersistence.list()).map((s) => ({ id: s.header.id, cwd: s.header.cwd ?? cwd }));
  },
  exit() {},
  async modelConfiguration() {
    configurationOpens++;
  },
};
try {
  ui = await mountEntryUI(test.renderer, launch, actions);
  await test.flush();
  assert.equal(ctx.agents.list().length, 0);
  assert.equal(adapter.calls.length, 0);
  assert.equal(opens, 0);
  await assert.rejects(readFile(snapshotPath(launch)), { code: 'ENOENT' });
  checks.homeDoesNotOpenAgentsOrWriteLayout = true;
  await ui.home!.submit('/model-config');
  await ui.home!.submit('怎么配置模型？');
  assert.equal(configurationOpens, 2);
  assert.equal(opens, 0);
  assert.equal(adapter.calls.length, 0);
  await assert.rejects(readFile(snapshotPath(launch)), { code: 'ENOENT' });
  checks.modelConfigurationOpensWithoutAgentOrLayout = true;
  await ui.home!.submit('/doctor');
  await test.flush();
  assert.match(test.captureCharFrame(), /运行诊断完成/);
  assert.equal(adapter.calls.length, 0);
  assert.equal(opens, 0);
  await assert.rejects(readFile(snapshotPath(launch)), { code: 'ENOENT' });
  checks.homeDiagnosticsRemainReadOnly = true;
  test.mockInput.pressEscape();
  await delay(100);
  await test.flush();
  for (const [width, height] of [
    [160, 44],
    [120, 38],
    [100, 32],
    [80, 24],
    [50, 30],
    [50, 20],
    [40, 18],
  ]) {
    test.resize(width, height);
    await test.flush();
    const frame = test.captureCharFrame();
    frames[`${width}x${height}`] = frame;
    assert.ok(frame.includes('deepseek-flash'));
    assert.ok(frame.includes('Enter'));
    assert.ok(frame.includes('Ctrl+C'));
    const layout = homeLayout(width, height),
      rows = frame.split('\n');
    if (layout.logo) {
      const art = layout.logo === 'home' ? homeLogo : layout.logo === 'small' ? smallHomeLogo : tinyHomeLogo;
      const firstLine = art.split('\n')[0],
        columns = firstLine.length;
      assert.equal(rows[layout.topRows].indexOf(firstLine), Math.floor((width - columns) / 2));
      const englishRow = layout.topRows + layout.logoHeight + 1;
      assert.equal(rows[englishRow].indexOf(englishWordmark.split('\n')[0]), Math.floor((width - 38) / 2));
      const infoRow = englishRow + 4;
      assert.ok(rows[infoRow].includes('deepseek'));
      assert.ok(rows[infoRow + 1].includes('项目'));
      const inputRow = infoRow + layout.infoRows + layout.noticeRows;
      assert.ok(rows[inputRow].includes('描述你要完成'));
      const statusRow = inputRow + 3 + layout.statusGap;
      assert.ok(rows[statusRow - 1].trim() === '');
      assert.ok(rows[statusRow].includes('就绪'));
      if (layout.hintGap) assert.ok(rows[statusRow + 1].trim() === '');
      if (layout.linkGap) assert.ok(rows[statusRow + 2 + layout.hintGap].trim() === '');
      assert.ok(columns <= 56);
      assert.ok(layout.topRows <= 2);
    } else assert.ok(frame.includes('涌现 · Emergence'));
  }
  assert.equal(homeLayout(80, 24).logo, 'tiny');
  checks.responsiveHome = true;
  checks.centeredBrandAndMetadataBelow = true;
  test.resize(120, 38);
  await test.flush();
  ui.home!.input.setText('/model');
  test.mockInput.pressEnter();
  await test.flush();
  assert.ok(test.captureCharFrame().includes('选择模型'));
  test.mockInput.pressArrow('down');
  test.mockInput.pressEnter();
  await test.flush();
  assert.ok(test.captureCharFrame().includes('alternate-model'));
  assert.equal(ctx.agents.list().length, 0);
  assert.equal(adapter.calls.length, 0);
  await ui.home!.submit('/model deepseek');
  await ui.home!.submit('/sessions');
  await test.flush();
  assert.ok(test.captureCharFrame().includes('没有保存的会话'));
  test.mockInput.pressEscape();
  // A lone ESC is decoded after the terminal's escape-sequence timeout.
  await delay(100);
  await test.flush();
  assert.ok(ui.home!.input.focused);
  checks.homeMenusDoNotCreateSessions = true;
  await test.mockInput.pasteBracketedText('第一条任务🙂\n保留第二行');
  await test.flush();
  assert.equal(ui.home!.input.plainText, '第一条任务🙂\n保留第二行');
  test.mockInput.pressEnter();
  test.mockInput.pressEnter();
  await test.flush();
  await ui.opening;
  assert.ok(ui.workspaceView);
  assert.equal(opens, 1);
  await workspace!.current.controller!.agent.whenIdle();
  await test.flush();
  assert.equal(adapter.calls.length, 1);
  assert.ok(adapter.calls[0].includes('第一条任务🙂'));
  assert.ok(workspace!.current.controller!.transcript().some((line) => line.includes('保留第二行')));
  assert.ok(test.captureCharFrame().includes('PHASE1_REPLY'));
  checks.firstSubmissionOnceAndMultilineIntact = true;
  frames.conversation = test.captureCharFrame();
  await workspace!.send(workspace!.focused, '/panes');
  const activeView = ui.workspaceView!.views.get(workspace!.focused)!;
  activeView.input.setText('/help');
  activeView.submit();
  await test.flush();
  assert.ok(workspace!.overlay.includes('/split'));
  workspace!.overlay = '';
  workspace!.changed();
  checks.infoPanelsDoNotTrapNewCommands = true;
  await workspace!.save();
  const original = await readFile(snapshotPath(launch), 'utf8');
  const session = workspace!.current.sessionId;
  ui.dispose();
  ui = undefined;
  await workspace!.close();
  workspace = undefined;
  ui = await mountEntryUI(test.renderer, launch, actions);
  await test.flush();
  assert.ok(ui.home);
  assert.equal(ctx.agents.list().length, 0);
  assert.equal(await readFile(snapshotPath(launch), 'utf8'), original);
  await ui.home.submit('/continue');
  await test.flush();
  assert.equal(workspace!.current.sessionId, session);
  assert.equal(adapter.calls.length, 1);
  checks.explicitContinueRestoresWithoutReplay = true;
  ui.dispose();
  ui = undefined;
  await workspace!.close();
  workspace = undefined;
  ui = await mountEntryUI(test.renderer, launch, actions);
  await test.flush();
  const beforeNew = await readFile(snapshotPath(launch), 'utf8');
  await ui.home!.submit('新的任务');
  await workspace!.current.controller!.agent.whenIdle();
  await test.flush();
  const archive = (await readdir(join(home, 'workspaces'))).find((name) => name.includes('.before-home-'))!;
  assert.equal(await readFile(join(home, 'workspaces', archive), 'utf8'), beforeNew);
  assert.notEqual(workspace!.current.sessionId, session);
  checks.newTaskArchivesPreviousWorkspace = true;
  const resumed = workspace!.current.sessionId!;
  ui.dispose();
  ui = undefined;
  await workspace!.close();
  workspace = undefined;
  ui = await mountEntryUI(test.renderer, { ...launch, resume: resumed }, actions);
  await test.flush();
  assert.equal(ui.home, undefined);
  assert.ok(ui.workspaceView);
  assert.equal(workspace!.current.sessionId, resumed);
  assert.equal(adapter.calls.length, 2);
  checks.explicitResumeBypassesHome = true;
  await writeFile(join(dir, 'native.json'), JSON.stringify({ passed: true, checks, frames, root }, null, 2));
  console.log(JSON.stringify(checks));
} catch (error) {
  await writeFile(
    join(dir, 'native.json'),
    JSON.stringify(
      { passed: false, error: String(error), checks, frames, frame: test.captureCharFrame(), root },
      null,
      2,
    ),
  );
  throw error;
} finally {
  ui?.dispose();
  await test.dispose();
  await workspace?.close();
  await ctx.fiber.dispose();
  if (previous === undefined) delete process.env.TUI_PHASE1_TEST_KEY;
  else process.env.TUI_PHASE1_TEST_KEY = previous;
}
