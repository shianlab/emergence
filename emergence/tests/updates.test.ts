import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { acquireLease } from '../src/core/storage/lease.ts';
import { verifyManifest, compareVersions, type ReleaseManifest } from '../src/app/updates/manifest.ts';
import { fetchManifest } from '../src/app/updates/transport.ts';
import { UpdateService } from '../src/app/updates/service.ts';
import { updateAction, updateChoices, updateHint } from '../src/app/updates/presentation.ts';
import { UpdateStore, installationLocation } from '../src/app/updates/storage.ts';

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const key = {
  id: 'test',
  status: 'active',
  pem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
};
function manifest(version = '1.0.2', sequence = 1): ReleaseManifest {
  return {
    schema: 1,
    product: 'emergence',
    platform: 'win32-x64',
    version,
    sequence,
    minimumInstaller: 2,
    publishedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    asset: {
      url: `https://github.com/shianlab/emergence/releases/download/v${version}/Emergence-${version}-win32-x64.zip`,
      bytes: 123,
      sha256: 'a'.repeat(64),
    },
    notes: '新增：中文版本提醒\n修复：更新失败恢复',
    notesURL: `https://github.com/shianlab/emergence/releases/tag/v${version}`,
  };
}
function signed(value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value));
  return {
    payload: bytes.toString('base64'),
    signatures: [{ keyId: key.id, signature: sign('RSA-SHA256', bytes, pair.privateKey).toString('base64') }],
  };
}
const verify = (value: unknown) => verifyManifest(value, [key]);
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'emergence-updates-'));
  await writeFile(join(root, 'installation.json'), JSON.stringify({ product: 'emergence', schema: 2 }));
  const location = { kind: 'managed' as const, root, release: root };
  return { root, location, store: new UpdateStore(root) };
}
test('signed release rejects forged, expired, wrong-platform, redirected and prerelease metadata', () => {
  const good = signed(manifest());
  assert.equal(verify(good).version, '1.0.2');
  assert.throws(() =>
    verify({ ...good, payload: Buffer.from(JSON.stringify(manifest('1.0.3'))).toString('base64') }),
  );
  for (const value of [
    { ...manifest(), expiresAt: '2020-01-01T00:00:00.000Z' },
    { ...manifest(), platform: 'linux-x64' },
    { ...manifest(), minimumInstaller: 99 },
    manifest('1.0.2-rc.1'),
    { ...manifest(), asset: { ...manifest().asset, url: 'https://evil.invalid/app.zip' } },
    { ...manifest(), notes: '\u001b[2J' },
    { ...manifest(), product: 'other' },
  ])
    assert.throws(() => verify(signed(value)));
  assert.equal(compareVersions('1.0.10', '1.0.9'), 1);
  assert.equal(compareVersions('1.0.2', '1.0.2-rc.1'), 1);
});
test('trust rotation accepts overlapping trusted signatures and rejects revoked or unknown keys', () => {
  const good = signed(manifest());
  assert.throws(() => verifyManifest(good, []));
  assert.throws(() => verifyManifest(good, [{ ...key, status: 'revoked' }]));
  const next = { ...key, id: 'next' };
  const dual = { ...good, signatures: [...good.signatures, { ...good.signatures[0], keyId: next.id }] };
  assert.equal(verifyManifest(dual, [{ ...key, status: 'revoked' }, next]).version, '1.0.2');
  assert.equal(verifyManifest(dual, [key]).version, '1.0.2');
});
test('metadata transport bounds streamed responses, rejects redirects and sends no user data', async () => {
  const value = signed(manifest());
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(
      String(url),
      'https://raw.githubusercontent.com/shianlab/emergence/main/releases/stable.json',
    );
    assert.equal(init?.redirect, 'manual');
    assert.equal(init?.body, undefined);
    return new Response(JSON.stringify(value));
  };
  assert.deepEqual(await fetchManifest(new AbortController().signal, fetcher), value);
  for (const response of [
    new Response('', { status: 302, headers: { location: 'https://evil.invalid' } }),
    new Response('x'.repeat(65537)),
    new Response('<html>error</html>'),
  ])
    await assert.rejects(fetchManifest(new AbortController().signal, async () => response));
});
test('concurrent clients share installed cache; background checks are limited, preference persists', async () => {
  const f = await fixture();
  let calls = 0;
  const dependencies = {
    verify,
    request: async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 80));
      return signed(manifest());
    },
  };
  const a = new UpdateService(f.location, '1.0.1', dependencies),
    b = new UpdateService(f.location, '1.0.1', dependencies);
  try {
    const results = await Promise.all([a.check(), a.check(), b.check()]);
    assert.ok(results.every((result) => result.status === 'available'));
    assert.equal(calls, 1);
    await a.check();
    assert.equal(calls, 1);
    await updateAction(a, 'later');
    assert.equal(updateHint(a.snapshot), '');
    await updateAction(a, 'off');
    assert.equal((await b.check()).enabled, false);
    assert.equal(calls, 1);
    assert.equal((await a.inspect()).enabled, false);
    assert.ok(updateChoices(a).some((item) => item.command === '开启自动检查'));
  } finally {
    a.dispose();
    b.dispose();
  }
});
test('a lower signed release sequence is rejected, failures persist without harming normal use', async () => {
  const f = await fixture();
  let envelope = signed(manifest('1.0.3', 3));
  const service = new UpdateService(f.location, '1.0.1', { verify, request: async () => envelope });
  try {
    assert.equal((await service.check(true)).release?.version, '1.0.3');
    envelope = signed(manifest('1.0.2', 2));
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal((await service.check(true)).status, 'error');
    assert.equal((await f.store.read()).sequence, 3);
    assert.ok((await service.inspect()).message.includes('失败'));
    assert.equal(updateHint(service.snapshot), '');
  } finally {
    service.dispose();
  }
});
test('verified update uses one installer and records success only after it completes', async () => {
  const f = await fixture();
  let installs = 0;
  let finish!: () => void;
  const service = new UpdateService(f.location, '1.0.1', {
    verify,
    request: async () => signed(manifest()),
    install: async (envelope, progress) => {
      assert.equal(verify(envelope).version, '1.0.2');
      installs++;
      progress('正在验证候选文件');
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
  });
  try {
    await service.check();
    const a = service.install('1.0.2'),
      b = service.install('1.0.2');
    for (let n = 0; n < 100 && !finish; n++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(service.snapshot.status, 'installing');
    assert.equal(installs, 1);
    await writeFile(join(f.root, 'current.json'), JSON.stringify({ product: 'emergence', version: '1.0.2' }));
    finish();
    await Promise.all([a, b]);
    assert.equal(service.snapshot.status, 'ready');
    assert.equal((await f.store.read()).installed, '1.0.2');
    assert.ok(!(await readFile(f.store.file, 'utf8')).includes('apiKey'));
  } finally {
    service.dispose();
  }
});
test('closing cancels background fetch and prevents late writes or notifications', async () => {
  const f = await fixture();
  let signal: AbortSignal | undefined;
  const service = new UpdateService(f.location, '1.0.1', {
    verify,
    request: async (requestSignal) => {
      signal = requestSignal;
      return new Promise((_, reject) =>
        requestSignal.addEventListener('abort', () => reject(Error('abort')), { once: true }),
      );
    },
  });
  const pending = service.check();
  for (let n = 0; n < 100 && !signal; n++) await new Promise((resolve) => setTimeout(resolve, 5));
  service.dispose();
  await pending;
  assert.equal(signal?.aborted, true);
  assert.equal((await f.store.read()).checkedAt, 0);
  assert.equal(service.listenerCount('change'), 0);
});
test('development installation neither checks the network nor invokes installer', async () => {
  assert.equal((await installationLocation()).kind, 'development');
  const service = new UpdateService({ kind: 'development' }, '1.0.1', {
    request: async () => {
      throw Error('must not call');
    },
  });
  assert.equal((await service.check(true)).status, 'unsupported');
  await assert.rejects(service.install('1.0.2'));
  service.dispose();
});

test('a stalled metadata connection times out without blocking later work', async () => {
  const server = createServer(() => {});
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const f = await fixture();
  const service = new UpdateService(f.location, '1.0.1', {
    verify,
    request: (signal) =>
      fetchManifest(signal, (_url, init) => fetch('http://127.0.0.1:' + address.port, init)),
  });
  try {
    const result = await service.check(true);
    assert.equal(result.status, 'error');
    assert.ok((await service.inspect()).checkedAt);
  } finally {
    service.dispose();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});
test('failed install is persisted and rollback does not leave a false ready notification', async () => {
  const f = await fixture();
  const service = new UpdateService(f.location, '1.0.1', {
    verify,
    request: async () => signed(manifest()),
    install: async () => {
      throw Error('fixture');
    },
  });
  try {
    await service.check();
    await assert.rejects(service.install('1.0.2'));
    assert.match((await service.inspect()).message, /未完成/);
    const state = await f.store.read();
    state.error = undefined;
    state.installed = '1.0.2';
    await f.store.write(state);
    await writeFile(join(f.root, 'current.json'), JSON.stringify({ product: 'emergence', version: '1.0.1' }));
    assert.equal((await service.inspect()).status, 'available');
  } finally {
    service.dispose();
  }
});
test('uninstall and update services honor the same OS-owned leases', async () => {
  const f = await fixture();
  const windows = createRequire(import.meta.url)('../release/installation/windows.cjs');
  const release = await acquireLease('update-install:' + f.root.toLowerCase(), 'fixture');
  try {
    await assert.rejects(windows.lockUpdates(f.root));
  } finally {
    await release();
  }
  const unlock = await windows.lockUpdates(f.root);
  try {
    await assert.rejects(acquireLease('update-check:' + f.root.toLowerCase(), 'fixture'));
  } finally {
    await unlock();
  }
});
