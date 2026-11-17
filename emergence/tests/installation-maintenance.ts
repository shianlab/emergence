// Real packaged-runtime maintenance. All paths, models and background processes are isolated fixtures.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, readdir, access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { defaultConfig } from '../src/core/domain/configuration.ts';
import { saveConfig } from '../src/app/config.ts';
import { phase6Server } from './fixtures/phase6-model-server.ts';

const directory = resolve(process.argv[2] ?? '../artifacts/install-phase2-20261117');
await mkdir(directory, { recursive: true });
const root = await mkdtemp(join(directory, 'maintenance-')),
  install = join(root, '中文 应用'),
  home = join(root, '独立 配置'),
  source = join(root, '发行副本');
const record = JSON.parse(await readFile('../artifacts/phase6/release-path.json', 'utf8'));
const manager = createRequire(import.meta.url)('../release/manage.cjs');
const files = JSON.parse(await readFile(join(record.bundle, 'manifest.sha256.json'), 'utf8'));
await manager.copyRelease(record.bundle, source, files);
const ps = join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const env: NodeJS.ProcessEnv = {
  ...process.env,
  PHASE6_RELEASE_KEY: 'maintenance-fixture',
  NODE_OPTIONS: '',
  NODE_PATH: '',
};
delete env.PSModulePath;
const children = new Set<ChildProcess>();
const start = (file: string, args: string[]) => {
  const child = spawn(file, args, { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(child);
  child.once('close', () => children.delete(child));
  return child;
};
async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return;
  const closed = new Promise<void>((done) => child.once('close', () => done()));
  const killer = spawn(
    join(process.env.SystemRoot!, 'System32/taskkill.exe'),
    ['/pid', String(child.pid), '/t', '/f'],
    { windowsHide: true, stdio: 'ignore' },
  );
  await new Promise<void>((done, reject) => {
    killer.once('error', reject);
    killer.once('close', () => done());
  });
  await closed;
}
async function run(file: string, args: string[]) {
  const child = start(file, args);
  let out = '',
    err = '';
  child.stdout!.on('data', (b) => (out += b));
  child.stderr!.on('data', (b) => (err += b));
  const timer = setTimeout(() => {
    void stop(child);
  }, 180000);
  const code = await new Promise<number | null>((done, reject) => {
    child.once('error', reject);
    child.once('close', done);
  });
  clearTimeout(timer);
  assert.equal(code, 0, err + out);
  return out;
}
const script = (file: string, args: string[] = []) =>
  run(ps, ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, ...args]);
const maintenance = (action: string, extra: string[] = []) =>
  script(join(install, 'maintenance.ps1'), ['-Action', action, '-InstallRoot', install, '-NoPath', ...extra]);
const current = async () => JSON.parse(await readFile(join(install, 'current.json'), 'utf8'));
async function version(next: string) {
  const releaseFile = join(source, 'release.json'),
    release = JSON.parse(await readFile(releaseFile, 'utf8')),
    prior = release.version;
  release.version = next;
  await writeFile(releaseFile, JSON.stringify(release, null, 2));
  const packageFile = join(source, 'app/package.json'),
    pkg = JSON.parse(await readFile(packageFile, 'utf8'));
  pkg.version = next;
  await writeFile(packageFile, JSON.stringify(pkg, null, 2));
  const cli = join(source, 'app/dist/cli.mjs'),
    text = await readFile(cli, 'utf8');
  assert.ok(text.includes('var VERSION = "' + prior + '";'));
  await writeFile(cli, text.replace('var VERSION = "' + prior + '";', 'var VERSION = "' + next + '";'));
  for (const file of files) {
    if (!['release.json', 'app/package.json', 'app/dist/cli.mjs'].includes(file.path)) continue;
    const bytes = await readFile(join(source, file.path));
    file.sha256 = createHash('sha256').update(bytes).digest('hex');
    file.bytes = bytes.length;
  }
  await writeFile(join(source, 'manifest.sha256.json'), JSON.stringify(files));
}
async function until(check: () => Promise<boolean>, label: string) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await delay(100);
  }
  throw Error(label);
}
const server = await phase6Server(),
  checks: Record<string, boolean> = {};
