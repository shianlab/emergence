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
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig, migrateConfig } from '../src/app/config.ts';
import { SessionController } from '../src/app/controller.ts';
import { WorkspaceController } from '../src/app/workspace.ts';
import {
  callFingerprint,
  evaluatePermission,
  evaluatePermissions,
} from '../src/core/adapters/permissions.ts';
import { configSchema, defaultConfig } from '../src/core/domain/configuration.ts';
import { type PermissionSnapshot } from '../src/core/domain/permissions.ts';
import { toolContract } from '../src/core/domain/tool-contract.ts';
import { effectiveKeys, keyAction, uiSchema } from '../src/core/domain/ui-preferences.ts';
import { harness } from './fixtures/harness.ts';

test('retired tool names cannot grant read authority; legacy dispatch rules still restrict plan execution', () => {
  const policy: PermissionSnapshot = { mode: 'edit', root: process.cwd(), rules: [], deny: [], confirm: [] };
  for (const name of [
    'emergence_team',
    'emergence_decide',
    'emergence_plan_work',
    'emergence_plan_step',
    'emergence_assess',
    'emergence_dispatch',
    'emergence_audit',
  ]) {
    assert.equal(toolContract(name).authority, 'unknown');
    assert.equal(
      evaluatePermission(policy, { name, arguments: {}, cwd: policy.root, actor: 'test' }).effect,
      'ask',
    );
  }
  for (const effect of ['deny', 'ask'] as const) {
    const restricted = { ...policy, rules: [{ tool: 'emergence_dispatch', effect }] };
    assert.equal(
      evaluatePermission(restricted, {
        name: 'emergence_execute_plan',
        arguments: {},
        cwd: policy.root,
        actor: 'test',
      }).effect,
      effect,
    );
  }
});

class Provider extends LlmAdapter {
  async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, defaultMaxTokens: 256 };
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const index = options.messages.findLastIndex(
      (m) =>
        m.role === 'user' &&
        m.content.some((b) => b.type === 'text' && b.text.split('\n').some((l) => l.startsWith('CALL:'))),
    );
    const latest = options.messages[index];
    const text = latest?.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n') ?? '';
    const count = options.messages.slice(index + 1).filter((m) => m.role === 'tool').length;
    const analysis = options.tools?.some((t) => t.name === 'emergence_analyze') === true;
    if (count < (analysis ? 2 : 1) && text.includes('CALL:')) {
      const line = text.split('\n').find((l) => l.startsWith('CALL:'))!;
      const { name, args } =
          analysis && count === 0
            ? {
                name: 'emergence_analyze',
                args: { objective: '执行本次指定操作', reason: '单项权限检查', route: 'focused' },
              }
            : JSON.parse(line.slice(5)),
        id = ToolCallId(randomUUID()),
        raw = JSON.stringify(args);
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: raw };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: raw } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
const callText = (name: string, args: object = {}) => 'CALL:' + JSON.stringify({ name, args });
async function until(predicate: () => boolean) {
  for (let i = 0; i < 500; i++) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error('permission test timeout');
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'emergence-e2-')),
    home = join(root, 'home'),
    cwd = join(root, 'project');
  await mkdir(home);
  await mkdir(cwd);
  const config = structuredClone(defaultConfig),
    ctx = await harness(home, ['deepseek'], new Provider());
  await ctx.plugin(UserApproval);
  config.models[0].apiKeyEnv = 'E2_FIXTURE_KEY';
  process.env.E2_FIXTURE_KEY = 'local-only-fixture';
  const calls: string[] = [];
  let release = () => {};
  let slow = Promise.resolve();
  for (const name of ['write', 'read', 'pwsh', 'mcp__fixture__effect'])
    ctx.effect(() =>
      ctx.tools.register(
        defineTool({
          name,
          description: 'inert permission fixture',
          parameters: {
            file_path: { type: 'string' },
            content: { type: 'string' },
            command: { type: 'string' },
          },
          output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
          async execute(args) {
            calls.push(name);
            if (args.command === 'slow') await slow;
            return 'executed';
          },
        }),
      ),
    );
  const controller = new SessionController(ctx, { home, cwd, modelId: 'deepseek', appConfig: config });
  await controller.open();
  const start = (name: string, args = {}, target = controller.agent) => {
    target.followup(
      createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: callText(name, args) }],
      }),
    );
  };
  return {
    root,
    home,
    cwd,
    ctx,
    config,
    controller,
    calls,
    start,
    hold() {
      slow = new Promise<void>((r) => {
        release = r;
      });
    },
    release() {
      release();
    },
    async run(name: string, args = {}) {
      start(name, args);
      await controller.agent.whenIdle();
    },
    async close() {
      release();
      await controller.close();
      await ctx.fiber.dispose();
    },
  };
}

