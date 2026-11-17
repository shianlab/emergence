import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const bootstrap = resolve('../install.ps1');
const psQuote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
function powershell(script: string) {
  return new Promise<{ code: number | null; out: string; err: string }>((done, reject) => {
    const env = { ...process.env };
    delete env.PSModulePath;
    const child = spawn(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        Buffer.from(
          "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';. " +
            psQuote(bootstrap) +
            ';' +
            script,
          'utf16le',
        ).toString('base64'),
      ],
      { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '',
      err = '';
    child.stdout.on('data', (b) => (out += b));
    child.stderr.on('data', (b) => (err += b));
    const timer = setTimeout(() => child.kill(), 20000);
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer);
      done({ code, out, err });
    });
  });
}
test('bootstrap transport recovers from real HTTP failures and protects cache boundaries', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'emergence-download-test-'));
  const payload = Buffer.alloc(128 * 1024, 71);
  const digest = createHash('sha256').update(payload).digest('hex');
  const counts = new Map<string, number>();
  const ranges = new Map<string, string[]>();
  const server = createServer((req, res) => {
    const route = req.url!;
    const count = (counts.get(route) ?? 0) + 1;
    counts.set(route, count);
    ranges.set(route, [...(ranges.get(route) ?? []), String(req.headers.range ?? '')]);
    if (route === '/error' || (route === '/retry' && count === 1)) {
      res.writeHead(503);
      res.end();
      return;
    }
    if (route === '/timeout') return;
    if (route === '/redirect') {
      res.writeHead(302, { Location: 'http://example.invalid/package.zip' });
      res.end();
      return;
    }
    if (route === '/oversize') {
      res.writeHead(200, { 'Content-Length': 2 ** 30 });
      res.end();
      return;
    }
    if (route === '/corrupt' && count === 1) {
      res.end(Buffer.alloc(payload.length, 2));
      return;
    }
    if (route === '/range416' && count === 1) {
      res.writeHead(416);
      res.end();
      return;
    }
    const offset = route !== '/ignore-range' ? Number(req.headers.range?.match(/bytes=(\d+)-/)?.[1] ?? 0) : 0;
    if (offset)
      res.writeHead(206, {
        'Content-Length': payload.length - offset,
        'Content-Range': 'bytes ' + offset + '-' + (payload.length - 1) + '/' + payload.length,
      });
    else res.writeHead(200, { 'Content-Length': payload.length });
    if (route === '/disconnect' && count === 1) {
      res.write(payload.subarray(0, 65536));
      setTimeout(() => res.destroy(), 40);
    } else res.end(payload.subarray(offset));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = 'http://127.0.0.1:' + address.port;
  try {
    for (const route of ['retry', 'disconnect', 'ignore-range', 'range416', 'corrupt']) {
      await t.test(route, async () => {
        const destination = join(root, route + '.part');
        if (route === 'ignore-range' || route === 'range416')
          await writeFile(destination, payload.subarray(0, 777));
        const result = await powershell(
          'Receive-EmergenceFile -Uri ' +
            psQuote(base + '/' + route) +
            ' -Destination ' +
            psQuote(destination) +
            ' -ExpectedHash ' +
            psQuote(digest) +
            ' -RetryDelaySeconds 0',
        );
        assert.equal(result.code, 0, result.err + result.out);
        assert.deepEqual(await readFile(destination), payload);
        if (route === 'disconnect')
          assert.ok(
            ranges.get('/disconnect')!.some((r) => /^bytes=[1-9]/.test(r)),
            'partial bytes must be resumed',
          );
      });
    }
    await t.test('verified cached content avoids network', async () => {
      const destination = join(root, 'verified.part');
      await writeFile(destination, payload);
      assert.equal(
        (
          await powershell(
            'Receive-EmergenceFile -Uri ' +
              psQuote(base + '/cached') +
              ' -Destination ' +
              psQuote(destination) +
              ' -ExpectedHash ' +
              psQuote(digest),
          )
        ).code,
        0,
      );
      assert.equal(counts.get('/cached'), undefined);
    });
    for (const route of ['error', 'timeout', 'redirect', 'oversize']) {
      await t.test('bounded failure: ' + route, async () => {
        const started = Date.now();
        const result = await powershell(
          'Receive-EmergenceFile -Uri ' +
            psQuote(base + '/' + route) +
            ' -Destination ' +
            psQuote(join(root, route + '.part')) +
            ' -ExpectedHash ' +
            psQuote(digest) +
            ' -Attempts 2 -TimeoutSeconds 1 -TotalSeconds 4 -RetryDelaySeconds 0 -MaximumBytes 262144',
        );
        assert.notEqual(result.code, 0);
        assert.ok(Date.now() - started < 15000);
        assert.ok((counts.get('/' + route) ?? 0) <= 2);
      });
    }
    await t.test('cache cannot take over an existing user directory', async () => {
      const folder = join(root, 'unowned');
      await mkdir(folder);
      await writeFile(join(folder, 'user.txt'), 'keep');
      assert.notEqual((await powershell('Initialize-EmergenceCache ' + psQuote(folder))).code, 0);
      assert.equal(await readFile(join(folder, 'user.txt'), 'utf8'), 'keep');
    });
    await t.test('linked cache and download targets are rejected', async () => {
      const target = join(root, 'real');
      const link = join(root, 'linked');
      await mkdir(target);
      await symlink(target, link, 'junction');
      const result = await powershell(
        'Receive-EmergenceFile -Uri ' +
          psQuote(base + '/linked') +
          ' -Destination ' +
          psQuote(join(link, 'payload.part')),
      );
      assert.notEqual(result.code, 0);
      assert.equal(counts.get('/linked'), undefined);
    });
    await t.test('pruning removes only expired digest payloads', async () => {
      const folder = join(root, 'cache');
      const stale = join(folder, 'a'.repeat(64) + '.part');
      const keep = join(folder, 'b'.repeat(64) + '.zip');
      const result = await powershell(
        'Initialize-EmergenceCache ' +
          psQuote(folder) +
          ';[IO.File]::WriteAllText(' +
          psQuote(stale) +
          ",'old');[IO.File]::SetLastWriteTimeUtc(" +
          psQuote(stale) +
          ',[DateTime]::UtcNow.AddDays(-9));[IO.File]::WriteAllText(' +
          psQuote(keep) +
          ",'current');[IO.File]::WriteAllText((Join-Path " +
          psQuote(folder) +
          " 'user.txt'),'keep');Clear-EmergenceDownloads " +
          psQuote(folder) +
          ' ' +
          psQuote(keep),
      );
      assert.equal(result.code, 0, result.err);
      await assert.rejects(readFile(stale));
      assert.equal(await readFile(keep, 'utf8'), 'current');
      assert.equal(await readFile(join(folder, 'user.txt'), 'utf8'), 'keep');
    });
    await t.test('archive validation rejects parent traversal before extraction', async () => {
      const archive = join(root, 'unsafe.zip');
      const script =
        'Add-Type -AssemblyName System.IO.Compression.FileSystem;$z=[IO.Compression.ZipFile]::Open(' +
        psQuote(archive) +
        ",[IO.Compression.ZipArchiveMode]::Create);foreach($n in @('a','b','c','d','../escape')){[void]$z.CreateEntry('Emergence-1.0.1-win32-x64/'+$n)};$z.Dispose();Test-EmergenceArchive " +
        psQuote(archive) +
        " '1.0.1'";
      assert.notEqual((await powershell(script)).code, 0);
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});
