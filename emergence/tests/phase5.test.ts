import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig, saveConfig } from '../src/app/config.ts';
import { inspector } from '../src/app/extensions.ts';
import { readTemplate, templateSchema } from '../src/app/templates.ts';
import { WorkspaceController } from '../src/app/workspace.ts';
import { configSchema, defaultConfig } from '../src/core/domain/configuration.ts';
import { keyAction, uiSchema } from '../src/core/domain/ui-preferences.ts';
import { harness } from './fixtures/harness.ts';

class Provider extends LlmAdapter {
  async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, defaultMaxTokens: 512 };
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const start = options.messages.findLastIndex(
      (m) => m.role === 'user' && /use-extension|use-write/.test(JSON.stringify(m.content)),
    );
    const text = JSON.stringify(options.messages[start]);
    const target = text?.includes('use-extension')
      ? 'ext_inspector_project_info'
      : text?.includes('use-write')
        ? 'proof_write'
        : undefined;
    const count = options.messages.slice(start + 1).filter((m) => m.role === 'tool').length;
    if (target && count < 2) {
      const name = count === 0 ? 'emergence_analyze' : target;
      const id = ToolCallId('phase5-' + Date.now()),
        raw = JSON.stringify(
          count === 0
            ? { objective: '执行本轮指定扩展工具', reason: '单项扩展集成检查', route: 'focused' }
            : {},
        );
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: raw };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: raw } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: 'PHASE5_DONE' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'PHASE5_DONE' } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'emergence-phase5-')),
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
    apiKeyEnv: 'PHASE5_KEY',
  }));
  config.permissions = {
    defaultMode: 'auto',
    rules: ['proof_write', 'ext_inspector_project_info'].map((tool) => ({ tool, effect: 'allow' })),
  };
  await saveConfig(home, config);
  process.env.PHASE5_KEY = 'fixture-credential';
  const ctx = await harness(home, ['one', 'two'], new Provider());
  const w = new WorkspaceController(ctx, { home, cwd: a, modelId: 'one', fresh: true, appConfig: config });
  await w.initialize();
  return {
    root,
    home,
    a,
    b,
    ctx,
    w,
    async close() {
      await w.close();
      assert.equal(ctx.agents.list().length, 0);
      await ctx.fiber.dispose();
    },
  };
}
async function run(w: WorkspaceController, message: string) {
  await w.send(w.focused, message);
  await delay(15);
  await w.current.controller!.agent.whenIdle();
}

test('old config migrates with safe defaults; key collisions and malformed templates are rejected', () => {
  const { ui: _, extensions: __, toolPolicy: ___, ...legacy } = defaultConfig;
  const parsed = configSchema.parse(legacy);
  assert.equal(parsed.ui.theme, 'dark');
  assert.deepEqual(parsed.toolPolicy, { deny: [], confirm: [] });
  assert.throws(() => uiSchema.parse({ keys: { close: 'F2' } }), /冲突/);
  assert.throws(() => uiSchema.parse({ keys: { close: 'Ctrl+C' } }));
  assert.equal(keyAction(uiSchema.parse({ keys: { close: 'f10' } }), { name: 'f10' }), 'close');
  assert.throws(() =>
    templateSchema.parse({
      version: 1,
      name: '../escape',
      focused: 'a',
      layout: { kind: 'pane', pane: 'a' },
      panes: [{ id: 'a', cwd: '.', modelId: 'one' }],
      roles: { workers: [] },
    }),
  );
});

