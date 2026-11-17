// Full bootstrap integration against a local release fixture; production URLs are unchanged.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, dirname, join, resolve } from 'node:path';
import { compareVersions, verifyManifest } from '../src/app/updates/manifest.ts';

const directory = resolve(process.argv[2] ?? '../artifacts/installation-bootstrap');
await mkdir(directory, { recursive: true });
const record = JSON.parse(await readFile('../artifacts/phase6/release-path.json', 'utf8'));
const root = await mkdtemp(join(directory, 'bootstrap-'));
const archive = record.archive ?? join(root, basename(record.bundle) + '.zip');
const signed = compareVersions(record.version, '1.0.2') >= 0;
if (signed) assert.ok(process.argv[3], 'Pass the signed release manifest for the candidate ZIP');
const envelope = signed ? await readFile(resolve(process.argv[3]), 'utf8') : undefined;
const manifest = envelope ? verifyManifest(JSON.parse(envelope)) : undefined;
const shell = process.argv[4] ?? 'powershell.exe';
const asset = basename(archive);
const install = join(root, '中文 安装');
const cacheHome = join(root, '中文 用户');
async function run(command: string, args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, LOCALAPPDATA: cacheHome };
  delete env.PSModulePath;
  const child = spawn(command, args, {
    cwd: root,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '',
    err = '';
  child.stdout.on('data', (b) => (out += b));
  child.stderr.on('data', (b) => (err += b));
  const timer = setTimeout(() => child.kill(), 240000);
  const code = await new Promise<number | null>((done, reject) => {
    child.once('error', reject);
    child.once('close', done);
  });
  clearTimeout(timer);
  assert.equal(code, 0, err + out);
  return out;
}
const archived = record.archive
  ? ''
  : await run('tar.exe', ['-a', '-cf', archive, '-C', dirname(record.bundle), basename(record.bundle)]);
assert.equal(archived.trim(), '');
const hash = createHash('sha256');
for await (const chunk of createReadStream(archive)) hash.update(chunk);
const digest = hash.digest('hex');
if (manifest) {
  assert.equal(manifest.version, record.version);
  assert.equal(manifest.asset.sha256, digest);
  assert.equal(manifest.asset.bytes, (await stat(archive)).size);
}
let downloads = 0;
const server = createServer((req, res) => {
  if (envelope && (req.url === '/stable.json' || req.url === '/update.json')) {
    res.end(envelope);
    return;
  }
  if (req.url?.endsWith('.sha256')) {
    res.end(digest + '  ' + asset + '\n');
    return;
  }
  if (!req.url?.endsWith('.zip')) {
    res.writeHead(404);
    res.end();
    return;
  }
  downloads++;
  void stat(archive).then((info) => {
    res.writeHead(200, { 'Content-Length': info.size });
    createReadStream(archive).pipe(res);
  });
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const address = server.address();
assert.ok(address && typeof address !== 'string');
const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const wrapper = join(root, 'bootstrap-test.ps1');
await writeFile(
  wrapper,
  '\ufeff' +
    [
      "$ErrorActionPreference='Stop'",
      "$ProgressPreference='SilentlyContinue'",
      '. ' + quote(resolve('../install.ps1')),
      '$script:transport=(Get-Command Receive-EmergenceFile).ScriptBlock',
      'function Receive-EmergenceFile {',
      'param([uri]$Uri,[string]$Destination,[long]$MaximumBytes=1GB,[int]$TotalSeconds=900,[string]$ExpectedHash="")',
      "$PSBoundParameters['Uri']=" +
        quote('http://127.0.0.1:' + address.port + '/') +
        '+[IO.Path]::GetFileName($Uri.AbsolutePath)',
      '& $script:transport @PSBoundParameters',
      '}',
      'Invoke-EmergenceInstall ' + quote(record.version) + ' ' + quote(install) + ' $true',
    ].join('\r\n'),
);
const ps = (file: string, args: string[] = []) =>
  run(shell, ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, ...args]);
try {
  const first = await ps(wrapper);
  await writeFile(join(root, 'first.log'), first);
  assert.equal(JSON.parse(await readFile(join(install, 'current.json'), 'utf8')).version, record.version);
  assert.equal(downloads, 1);
  assert.equal((await ps(join(install, 'bin/emergence.ps1'), ['--version'])).trim(), record.version);
  const second = await ps(wrapper);
  await writeFile(join(root, 'repeat.log'), second);
  assert.equal(downloads, 1, 'repeat installation must reuse the validated archive');
  await ps(join(install, 'uninstall.ps1'), ['-NoPath']);
  await writeFile(
    join(directory, 'bootstrap-validation.json'),
    JSON.stringify(
      {
        passed: true,
        root,
        digest,
        candidate: record.bundle,
        shell,
        signed,
        downloads,
        checks: ['fullBootstrap', 'chinesePaths', 'installedCommand', 'repeatUsesCache', 'isolatedUninstall'],
        note: 'Only the download adapter URL is routed to a local HTTP fixture. Production bootstrap orchestration, ZIP validation, extraction, manager and health probes execute unmodified; no real PATH or application install changed.',
      },
      null,
      2,
    ),
  );
  console.log('Bootstrap integration passed; repeat install used cached archive.');
} finally {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
}
