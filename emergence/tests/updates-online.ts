// Full signed-update chain with ephemeral publisher keys and a local download adapter only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { compareVersions, verifyManifest, type ReleaseManifest } from '../src/app/updates/manifest.ts';
import { installOnline } from '../src/app/updates/runtime.ts';
import { UpdateService } from '../src/app/updates/service.ts';
import { registerModelEnvironmentNames } from '../src/platform/child-environment.ts';
import { saveConfig } from '../src/app/config.ts';
import { defaultConfig } from '../src/core/domain/configuration.ts';
import { phase6Server } from './fixtures/phase6-model-server.ts';

const output = resolve(process.argv[3] ?? '../artifacts/install-phase3-20261117');
await mkdir(output, { recursive: true });
const record = JSON.parse(await readFile('../artifacts/phase6/release-path.json', 'utf8'));
const candidate = process.argv[2]
  ? (JSON.parse(await readFile(resolve(process.argv[2]), 'utf8')) as {
      version: string;
      bundle: string;
      archive: string;
      sha256: string;
    })
  : undefined;
const root = await mkdtemp(join(tmpdir(), 'emergence-online-')),
  install = join(root, '中文 安装'),
  cache = join(root, '独立 缓存');
const version = candidate?.version ?? '9.0.2';
assert.ok(compareVersions(version, record.version) > 0, 'Update fixture must be newer than the baseline');
const source = candidate?.bundle ?? join(root, `Emergence-${version}-win32-x64`),
  helper = join(root, 'transport');
await mkdir(helper);
const require = createRequire(import.meta.url);
const ps = join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const environment: NodeJS.ProcessEnv = { ...process.env, LOCALAPPDATA: cache };
delete environment.PSModulePath;
async function run(file: string, args: string[], expectedCode = 0) {
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
  assert.equal(code, expectedCode, err + out);
  return out;
}
const script = (file: string, args: string[] = []) =>
  run(ps, ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, ...args]);
