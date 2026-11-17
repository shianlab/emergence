// Explicit old-release input is read only; every mutation targets an isolated fixture installation.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const legacy = resolve(process.argv[2] ?? '');
assert.ok(process.argv[2], 'Pass an extracted published release directory');
const before = await readFile(join(legacy, 'manifest.sha256.json'));
const legacyVersion = JSON.parse(await readFile(join(legacy, 'release.json'), 'utf8')).version;
assert.match(legacyVersion, /^1\.0\.[01]$/);
const directory = resolve(process.argv[3] ?? '../artifacts/install-phase2-20261117');
await mkdir(directory, { recursive: true });
const root = await mkdtemp(join(directory, 'migration-'));
const install = join(root, '旧版迁移');
const record = JSON.parse(await readFile('../artifacts/phase6/release-path.json', 'utf8'));
const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' };
delete env.PSModulePath;
const ps = join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
async function run(file: string, args: string[], expected = 0) {
  const child = spawn(file, args, { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '',
    errors = '';
  child.stdout.on('data', (bytes) => (output += bytes));
  child.stderr.on('data', (bytes) => (errors += bytes));
  const timeout = setTimeout(() => child.kill(), 240000);
  const code = await new Promise<number | null>((done, reject) => {
    child.once('error', reject);
    child.once('close', done);
  });
  clearTimeout(timeout);
  assert.equal(code, expected, errors + output);
  return output;
}
const script = (file: string, args: string[]) =>
  run(ps, ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, ...args]);
const checks: Record<string, boolean> = {};
try {
  await script(join(legacy, 'install.ps1'), ['-InstallRoot', install, '-NoPath']);
  const original = await readFile(join(install, 'current.json'));
  checks.originalPublishedInstallerWorksInIsolation = true;
  const helper = join(root, 'interrupt.cjs');
  await writeFile(
    helper,
    'require(' +
      JSON.stringify(join(record.bundle, 'installation/service.cjs')) +
      ').createInstaller({checkpoint:async(name)=>{if(name==="activated")process.exit(77)}}).run(' +
      JSON.stringify({ action: 'install', root: install, source: record.bundle, noPath: true }) +
      ').catch(error=>{console.error(error);process.exitCode=1});',
  );
  await run(process.execPath, [helper], 77);
  await access(join(install, 'install-transaction.json'));
  const output = await script(join(install, 'bin/emergence.ps1'), ['--version']);
  assert.equal(output.trim(), legacyVersion, 'Automatic recovery must not contaminate CLI output');
  assert.deepEqual(await readFile(join(install, 'current.json')), original);
  await assert.rejects(access(join(install, 'install-transaction.json')));
  checks.interruptedMigrationRecoversOnNextLaunch = true;
  await script(join(record.bundle, 'install.ps1'), ['-InstallRoot', install, '-NoPath']);
  const current = JSON.parse(await readFile(join(install, 'current.json'), 'utf8'));
  assert.notEqual(current.directory, legacyVersion);
  assert.equal(current.version, record.version);
  assert.equal(JSON.parse(await readFile(join(install, 'installation.json'), 'utf8')).schema, 2);
  checks.legacyMigratesWithoutOverwritingVersion = true;
  await script(join(install, 'bin/emergence.ps1'), ['rollback']);
  assert.equal((await script(join(install, 'bin/emergence.ps1'), ['--version'])).trim(), legacyVersion);
  await access(join(install, 'versions', current.manager, 'installation/service.cjs'));
  checks.oldProductRunsWithNewManagerAfterRollback = true;
  const windows = createRequire(import.meta.url)('../release/installation/windows.cjs');
  // Windows process enumeration can outlive pipe closure briefly; uninstall must stay conservative.
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!(await windows.inUse(install))) break;
    await delay(100);
  }
  await script(join(install, 'uninstall.ps1'), ['-NoPath']);
  await assert.rejects(access(install));
  assert.deepEqual(await readFile(join(legacy, 'manifest.sha256.json')), before);
  checks.sourceUntouchedAndIsolatedInstallationRemoved = true;
  await writeFile(
    join(directory, 'migration-validation.json'),
    JSON.stringify({ passed: true, root, legacyVersion, candidate: record.bundle, checks }, null, 2),
  );
  console.log(JSON.stringify(checks));
} catch (error) {
  await writeFile(
    join(directory, 'migration-validation.json'),
    JSON.stringify({ passed: false, root, checks, error: String(error) }, null, 2),
  );
  throw error;
}
