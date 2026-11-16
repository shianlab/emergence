import Anthropic from '@anthropic-ai/sdk';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig, saveConfig, updateConfig } from '../src/app/config.ts';
import {
  adoptHydratedCredentials,
  credentialSource,
  hydrateCredentials,
  resolveCredential,
  saveCredential,
} from '../src/app/credentials.ts';
import { modelProviders } from '../src/app/model-config-runtime.ts';
import { startModelConfiguration } from '../src/app/model-config.ts';
import {
  ModelConfiguration,
  modelConfigurationIntent,
  testModelConnection,
  windowModel,
  type ModelConfigurationHost,
} from '../src/app/model-configuration.ts';
import { modelBaseURL } from '../src/app/model-endpoint.ts';
import { modelPresets } from '../src/app/model-presets.ts';
import { configSchema, defaultConfig, modelSchema } from '../src/core/domain/configuration.ts';
import { configurationModelServer } from './fixtures/configuration-model-server.ts';

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'emergence-model-config-'));
  await saveConfig(home, structuredClone(defaultConfig));
  return home;
}
test('domestic presets fill valid complete routes, keep subscription credentials separate and cite official sources', () => {
  assert.equal(modelPresets.filter((preset) => preset.group.startsWith('国内')).length, 15);
  assert.equal(new Set(modelPresets.map((preset) => preset.id)).size, modelPresets.length);
  for (const preset of modelPresets.filter((preset) => preset.group.startsWith('国内'))) {
    const model = modelSchema.parse({
      id: preset.id,
      provider: preset.provider,
      model: preset.model,
      api: preset.api,
      baseURL: preset.baseURL,
      apiKeyEnv: preset.apiKeyEnv,
    });
    assert.ok(preset.models.includes(model.model));
    assert.equal(new URL(preset.source).protocol, 'https:');
    assert.ok(!preset.baseURL.includes('{'));
    assert.ok(preset.verified);
  }
  for (const [ordinary, subscription] of [
    ['glm-api', 'glm-coding'],
    ['kimi-api', 'kimi-coding'],
    ['minimax-api', 'minimax-plan'],
    ['bailian-api', 'bailian-coding'],
    ['ark-api', 'ark-coding'],
    ['hunyuan-api', 'tencent-coding'],
    ['qianfan-api', 'qianfan-coding'],
  ]) {
    const a = modelPresets.find((preset) => preset.id === ordinary)!,
      b = modelPresets.find((preset) => preset.id === subscription)!;
    assert.notEqual(a.apiKeyEnv, b.apiKeyEnv);
    if (ordinary !== 'minimax-api') assert.notEqual(a.baseURL, b.baseURL);
  }
});
test('old configurations default to empty window rules; model references and window slots are validated', () => {
  const { windowModels: omitted, ...old } = defaultConfig;
  const config = configSchema.parse(old);
  assert.deepEqual(config.windowModels, { slots: {} });
  config.models.push({ ...config.models[0], id: 'worker' });
  config.windowModels = { master: 'deepseek', worker: 'worker', slots: { '3': 'deepseek' } };
  assert.equal(windowModel(config, 'worker', 2), 'worker');
  assert.equal(windowModel(config, 'worker', 3), 'deepseek');
  assert.equal(windowModel(config, 'single'), 'deepseek');
  assert.equal(configSchema.safeParse({ ...config, windowModels: { worker: 'missing' } }).success, false);
  assert.equal(
    configSchema.safeParse({ ...config, windowModels: { slots: { '17': 'worker' } } }).success,
    false,
  );
});
test('only clear local requests open the configuration window', () => {
  for (const text of [
    '打开模型配置',
    '帮我配置一下模型',
    '怎么去配置模型？',
    '如何配置模型',
    '模型怎么配置啊',
    'open model settings',
  ])
    assert.ok(modelConfigurationIntent(text), text);
  for (const text of [
    '实现一个模型配置工具',
    '分析怎么配置模型的源码',
    '给这个项目配置数据库',
    '我配置的模型为何报错',
  ])
    assert.ok(!modelConfigurationIntent(text), text);
});
test('Anthropic connection tests and the actual SDK share one /v1/messages path for root and legacy inputs', async () => {
  const server = await configurationModelServer();
  try {
    for (const baseURL of [server.baseURL, server.baseURL.replace(/\/v1$/, '')]) {
      const model = {
        ...defaultConfig.models[0],
        model: 'fixture-anthropic',
        api: 'anthropic-messages' as const,
        baseURL,
      };
      assert.equal((await testModelConnection(model, 'fixture-secret-value')).ok, true);
      const config = structuredClone(defaultConfig);
      config.models = [model];
      const route = modelProviders(config)[model.id];
      assert.equal(route.baseURL, modelBaseURL(model));
      const client = new Anthropic({ apiKey: 'fixture-secret-value', baseURL: route.baseURL });
      await client.messages.create({
        model: model.model,
        max_tokens: 64,
        messages: [{ role: 'user', content: 'OK' }],
      });
    }
    assert.equal(server.calls.length, 4);
    assert.ok(server.calls.every((call) => call.path === '/v1/messages' && call.authorized));
  } finally {
    await server.close();
  }
});
test('model edits preserve unrelated settings, reject stale editors and prevent dangling default/window references', async () => {
  const home = await fixture(),
    service = new ModelConfiguration(home),
    initial = await service.state();
  await updateConfig(home, (config) => {
    config.ui.language = 'en';
  });
  const model = { ...defaultConfig.models[0], id: 'second' };
  const saved = await service.save({ revision: initial.revision, model });
  assert.equal(saved.models.length, 2);
  assert.equal((await loadConfig(home)).ui.language, 'en');
  await assert.rejects(service.save({ revision: initial.revision, model }), /其他窗口修改/);
  const defaults = await service.defaults({
    revision: saved.revision,
    defaultModel: 'deepseek',
    windowModels: { worker: 'second', slots: {} },
  });
  await assert.rejects(service.remove({ revision: defaults.revision, id: 'second' }));
  await assert.rejects(service.remove({ revision: defaults.revision, id: 'deepseek' }));
  const noReference = await service.defaults({
    revision: defaults.revision,
    defaultModel: 'deepseek',
    windowModels: { slots: {} },
  });
  const removed = await service.remove({ revision: noReference.revision, id: 'second' });
  assert.equal(removed.models.length, 1);
});
test('runtime failures roll back only model fields and busy window edits never reach disk', async () => {
  const home = await fixture();
  let locked = false,
    released = false;
  const host: ModelConfigurationHost = {
    windows: () => [],
    beginChange() {
      if (locked) throw new Error('busy');
      return () => {
        released = true;
      };
    },
    validate() {},
    async apply() {
      await updateConfig(home, (config) => {
        config.ui.language = 'en';
      });
      throw new Error('runtime route failure');
    },
    async assign() {},
  };
  const service = new ModelConfiguration(home, host),
    initial = await service.state();
  await assert.rejects(
    service.save({ revision: initial.revision, model: { ...defaultConfig.models[0], id: 'new' } }),
    /runtime route failure/,
  );
  assert.equal(released, true);
  assert.equal((await loadConfig(home)).models.length, 1);
  assert.equal((await loadConfig(home)).ui.language, 'en');
  locked = true;
  await assert.rejects(
    service.save({ revision: initial.revision, model: { ...defaultConfig.models[0], id: 'new' } }),
    /busy/,
  );
  assert.equal((await loadConfig(home)).models.length, 1);
});
test('connection tests exercise all four wire protocols and refuse auth failures, HTML and empty success', async () => {
  const server = await configurationModelServer();
  try {
    for (const api of [
      'openai-completions',
      'openai-responses',
      'anthropic-messages',
      'google-generative-ai',
    ] as const) {
      const result = await testModelConnection(
        { ...defaultConfig.models[0], model: 'fixture-protocol', api, baseURL: server.baseURL },
        'fixture-secret-value',
      );
      assert.equal(result.ok, true, `${api}: ${result.message}`);
    }
    for (const model of ['unauthorized', 'html', 'empty']) {
      const result = await testModelConnection(
        { ...defaultConfig.models[0], model, baseURL: server.baseURL },
        'fixture-secret-value',
      );
      assert.equal(result.ok, false);
      assert.ok(!JSON.stringify(result).includes('fixture-secret-value'));
    }
    const missing = await testModelConnection(defaultConfig.models[0]);
    assert.equal(missing.kind, 'credential');
    const cancelled = await testModelConnection(
      { ...defaultConfig.models[0], model: 'slow', baseURL: server.baseURL },
      'fixture-secret-value',
      AbortSignal.timeout(40),
    );
    assert.equal(cancelled.kind, 'timeout');
    assert.deepEqual(
      server.calls.slice(0, 4).map((c) => c.path),
      ['/v1/chat/completions', '/v1/responses', '/v1/messages', '/v1/openai/chat/completions'],
    );
  } finally {
    await server.close();
  }
});
test('local JSON APIs require a session and same-origin requests; no web interface is served', async () => {
  const service = await startModelConfiguration(await fixture());
  const token = new URLSearchParams(new URL(service.url).hash.slice(1)).get('session')!;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  try {
    assert.equal((await fetch(service.origin + '/api/state')).status, 401);
    assert.equal(
      (
        await fetch(service.origin + '/api/state', {
          headers: { ...headers, Origin: 'https://malicious.example' },
        })
      ).status,
      403,
    );
    const rebound = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        service.origin + '/api/state',
        { headers: { ...headers, Host: 'rebound.example' } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(rebound, 403);
    const response = await fetch(service.origin + '/api/state', { headers }),
      state = (await response.json()) as { revision: string; models: unknown[] };
    assert.equal(state.models.length, 1);
    assert.ok(!JSON.stringify(state).includes('secret'));
    for (const path of ['/', '/style.css', '/app.js'])
      assert.equal((await fetch(service.origin + path)).status, 404);
    assert.equal(
      (
        await fetch(service.origin + '/api/models/save', {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify({
            revision: state.revision,
            model: { ...defaultConfig.models[0], id: 'second' },
          }),
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(service.origin + '/api/windows/assign', {
          method: 'POST',
          headers,
          body: JSON.stringify({ revision: state.revision, windowId: 'one', modelId: 'deepseek' }),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(service.origin + '/api/test', {
          method: 'POST',
          headers: { Authorization: headers.Authorization },
          body: '{}',
        })
      ).status,
      400,
    );
  } finally {
    await service.close();
  }
});
test(
  'replacing a DPAPI credential refreshes injected values and never stores a plaintext key in configuration',
  { skip: process.platform !== 'win32' },
  async () => {
    const home = await fixture(),
      name = 'EMERGENCE_MODEL_CONFIG_TEST_SECRET';
    delete process.env[name];
    try {
      await saveCredential(home, name, 'first-fixture-secret');
      await hydrateCredentials(home, [name]);
      await saveCredential(home, name, 'second-fixture-secret');
      assert.equal(await resolveCredential(home, name), 'second-fixture-secret');
      process.env[name] = 'explicit-shell-secret';
      await saveCredential(home, name, 'third-fixture-secret');
      assert.equal(await resolveCredential(home, name), 'explicit-shell-secret');
      adoptHydratedCredentials([name]);
      await saveCredential(home, name, 'launcher-injected-replacement');
      assert.equal(await resolveCredential(home, name), 'launcher-injected-replacement');
      assert.ok(!(await readFile(join(home, 'credentials.dpapi.json'), 'utf8')).includes('fixture-secret'));
      assert.ok(!(await readFile(join(home, 'config.json'), 'utf8')).includes('fixture-secret'));
    } finally {
      delete process.env[name];
    }
  },
);
test(
  'saving a key warns when an explicit environment override still drives requests, and clearing it loads the saved key',
  { skip: process.platform !== 'win32' },
  async () => {
    const home = await fixture(),
      name = 'EMERGENCE_MODEL_CONFIG_OVERRIDE_TEST';
    process.env[name] = 'explicit-shell-secret';
    try {
      const service = new ModelConfiguration(home),
        initial = await service.state();
      const saved = await service.save({
        revision: initial.revision,
        model: { ...defaultConfig.models[0], apiKeyEnv: name },
        secret: 'saved-encrypted-secret',
      });
      assert.match(saved.credentialWarning ?? '', new RegExp(name));
      assert.equal(saved.models[0].credentialSource, 'environment');
      assert.equal(await resolveCredential(home, name), 'explicit-shell-secret');
      assert.ok(!JSON.stringify(saved).includes('saved-encrypted-secret'));
      delete process.env[name];
      assert.equal(await resolveCredential(home, name), 'saved-encrypted-secret');
      assert.equal(credentialSource(name), 'encrypted');
      const refreshed = await service.save({
        revision: saved.revision,
        model: { ...defaultConfig.models[0], apiKeyEnv: name },
        secret: 'replacement-encrypted-secret',
      });
      assert.equal(refreshed.credentialWarning, undefined);
      assert.equal(await resolveCredential(home, name), 'replacement-encrypted-secret');
    } finally {
      delete process.env[name];
    }
  },
);
