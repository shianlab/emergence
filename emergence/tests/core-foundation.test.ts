import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { WorkspaceController } from '../src/app/workspace.ts';
import { loadCoreCatalog } from '../src/core/adapters/catalog.ts';
import { CoreObserver } from '../src/core/application/observer.ts';
import { catalogJson } from '../src/core/assets/catalog.ts';
import { configSchema, defaultConfig } from '../src/core/domain/configuration.ts';
import {
  catalogSchema,
  comparePermission,
  observationSnapshotSchema,
  type ObservationSnapshot,
} from '../src/core/domain/contracts.ts';
import { FileObservationStore } from '../src/core/storage/observation-store.ts';
import { harness } from './fixtures/harness.ts';

test('core catalog binds frozen role definitions and both workflows to preserved upstream bytes', async () => {
  const catalog = loadCoreCatalog();
  assert.equal(catalog.roles.length, 9);
  assert.equal(catalog.stages.length, 8);
  assert.equal(catalog.businessPhases.length, 11);
  assert.ok(catalog.roles.every((r) => r.executionAuthority === false));
  assert.throws(() => {
    catalog.roles[0].name = 'changed';
  });
  for (const ref of catalog.sourceAssets)
    assert.equal(
      createHash('sha256')
        .update(await readFile(resolve('vendor/meta-kim', ref.path)))
        .digest('hex'),
      ref.sha256,
    );
  const inventory = JSON.parse(await readFile('../docs/meta-kim-source-inventory.json', 'utf8'));
  assert.equal(inventory.files.length, 1073);
  assert.equal(new Set(inventory.files.map((f: { path: string }) => f.path)).size, 1073);
  assert.ok(
    inventory.files.every(
      (f: { category: string; disposition: string; targetPhase: number }) =>
        f.category && f.disposition && f.targetPhase >= 2,
    ),
  );
  const duplicate = JSON.parse(catalogJson);
  duplicate.roles[1] = duplicate.roles[0];
  assert.equal(catalogSchema.safeParse(duplicate).success, false);
  assert.throws(() => loadCoreCatalog(catalogJson + ' '), /DIGEST/);
  assert.throws(() => loadCoreCatalog('{}', createHash('sha256').update('{}').digest('hex')), /SCHEMA/);
  const legacy = structuredClone(defaultConfig) as Partial<typeof defaultConfig>;
  delete legacy.core;
  assert.equal(configSchema.parse(legacy).core.mode, 'observe');
  assert.equal(configSchema.safeParse({ ...legacy, core: { mode: 'execute' } }).success, false);
});

test('shadow invariant compares inherited plan boundaries without granting or mutating permissions', () => {
  const input = {
    modes: ['auto', 'plan'] as const,
    toolKind: 'write' as const,
    legacyDecision: 'allow' as const,
  };
  assert.deepEqual(comparePermission({ ...input, modes: [...input.modes] }), {
    shadowDecision: 'deny',
    comparison: 'disagreement',
  });
  assert.deepEqual(comparePermission({ modes: ['plan'], toolKind: 'write', legacyDecision: 'deny' }), {
    shadowDecision: 'deny',
    comparison: 'consistent',
  });
  assert.deepEqual(comparePermission({ modes: ['auto'], toolKind: 'other', legacyDecision: 'ask' }), {
    shadowDecision: 'not-assessed',
    comparison: 'not-assessed',
  });
  assert.equal(input.legacyDecision, 'allow');
});

