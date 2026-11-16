import { Context } from '@deepseek-ai/cordis';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import Filesystem from '@deepseek-ai/dsh-fs-local';
import Llm, { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import Sessions from '@deepseek-ai/dsh-session';
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import Projections from '@deepseek-ai/dsh-session-projection';
import Prompt from '@deepseek-ai/dsh-system-prompt';
import * as Executor from '@deepseek-ai/dsh-tool-executor-native';
import Tools, { defineTool } from '@deepseek-ai/dsh-tools';
import WorkingDirectory from '@deepseek-ai/dsh-working-directory';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkspaceController } from '../src/app/workspace.ts';
import { defaultConfig } from '../src/core/domain/configuration.ts';

class Provider extends LlmAdapter {
  calls: string[] = [];
  async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, defaultMaxTokens: 512 };
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options.model);
    const toolCount = options.messages.filter((m) => m.role === 'tool').length;
    const tool = toolCount < 2 && options.model.startsWith('tool');
    if (tool) {
      const id = ToolCallId('shared-call-' + options.model + '-' + toolCount);
      const name = toolCount === 0 ? 'emergence_analyze' : 'write';
      const args =
        toolCount === 0
          ? JSON.stringify({ objective: '修改共享文件', reason: '单文件改动', route: 'focused' })
          : '{"file_path":"shared.txt"}';
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    const text = '完成 ' + options.model;
    yield { type: 'block-start', index: 0, blockType: 'text' };
    for (const char of text) {
      await delay(20, undefined, { signal: options.signal });
      yield { type: 'text-delta', index: 0, text: char };
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

test('real Harness workspace retains hidden tasks, isolates cancellation, resumes bindings and blocks overlapping writes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'emergence-workspace-'));
  const cwd = join(home, '项目 A'),
    other = join(home, '项目 B');
  await mkdir(cwd);
  await mkdir(other);
  const ctx = new Context(),
    provider = new Provider();
  let bodyCalls = 0;
  const previous = process.env.WORKSPACE_TEST_KEY;
  process.env.WORKSPACE_TEST_KEY = 'local-fixture';
  const config = structuredClone(defaultConfig);
  config.defaultModel = 'one';
  config.models = ['one', 'two', 'tool-one', 'tool-two'].map((id) => ({
    ...defaultConfig.models[0],
    id,
    model: id,
    apiKeyEnv: 'WORKSPACE_TEST_KEY',
  }));
  let workspace: WorkspaceController | undefined;
  try {
    await ctx.plugin(Llm);
    await ctx.plugin(Sessions);
    await ctx.plugin(Projections);
    await ctx.plugin(Prompt);
    await ctx.plugin(Tools);
    await ctx.plugin(Executor);
    await ctx.plugin(AgentRegistry);
    await ctx.plugin(Filesystem);
    await ctx.plugin(WorkingDirectory);
    await ctx.plugin(Persistence, { root: join(home, 'sessions'), compression: 'none' });
    await ctx.plugin(AgentLoop, { agents: [] });
    ctx.effect(() =>
      ctx.llm.registerAdapter(
        config.models.map((m) => m.id),
        provider,
      ),
    );
    ctx.effect(() =>
      ctx.tools.register(
        defineTool({
          name: 'write',
          description: 'Controlled conflict fixture',
          parameters: { file_path: { type: 'string', required: true } },
          output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
          async execute() {
            bodyCalls++;
            await delay(150);
            return 'written';
          },
        }),
      ),
    );
    const launch = { home, cwd, modelId: 'one', appConfig: config };
    workspace = new WorkspaceController(ctx, launch);
    await workspace.initialize();
    const a = workspace.current,
      b = await workspace.split('row', other, 'two');
    await workspace.send(a.id, '运行 A');
    await workspace.send(b.id, '运行 B');
    await delay(30);
    workspace.hide(a.id);
    await a.controller!.agent.whenIdle();
    assert.ok(
      a.controller!.transcript().some((line) => line.includes('完成 one')),
      'hidden session finishes',
    );
    workspace.show(a.id);
    await workspace.send(a.id, '再运行 A');
    await workspace.send(b.id, '再运行 B');
    await delay(20);
    await a.controller!.cancel();
    await b.controller!.agent.whenIdle();
    assert.ok(
      b.controller!.transcript().some((line) => line.includes('完成 two')),
      'other session keeps running',
    );
    workspace.updateView(a.id, '独立草稿', 4);
    await workspace.save();
    const sessionA = a.controller!.id;
    await workspace.close();
    workspace = new WorkspaceController(ctx, launch);
    await workspace.initialize();
    let restored = workspace.panes.get(a.id)!;
    assert.equal(restored.controller!.id, sessionA);
    assert.equal(restored.draft, '独立草稿');
    assert.equal(workspace.panes.get(b.id)!.controller!.cwd, other);
    assert.equal(restored.controller!.launch.modelId, 'one');
    assert.equal(workspace.panes.get(b.id)!.controller!.launch.modelId, 'two');
    await workspace.close();
    workspace = new WorkspaceController(ctx, { ...launch, explicitModel: true, modelId: 'two' });
    await workspace.initialize();
    restored = workspace.panes.get(a.id)!;
    assert.equal(restored.controller!.id, sessionA);
    assert.equal(restored.controller!.launch.modelId, 'two');
    assert.equal(workspace.panes.get(b.id)!.controller!.launch.modelId, 'two');
    const first = await workspace.split('row', cwd, 'tool-one'),
      second = await workspace.split('column', cwd, 'tool-two');
    await workspace.send(first.id, '并发修改');
    await workspace.send(second.id, '并发修改');
    await Promise.all([first.controller!.agent.whenIdle(), second.controller!.agent.whenIdle()]);
    assert.equal(bodyCalls, 1, 'second writer is refused before dispatch');
    assert.ok(
      [first, second].some((p) => p.controller!.transcript().some((line) => line.includes('正由窗格'))),
    );
    await assert.rejects(workspace.send(first.id, `/resume ${restored.controller!.id}`), /已绑定其他窗格/);
    await assert.rejects(workspace.send(first.id, `/resume\t${restored.controller!.id}`), /已绑定其他窗格/);
    const previousA = restored.controller!.id,
      previousB = workspace.panes.get(b.id)!.controller!.id;
    await workspace.send(restored.id, '/new');
    assert.notEqual(restored.controller!.id, previousA);
    assert.equal(workspace.panes.get(b.id)!.controller!.id, previousB);
    await workspace.send(restored.id, `/resume ${previousA}`);
    assert.equal(restored.controller!.id, previousA);
    // Continuous events must not postpone layout saving indefinitely.
    workspace.updateView(restored.id, '流式期间也保存', 7);
    for (let i = 0; i < 8; i++) {
      workspace.changed();
      await delay(50);
    }
    assert.equal(
      JSON.parse(await readFile(workspace.path, 'utf8')).panes.find(
        (p: { id: string }) => p.id === restored.id,
      ).draft,
      '流式期间也保存',
    );
    await workspace.save();
    const saved = JSON.parse(await readFile(workspace.path, 'utf8'));
    await workspace.close();
    // Failed restoration remains an explicit error pane with its original binding.
    saved.panes[0].cwd = join(home, 'missing-directory');
    saved.panes[1].modelId = 'missing-model';
    saved.panes[2].sessionId = 'missing-session';
    await writeFile(workspace.path, JSON.stringify(saved));
    workspace = new WorkspaceController(ctx, launch);
    await workspace.initialize();
    assert.equal(workspace.panes.size, 4);
    assert.equal([...workspace.panes.values()].filter((p) => p.error).length, 3);
    assert.equal(workspace.panes.get(first.id)!.sessionId, 'missing-session');
    await workspace.send(b.id, '/model one');
    assert.equal(workspace.panes.get(b.id)!.controller!.launch.modelId, 'one');
    await assert.rejects(workspace.send(a.id, '/retry'));
    const changing = workspace.send(a.id, `/project "${cwd}"`);
    await assert.rejects(workspace.send(a.id, `/project "${other}"`), /正在切换/);
    await changing;
    assert.equal(workspace.panes.get(a.id)!.controller!.cwd, cwd);
    await workspace.close();
    await writeFile(workspace.path, '{broken json');
    workspace = new WorkspaceController(ctx, launch);
    await assert.rejects(workspace.initialize(), /--fresh/);
    await workspace.close();
    workspace = new WorkspaceController(ctx, { ...launch, fresh: true });
    await workspace.initialize();
    assert.equal(workspace.panes.size, 1);
    const opening = workspace.split('row');
    const closing = workspace.close();
    await assert.rejects(opening, /已退出/);
    await closing;
  } finally {
    await workspace?.close();
    await ctx.fiber.dispose();
    if (previous === undefined) delete process.env.WORKSPACE_TEST_KEY;
    else process.env.WORKSPACE_TEST_KEY = previous;
  }
});
