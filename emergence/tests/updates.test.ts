import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { acquireLease } from '../src/core/storage/lease.ts';
import { verifyManifest, compareVersions, type ReleaseManifest } from '../src/app/updates/manifest.ts';
import { fetchManifest } from '../src/app/updates/transport.ts';
import { UpdateService } from '../src/app/updates/service.ts';
import { installOnline } from '../src/app/updates/runtime.ts';
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
test('metadata transport retries a connection failure on the official contents endpoint', async () => {
  const value = signed(manifest());
  const requests: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    requests.push(String(url));
    assert.equal(init?.redirect, 'manual');
    assert.equal(new Headers(init?.headers).has('authorization'), false);
    if (requests.length === 1) throw new TypeError('connection reset');
    assert.equal(new Headers(init?.headers).get('accept'), 'application/vnd.github.raw+json');
    return new Response(JSON.stringify(value));
  };
  assert.equal(verify(await fetchManifest(new AbortController().signal, fetcher)).version, '1.0.2');
  assert.deepEqual(requests, [
    'https://raw.githubusercontent.com/shianlab/emergence/main/releases/stable.json',
    'https://api.github.com/repos/shianlab/emergence/contents/releases/stable.json?ref=main',
  ]);

  const controller = new AbortController();
  let attempts = 0;
  await assert.rejects(
    fetchManifest(controller.signal, async () => {
      attempts++;
      controller.abort();
      throw new TypeError('connection reset');
    }),
    { name: 'AbortError' },
  );
  assert.equal(attempts, 1);
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

test('a busy update cache cannot hide the installer error or block retry', async () => {
  const f = await fixture();
  const failure = Error('fixture: download interrupted');
  let fail = true;
  const service = new UpdateService(f.location, '1.0.1', {
    verify,
    request: async () => signed(manifest()),
    install: async () => {
      if (fail) throw failure;
      await writeFile(
        join(f.root, 'current.json'),
        JSON.stringify({ product: 'emergence', version: '1.0.2' }),
      );
    },
  });
  try {
    await service.check();
    const unlock = await acquireLease('update-check:' + f.root.toLowerCase(), 'fixture');
    try {
      await assert.rejects(service.install('1.0.2'), (error) => error === failure);
      assert.equal(service.snapshot.status, 'error');
      assert.match(service.snapshot.message, /download interrupted/);
      fail = false;
      await service.install('1.0.2');
      assert.equal(service.snapshot.status, 'ready');
      assert.equal((await f.store.read()).installed, undefined);
      assert.equal((await service.inspect()).status, 'ready');
    } finally {
      await unlock();
    }
    await writeFile(join(f.root, 'install-transaction.json'), '{}');
    assert.equal((await service.inspect()).status, 'available');
  } finally {
    service.dispose();
  }
});

test(
  'a stalled Windows installer terminates its child tree and restores the installation through its manager',
  {
    skip: process.platform !== 'win32',
  },
  async () => {
    const f = await fixture();
    const previous = JSON.stringify({ product: 'emergence', version: '1.0.1' });
    await writeFile(join(f.root, 'current.previous.json'), previous);
    await writeFile(
      join(f.root, 'bootstrap.ps1'),
      [
        'param($InstallRoot, $SignedManifest, [switch]$Update)',
        '$ErrorActionPreference = "Stop"',
        'Set-Content (Join-Path $InstallRoot "install-transaction.json") "{}"',
        `Set-Content (Join-Path $InstallRoot "current.json") '{"product":"emergence","version":"1.0.2"}'`,
        '$worker = Start-Process "$PSHOME\\powershell.exe" -ArgumentList "-NoProfile -Command Start-Sleep 60" -WindowStyle Hidden -PassThru',
        'Set-Content (Join-Path $InstallRoot "worker.pid") $worker.Id',
        'Start-Sleep 60',
      ].join('\r\n'),
    );
    await writeFile(
      join(f.root, 'run-manager.ps1'),
      [
        'param($Action, $InstallRoot, [switch]$NoPath, [switch]$Quiet)',
        '$ErrorActionPreference = "Stop"',
        'if ($Action -ne "recover" -or !$NoPath -or !$Quiet) { exit 1 }',
        'Copy-Item (Join-Path $InstallRoot "current.previous.json") (Join-Path $InstallRoot "current.json") -Force',
        'Remove-Item -LiteralPath (Join-Path $InstallRoot "install-transaction.json")',
      ].join('\r\n'),
    );
    await assert.rejects(
      installOnline(f.location, signed(manifest()), () => {}, verify, 3500),
      /更新安装超时/,
    );
    const worker = Number(await readFile(join(f.root, 'worker.pid'), 'utf8'));
    assert.throws(() => process.kill(worker, 0), { code: 'ESRCH' });
    assert.equal(await readFile(join(f.root, 'current.json'), 'utf8'), previous);
    const entries = await readdir(join(f.root, 'updates'));
    assert.deepEqual(entries, ['failure.json']);
    assert.match(await readFile(join(f.root, 'updates', 'failure.json'), 'utf8'), /更新安装超时/);
  },
);

test(
  'the installer exit reason survives failure to clean up its request',
  { skip: process.platform !== 'win32' },
  async () => {
    const f = await fixture();
    await writeFile(
      join(f.root, 'bootstrap.ps1'),
      [
        'param($InstallRoot, $SignedManifest, [switch]$Update)',
        '$ErrorActionPreference = "Stop"',
        'Remove-Item -LiteralPath $SignedManifest',
        '[IO.Directory]::CreateDirectory($SignedManifest) | Out-Null',
        '[Console]::Error.WriteLine("fixture: download disconnected")',
        'exit 37',
      ].join('\r\n'),
    );
    await assert.rejects(
      installOnline(f.location, signed(manifest()), () => {}, verify),
      /退出码 37.*download disconnected/,
    );
    const diagnostic = JSON.parse(await readFile(join(f.root, 'updates', 'failure.json'), 'utf8'));
    assert.equal(diagnostic.code, 37);
    assert.match(diagnostic.detail, /download disconnected/);
    assert.ok(diagnostic.cleanup);
  },
);

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
