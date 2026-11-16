import {
  LlmAdapter,
  ToolCallId,
  createUserMessage,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { defineTool } from '@deepseek-ai/dsh-tools';
import UserApproval from '@deepseek-ai/dsh-user-approval';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig, saveConfig, updateConfig } from '../src/app/config.ts';
import { SessionController } from '../src/app/controller.ts';
import { HistoricalOrchestrationWorkspace as WorkspaceController } from './fixtures/historical-orchestration.ts';
import { registerSecretNames, safeError } from '../src/core/adapters/redaction.ts';
import { defaultConfig } from '../src/core/domain/configuration.ts';
import { acquireLease } from '../src/core/storage/lease.ts';
import { harness } from './fixtures/harness.ts';

class Provider extends LlmAdapter {
  rootCalls = 0;
  async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, defaultMaxTokens: 1024 };
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.model === 'master') this.rootCalls++;
    const messages = options.messages.map((m) => ({ role: m.role, text: JSON.stringify(m.content) }));
    const shell =
      messages.some((m) => m.role === 'user' && m.text.includes('run-shell')) &&
      !messages.some((m) => m.role === 'tool');
    const report = options.model === 'worker';
    if (shell || report) {
      const name = shell ? 'pwsh' : 'emergence_report',
        id = ToolCallId('call-' + randomUUID());
      const raw = JSON.stringify(
        shell
          ? { command: 'fixture-command', description: 'permission test' }
          : { outcome: 'success', summary: 'verified report', artifacts: [] },
      );
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: raw };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: raw } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: 'done' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
async function until(condition: () => boolean) {
  for (let i = 0; i < 500; i++) {
    if (condition()) return;
    await delay(10);
  }
  throw new Error('Audit condition timeout');
}
function config() {
  const value = structuredClone(defaultConfig);
  value.defaultModel = 'master';
  value.models = ['master', 'worker'].map((id) => ({
    ...value.models[0],
    id,
    model: id,
    apiKeyEnv: 'AUDIT_FIXTURE_KEY',
  }));
  return value;
}

test('diagnostics strip terminal title/clipboard controls while preserving Chinese and newlines', () => {
  assert.equal(safeError('中文\n\x1b[31mred\x1b[0m\x1b]52;c;ZXhmaWw=\x07\x00'), '中文\nred');
});
test('configured credential variables are redacted even without KEY or TOKEN in the name', () => {
  const previous = process.env.AUDIT_CUSTOM_AUTH;
  process.env.AUDIT_CUSTOM_AUTH = 'unusually-named-credential';
  registerSecretNames(['AUDIT_CUSTOM_AUTH']);
  try {
    assert.equal(safeError('unusually-named-credential'), '[已隐藏]');
  } finally {
    if (previous === undefined) delete process.env.AUDIT_CUSTOM_AUTH;
    else process.env.AUDIT_CUSTOM_AUTH = previous;
  }
});

