import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { hydrateCredentials, readCredentials, saveCredential } from '../src/app/credentials.ts';

test(
  'Windows credentials are encrypted, round-trip, and do not replace explicit environment values',
  { skip: process.platform !== 'win32' },
  async () => {
    const home = await mkdtemp(join(tmpdir(), 'emergence-credentials-'));
    const name = 'EMERGENCE_CREDENTIAL_TEST_KEY';
    const original = process.env[name];
    try {
      await saveCredential(home, name, 'credential-unit-test-value');
      const stored = await readFile(join(home, 'credentials.dpapi.json'), 'utf8');
      assert.ok(!stored.includes('credential-unit-test-value'));
      assert.equal((await readCredentials(home))[name], 'credential-unit-test-value');
      await Promise.all([
        saveCredential(home, 'CONCURRENT_A', 'concurrent-a'),
        saveCredential(home, 'CONCURRENT_B', 'concurrent-b'),
      ]);
      const merged = await readCredentials(home);
      assert.equal(merged.CONCURRENT_A, 'concurrent-a');
      assert.equal(merged.CONCURRENT_B, 'concurrent-b');
      delete process.env[name];
      await hydrateCredentials(home, [name]);
      assert.equal(process.env[name], 'credential-unit-test-value');
      process.env[name] = 'explicit-override';
      await hydrateCredentials(home, [name]);
      assert.equal(process.env[name], 'explicit-override');
    } finally {
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    }
  },
);
