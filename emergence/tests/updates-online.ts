// Full signed-update chain with ephemeral publisher keys and a local download adapter only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { verifyManifest, type ReleaseManifest } from '../src/app/updates/manifest.ts';
import { installOnline } from '../src/app/updates/runtime.ts';
import { UpdateService } from '../src/app/updates/service.ts';
import { registerModelEnvironmentNames } from '../src/platform/child-environment.ts';

const output = resolve('../artifacts/install-phase3-20261117');
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(output, 'online-')),
  install = join(root, '中文 安装'),
  cache = join(root, '独立 缓存');
const record = JSON.parse(await readFile('../artifacts/phase6/release-path.json', 'utf8'));
const source = join(root, 'Emergence-9.0.2-win32-x64'),
  helper = join(root, 'transport');
await mkdir(helper);
const manager = createRequire(import.meta.url)('../release/manage.cjs');
const files = JSON.parse(await readFile(join(record.bundle, 'manifest.sha256.json'), 'utf8'));
const ps = join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const environment: NodeJS.ProcessEnv = { ...process.env, LOCALAPPDATA: cache };
delete environment.PSModulePath;
async function run(file: string, args: string[]) {
  const child = spawn(file, args, {
    cwd: root,
    env: environment,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '',
    err = '';
  child.stdout.on('data', (data) => (out += data));
  child.stderr.on('data', (data) => (err += data));
  const code = await new Promise<number | null>((done, reject) => {
    child.once('error', reject);
    child.once('close', done);
  });
  assert.equal(code, 0, err + out);
  return out;
}
const script = (file: string, args: string[] = []) =>
  run(ps, ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, ...args]);
const checks: Record<string, boolean> = {};
let downloads = 0;
const archive = join(root, 'Emergence-9.0.2-win32-x64.zip');
const server = createServer((_request, response) => {
  downloads++;
  response.writeHead(200, { 'Content-Length': String(requireStatSize) });
  createReadStream(archive).pipe(response);
});
let requireStatSize = 0;
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const address = server.address();
assert.ok(address && typeof address !== 'string');
const savedLocal = process.env.LOCALAPPDATA;
const modelRef = 'UPDATE_FIXTURE_AUTH';
const savedModelRef = process.env[modelRef];
registerModelEnvironmentNames([modelRef]);
try {
  console.log('Installing current candidate in isolation…');
  await script(join(record.bundle, 'install.ps1'), ['-InstallRoot', install, '-NoPath']);
  await manager.copyRelease(record.bundle, source, files);
  for (const file of ['release.json', 'app/package.json']) {
    const value = JSON.parse(await readFile(join(source, file), 'utf8'));
    value.version = '9.0.2';
    await writeFile(join(source, file), JSON.stringify(value));
  }
  const cli = join(source, 'app/dist/cli.mjs');
  const cliText = await readFile(cli, 'utf8');
  assert.ok(cliText.includes(`var VERSION = "${record.version}";`));
  await writeFile(cli, cliText.replace(`var VERSION = "${record.version}";`, 'var VERSION = "9.0.2";'));
  for (const file of files) {
    if (!['release.json', 'app/package.json', 'app/dist/cli.mjs'].includes(file.path)) continue;
    const bytes = await readFile(join(source, file.path));
    file.sha256 = createHash('sha256').update(bytes).digest('hex');
    file.bytes = bytes.length;
  }
  await writeFile(join(source, 'manifest.sha256.json'), JSON.stringify(files));
  console.log('Building signed local release fixture…');
  await run('tar.exe', ['-a', '-cf', archive, '-C', dirname(source), basename(source)]);
  requireStatSize = (await stat(archive)).size;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 }),
    jwk = pair.publicKey.export({ format: 'jwk' });
  const key = {
    id: 'integration',
    status: 'active',
    pem: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    modulus: Buffer.from(jwk.n!, 'base64url').toString('base64'),
    exponent: Buffer.from(jwk.e!, 'base64url').toString('base64'),
  };
  const release: ReleaseManifest = {
    schema: 1,
    product: 'emergence',
    platform: 'win32-x64',
    version: '9.0.2',
    sequence: 1,
    minimumInstaller: 2,
    publishedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    asset: {
      url: 'https://github.com/shianlab/emergence/releases/download/v9.0.2/Emergence-9.0.2-win32-x64.zip',
      bytes: requireStatSize,
      sha256: hash.digest('hex'),
    },
    notes: '隔离测试，不发布',
    notesURL: 'https://github.com/shianlab/emergence/releases/tag/v9.0.2',
  };
  const payload = Buffer.from(JSON.stringify(release));
  const envelope = {
    payload: payload.toString('base64'),
    signatures: [
      { keyId: key.id, signature: sign('RSA-SHA256', payload, pair.privateKey).toString('base64') },
    ],
  };
  const bootstrap = await readFile('../install.ps1', 'utf8');
  await writeFile(
    join(helper, 'transport.ps1'),
    bootstrap.replace(
      /\$encodedTrust = '[^']*'/,
      "$encodedTrust = '" + Buffer.from(JSON.stringify({ schema: 1, keys: [key] })).toString('base64') + "'",
    ),
  );
  const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
  await writeFile(
    join(helper, 'bootstrap.ps1'),
    '\uFEFF' +
      [
        'param([string]$InstallRoot,[string]$SignedManifest,[switch]$Update)',
        '$targetInstall=$InstallRoot;$targetMetadata=$SignedManifest',
        "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'",
        `if (Test-Path Env:${modelRef}) { throw 'Update worker inherited a model credential' }`,
        '. ' + quote(join(helper, 'transport.ps1')),
        '$script:transport=(Get-Command Receive-EmergenceFile).ScriptBlock',
        'function Receive-EmergenceFile { param([uri]$Uri,[string]$Destination,[long]$MaximumBytes=1GB,[int]$TotalSeconds=900,[string]$ExpectedHash="")',
        "$PSBoundParameters['Uri']=" +
          quote('http://127.0.0.1:' + address.port + '/') +
          '+[IO.Path]::GetFileName($Uri.AbsolutePath)',
        '& $script:transport @PSBoundParameters }',
        "Invoke-EmergenceInstall '1.0.1' $targetInstall $true $targetMetadata $false $true",
      ].join('\r\n'),
  );
  const progress: string[] = [];
  const validate = (value: unknown) => verifyManifest(value, [key]);
  const location = { kind: 'managed' as const, root: install, release: helper };
  const service = new UpdateService(location, record.version, {
    verify: validate,
    request: async () => envelope,
    install: (value, onProgress) =>
      installOnline(
        location,
        value,
        (message) => {
          progress.push(message);
          onProgress(message);
        },
        validate,
      ),
  });
  process.env.LOCALAPPDATA = cache;
  process.env[modelRef] = 'update-test-value';
  try {
    await service.check(true);
    assert.equal(service.snapshot.status, 'available');
    console.log('Running verified download, extraction and transactional update…');
    await service.install('9.0.2');
    assert.equal(service.snapshot.status, 'ready');
    assert.equal(downloads, 1);
    checks.signedDownloadAndSharedTransaction = true;
    checks.updateWorkerOmitsModelCredentials = true;
    assert.equal((await script(join(install, 'bin/emergence.ps1'), ['--version'])).trim(), '9.0.2');
    assert.ok(progress.some((line) => /下载|校验/.test(line)));
    checks.realProgressAndActivatedVersion = true;
    const before = downloads;
    await assert.rejects(
      installOnline(
        location,
        { ...envelope, payload: Buffer.from('{}').toString('base64') },
        () => {},
        validate,
      ),
    );
    assert.equal(downloads, before);
    checks.forgeryRejectedBeforeDownload = true;
  } finally {
    service.dispose();
  }
  await script(join(install, 'uninstall.ps1'), ['-NoPath']);
  await assert.rejects(access(install));
  checks.uninstallRemovesManagedUpdateState = true;
  await writeFile(
    join(output, 'online-validation.json'),
    JSON.stringify({ passed: true, root, candidate: record.bundle, checks, downloads }, null, 2),
  );
  console.log(JSON.stringify(checks));
} catch (error) {
  await writeFile(
    join(output, 'online-validation.json'),
    JSON.stringify({ passed: false, root, checks, error: String(error) }, null, 2),
  );
  throw error;
} finally {
  if (savedLocal === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = savedLocal;
  if (savedModelRef === undefined) delete process.env[modelRef];
  else process.env[modelRef] = savedModelRef;
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
}