test('redaction observes newly added and rotated credentials immediately without caching environment values', () => {
  const key = 'AUDIT_DYNAMIC_KEY_' + randomUUID().replaceAll('-', '');
  const custom = 'AUDIT_DYNAMIC_AUTH_' + randomUUID().replaceAll('-', '');
  try {
    assert.equal(safeError('普通状态'), '普通状态');
    process.env[key] = 'first-dynamic-fixture-value';
    assert.equal(safeError(process.env[key]), '[已隐藏]');
    process.env[key] = 'rotated-dynamic-fixture-value';
    process.env[custom] = 'custom-dynamic-fixture-value';
    registerSecretNames([custom]);
    assert.equal(safeError(`${process.env[key]} ${process.env[custom]}`), '[已隐藏] [已隐藏]');
    delete process.env[key];
    assert.equal(safeError(process.env[custom]), '[已隐藏]');
  } finally {
    delete process.env[key];
    delete process.env[custom];
  }
});
test('OS lease rejects a second owner and releases for the next owner', async () => {
  const key = 'audit-' + randomUUID(),
    release = await acquireLease(key, '测试租约');
  try {
    await assert.rejects(acquireLease(key, '测试租约'), /正在被其他操作使用/);
  } finally {
    await release();
  }
  const next = await acquireLease(key, '测试租约');
  await next();
  await next();
});
test('a terminated lease-owner process cannot leave a stale workspace lock', async () => {
  const key = 'crash-' + randomUUID();
  const code = `import { acquireLease } from './src/core/storage/lease.ts'; await acquireLease(${JSON.stringify(key)}, 'fixture'); process.send('ready'); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    cwd: process.cwd(),
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Lease fixture startup timeout')), 10000);
      child.once('message', () => {
        clearTimeout(timer);
        resolve();
      });
      child.once('error', reject);
    });
    await assert.rejects(acquireLease(key, '测试租约'), /正在被其他操作使用/);
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill();
    await exited;
    const recovered = await acquireLease(key, '测试租约');
    await recovered();
  } finally {
    child.kill();
  }
});
test('parallel configuration updates preserve both additions and a pane model switch does not overwrite shared settings', async () => {
  const home = await mkdtemp(join(tmpdir(), 'emergence-audit-config-')),
    appConfig = config();
  await saveConfig(home, appConfig);
  await Promise.all(
    ['extra-a', 'extra-b'].map((id) =>
      updateConfig(home, (value) => value.models.push({ ...value.models[0], id })),
    ),
  );
  const ctx = await harness(home, ['master', 'worker'], new Provider());
  const controller = new SessionController(ctx, { home, cwd: home, modelId: 'master', appConfig });
  try {
    await controller.open();
    await controller.command('/model worker');
    const saved = await loadConfig(home);
    assert.ok(saved.models.some((m) => m.id === 'extra-a'));
    assert.ok(saved.models.some((m) => m.id === 'extra-b'));
    assert.equal(saved.defaultModel, 'master');
  } finally {
    await controller.close();
    await ctx.fiber.dispose();
  }
});
test('an active persisted session cannot be resumed by a second controller, even in a different Harness context', async () => {
  const home = await mkdtemp(join(tmpdir(), 'emergence-audit-session-')),
    appConfig = config();
  const aCtx = await harness(home, ['master', 'worker'], new Provider()),
    bCtx = await harness(home, ['master', 'worker'], new Provider());
  const launch = { home, cwd: home, modelId: 'master', appConfig };
  const a = new SessionController(aCtx, launch),
    b = new SessionController(bCtx, launch);
  const previous = process.env.AUDIT_FIXTURE_KEY;
  process.env.AUDIT_FIXTURE_KEY = 'local-audit-fixture';
  try {
    await a.open();
    await a.send('persist');
    await a.agent.whenIdle();
    const id = a.id!;
    await assert.rejects(b.open(id), /该历史会话/);
    await a.close();
    await b.open(id);
    assert.equal(b.id, id);
  } finally {
    await Promise.allSettled([a.close(), b.close()]);
    await aCtx.fiber.dispose();
    await bCtx.fiber.dispose();
    if (previous === undefined) delete process.env.AUDIT_FIXTURE_KEY;
    else process.env.AUDIT_FIXTURE_KEY = previous;
  }
});
test('nested agent shell approval belongs to its runtime owner; forged durable lineage cannot bypass it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'emergence-audit-approval-')),
    appConfig = config(),
    ctx = await harness(home, ['master', 'worker'], new Provider());
  await ctx.plugin(UserApproval);
  let executions = 0;
  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'pwsh',
        description: 'Inert audit shell fixture',
        parameters: { command: { type: 'string' }, description: { type: 'string' } },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        async execute() {
          executions++;
          return 'fixture-only';
        },
      }),
    ),
  );
  const launch = { home, cwd: home, modelId: 'master', appConfig },
    a = new SessionController(ctx, launch),
    b = new SessionController(ctx, launch);
  const handles: Array<{ dispose(): Promise<void> }> = [];
  try {
    await a.open();
    await b.open();
    const child = await ctx.agents.create({
      sessionId: SessionId(randomUUID()),
      parentAgent: a.agent,
      meta: { cwd: home },
      agentOptions: { provider: 'master', model: 'master' },
    });
    handles.push(child);
    const nested = await ctx.agents.create({
      sessionId: SessionId(randomUUID()),
      parentAgent: child.agent,
      meta: { cwd: home },
      agentOptions: { provider: 'master', model: 'master' },
    });
    handles.push(nested);
    nested.agent.followup(
      createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'run-shell' }] }),
    );
    await until(() => !!a.pending);
    assert.equal(b.pending, undefined);
    assert.equal(executions, 0);
    await a.send('n');
    await nested.agent.whenIdle();
    assert.equal(executions, 0);
    await assert.rejects(b.open(nested.agent.id), /该历史会话/);
    child.agent.followup(
      createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'run-shell' }] }),
    );
    await until(() => !!a.pending);
    await a.send('y');
    await child.agent.whenIdle();
    assert.equal(executions, 1);
    const unrelated = await ctx.agents.create({
      sessionId: SessionId(randomUUID()),
      meta: { cwd: home, parentSession: SessionId(a.id!) },
      agentOptions: { provider: 'master', model: 'master' },
    });
    handles.push(unrelated);
    unrelated.agent.followup(
      createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'run-shell' }] }),
    );
    await unrelated.agent.whenIdle();
    assert.equal(executions, 1);
    assert.equal(a.pending, undefined);
    assert.ok(
      unrelated.agent.session
        .snapshotEvents()
        .some((e) => e.type === 'tool/result' && e.data.message.isError),
    );
  } finally {
    for (const handle of handles.reverse()) await handle.dispose();
    await a.close();
    await b.close();
    await ctx.fiber.dispose();
  }
});
test('oversized pasted drafts cannot break workspace persistence or split surrogate pairs', async () => {
  const home = await mkdtemp(join(tmpdir(), 'emergence-audit-draft-')),
    appConfig = config(),
    ctx = await harness(home, ['master', 'worker'], new Provider());
  const workspace = new WorkspaceController(ctx, { home, cwd: home, modelId: 'master', appConfig });
  try {
    await workspace.initialize();
    workspace.updateView(workspace.focused, 'a'.repeat(99999) + '😀extra', 0);
    await workspace.save();
    const saved = JSON.parse(await readFile(workspace.path, 'utf8'));
    assert.equal(saved.panes[0].draft.length, 99999);
    assert.ok(workspace.notice.includes('100000'));
  } finally {
    await workspace.close();
    await ctx.fiber.dispose();
  }
});
test('a delayed task receipt cannot wake a replacement master session', async () => {
  const home = await mkdtemp(join(tmpdir(), 'emergence-audit-receipt-')),
    appConfig = config(),
    provider = new Provider(),
    ctx = await harness(home, ['master', 'worker'], provider);
  const workspace = new WorkspaceController(ctx, { home, cwd: home, modelId: 'master', appConfig });
  const previous = process.env.AUDIT_FIXTURE_KEY;
  process.env.AUDIT_FIXTURE_KEY = 'local-audit-fixture';
  let unblock!: () => void, reached!: () => void;
  const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    }),
    ready = new Promise<void>((resolve) => {
      reached = resolve;
    });
  let intercepted = false;
  const originalSave = workspace.save.bind(workspace);
  workspace.save = async () => {
    await originalSave();
    if (!intercepted && workspace.collaboration.state.tasks.some((t) => t.notified)) {
      intercepted = true;
      reached();
      await blocked;
    }
  };
  try {
    await workspace.initialize();
    const master = workspace.current,
      worker = await workspace.split('row', home, 'worker');
    workspace.collaboration.configure(master.id, [worker.id]);
    await workspace.collaboration.enqueue(master.id, worker.id, 'delayed-receipt', 'report a result');
    await ready;
    const oldId = master.controller!.id;
    await workspace.send(master.id, '/new');
    assert.notEqual(master.controller!.id, oldId);
    unblock();
    await until(() => !workspace.collaboration.current(worker.id));
    await delay(50);
    assert.equal(provider.rootCalls, 0);
    assert.ok(
      !master
        .controller!.agent.session.snapshotEvents()
        .some((e) => e.type === 'user/message' && e.data.source.kind === 'emergence-receipt'),
    );
  } finally {
    unblock();
    await workspace.close();
    await ctx.fiber.dispose();
    if (previous === undefined) delete process.env.AUDIT_FIXTURE_KEY;
    else process.env.AUDIT_FIXTURE_KEY = previous;
  }
});
test('a child command failure cannot be hidden by a successful parent task report', async () => {
  class ParentProvider extends Provider {
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      const calls = options.messages.filter((message) => message.role === 'tool').length;
      if (options.model === 'parent' && calls < 2) {
        const name = calls === 0 ? 'emergence_analyze' : 'call_child';
        const raw = JSON.stringify(
          calls === 0
            ? { objective: '执行子代理并核对真实命令结果', reason: '单项失败传播检查', route: 'focused' }
            : {},
        );
        const id = ToolCallId(randomUUID());
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: raw };
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: raw } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      yield* super.stream(options.model === 'parent' ? { ...options, model: 'worker' } : options);
    }
  }
  const home = await mkdtemp(join(tmpdir(), 'emergence-audit-child-result-')),
    appConfig = config();
  appConfig.models[1].model = 'parent';
  appConfig.shellMode = 'sandbox';
  appConfig.permissions = {
    defaultMode: 'auto',
    rules: ['call_child', 'pwsh'].map((tool) => ({ tool, effect: 'allow' })),
  };
  const ctx = await harness(home, ['master', 'worker'], new ParentProvider());
  const previous = process.env.AUDIT_FIXTURE_KEY;
  process.env.AUDIT_FIXTURE_KEY = 'local-audit-fixture';
  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'pwsh',
        description: 'Inert failed command',
        parameters: { command: { type: 'string' }, description: { type: 'string' } },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        async execute() {
          return { kind: 'foreground', exitCode: 9, timedOut: false, signal: null };
        },
      }),
    ),
  );
  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'call_child',
        description: 'Run a real owned child',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        async execute(_args, exec) {
          const child = await ctx.agents.create({
            sessionId: SessionId(randomUUID()),
            parentAgent: exec.agent!,
            meta: { cwd: home },
            agentOptions: { provider: 'master', model: 'master' },
          });
          try {
            child.agent.followup(
              createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'run-shell' }] }),
            );
            await child.agent.whenIdle();
            return 'parent claims child success';
          } finally {
            await child.dispose();
          }
        },
      }),
    ),
  );
  const workspace = new WorkspaceController(ctx, { home, cwd: home, modelId: 'master', appConfig });
  try {
    await workspace.initialize();
    const master = workspace.current,
      worker = await workspace.split('row', home, 'worker');
    workspace.collaboration.configure(master.id, [worker.id]);
    const task = await workspace.collaboration.enqueue(
      master.id,
      worker.id,
      'child-failed',
      'run a child and report',
    );
    await until(() => task.status === 'needs_review');
    assert.equal(task.report!.outcome, 'success');
    assert.ok(task.result!.errors.some((error) => error.includes('exit code: 9')));
  } finally {
    await workspace.close();
    await ctx.fiber.dispose();
    if (previous === undefined) delete process.env.AUDIT_FIXTURE_KEY;
    else process.env.AUDIT_FIXTURE_KEY = previous;
  }
});
