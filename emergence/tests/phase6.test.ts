import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig, migrateConfig, saveConfig } from '../src/app/config.ts';
import { SessionController } from '../src/app/controller.ts';
import { diagnose, formatDiagnosis } from '../src/app/doctor.ts';
import { checkDataRuntime } from '../src/app/runtime-health.ts';
import { cleanStaleProfiles } from '../src/app/profiles.ts';
import { WorkspaceController } from '../src/app/workspace.ts';
import { defaultConfig } from '../src/core/domain/configuration.ts';
import { harness } from './fixtures/harness.ts';

class Provider extends LlmAdapter {
  async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, defaultMaxTokens: 512 };
  }
  async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: 'retained response' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'retained response' } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
test('explicit configuration migration preserves exact backups, history and unknown/corrupt configurations', async () => {
  const home = await mkdtemp(join(tmpdir(), 'emergence-migration-'));
  const { ui: _, toolPolicy: __, extensions: ___, ...legacy } = defaultConfig;
  const original = JSON.stringify(legacy, null, 4);
  await writeFile(join(home, 'config.json'), original);
  await writeFile(join(home, 'history-sentinel'), 'preserve');
  const result = await migrateConfig(home);
  assert.equal(result.changed, true);
  assert.equal(await readFile(result.backup!, 'utf8'), original);
  assert.equal((await loadConfig(home)).ui.theme, 'dark');
  assert.equal((await migrateConfig(home)).changed, false);
  assert.equal(await readFile(join(home, 'history-sentinel'), 'utf8'), 'preserve');
  for (const raw of ['{broken', JSON.stringify({ ...defaultConfig, version: 99 })]) {
    await writeFile(join(home, 'config.json'), raw);
    await assert.rejects(migrateConfig(home));
    assert.equal(await readFile(join(home, 'config.json'), 'utf8'), raw);
  }
});
test('doctor is read-only and never decrypts or prints credential data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'emergence-doctor-')),
    missing = join(root, 'not-created');
  const fresh = await diagnose(missing, root);
  assert.equal(fresh.ok, true);
  await assert.rejects(access(missing));
  await saveConfig(root, defaultConfig);
  const opaque = JSON.stringify({ version: 1, encrypted: 'OPAQUE_DOCTOR_SENTINEL' });
  await writeFile(join(root, 'credentials.dpapi.json'), opaque);
  const report = await diagnose(root, root);
  assert.equal(report.ok, true);
  assert.equal(JSON.stringify(report).includes('OPAQUE_DOCTOR_SENTINEL'), false);
  assert.equal(formatDiagnosis(report).includes('OPAQUE_DOCTOR_SENTINEL'), false);
  assert.match(formatDiagnosis(report), /版本管理（可选）/);
  assert.equal(report.checks.find((check) => check.name === 'git')?.status, 'warning');
  assert.equal(await readFile(join(root, 'credentials.dpapi.json'), 'utf8'), opaque);
  assert.match(report.models[0].credential, /environment|unverified/);
  const file = join(root, 'file.txt');
  await writeFile(file, 'not a directory');
  assert.equal((await diagnose(root, file)).ok, false);
  await writeFile(join(root, 'config.json'), '{broken');
  assert.equal((await diagnose(root, root)).ok, false);
});
test('missing data Python is an actionable optional capability warning', async () => {
  const root = await mkdtemp(join(tmpdir(), 'emergence-no-python-'));
  const check = await checkDataRuntime({
    root,
    python: join(root, 'absent-python'),
    worker: join(root, 'absent-worker.py'),
    probe: join(root, 'absent-probe.py'),
    lock: join(root, 'absent-lock.json'),
  });
  assert.equal(check.status, 'warning');
  assert.match(check.detail, /scripts\/setup-data.ps1/);
  assert.match(check.detail, /编程仍可使用/);
});

