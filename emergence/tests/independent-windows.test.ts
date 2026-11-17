import { ExecutionJournal } from '../src/core/storage/execution-journal.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { WorkspaceController } from '../src/app/workspace.ts';
import { commandHelp, workspaceCommands } from '../src/app/commands.ts';
import { defaultConfig } from '../src/core/domain/configuration.ts';
import { harness } from './fixtures/harness.ts';
import { taskSchema } from '../src/core/domain/task.ts';
import { ExecutionProvider, until } from './fixtures/core-execution.ts';

class ConversationProvider extends LlmAdapter {
  calls: GenerateOptions[] = [];
  async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, defaultMaxTokens: 512 };
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options);
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: '当前会话回复 ' + options.model };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '当前会话回复 ' + options.model } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

async function fixture(provider: LlmAdapter = new ConversationProvider()) {
  const home = await mkdtemp(join(tmpdir(), 'emergence-independent-'));
  const a = join(home, 'project-a'),
    b = join(home, 'project-b');
  await mkdir(a);
  await mkdir(b);
  const config = structuredClone(defaultConfig);
  config.models = ['one', 'two'].map((id) => ({
    ...config.models[0],
    id,
    model: id,
    apiKeyEnv: 'INDEPENDENT_WINDOW_FIXTURE',
  }));
  config.defaultModel = 'one';
  config.permissions.defaultMode = 'edit';
  const previous = process.env.INDEPENDENT_WINDOW_FIXTURE;
  process.env.INDEPENDENT_WINDOW_FIXTURE = 'local-fixture';
  const ctx = await harness(home, ['one', 'two'], provider);
  const launch = { home, cwd: a, modelId: 'one', appConfig: config };
  const w = new WorkspaceController(ctx, launch);
  await w.initialize();
  return {
    home,
    a,
    b,
    config,
    ctx,
    launch,
    w,
    async close() {
      await w.close();
      await ctx.fiber.dispose();
      if (previous === undefined) delete process.env.INDEPENDENT_WINDOW_FIXTURE;
      else process.env.INDEPENDENT_WINDOW_FIXTURE = previous;
    },
  };
}

test('shipped multi-window sessions keep projects/models and conversation input independent', async () => {
  const provider = new ConversationProvider(),
    f = await fixture(provider);
  try {
    const first = f.w.current,
      second = await f.w.split('row', f.b, 'two');
    assert.equal('team' in f.w, false);
    assert.equal(f.w.panes.size, 2);
    await Promise.all([f.w.send(first.id, '你好，独立甲'), f.w.send(second.id, '你好，独立乙')]);
    await Promise.all([first.controller!.agent.whenIdle(), second.controller!.agent.whenIdle()]);
    assert.equal(provider.calls.length, 2);
    for (const [pane, own, foreign] of [
      [first, '独立甲', '独立乙'],
      [second, '独立乙', '独立甲'],
    ] as const) {
      const call = provider.calls.find((c) => c.model === pane.modelId)!;
      assert.ok(call);
      assert.match(JSON.stringify(call.messages), new RegExp(own));
      assert.doesNotMatch(JSON.stringify(call.messages), new RegExp(foreign));
      const inventory = await pane.controller!.planning.inventory();
      assert.deepEqual(
        inventory.windows.map((window) => window.id),
        [pane.id],
      );
      const tools = f.ctx.tools.definitions(pane.controller!.agent).map((tool) => tool.name);
      assert.ok(tools.includes('emergence_analyze'), 'KIM remains available');
      assert.ok(tools.includes('emergence_data_analyze'), 'native data remains available');
      assert.ok(tools.includes('emergence_code_context'), 'native code remains available');
      assert.ok(
        !tools.some((name) => ['emergence_team', 'emergence_dispatch', 'emergence_audit'].includes(name)),
      );
    }
    f.w.hide(second.id);
    f.w.show(second.id);
    await f.w.closePane(second.id);
    assert.equal(f.w.current.controller?.id, first.controller?.id);
    assert.equal(f.w.panes.size, 1);
  } finally {
    await f.close();
  }
});

test('retired window control fails at commands and runtime before any cross-window effects', async () => {
  const provider = new ConversationProvider(),
    f = await fixture(provider);
  try {
    const first = f.w.current,
      second = await f.w.split('row', f.b, 'two');
    const commands = workspaceCommands(f.w, first.id);
    const retired = [
      '/mode',
      '/assign',
      '/assign-role',
      '/team',
      '/window-role',
      '/dispatch',
      '/takeover',
      '/release',
    ];
    assert.ok(commands.every((item) => !retired.includes(item.command.split(' ')[0])));
    assert.doesNotMatch(commandHelp(commands, f.config.ui), /设为主控|\/assign|\/mode collaborate/);
    for (const command of retired) await assert.rejects(f.w.send(first.id, command), /已移除/);
    assert.equal('setMaster' in f.w, false);
    assert.equal('configure' in f.w.taskEngine, false);
    await assert.rejects(f.w.taskEngine.enqueue(first.id, second.id, 'cross', '不应写入'), /已移除/);
    assert.equal('request' in f.w.taskEngine.assurance, false);
    await assert.rejects(
      f.w.taskEngine.executePlan(first.id, { steps: [{ window: second.id }] } as never),
      /已移除/,
    );
    assert.equal(provider.calls.length, 0);
    assert.equal(f.w.taskEngine.state.tasks.length, 0);
    assert.equal(f.w.panes.size, 2);
  } finally {
    await f.close();
  }
});