test('mode matrix, explicit deny/ask precedence, unknown tools and exact command rules', async () => {
  const root = await mkdtemp(join(tmpdir(), 'emergence-policy-'));
  const p: PermissionSnapshot = { mode: 'plan', root, rules: [], deny: [], confirm: [] };
  const c = (name: string, args: object = {}) => ({ name, arguments: args, cwd: root, actor: 'a' });
  assert.equal(evaluatePermission(p, c('read', { file_path: 'x' })).effect, 'allow');
  for (const tool of ['write', 'pwsh', 'subagent', 'emergence_dispatch', 'mcp__unknown'])
    assert.equal(evaluatePermission(p, c(tool)).effect, 'deny');
  p.mode = 'ask';
  assert.equal(evaluatePermission(p, c('write', { file_path: 'x' })).effect, 'ask');
  p.mode = 'edit';
  assert.equal(evaluatePermission(p, c('write', { file_path: 'x' })).effect, 'allow');
  assert.equal(evaluatePermission(p, c('write', { file_path: '../outside' })).effect, 'ask');
  p.mode = 'auto';
  p.rules = [{ tool: 'pwsh', effect: 'allow', command: 'npm test' }];
  assert.equal(evaluatePermission(p, c('pwsh', { command: 'npm test' })).effect, 'allow');
  assert.equal(evaluatePermission(p, c('pwsh', { command: 'npm test; whoami' })).effect, 'ask');
  assert.equal(evaluatePermission(p, c('mcp__unknown')).effect, 'ask');
  p.rules.push({ tool: 'pwsh', effect: 'ask' });
  assert.equal(evaluatePermission(p, c('pwsh', { command: 'npm test' })).explicitAsk, true);
  p.deny = ['pw*'];
  assert.equal(evaluatePermission(p, c('pwsh', { command: 'npm test' })).effect, 'deny');
  assert.equal(
    evaluatePermissions(
      [
        { ...p, mode: 'edit', deny: [] },
        { ...p, mode: 'plan' },
      ],
      c('write', { file_path: 'x' }),
    ).effect,
    'deny',
  );
});