test('workspace code and doctor commands inspect the selected project without a model turn or write', async () => {
  const home = await mkdtemp(join(tmpdir(), 'emergence-inspect-command-'));
  const project = join(home, 'project');
  await mkdir(project);
  const config = structuredClone(defaultConfig);
  const ctx = await harness(home, ['deepseek'], new Provider());
  const w = new WorkspaceController(ctx, { home, cwd: project, modelId: 'deepseek', appConfig: config });
  try {
    await w.initialize();
    const pane = w.current;
    const events = pane.controller!.agent.session.snapshotEvents().length;
    await w.send(pane.id, '/code');
    assert.match(w.overlay, /尚未完成验证/);
    assert.match(w.overlay, /未发现可识别的检查命令/);
    await w.send(pane.id, '/doctor');
    assert.ok(w.overlay.includes(project));
    assert.match(w.overlay, /模型配置/);
    assert.match(w.overlay, /只读诊断/);
    assert.equal(pane.controller!.agent.session.snapshotEvents().length, events);
    await assert.rejects(access(join(home, 'core/code-runs')));
    await assert.rejects(w.send(pane.id, '/code preview ../outside.txt'), /路径|权限/);
    await assert.rejects(w.send(pane.id, '/code restore file.txt'), /用法/);
  } finally {
    await w.close();
    await ctx.fiber.dispose();
  }
});
test('incremental display remains bounded without truncating history and releases a closed handle', async () => {
  const home = await mkdtemp(join(tmpdir(), 'emergence-display-')),
    config = structuredClone(defaultConfig);
  config.models[0].apiKeyEnv = 'PHASE6_UNIT_KEY';
  process.env.PHASE6_UNIT_KEY = 'local-fixture';
  const ctx = await harness(home, ['deepseek'], new Provider()),
    controller = new SessionController(ctx, { home, cwd: home, modelId: 'deepseek', appConfig: config });
  try {
    await controller.open();
    controller.displayTranscript();
    for (let i = 0; i < 130; i++) {
      await controller.send(`turn ${i}`);
      await controller.agent.whenIdle();
    }
    assert.equal(controller.displayTranscript().length, 200);
    assert.ok(controller.transcript().some((line) => line.includes('turn 0')));
    assert.deepEqual(controller.displayTranscript(), controller.transcript().slice(-200));
    const before = performance.now();
    for (let i = 0; i < 10000; i++) controller.displayTranscript();
    assert.ok(performance.now() - before < 300);
    await controller.open();
    assert.deepEqual(controller.displayTranscript(), []);
    await controller.close();
    assert.equal(ctx.agents.list().length, 0);
    assert.throws(() => controller.agent);
    assert.deepEqual(controller.displayTranscript(), []);
  } finally {
    await controller.close();
    await ctx.fiber.dispose();
  }
});
test('workspace shutdown during asynchronous MCP initialization cannot create late sessions', async () => {
  const home = await mkdtemp(join(tmpdir(), 'emergence-startup-close-')),
    config = structuredClone(defaultConfig);
  config.mcp = [
    {
      serverName: 'slow',
      transport: 'stdio',
      command: process.execPath,
      args: [resolve('tests/fixtures/mcp.cjs'), '--delay-init'],
      enabled: true,
    },
  ];
  const ctx = await harness(home, ['deepseek'], new Provider()),
    w = new WorkspaceController(ctx, { home, cwd: home, modelId: 'deepseek', appConfig: config });
  try {
    const starting = w.initialize();
    const ended = starting.then(
      () => 'started',
      () => 'cancelled',
    );
    await delay(10);
    await w.close();
    assert.equal(await ended, 'cancelled');
    assert.equal(ctx.agents.list().length, 0);
    assert.equal(w.panes.size, 0);
    assert.equal(
      ctx.tools.definitions().some((t) => t.name === 'mcp__slow__echo'),
      false,
    );
  } finally {
    await w.close();
    await ctx.fiber.dispose();
  }
});

test('stale profile recovery preserves live owners, new activations, unknown directories and diagnostic files', async () => {
  const home = await mkdtemp(join(tmpdir(), 'emergence-profile-recovery-')),
    root = join(home, 'harness/profiles');
  await mkdir(root, { recursive: true });
  const rows = [
    { cliPid: 2147483646, createdAt: Date.now() - 120000 },
    { cliPid: process.pid, createdAt: Date.now() - 120000 },
    { cliPid: 2147483646, createdAt: Date.now() },
  ];
  const paths: string[] = [];
  for (const row of rows) {
    const path = join(root, 'emergence-' + randomUUID());
    paths.push(path);
    await mkdir(path);
    await writeFile(join(path, 'lifecycle.json'), JSON.stringify({ product: 'emergence', ...row }));
    await writeFile(join(path, 'package.json'), '{}');
  }
  await writeFile(join(paths[0], 'diagnostic.txt'), 'preserve unknown file');
  const unknown = join(root, 'foreign-profile');
  await mkdir(unknown);
  await writeFile(join(unknown, 'package.json'), '{}');
  assert.equal(await cleanStaleProfiles(home), 1);
  assert.equal(await readFile(join(paths[0], 'diagnostic.txt'), 'utf8'), 'preserve unknown file');
  await assert.rejects(access(join(paths[0], 'package.json')));
  await access(join(paths[1], 'package.json'));
  await access(join(paths[2], 'package.json'));
  await access(join(unknown, 'package.json'));
});
