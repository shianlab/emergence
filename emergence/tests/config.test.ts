import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/app/config.ts';
import { safeError } from '../src/core/adapters/redaction.ts';
import { configSchema, defaultConfig } from '../src/core/domain/configuration.ts';

test('duplicate model identities and unknown default are rejected', () => {
  assert.equal(
    configSchema.safeParse({ ...defaultConfig, models: [...defaultConfig.models, ...defaultConfig.models] })
      .success,
    false,
  );
  assert.equal(configSchema.safeParse({ ...defaultConfig, defaultModel: 'absent' }).success, false);
});
test('credentials cannot be persisted in endpoint or inline key fields', () => {
  for (const baseURL of ['https://user:secret@example.com/v1', 'https://example.com?api_key=secret']) {
    assert.equal(
      configSchema.safeParse({ ...defaultConfig, models: [{ ...defaultConfig.models[0], baseURL }] }).success,
      false,
    );
  }
  assert.equal(
    configSchema.safeParse({ ...defaultConfig, models: [{ ...defaultConfig.models[0], apiKey: 'secret' }] })
      .success,
    false,
  );
});
test('corrupt existing config is reported instead of overwritten with defaults', async () => {
  const home = await mkdtemp(join(tmpdir(), 'emergence-config-'));
  await writeFile(join(home, 'config.json'), '{ broken');
  await assert.rejects(loadConfig(home), SyntaxError);
});
test('errors redact credential environment values', () => {
  process.env.EMERGENCE_TEST_SECRET = 'unit-test-secret';
  try {
    assert.equal(safeError(new Error('request unit-test-secret')), 'request [已隐藏]');
  } finally {
    delete process.env.EMERGENCE_TEST_SECRET;
  }
});

test('provider errors redact URL credentials and authorization without environment registration', () => {
  const value = safeError(
    'failed https://alice:unknown-password@example.test/v1?api_key=unknown-query-secret&lang=zh Authorization: Basic dXNlcjpwYXNz',
  );
  for (const secret of ['alice', 'unknown-password', 'unknown-query-secret', 'dXNlcjpwYXNz'])
    assert.ok(!value.includes(secret));
  assert.ok(value.includes('lang=zh'));
  assert.equal(safeError('https://example.test/docs?page=2'), 'https://example.test/docs?page=2');
});
