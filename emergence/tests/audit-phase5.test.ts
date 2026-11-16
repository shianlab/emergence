import { AttachmentId } from '@deepseek-ai/dsh-attachment';
import {
  createToolResultMessage,
  createUserMessage,
  LlmAdapter,
  ToolCallId,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm';
import { SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { saveConfig } from '../src/app/config.ts';
import { assertModelHistory } from '../src/app/controller.ts';
import { HistoricalOrchestrationWorkspace as WorkspaceController } from './fixtures/historical-orchestration.ts';
import { defaultConfig } from '../src/core/domain/configuration.ts';
import { harness } from './fixtures/harness.ts';

class Provider extends LlmAdapter {
  async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, defaultMaxTokens: 256 };
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (JSON.stringify(options.messages).includes('probe_tool') && options.messages.at(-1)?.role !== 'tool') {
      const id = ToolCallId(randomUUID()),
        name = 'ext_owned_probe';
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: '{}' };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: '{}' } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: 'audit done' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'audit done' } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'emergence-audit5-')),
    home = join(root, 'home'),
    a = join(root, '项目 A'),
    b = join(root, '项目 B');
  await mkdir(home);
  await mkdir(a);
  await mkdir(b);
  const config = structuredClone(defaultConfig);
  config.defaultModel = 'one';
  config.models = ['one', 'two'].map((id) => ({
    ...config.models[0],
    id,
    model: id,
    apiKeyEnv: 'AUDIT5_FIXTURE_KEY',
  }));
  config.permissions = { defaultMode: 'auto', rules: [{ tool: 'ext_owned_probe', effect: 'allow' }] };
  await saveConfig(home, config);
  process.env.AUDIT5_FIXTURE_KEY = 'local-audit5-fixture';
  const ctx = await harness(home, ['one', 'two'], new Provider());
  const w = new WorkspaceController(ctx, { home, cwd: a, modelId: 'one', fresh: true, appConfig: config });
  await w.initialize();
  const slow = {
    serverName: 'slow',
    transport: 'stdio' as const,
    command: process.execPath,
    args: [resolve('tests/fixtures/mcp.cjs'), '--delay-init'],
    enabled: true,
  };
  return {
    w,
    ctx,
    config,
    a,
    b,
    home,
    slow,
    async close() {
      await w.close();
      assert.equal(ctx.agents.list().length, 0);
      await ctx.fiber.dispose();
    },
  };
}

test('MCP shutdown during startup cannot publish late tools or accept a new server afterwards', async () => {
  const f = await fixture();
  try {
    const enabling = f.w.capabilities.enable(f.slow);
    const outcome = enabling.then(
      () => 'ready',
      () => 'stopped',
    );
    await delay(25);
    await f.w.capabilities.close();
    await outcome;
    assert.equal(
      f.ctx.tools.definitions(f.w.current.controller!.agent).some((t) => t.name === 'mcp__slow__echo'),
      false,
    );
    await assert.rejects(f.w.capabilities.enable({ ...f.slow, serverName: 'after_close' }), /关闭|停止/);
  } finally {
    await f.close();
  }
});

test('a slow MCP configuration change excludes new work and structural changes in every pane', async () => {
  const f = await fixture();
  let configuring: Promise<void> | undefined;
  try {
    const first = f.w.focused;
    await f.w.split('row', f.b, 'two');
    const second = f.w.focused;
    f.config.mcp.push(f.slow);
    await saveConfig(f.home, f.config);
    configuring = f.w.send(first, '/mcp enable slow');
    await delay(25);
    await assert.rejects(f.w.send(second, 'hello'), /设置|配置/);
    await assert.rejects(f.w.split('column'), /设置|配置/);
    await assert.rejects(f.w.closePane(second), /设置|配置/);
    await configuring;
    await f.w.send(second, 'hello');
    await f.w.current.controller!.agent.whenIdle();
  } finally {
    await configuring?.catch(() => {});
    await f.close();
  }
});

test('template loading keeps focus but retires saved team roles', async () => {
  const f = await fixture();
  try {
    const first = f.w.focused;
    await f.w.split('row', f.b, 'two');
    const second = f.w.focused;
    f.w.collaboration.configure(first, [second]);
    await f.w.send(second, '/template save roles');
    await f.w.send(second, '/template load roles');
    assert.equal(f.w.focused, second);
    await assert.rejects(f.w.send(second, '/mode collaborate'), /已移除/);
    assert.equal(f.w.collaboration.state.master, undefined);
    assert.deepEqual(f.w.collaboration.state.workers, []);
  } finally {
    await f.close();
  }
});

test('an owned child extension tool receives the child project, model and session instead of the root binding', async () => {
  const f = await fixture();
  let child: { dispose(): Promise<void> } | undefined;
  try {
    await f.w.extensions.enable(
      { id: 'owned', module: 'fixture', enabled: true },
      {
        activate(api) {
          api.tool('probe', 'Return the actual calling context.', {}, (_args, pane) => pane);
        },
      },
    );
    const handle = await f.ctx.agents.create({
      sessionId: SessionId(randomUUID()),
      parentAgent: f.w.current.controller!.agent,
      meta: { cwd: f.b },
      agentOptions: { provider: 'two', model: 'two' },
    });
    child = handle;
    handle.agent.followup(
      createUserMessage({ content: [{ type: 'text', text: 'probe_tool' }], source: { kind: 'user' } }),
    );
    await handle.agent.whenIdle();
    const result = handle.agent.session.snapshotEvents().find((e) => e.type === 'tool/result');
    assert.ok(result && result.type === 'tool/result');
    const block = result.data.message.content[0];
    assert.equal(block.type, 'text');
    if (block.type !== 'text') throw new Error('expected result');
    const context = JSON.parse(block.text);
    assert.equal(context.cwd, f.b);
    assert.equal(context.modelId, 'two');
    assert.equal(context.sessionId, handle.agent.id);
  } finally {
    await child?.dispose();
    await f.close();
  }
});