test('canonical paths catch junction escapes, siblings, device streams and fingerprint physical destinations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'emergence-path-')),
    project = join(root, 'project'),
    outside = join(root, 'project-other');
  await mkdir(project);
  await mkdir(outside);
  await symlink(outside, join(project, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  const p: PermissionSnapshot = { mode: 'edit', root: project, rules: [], deny: [], confirm: [] };
  const c = { name: 'write', arguments: { file_path: 'link/new/deep.txt' }, cwd: project, actor: 'a' };
  assert.equal(evaluatePermission(p, c).effect, 'ask');
  assert.notEqual(callFingerprint(c), callFingerprint({ ...c, actor: 'b' }));
  p.rules.push({ tool: 'write', effect: 'deny', path: outside.replaceAll('\\', '/') + '/**' });
  assert.equal(evaluatePermission(p, c).effect, 'deny');
  if (process.platform === 'win32')
    for (const file_path of ['file.txt:stream', 'NUL', '\\\\?\\C:\\x'])
      assert.equal(evaluatePermission(p, { ...c, arguments: { file_path } }).effect, 'deny');
});

test('real Harness enforces plan, ask, edit, auto and model capability in final guard', async () => {
  const f = await fixture();
  try {
    f.controller.setPermissionMode('plan');
    await f.run('write', { file_path: 'x' });
    await f.run('pwsh', { command: 'x' });
    assert.deepEqual(f.calls, []);
    await f.run('read', { file_path: 'x' });
    assert.deepEqual(f.calls, ['read']);
    f.controller.setPermissionMode('ask');
    f.start('write', { file_path: 'x' });
    await until(() => !!f.controller.pending);
    f.controller.pending!.respond('y');
    await f.controller.agent.whenIdle();
    f.controller.setPermissionMode('edit');
    await f.run('write', { file_path: 'x' });
    assert.equal(f.calls.filter((n) => n === 'write').length, 2);
    f.config.permissions.rules.push({ tool: 'pwsh', effect: 'allow', command: 'exact' });
    f.controller.setPermissionMode('auto');
    await f.run('pwsh', { command: 'exact' });
    f.config.toolPolicy.deny.push('pwsh');
    await f.run('pwsh', { command: 'exact' });
    assert.equal(f.calls.filter((n) => n === 'pwsh').length, 1);
    f.config.models[0].capabilities = { tools: false };
    await f.run('read', { file_path: 'x' });
    assert.equal(f.calls.filter((n) => n === 'read').length, 1);
  } finally {
    await f.close();
  }
});

test('session grants are exact, actor-local, revocable, not persisted, and cannot override explicit ask', async () => {
  const f = await fixture();
  try {
    const args = { command: 'identical' };
    f.start('pwsh', args);
    await until(() => !!f.controller.pending);
    f.controller.pending!.respond('s');
    await f.controller.agent.whenIdle();
    await f.run('pwsh', args);
    assert.equal(f.calls.length, 2);
    f.start('pwsh', { command: 'different' });
    await until(() => !!f.controller.pending);
    f.controller.pending!.respond('n');
    await f.controller.agent.whenIdle();
    assert.equal(f.calls.length, 2);
    f.config.toolPolicy.confirm.push('pwsh');
    f.start('pwsh', args);
    await until(() => !!f.controller.pending);
    assert.ok(!f.controller.pending!.options.some((o) => o.id === 'session'));
    f.controller.pending!.respond('n');
    await f.controller.agent.whenIdle();
    f.config.toolPolicy.confirm = [];
    const child = await f.ctx.agents.create({
      parentAgent: f.controller.agent,
      sessionId: SessionId(randomUUID()),
      meta: { cwd: f.cwd },
      agentOptions: { provider: 'deepseek', model: 'deepseek-flash' },
    });
    f.start('pwsh', args, child.agent);
    await until(() => !!f.controller.pending);
    f.controller.pending!.respond('n');
    await child.agent.whenIdle();
    await child.dispose();
    f.controller.setPermissionMode('ask');
    f.start('pwsh', args);
    await until(() => !!f.controller.pending);
    const stale = f.controller.pending!;
    f.controller.setPermissionMode('auto');
    await f.controller.agent.whenIdle();
    assert.throws(() => stale.respond('y'), /过期/);
    assert.equal(f.calls.length, 2);
    await f.controller.open();
    f.start('pwsh', args);
    await until(() => !!f.controller.pending);
    f.controller.pending!.respond('n');
    await f.controller.agent.whenIdle();
    assert.equal(f.calls.length, 2);
  } finally {
    await f.close();
  }
});

test('mode changes while a tool runs expose transition and cannot auto-approve pending work', async () => {
  const f = await fixture();
  try {
    f.hold();
    f.start('pwsh', { command: 'slow' });
    await until(() => !!f.controller.pending);
    f.controller.pending!.respond('y');
    await until(() => f.calls.length === 1);
    const session = f.controller.id;
    f.controller.setPermissionMode('plan');
    assert.equal(f.controller.permissionTransitioning, true);
    assert.equal(f.controller.id, session);
    f.release();
    await f.controller.agent.whenIdle();
    assert.equal(f.controller.permissionTransitioning, false);
    await f.run('write', { file_path: 'x' });
    assert.deepEqual(f.calls, ['pwsh']);
    assert.ok(f.controller.transcript().some((line) => line.includes('slow')));
  } finally {
    await f.close();
  }
});

test('owned children inherit plan and an allow middleware cannot bypass the final guard', async () => {
  const f = await fixture();
  try {
    f.controller.setPermissionMode('plan');
    const child = await f.ctx.agents.create({
      parentAgent: f.controller.agent,
      sessionId: SessionId(randomUUID()),
      meta: { cwd: f.cwd },
      agentOptions: { provider: 'deepseek', model: 'deepseek-flash' },
    });
    const dispose = f.ctx.on('tools/pre-execute', async () => ({ kind: 'allow' as const }));
    f.start('write', { file_path: 'x' }, child.agent);
    await child.agent.whenIdle();
    assert.equal(f.calls.length, 0);
    dispose();
    await child.dispose();
  } finally {
    await f.close();
  }
});

test('tasks capture session permission ceiling, changes revoke own and child approval, pane modes survive restore', async () => {
  const f = await fixture();
  await f.controller.close();
  let w = new WorkspaceController(f.ctx, {
    home: f.home,
    cwd: f.cwd,
    modelId: 'deepseek',
    fresh: true,
    appConfig: f.config,
  });
  try {
    await w.initialize();
    const a = w.current,
      b = await w.split('row');
    a.controller!.setPermissionMode('auto');
    b.controller!.setPermissionMode('plan');
    await assert.rejects(w.taskEngine.enqueue(b.id, b.id, 'plan', 'work'), /计划模式/);
    b.controller!.setPermissionMode('ask');
    const task = await w.taskEngine.enqueue(b.id, b.id, 'ask', callText('write', { file_path: 'x' }));
    assert.equal(task.permission!.mode, 'ask');
    await until(() => !!b.controller!.pending);
    assert.equal(f.calls.length, 0);
    const child = await f.ctx.agents.create({
      parentAgent: b.controller!.agent,
      sessionId: SessionId(randomUUID()),
      meta: { cwd: f.cwd },
      agentOptions: { provider: 'deepseek', model: 'deepseek-flash' },
    });
    const stale = b.controller!.pending!;
    b.controller!.setPermissionMode('plan');
    await b.controller!.agent.whenIdle();
    assert.equal(b.controller!.pending, undefined);
    assert.throws(() => stale.respond('y'), /过期/);
    assert.equal(f.calls.length, 0);
    f.start('write', { file_path: 'late-child.txt' }, child.agent);
    await child.agent.whenIdle();
    assert.equal(f.calls.length, 0);
    await child.dispose();
    await w.save();
    const saved = JSON.parse(await readFile(w.path, 'utf8'));
    assert.deepEqual(
      saved.panes.map((p: { permissionMode: string }) => p.permissionMode),
      ['auto', 'plan'],
    );
    await w.close();
    w = new WorkspaceController(f.ctx, {
      home: f.home,
      cwd: f.cwd,
      modelId: 'deepseek',
      appConfig: f.config,
    });
    await w.initialize();
    assert.deepEqual(
      [...w.panes.values()].map((p) => p.controller?.permissionMode),
      ['auto', 'plan'],
    );
  } finally {
    await w.close();
    await f.close();
  }
});

test('old config backup and legacy custom Shift+Tab binding are preserved', async () => {
  const root = await mkdtemp(join(tmpdir(), 'emergence-e2-config-'));
  const { permissions: _, ...legacy } = defaultConfig;
  const config = configSchema.parse(legacy);
  assert.equal(config.permissions.defaultMode, 'edit');
  const { writeFile } = await import('node:fs/promises');
  const raw = JSON.stringify(legacy);
  await writeFile(join(root, 'config.json'), raw);
  const migration = await migrateConfig(root);
  assert.equal(await readFile(migration.backup!, 'utf8'), raw);
  assert.equal((await loadConfig(root)).permissions.defaultMode, 'edit');
  const ui = uiSchema.parse({ keys: { previous: 'Shift+Tab' } });
  assert.equal(effectiveKeys(ui).previous, 'Shift+Tab');
  assert.equal(effectiveKeys(ui).cyclePermission, 'F5');
  assert.equal(keyAction(uiSchema.parse({}), { name: 'tab', shift: true }), 'cyclePermission');
});