test('single-window execution still runs through the real Harness and produces its file', async () => {
  const f = await fixture(new ExecutionProvider());
  try {
    f.ctx.tools.register(
      defineTool({
        name: 'write',
        description: 'native fixture write',
        parameters: {
          file_path: { type: 'string', required: true },
          content: { type: 'string', required: true },
        },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute: async (args, exec) => {
          await writeFile(
            join(f.ctx.workingDirectory.get(exec.agent!.session), args.file_path),
            args.content,
          );
          return 'written';
        },
      }),
    );
    const pane = f.w.current;
    const task = await f.w.taskEngine.enqueue(
      pane.id,
      pane.id,
      'local',
      '写入当前项目',
      [],
      undefined,
      undefined,
      {},
    );
    await until(() => task.status === 'succeeded');
    assert.equal(await readFile(join(f.a, 'result.txt'), 'utf8'), 'persisted actual effect');
    assert.equal(f.w.panes.size, 1);
    assert.equal('master' in f.w.taskEngine.state, false);
  } finally {
    await f.close();
  }
});

test('old workspace/journal and role templates restore history without restoring window control', async () => {
  const provider = new ConversationProvider(),
    f = await fixture(provider);
  let legacy: WorkspaceController | undefined, restored: WorkspaceController | undefined;
  try {
    await f.w.close();
    legacy = new WorkspaceController(f.ctx, f.launch);
    await legacy.initialize();
    const first = legacy.current,
      second = await legacy.split('row', f.b, 'two');
    legacy.updateView(first.id, '保留这个未发送草稿', 0);
    const task = taskSchema.parse({
      id: 'legacy-task',
      requestKey: 'old',
      objective: '保留旧任务事实',
      issuer: first.id,
      issuerSession: first.controller!.id,
      target: second.id,
      targetSession: second.controller!.id,
      cwd: second.cwd,
      modelId: second.modelId,
      dependsOn: [],
      status: 'queued',
      progress: 'old queued work',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    // Write the old wire format directly; never re-enable a historical runtime to create fixtures.
    const legacyPayload = {
      version: 1,
      mode: 'collaborate',
      paused: false,
      master: first.id,
      workers: [second.id],
      owned: [],
      autoWorkers: true,
      tasks: [task],
    };
    const sessions = [...legacy.panes.values()].map((pane) => pane.sessionId);
    await legacy.close();
    const journal = new ExecutionJournal(f.home, process.platform === 'win32' ? f.a.toLowerCase() : f.a);
    await journal.open();
    journal.commit(legacyPayload);
    await journal.close();
    restored = new WorkspaceController(f.ctx, f.launch);
    await restored.initialize();
    assert.equal(restored.taskEngine.state.history?.master, first.id);
    assert.equal('master' in restored.taskEngine.state, false);
    assert.equal('workers' in restored.taskEngine.state, false);
    assert.deepEqual(
      [...restored.panes.values()].map((pane) => pane.sessionId),
      sessions,
    );
    assert.equal(restored.panes.get(first.id)?.draft, '保留这个未发送草稿');
    assert.ok(
      restored.taskEngine.state.tasks.some((item) => item.id === task.id && item.status !== 'running'),
    );
    assert.equal(provider.calls.length, 0);
    await assert.rejects(
      restored.taskEngine.recover(task.id, first.id, '不得恢复历史跨窗任务'),
      /历史跨窗口/,
    );
    await restored.applyTemplate({
      version: 1,
      name: 'old-roles',
      focused: 'a',
      layout: {
        kind: 'split',
        id: 'split',
        axis: 'row',
        ratio: 0.5,
        first: { kind: 'pane', pane: 'a' },
        second: { kind: 'pane', pane: 'b' },
      },
      panes: [
        { id: 'a', cwd: f.a, modelId: 'one' },
        { id: 'b', cwd: f.b, modelId: 'two' },
      ],
      roles: { master: 'a', workers: ['b'] },
    });
    assert.equal('master' in restored.taskEngine.state, false);
    assert.equal('workers' in restored.taskEngine.state, false);
    assert.equal(restored.panes.size, 2);
    assert.equal(provider.calls.length, 0);
  } finally {
    await restored?.close();
    await legacy?.close();
    await f.close();
  }
});