try {
  console.log('Installing isolated managed runtime…');
  await script(join(source, 'install.ps1'), ['-InstallRoot', install, '-NoPath']);
  const one = await current();
  assert.equal(one.version, record.version);
  assert.equal(JSON.parse(await readFile(join(install, 'installation.json'), 'utf8')).pathManaged, false);
  checks.initialManagedInstallation = true;
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
  const preserved = await readFile(join(home, 'config.json'));
  const cli = start(ps, [
    '-NoLogo',
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    join(install, 'bin/emergence.ps1'),
    home,
    '--home',
    home,
    '--print',
    'phase6:hang',
  ]);
  cli.stdout!.resume();
  cli.stderr!.resume();
  await until(async () => server.calls.length > 0, 'Managed CLI did not reach fixture model');
  const native = start(join(install, 'versions', one.directory, '涌现模型配置.exe'), ['--attach']);
  native.stdout!.resume();
  native.stderr!.resume();
  await until(
    async () =>
      (await readdir(join(install, '.usage'))).some((n) =>
        n.startsWith(one.directory + '.' + native.pid + '.'),
      ),
    'Native version lease missing',
  );
  console.log('Upgrading twice while CLI and native configuration retain the first version…');
  await version('9.0.2');
  await maintenance('update', ['-Source', source]);
  await version('9.0.3');
  await maintenance('update', ['-Source', source]);
  await access(join(install, 'versions', one.directory));
  assert.equal(cli.exitCode, null);
  assert.equal(native.exitCode, null);
  checks.runningCliAndNativeSurviveUpgrade = true;
  await stop(cli);
  await maintenance('cleanup');
  await access(join(install, 'versions', one.directory));
  checks.nativeLeaseAlonePreventsCleanup = true;
  await stop(native);
  // A reused PID in an old record cannot masquerade as a live lease.
  await writeFile(
    join(install, '.usage', one.directory + '.' + process.pid + '.stale.json'),
    JSON.stringify({ directory: one.directory, pid: process.pid, started: '1' }),
  );
  await maintenance('cleanup');
  await assert.rejects(access(join(install, 'versions', one.directory)));
  checks.exitedVersionCleanedDespiteStalePidRecord = true;
  const beforeRepair = await current(),
    old = join(install, 'versions', beforeRepair.directory);
  const hold = start(join(old, 'runtime/node.exe'), ['-e', 'setInterval(()=>{},1000)']);
  hold.stdout!.resume();
  hold.stderr!.resume();
  await new Promise<void>((done, reject) => {
    hold.once('spawn', done);
    hold.once('error', reject);
  });
  await writeFile(join(old, 'app/dist/cli.mjs'), 'broken runtime entry');
  await maintenance('repair', ['-Source', source]);
  const repaired = await current();
  assert.equal(repaired.version, '9.0.3');
  assert.notEqual(repaired.directory, beforeRepair.directory);
  assert.equal(hold.exitCode, null);
  await access(join(old, 'runtime/node.exe'));
  assert.equal((await script(join(install, 'bin/emergence.ps1'), ['--version'])).trim(), '9.0.3');
  checks.repairUsesFreshDirectoryAndPreservesRunningOldRuntime = true;
  await stop(hold);
  await maintenance('cleanup');
  await assert.rejects(access(old));
  const status = await script(join(install, 'bin/emergence.ps1'), ['installation', 'status']);
  assert.equal(JSON.parse(status).current.directory, repaired.directory);
  checks.cliStatusRoutesToInstalledManager = true;
  // NoPath preference persists through CLI maintenance, so this does not alter the real user PATH.
  await script(join(install, 'bin/emergence.ps1'), ['rollback']);
  assert.equal((await current()).version, '9.0.2');
  assert.equal((await script(join(install, 'bin/emergence.ps1'), ['--version'])).trim(), '9.0.2');
  await access(join(install, 'versions', repaired.directory, 'installation/service.cjs'));
  checks.rollbackKeepsWorkingManagementEngine = true;
  assert.deepEqual(await readFile(join(home, 'config.json')), preserved);
  checks.userConfigurationUnchanged = true;
  await script(join(install, 'uninstall.ps1'), ['-NoPath']);
  await assert.rejects(access(install));
  checks.cleanUninstall = true;
  await writeFile(
    join(directory, 'maintenance-validation.json'),
    JSON.stringify(
      {
        passed: true,
        root,
        checks,
        source: record.bundle,
        note: 'Real bundled runtime, hidden native --attach process with no UI opened, local fixture model, isolated user config. No real PATH or installed user app changed.',
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(checks));
} catch (error) {
  await writeFile(
    join(directory, 'maintenance-validation.json'),
    JSON.stringify({ passed: false, root, checks, error: String(error) }, null, 2),
  );
  throw error;
} finally {
  for (const child of children) await stop(child);
  await server.close();
}