test('templates recreate independent projects/models, archive drafts and roll back staging failures', async () => {
  const f = await fixture(),
    w = f.w;
  try {
    const first = w.focused;
    await w.split('row', f.b, 'two');
    const second = w.focused;
    w.updateView(first, '保留草稿', 0);
    await w.send(second, '/template save dual');
    const template = await readTemplate(f.home, 'dual');
    assert.equal(JSON.stringify(template).includes('sessionId'), false);
    assert.equal(JSON.stringify(template).includes('保留草稿'), false);
    const previous = [...w.panes.values()].map((p) => p.sessionId);
    await w.send(second, '/template load dual');
    assert.deepEqual(
      [...w.panes.values()].map((p) => [p.cwd, p.modelId]),
      [
        [f.a, 'one'],
        [f.b, 'two'],
      ],
    );
    assert.ok([...w.panes.values()].every((p) => !previous.includes(p.sessionId)));
    assert.equal('master' in w.taskEngine.state, false);
    assert.equal(w.taskEngine.state.paused, false);
    assert.equal('master' in w.taskEngine.state, false);
    const archive = (await readdir(join(f.home, 'workspaces'))).find((n) => n.includes('.before-template-'))!;
    assert.match(await readFile(join(f.home, 'workspaces', archive), 'utf8'), /保留草稿/);
    const ids = [...w.panes.values()].map((p) => p.sessionId),
      bad = structuredClone(template);
    bad.panes[1].cwd = join(f.root, 'missing');
    await assert.rejects(w.applyTemplate(bad));
    assert.deepEqual(
      [...w.panes.values()].map((p) => p.sessionId),
      ids,
    );
    assert.equal(f.ctx.agents.list().length, 2);
  } finally {
    await f.close();
  }
});

test('preferences persist without replacing other routes; incompatible model switching preserves history', async () => {
  const f = await fixture(),
    w = f.w;
  try {
    await w.send(w.focused, '/theme amber');
    await w.send(w.focused, '/bind close F10');
    await w.send(w.focused, '/language en');
    assert.equal((await loadConfig(f.home)).ui.theme, 'amber');
    assert.equal(w.launch.appConfig.models.length, 2);
    let calls = 0;
    f.ctx.effect(() =>
      f.ctx.tools.register(
        defineTool({
          name: 'proof_write',
          description: 'fixture',
          parameters: {},
          output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
          execute: async () => {
            calls++;
            return 'wrote';
          },
        }),
      ),
    );
    await w.send(w.focused, '/permissions deny proof_*');
    await run(w, 'use-write');
    assert.equal(calls, 0);
    assert.match(w.current.controller!.transcript().join('\n'), /禁止/);
    await w.send(w.focused, '/permissions allow proof_*');
    await run(w, 'use-write');
    assert.equal(calls, 1);
    const controller = w.current.controller!,
      events = controller.agent.session.snapshotEvents().length;
    controller.launch.appConfig.models[1].capabilities = { tools: false };
    await assert.rejects(w.send(w.focused, '/model two'), /历史/);
    assert.equal(controller.model.id, 'one');
    assert.equal(controller.agent.session.snapshotEvents().length, events);
    await w.send(w.focused, '/context note "下一轮仅检查文档"');
    assert.equal(controller.busy, false);
    assert.match(JSON.stringify(controller.agent.inbox.nextStep), /下一轮仅检查文档/);
  } finally {
    await f.close();
  }
});