test('observer bounds storage, isolates scopes, survives reload and leaves disabled execution unobserved', async () => {
  const root = await mkdtemp(join(tmpdir(), 'emergence-core-')),
    store = new FileObservationStore(root);
  const observer = new CoreObserver(loadCoreCatalog(), 'observe', store);
  await observer.bind('session-secret', 'private-project-path');
  for (let i = 0; i < 300; i++) observer.modelStep('actor-secret');
  observer.permissionCheck('actor-secret', 'secret-command', {
    modes: ['plan'],
    toolKind: 'write',
    legacyDecision: 'deny',
  });
  await observer.settle();
  const snapshot = observer.inspect().snapshot!;
  assert.equal(snapshot.events.length, 128);
  assert.equal(snapshot.lastSequence, 302);
  assert.ok(snapshot.events.some((e) => e.comparison === 'consistent'));
  const path = join(root, 'core/observations', snapshot.scopeKey + '.json'),
    bytes = await readFile(path, 'utf8');
  for (const secret of ['session-secret', 'private-project-path', 'actor-secret', 'secret-command'])
    assert.ok(!bytes.includes(secret));
  const resumed = new CoreObserver(loadCoreCatalog(), 'observe', store);
  await resumed.bind('session-secret', 'private-project-path');
  assert.equal(resumed.inspect().snapshot?.lastSequence, 303);
  await resumed.close();
  await observer.setMode('off');
  const before = await readFile(path, 'utf8');
  observer.modelStep('ignored');
  await observer.settle();
  assert.equal(await readFile(path, 'utf8'), before);
  await observer.bind('another', 'other-project');
  assert.equal(observer.inspect().snapshot?.lastSequence, 0);
  assert.equal((await readdir(join(root, 'core/observations'))).length, 1);
  await observer.close();
});

test('corrupt snapshots and unsafe storage paths do not overwrite evidence or break the observer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'emergence-core-fault-')),
    store = new FileObservationStore(root);
  const one = new CoreObserver(loadCoreCatalog(), 'observe', store);
  await one.bind('s', 'p');
  await one.close();
  const path = join(root, 'core/observations', one.inspect().snapshot!.scopeKey + '.json');
  await writeFile(path, '{corrupted');
  const two = new CoreObserver(loadCoreCatalog(), 'observe', store);
  await two.bind('s', 'p');
  two.modelStep('a');
  await two.close();
  assert.equal(two.inspect().diagnostic, 'CORE_STORE_READ_FAILED');
  assert.equal(await readFile(path, 'utf8'), '{corrupted');
  const outside = await mkdtemp(join(tmpdir(), 'emergence-core-outside-')),
    linked = await mkdtemp(join(tmpdir(), 'emergence-core-link-'));
  await symlink(outside, join(linked, 'core'), process.platform === 'win32' ? 'junction' : 'dir');
  const three = new CoreObserver(loadCoreCatalog(), 'observe', new FileObservationStore(linked));
  await three.bind('s', 'p');
  three.modelStep('a');
  await three.close();
  assert.ok(three.inspect().diagnostic);
  assert.deepEqual(await readdir(outside), []);
  assert.equal(
    observationSnapshotSchema.safeParse({ ...one.inspect().snapshot, extra: 'raw prompt' }).success,
    false,
  );
});

test('coalesced writes drain on close; storage failure and invalid assets remain diagnostic only', async () => {
  const saved: ObservationSnapshot[] = [];
  let release: (() => void) | undefined;
  const o = new CoreObserver(loadCoreCatalog(), 'observe', {
    async read() {
      return undefined;
    },
    async write(s) {
      if (!saved.length)
        await new Promise<void>((r) => {
          release = r;
        });
      saved.push(s);
    },
  });
  await o.bind('s', 'p');
  o.modelStep('a');
  o.idle('a');
  release!();
  await o.close();
  assert.equal(saved.at(-1)!.lastSequence, 3);
  const failed = new CoreObserver(loadCoreCatalog(), 'observe', {
    async read() {
      return undefined;
    },
    async write() {
      throw new Error('secret');
    },
  });
  await failed.bind('s', 'p');
  await failed.close();
  assert.equal(failed.inspect().diagnostic, 'CORE_STORE_WRITE_FAILED');
  assert.ok(!failed.describe().includes('secret'));
  const unavailable = new CoreObserver(
    undefined,
    'observe',
    {
      async read() {
        throw Error('must not read');
      },
      async write() {
        throw Error('must not write');
      },
    },
    'CORE_ASSET_INVALID',
  );
  await unavailable.bind('s', 'p');
  unavailable.modelStep('a');
  await unavailable.close();
  assert.equal(unavailable.inspect().snapshot?.lastSequence, 0);
  assert.ok(unavailable.describe().includes('CORE_ASSET_INVALID'));
});