const checks: Record<string, boolean> = {};
let downloads = 0;
const archive = candidate?.archive ?? join(root, `Emergence-${version}-win32-x64.zip`);
let signedManifest: string | undefined;
const server = createServer((request, response) => {
  if (request.url === '/stable.json' && signedManifest) {
    response.end(signedManifest);
    return;
  }
  if (request.url !== '/' + basename(archive)) {
    response.writeHead(404).end();
    return;
  }
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
const model = await phase6Server();
try {
  console.log('Installing current candidate in isolation…');
  await script(join(record.bundle, 'install.ps1'), ['-InstallRoot', install, '-NoPath']);
  if (!candidate) {
    const manager = require('../release/manage.cjs');
    const files = JSON.parse(await readFile(join(record.bundle, 'manifest.sha256.json'), 'utf8'));
    await manager.copyRelease(record.bundle, source, files);
    for (const file of ['release.json', 'app/package.json']) {
      const value = JSON.parse(await readFile(join(source, file), 'utf8'));
      value.version = version;
      await writeFile(join(source, file), JSON.stringify(value));
    }
    const cli = join(source, 'app/dist/cli.mjs');
    const cliText = await readFile(cli, 'utf8');
    assert.ok(cliText.includes(`var VERSION = "${record.version}";`));
    await writeFile(
      cli,
      cliText.replace(`var VERSION = "${record.version}";`, `var VERSION = "${version}";`),
    );
    for (const file of files) {
      if (!['release.json', 'app/package.json', 'app/dist/cli.mjs'].includes(file.path)) continue;
      const bytes = await readFile(join(source, file.path));
      file.sha256 = createHash('sha256').update(bytes).digest('hex');
      file.bytes = bytes.length;
    }
    await writeFile(join(source, 'manifest.sha256.json'), JSON.stringify(files));
    await run('tar.exe', ['-a', '-cf', archive, '-C', dirname(source), basename(source)]);
  }
  const installedEntry = join(install, 'bin/emergence.ps1');
  const home = join(root, '用户 配置');
  const project = join(root, '项目 中文');
  await mkdir(project);
  const config = structuredClone(defaultConfig);
  config.models = [
    { ...config.models[0], id: 'fixture', model: 'fixture', apiKeyEnv: modelRef, baseURL: model.baseURL },
  ];
  config.defaultModel = 'fixture';
  await saveConfig(home, config);
  const keyFile = join(root, 'test.key');
  await writeFile(keyFile, 'isolated-update-fixture-key');
  try {
    await script(installedEntry, ['auth', '--home', home, '--key-file', keyFile, '--model', 'fixture']);
  } finally {
    await unlink(keyFile);
  }
  const initial = await script(installedEntry, [project, '--home', home, '--print', '升级前保留这次会话']);
  const history = JSON.parse(initial.trim().split('\n').at(-1)!);
  assert.ok(initial.includes('ECHO_COMPLETE'));
  const beforeUpdate = await Promise.all(
    ['config.json', 'credentials.dpapi.json'].map((file) => readFile(join(home, file))),
  );
  assert.ok(!beforeUpdate[1].includes('isolated-update-fixture-key'));
  async function checkPreservedSession() {
    const calls = model.calls.length;
    const resumed = await script(installedEntry, [
      project,
      '--home',
      home,
      '--resume',
      history.sessionId,
      '--print',
      '/tools',
    ]);
    assert.ok(resumed.includes('升级前保留这次会话') && resumed.includes('ECHO_COMPLETE'));
    assert.equal(model.calls.length, calls);
    for (const [index, file] of ['config.json', 'credentials.dpapi.json'].entries())
      assert.deepEqual(await readFile(join(home, file)), beforeUpdate[index]);
    const used = await script(installedEntry, [project, '--home', home, '--print', '核对已保存模型']);
    assert.ok(used.includes('ECHO_COMPLETE'));
    assert.equal(model.calls.length, calls + 1);
  }
  console.log('Interrupting the installation before the new manager is deployed…');
  await run(
    process.execPath,
    [
      '-e',
      `const { createInstaller } = require(${JSON.stringify(require.resolve('../release/installation/service.cjs'))});
       createInstaller({ checkpoint(name) { if (name === 'preparing') process.exit(77); } })
         .run(${JSON.stringify({ action: 'update', root: install, source, noPath: true })})
         .catch((error) => { console.error(error); process.exitCode = 1; });`,
    ],
    77,
  );
  await access(join(install, 'install-transaction.json'));
  assert.equal((await script(join(install, 'bin/emergence.ps1'), ['--version'])).trim(), record.version);
  await assert.rejects(access(join(install, 'install-transaction.json')), { code: 'ENOENT' });
  checks.interruptedPreparationRecoversThroughOldLauncher = true;
  console.log('Building signed local release fixture…');
  requireStatSize = (await stat(archive)).size;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  const sha256 = hash.digest('hex');
  if (candidate) assert.equal(sha256, candidate.sha256, 'Exercise the exact packaged ZIP');
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
    version,
    sequence: 1,
    minimumInstaller: 2,
    publishedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    asset: {
      url: `https://github.com/shianlab/emergence/releases/download/v${version}/Emergence-${version}-win32-x64.zip`,
      bytes: requireStatSize,
      sha256,
    },
    notes: '隔离测试，不发布',
    notesURL: `https://github.com/shianlab/emergence/releases/tag/v${version}`,
  };
  const payload = Buffer.from(JSON.stringify(release));
  const envelope = {
    payload: payload.toString('base64'),
    signatures: [
      { keyId: key.id, signature: sign('RSA-SHA256', payload, pair.privateKey).toString('base64') },
    ],
  };
  signedManifest = JSON.stringify(envelope);
  if (candidate) {
    await writeFile(join(output, 'candidate-test-manifest.json'), signedManifest);
    await writeFile(
      join(output, 'candidate-test-trust.json'),
      JSON.stringify({ schema: 1, keys: [key] }, null, 2),
    );
  }
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
        "Invoke-EmergenceInstall '1.0.1' $targetInstall $true $targetMetadata (!$Update) $Update.IsPresent",
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
    await service.install(version);
    assert.equal(service.snapshot.status, 'ready');
    assert.equal(downloads, 1);
    checks.signedDownloadAndSharedTransaction = true;
    checks.updateWorkerOmitsModelCredentials = true;
    assert.equal((await script(installedEntry, ['--version'])).trim(), version);
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
  await checkPreservedSession();
  checks.upgradePreservesConfigurationCredentialsAndHistory = true;
  await script(installedEntry, ['rollback']);
  assert.equal((await script(installedEntry, ['--version'])).trim(), record.version);
  await checkPreservedSession();
  checks.rollbackPreservesConfigurationCredentialsAndHistory = true;
  if (candidate) {
    const fresh = join(root, '全新 安装');
    await script(join(helper, 'bootstrap.ps1'), ['-InstallRoot', fresh]);
    assert.equal((await script(join(fresh, 'bin/emergence.ps1'), ['--version'])).trim(), version);
    assert.equal(downloads, 1, 'Signed stable bootstrap reuses the verified archive');
    await script(join(fresh, 'uninstall.ps1'), ['-NoPath']);
    await assert.rejects(access(fresh));
    checks.exactCandidateFreshInstallThroughSignedStableChannel = true;
  }
  await script(join(install, 'uninstall.ps1'), ['-NoPath']);
  await assert.rejects(access(install));
  checks.uninstallRemovesManagedUpdateState = true;
  await writeFile(
    join(output, 'online-validation.json'),
    JSON.stringify(
      { passed: true, root, baseline: record.version, version, candidate: source, sha256, checks, downloads },
      null,
      2,
    ),
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
  await model.close();
}