test('real extension command/panel/tool works; disabling removes registrations and aborts active jobs', async () => {
  const f = await fixture(),
    w = f.w;
  try {
    await w.send(w.focused, '/extensions enable inspector');
    await w.send(w.focused, '/x_inspector_project');
    assert.match(w.overlay, /项目 A/);
    await w.send(w.focused, '/panel inspector.project');
    assert.match(w.overlay, /entries/);
    await run(w, 'use-extension');
    assert.match(w.current.controller!.transcript().join('\n'), /uptimeSeconds/);
    await w.send(w.focused, '/extensions disable inspector');
    assert.equal(
      f.ctx.tools
        .definitions(w.current.controller!.agent)
        .some((t) => t.name === 'ext_inspector_project_info'),
      false,
    );
    await assert.rejects(w.extensions.panel('inspector.project', w.focused), /不存在/);
    let cleaned = 0,
      aborted = false,
      started = false;
    await w.extensions.enable(
      { id: 'probe', module: 'fixture', enabled: true },
      {
        activate(api) {
          api.effect(() => () => {
            cleaned++;
          });
          api.command('wait', async (_args, _pane, signal) => {
            started = true;
            try {
              await delay(60000, undefined, { signal });
              return 'late';
            } finally {
              aborted = signal.aborted;
            }
          });
        },
      },
    );
    const job = w.extensions.command('/x_probe_wait', [], w.focused);
    const rejected = assert.rejects(job);
    for (let i = 0; !started && i < 50; i++) await delay(5);
    await w.extensions.disable('probe');
    await rejected;
    assert.equal(cleaned, 1);
    assert.equal(aborted, true);
    await assert.rejects(
      w.extensions.enable(
        { id: 'broken', module: 'fixture', enabled: true },
        {
          activate(api) {
            api.effect(() => () => {
              cleaned++;
            });
            api.tool('temp', 'fixture', {}, () => ({}));
            throw new Error('activation failed');
          },
        },
      ),
      /activation failed/,
    );
    assert.equal(cleaned, 2);
    assert.equal(
      f.ctx.tools.definitions(w.current.controller!.agent).some((t) => t.name === 'ext_broken_temp'),
      false,
    );
    let lateCleanup = false;
    const enabling = w.extensions.enable(
      { id: 'late', module: 'fixture', enabled: true },
      {
        async activate(api) {
          await new Promise<void>((done) =>
            api.signal.addEventListener('abort', () => done(), { once: true }),
          );
          return () => {
            lateCleanup = true;
          };
        },
      },
    );
    const activationRejected = assert.rejects(enabling);
    await w.extensions.disable('late');
    await activationRejected;
    assert.equal(lateCleanup, true);
    await w.extensions.enable({ id: 'again', module: 'builtin:inspector', enabled: true }, inspector);
    await w.extensions.disable('again');
  } finally {
    await f.close();
  }
});

test('MCP fibers publish actual tools, survive one failed server, release names on disable and can reconnect', async () => {
  const f = await fixture(),
    w = f.w;
  try {
    const proof = {
      serverName: 'proof5',
      transport: 'stdio' as const,
      command: process.execPath,
      args: [resolve('tests/fixtures/mcp.cjs')],
      enabled: true,
    };
    w.launch.appConfig.mcp.push(proof);
    await w.capabilities.enable(proof);
    assert.ok(
      f.ctx.tools.definitions(w.current.controller!.agent).some((t) => t.name === 'mcp__proof5__echo'),
    );
    await assert.rejects(
      w.capabilities.enable({
        ...proof,
        serverName: 'broken5',
        command: 'emergence-fixture-missing-command',
      }),
    );
    assert.ok(
      f.ctx.tools.definitions(w.current.controller!.agent).some((t) => t.name === 'mcp__proof5__echo'),
    );
    await w.capabilities.disable('proof5');
    assert.equal(
      f.ctx.tools.definitions(w.current.controller!.agent).some((t) => t.name === 'mcp__proof5__echo'),
      false,
    );
    await w.capabilities.enable(proof);
    assert.match(w.capabilities.describe(), /proof5 · active/);
  } finally {
    await f.close();
  }
});

test('an external ESM extension loads by explicit absolute path and persists its enabled state', async () => {
  const f = await fixture(),
    w = f.w;
  try {
    await writeFile(join(f.a, 'README.md'), '# Project notes');
    await w.send(w.focused, `/extensions add notes "${resolve('examples/project-notes.mjs')}"`);
    await w.send(w.focused, '/extensions enable notes');
    await w.send(w.focused, '/x_notes_summary');
    assert.match(w.overlay, /README.md/);
    await w.send(w.focused, '/panel notes.summary');
    assert.match(w.overlay, /项目 A/);
    assert.equal((await loadConfig(f.home)).extensions.find((e) => e.id === 'notes')?.enabled, true);
    await w.send(w.focused, '/extensions disable notes');
    assert.equal((await loadConfig(f.home)).extensions.find((e) => e.id === 'notes')?.enabled, false);
  } finally {
    await f.close();
  }
});