test('actual Harness observer records plan denial; off mode preserves requests, permissions and session switching', async () => {
  const root = await mkdtemp(join(tmpdir(), 'emergence-core-harness-')),
    cwd = join(root, 'project');
  await mkdir(cwd);
  const captured: Array<Array<Pick<GenerateOptions['messages'][number], 'role' | 'content'>>> = [];
  let writes = 0;
  class Provider extends LlmAdapter {
    async resolveModel(provider: string, model: string) {
      return { provider, id: model, name: model, defaultMaxTokens: 256 };
    }
    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      captured.push(options.messages.map((m) => ({ role: m.role, content: m.content })));
      if (!options.messages.some((m) => m.role === 'tool')) {
        const id = ToolCallId('core-test-write'),
          args = JSON.stringify({ file_path: join(cwd, 'blocked.txt'), content: 'TOOL_ARGUMENT_SECRET' });
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'tool-call-delta', index: 0, id, name: 'write', argumentsDelta: args };
        yield {
          type: 'block-end',
          index: 0,
          block: { type: 'tool-call', id, name: 'write', arguments: args },
        };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'done' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  const ctx = await harness(root, ['deepseek'], new Provider()),
    config = structuredClone(defaultConfig);
  config.permissions.defaultMode = 'plan';
  config.models[0].apiKeyEnv = 'CORE_FOUNDATION_KEY';
  const before = process.env.CORE_FOUNDATION_KEY;
  process.env.CORE_FOUNDATION_KEY = 'local';
  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'write',
        description: 'test',
        parameters: { file_path: { type: 'string' }, content: { type: 'string' } },
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
        async execute() {
          writes++;
          return 'unexpected';
        },
      }),
    ),
  );
  const w = new WorkspaceController(ctx, { home: root, cwd, modelId: 'deepseek', appConfig: config });
  try {
    await w.initialize();
    const c = w.current.controller!;
    await w.send(w.focused, 'PROMPT_SECRET');
    await c.agent.whenIdle();
    await c.core.settle();
    assert.equal(writes, 0);
    assert.ok(
      c.core
        .inspect()
        .snapshot!.events.some((e) => e.comparison === 'consistent' && e.legacyDecision === 'deny'),
    );
    const first = captured[0];
    await w.send(w.focused, '/core roles');
    assert.ok(w.overlay.includes('记忆管理'));
    assert.equal(captured.length, 2);
    await w.send(w.focused, '/core off');
    assert.equal(c.core.mode, 'off');
    await w.send(w.focused, '/new');
    await w.send(w.focused, 'PROMPT_SECRET');
    await c.agent.whenIdle();
    assert.equal(writes, 0);
    // Core state is now an explicit live runtime fact. Only that context may change.
    const withoutRuntime = (messages: typeof first) =>
      messages.map((m) => ({
        ...m,
        content: m.content.map((b) =>
          b.type === 'text'
            ? {
                ...b,
                text: b.text.replace(
                  /你是涌现 Emergence，运行于 Emergence Harness。[\s\S]*?(?=Emergence permission mode:)/,
                  '',
                ),
              }
            : b,
        ),
      }));
    assert.deepEqual(withoutRuntime(captured[2]), withoutRuntime(first));
    assert.ok(JSON.stringify(captured[2]).includes('\\"enabled\\":false'));
    assert.equal(c.core.inspect().snapshot?.lastSequence, 0);
    await w.send(w.focused, '/core observe');
    assert.equal(c.core.mode, 'observe');
    const logs = (
      await Promise.all(
        (await readdir(join(root, 'core/observations'))).map((file) =>
          readFile(join(root, 'core/observations', file), 'utf8'),
        ),
      )
    ).join('');
    assert.ok(!logs.includes('PROMPT_SECRET'));
    assert.ok(!logs.includes('TOOL_ARGUMENT_SECRET'));
    assert.equal(c.permissionMode, 'plan');
  } finally {
    await w.close();
    await ctx.fiber.dispose();
    if (before === undefined) delete process.env.CORE_FOUNDATION_KEY;
    else process.env.CORE_FOUNDATION_KEY = before;
  }
});