test('the UI disable command can abort a running extension command and release its resources', async () => {
  const f = await fixture();
  let running: Promise<void> | undefined;
  try {
    const first = f.w.focused;
    await f.w.split('row', f.b, 'two');
    const second = f.w.focused;
    const entry = { id: 'waiting', module: 'fixture', enabled: true };
    f.config.extensions.push(entry);
    await saveConfig(f.home, f.config);
    let started = false,
      cleaned = false;
    await f.w.extensions.enable(entry, {
      activate(api) {
        api.effect(() => () => {
          cleaned = true;
        });
        api.command('wait', async (_args, _pane, signal) => {
          started = true;
          await delay(60000, undefined, { signal });
          return 'late';
        });
      },
    });
    running = f.w.send(first, '/x_waiting_wait');
    const stopped = assert.rejects(running);
    for (let i = 0; !started && i < 100; i++) await delay(5);
    assert.equal(started, true);
    await f.w.send(second, '/extensions disable waiting');
    await stopped;
    assert.equal(cleaned, true);
  } finally {
    await f.w.extensions.disable('waiting');
    await running?.catch(() => {});
    await f.close();
  }
});

test('model image compatibility includes tool results and pending context, while offloaded images stay text-only', () => {
  const image = {
    type: 'image' as const,
    attachment: {
      attachmentId: AttachmentId('a'.repeat(64)),
      mediaType: 'image/png' as const,
      bytes: 80,
      width: 1,
      height: 1,
    },
  };
  const target = { ...defaultConfig.models[0], capabilities: { vision: false } };
  const message = createToolResultMessage({
    callId: ToolCallId('image-proof'),
    isError: false,
    content: [image],
  });
  const event = {
    type: 'tool/result',
    seq: SessionSeq(0),
    time: 1,
    data: { turn: 1, step: 1, message },
    surfaceOp: 'append',
  } satisfies SessionEvent;
  assert.throws(() => assertModelHistory(target, [event]), /图像/);
  const offloaded = {
    ...event,
    data: {
      ...event.data,
      message: createToolResultMessage({
        callId: ToolCallId('image-proof'),
        isError: false,
        content: [{ ...image, offloaded: true }],
      }),
    },
  };
  assert.doesNotThrow(() => assertModelHistory(target, [offloaded]));
  assert.throws(
    () => assertModelHistory(target, [], [createUserMessage({ content: [image], source: { kind: 'user' } })]),
    /图像/,
  );
});

test('the UI can disable an extension while its asynchronous panel is waiting', async () => {
  const f = await fixture();
  let running: Promise<void> | undefined;
  try {
    const first = f.w.focused;
    await f.w.split('row', f.b, 'two');
    const second = f.w.focused;
    const entry = { id: 'panelwait', module: 'fixture', enabled: true };
    f.config.extensions.push(entry);
    await saveConfig(f.home, f.config);
    let started = false;
    await f.w.extensions.enable(entry, {
      activate(api) {
        api.panel('wait', async (_pane, signal) => {
          started = true;
          await delay(60000, undefined, { signal });
          return 'late';
        });
      },
    });
    running = f.w.send(first, '/panel panelwait.wait');
    const stopped = assert.rejects(running);
    for (let i = 0; !started && i < 100; i++) await delay(5);
    assert.ok(started);
    await f.w.send(second, '/extensions disable panelwait');
    await stopped;
  } finally {
    await f.w.extensions.disable('panelwait');
    await running?.catch(() => {});
    await f.close();
  }
});

test('a child uses the capability restriction of its actual model route', async () => {
  const f = await fixture();
  let child: { dispose(): Promise<void> } | undefined;
  try {
    let executions = 0;
    f.w.current.controller!.launch.appConfig.models[1].capabilities = { tools: false };
    await f.w.extensions.enable(
      { id: 'owned', module: 'fixture', enabled: true },
      {
        activate(api) {
          api.tool('probe', 'Count executions.', {}, () => {
            executions++;
            return {};
          });
        },
      },
    );
    const handle = await f.ctx.agents.create({
      sessionId: SessionId(randomUUID()),
      parentAgent: f.w.current.controller!.agent,
      meta: { cwd: f.b },
      agentOptions: { provider: 'two', model: 'two' },
    });
    child = handle;
    handle.agent.followup(
      createUserMessage({ content: [{ type: 'text', text: 'probe_tool' }], source: { kind: 'user' } }),
    );
    await handle.agent.whenIdle();
    assert.equal(executions, 0);
    assert.ok(
      handle.agent.session.snapshotEvents().some((e) => e.type === 'tool/result' && e.data.message.isError),
    );
  } finally {
    await child?.dispose();
    await f.close();
  }
});
