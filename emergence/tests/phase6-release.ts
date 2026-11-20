import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { saveConfig } from '../src/app/config.ts';
import { defaultConfig } from '../src/core/domain/configuration.ts';
import { phase6Server } from './fixtures/phase6-model-server.ts';

const dir = resolve('../artifacts/phase6'),
  record = JSON.parse(await readFile(join(dir, 'release-path.json'), 'utf8'));
const root = await mkdtemp(join(dir, 'release-validation-')),
  extracted = join(root, 'extracted'),
  install = join(root, '安装 应用'),
  home = join(root, '用户 配置'),
  cwd = join(root, '项目 中文');
await mkdir(extracted);
await mkdir(cwd);
assert.ok(
  relative(dir, install) && !relative(dir, install).startsWith('..'),
  'installer target is confined to the validation workspace',
);
const env: NodeJS.ProcessEnv = Object.fromEntries(
  [
    'SystemRoot',
    'WINDIR',
    'COMSPEC',
    'TEMP',
    'TMP',
    'LOCALAPPDATA',
    'APPDATA',
    'USERPROFILE',
    'SYSTEMDRIVE',
    'HOMEDRIVE',
    'HOMEPATH',
    'OS',
    'PATHEXT',
  ].flatMap((k) => (process.env[k] ? [[k, process.env[k]!]] : [])),
);
env.PATH = [
  join(process.env.SystemRoot!, 'System32'),
  process.env.SystemRoot!,
  join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0'),
].join(';');
env.PHASE6_RELEASE_KEY = 'phase6-release-fixture';
env.TERM = 'xterm-256color';
async function run(command: string, args: string[], customEnv = env, verbatim = false) {
  const child = spawn(command, args, {
    cwd,
    env: customEnv,
    windowsHide: true,
    windowsVerbatimArguments: verbatim,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (b) => (stdout += b.toString('utf8')));
  child.stderr.on('data', (b) => (stderr += b.toString('utf8')));
  const timer = setTimeout(() => child.kill(), 240000);
  const code = await new Promise<number | null>((done, reject) => {
    child.once('error', reject);
    child.once('exit', done);
  });
  clearTimeout(timer);
  return { code, stdout, stderr };
}
const ps = (file: string, args: string[]) =>
  run('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, ...args]);
const checks: Record<string, boolean> = {},
  server = await phase6Server();
try {
  console.log('Preparing the candidate in an isolated directory…');
  if (record.archive) {
    const unpacked = await run('tar.exe', ['-xf', record.archive, '-C', extracted]);
    assert.equal(unpacked.code, 0, unpacked.stderr);
  } else await cp(record.bundle, join(extracted, basename(record.bundle)), { recursive: true });
  const source = join(extracted, basename(record.bundle));
  await assert.rejects(access(join(source, 'app/node_modules/picomatch')), { code: 'ENOENT' });
  checks.disabledHmrGlobDependencyExcluded = true;
  const files = JSON.parse(await readFile(join(source, 'manifest.sha256.json'), 'utf8')) as {
    path: string;
  }[];
  assert.ok(files.some(({ path }) => /\/node-pty\/prebuilds\/win32-x64\/.*\.node$/.test(path)));
  assert.ok(files.every(({ path }) => !/\.pdb$|\/node-pty\/prebuilds\/(?!win32-x64\/)/i.test(path)));
  checks.onlyWindowsX64NativePrebuildsAndNoDebugSymbols = true;
  const entry = join(source, 'emergence.ps1');
  const portable = await ps(entry, ['--version']);
  assert.equal(portable.code, 0, portable.stderr);
  assert.equal(portable.stdout.trim(), record.version);
  checks.portableWithoutGlobalNode = true;
  const cmd = await run(
    'cmd.exe',
    ['/d', '/s', '/c', `""${join(source, 'emergence.cmd')}" --version"`],
    env,
    true,
  );
  assert.equal(cmd.code, 0, cmd.stderr);
  assert.equal(cmd.stdout.trim(), record.version);
  checks.cmdLauncher = true;
  const config = structuredClone(defaultConfig);
  config.defaultModel = 'fixture';
  config.models = [
    {
      ...config.models[0],
      id: 'fixture',
      provider: 'fixture',
      model: 'fixture',
      apiKeyEnv: 'PHASE6_RELEASE_KEY',
      baseURL: server.baseURL,
    },
  ];
  await saveConfig(home, config);
  const text = '中文🙂 JSON {"path":"C:\\quoted path\\"} & literal';
  const echo = await ps(entry, [cwd, '--home', home, '--print', text]);
  assert.equal(echo.code, 0, echo.stderr);
  const original = JSON.parse(echo.stdout.trim().split('\n').at(-1)!);
  assert.ok(original.transcript.includes('你 › ' + text), echo.stdout);
  checks.quotedUnicodeArguments = true;
  const keyFile = join(root, 'fixture.key');
  await writeFile(keyFile, 'release-fixture-encrypted-secret');
  const auth = await ps(entry, ['auth', '--home', home, '--key-file', keyFile, '--model', 'fixture']);
  assert.equal(auth.code, 0, auth.stderr);
  const encrypted = await readFile(join(home, 'credentials.dpapi.json'), 'utf8');
  assert.ok(!encrypted.includes('release-fixture-encrypted-secret'));
  const { ui: _, toolPolicy: __, extensions: ___, ...legacy } = config;
  await writeFile(join(home, 'config.json'), JSON.stringify(legacy));
  const migrated = await ps(entry, ['config', 'migrate', '--home', home]);
  assert.equal(migrated.code, 0, migrated.stderr);
  assert.equal(JSON.parse(migrated.stdout.trim()).changed, true);
  checks.migrationWithBackup = true;
  await mkdir(join(home, 'templates'), { recursive: true });
  await writeFile(
    join(home, 'templates/retain.json'),
    JSON.stringify({
      version: 1,
      name: 'retain',
      focused: 'master',
      layout: { kind: 'pane', pane: 'master' },
      panes: [{ id: 'master', cwd, modelId: 'fixture' }],
      roles: { workers: [] },
    }),
  );
  await writeFile(join(cwd, 'user-file.txt'), 'preserve project data');
  const configBefore = await readFile(join(home, 'config.json'), 'utf8'),
    templateBefore = await readFile(join(home, 'templates/retain.json'), 'utf8');
  // A release-candidate fixture exercises the version switch with the exact same locked runtime.
  const changed = new Map<string, string>();
  for (const file of ['release.json', 'app/package.json', 'app/dist/cli.mjs', 'manifest.sha256.json'])
    changed.set(file, await readFile(join(source, file), 'utf8'));
  const rc = record.version + '-rc.1';
  const release = JSON.parse(changed.get('release.json')!);
  release.version = rc;
  await writeFile(join(source, 'release.json'), JSON.stringify(release, null, 2));
  const manifest = JSON.parse(changed.get('app/package.json')!);
  manifest.version = rc;
  await writeFile(join(source, 'app/package.json'), JSON.stringify(manifest, null, 2));
  const cli = changed.get('app/dist/cli.mjs')!;
  assert.ok(cli.includes(`var VERSION = "${record.version}";`));
  await writeFile(
    join(source, 'app/dist/cli.mjs'),
    cli.replace(`var VERSION = "${record.version}";`, `var VERSION = "${rc}";`),
  );
  const hashes = JSON.parse(changed.get('manifest.sha256.json')!);
  for (const file of hashes)
    if (changed.has(file.path)) {
      const bytes = await readFile(join(source, file.path));
      file.sha256 = createHash('sha256').update(bytes).digest('hex');
      file.bytes = bytes.length;
    }
  await writeFile(join(source, 'manifest.sha256.json'), JSON.stringify(hashes));
  console.log('Installing a release candidate using Windows PowerShell 5.1…');
  const first = await ps(join(source, 'install.ps1'), ['-InstallRoot', install, '-NoPath']);
  assert.equal(first.code, 0, first.stderr + first.stdout);
  checks.cleanInstallLongPaths = true;
  const installedEntry = join(install, 'bin/emergence.ps1'),
    installedVersion = await ps(installedEntry, ['--version']);
  assert.equal(installedVersion.stdout.trim(), rc);
  for (const [file, bytes] of changed) await writeFile(join(source, file), bytes);
  const candidateWorker = join(source, 'app/dist/data/worker.py');
  const workerBytes = await readFile(candidateWorker);
  const activeBeforeFailure = await readFile(join(install, 'current.json'), 'utf8');
  try {
    await writeFile(candidateWorker, Buffer.concat([workerBytes, Buffer.from('\n# corrupted upgrade\n')]));
    const failedUpgrade = await ps(join(source, 'install.ps1'), ['-InstallRoot', install, '-NoPath']);
    assert.equal(failedUpgrade.code, 1);
    assert.equal(await readFile(join(install, 'current.json'), 'utf8'), activeBeforeFailure);
    assert.equal((await ps(installedEntry, ['--version'])).stdout.trim(), rc);
    checks.corruptUpgradeKeepsPreviousVersionRunnable = true;
  } finally {
    await writeFile(candidateWorker, workerBytes);
  }
  // A hash-valid package can still fail to launch. It must never become the active version.
  const nativeFile = join(source, '涌现模型配置.exe');
  const nativeBytes = await readFile(nativeFile);
  const validManifest = await readFile(join(source, 'manifest.sha256.json'), 'utf8');
  try {
    const broken = Buffer.from('not a Windows executable');
    await writeFile(nativeFile, broken);
    const entries = JSON.parse(validManifest);
    const native = entries.find((entry: { path: string }) => entry.path === '涌现模型配置.exe');
    native.bytes = broken.length;
    native.sha256 = createHash('sha256').update(broken).digest('hex');
    await writeFile(join(source, 'manifest.sha256.json'), JSON.stringify(entries));
    const failed = await ps(join(source, 'install.ps1'), ['-InstallRoot', install, '-NoPath']);
    assert.equal(failed.code, 1, failed.stdout);
    assert.equal(await readFile(join(install, 'current.json'), 'utf8'), activeBeforeFailure);
    assert.equal((await ps(installedEntry, ['--version'])).stdout.trim(), rc);
    checks.hashValidButUnrunnableCandidateRejected = true;
  } finally {
    await writeFile(nativeFile, nativeBytes);
    await writeFile(join(source, 'manifest.sha256.json'), validManifest);
  }
  console.log('Upgrading to the final build and checking preserved history…');
  const upgrade = await ps(join(source, 'install.ps1'), ['-InstallRoot', install, '-NoPath']);
  assert.equal(upgrade.code, 0, upgrade.stderr + upgrade.stdout);
  assert.equal((await ps(installedEntry, ['--version'])).stdout.trim(), record.version);
  const repeat = await ps(join(source, 'install.ps1'), ['-InstallRoot', install, '-NoPath']);
  assert.equal(repeat.code, 0, repeat.stderr + repeat.stdout);
  assert.equal((await ps(installedEntry, ['--version'])).stdout.trim(), record.version);
  checks.repeatInstallChecksActualStartup = true;
  assert.equal(JSON.parse(await readFile(join(install, 'current.previous.json'), 'utf8')).version, rc);
  const requests = server.calls.length,
    resumed = await ps(installedEntry, [
      cwd,
      '--home',
      home,
      '--resume',
      original.sessionId,
      '--print',
      '/tools',
    ]);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(server.calls.length, requests);
  assert.ok(resumed.stdout.includes('ECHO_COMPLETE'));
  assert.equal(await readFile(join(home, 'config.json'), 'utf8'), configBefore);
  assert.equal(await readFile(join(home, 'credentials.dpapi.json'), 'utf8'), encrypted);
  assert.equal(await readFile(join(home, 'templates/retain.json'), 'utf8'), templateBefore);
  checks.upgradePreservesConfigurationCredentialsHistoryAndTemplates = true;
  const pathEnv = { ...env, PATH: join(install, 'bin') + ';' + env.PATH };
  const onPath = await run('cmd.exe', ['/d', '/s', '/c', 'emergence --version'], pathEnv, true);
  assert.equal(onPath.code, 0, onPath.stderr);
  assert.equal(onPath.stdout.trim(), record.version);
  checks.isolatedPathCommand = true;
  const doctor = await ps(installedEntry, ['doctor', cwd, '--home', home, '--json']);
  assert.equal(doctor.code, 0, doctor.stderr);
  assert.equal(JSON.parse(doctor.stdout).ok, true);
  checks.installedDiagnostics = true;
  const hold = spawn(
    join(install, 'versions', record.version, 'runtime/node.exe'),
    ['-e', 'setInterval(()=>{},1000)'],
    { env, windowsHide: true, stdio: 'ignore' },
  );
  await new Promise<void>((done, reject) => {
    hold.once('spawn', done);
    hold.once('error', reject);
  });
  const refused = await ps(join(install, 'uninstall.ps1'), ['-NoPath']);
  hold.kill('SIGKILL');
  await new Promise<void>((done) => hold.once('exit', () => done()));
  assert.equal(refused.code, 1);
  await access(join(install, 'current.json'));
  checks.runningInstanceProtectsUninstall = true;
  console.log('Uninstalling from its own installed script…');
  const removed = await ps(join(install, 'uninstall.ps1'), ['-NoPath']);
  assert.equal(removed.code, 0, removed.stderr + removed.stdout);
  await assert.rejects(access(install));
  assert.equal(await readFile(join(home, 'config.json'), 'utf8'), configBefore);
  assert.equal(await readFile(join(home, 'credentials.dpapi.json'), 'utf8'), encrypted);
  assert.equal(await readFile(join(cwd, 'user-file.txt'), 'utf8'), 'preserve project data');
  checks.uninstallPreservesUserData = true;
  const unowned = join(root, 'not-an-installation');
  await mkdir(unowned);
  await writeFile(join(unowned, 'sentinel'), 'keep');
  const unsafe = await ps(join(source, 'uninstall.ps1'), ['-InstallRoot', unowned, '-NoPath']);
  assert.equal(unsafe.code, 1);
  assert.equal(await readFile(join(unowned, 'sentinel'), 'utf8'), 'keep');
  checks.unownedDirectoryNotRemoved = true;
  const output = {
    passed: true,
    timestamp: new Date().toISOString(),
    checks,
    root,
    archive: record.archive,
    archiveSha256: record.sha256,
    oldVersionFixture: rc,
    note: 'Release-candidate fixture uses the same locked payload with its own version. PATH resolution is tested in an isolated child environment; real user PATH was not modified.',
  };
  await writeFile(join(dir, 'release-validation.json'), JSON.stringify(output, null, 2));
  console.log(JSON.stringify(checks));
} catch (error) {
  await writeFile(
    join(dir, 'release-validation.json'),
    JSON.stringify({ passed: false, error: String(error), checks, root }, null, 2),
  );
  throw error;
} finally {
  await server.close();
}
