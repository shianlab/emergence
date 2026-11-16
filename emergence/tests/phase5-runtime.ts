import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { saveConfig } from '../src/app/config.ts';
import { defaultConfig } from '../src/core/domain/configuration.ts';
import { installationModelServer } from './fixtures/installation-model-server.ts';

const execute = promisify(execFile);
const output = resolve('../artifacts/iteration-20261116-phase5');
const candidate = JSON.parse(await readFile('../artifacts/phase6/release-path.json', 'utf8'));
const app = join(candidate.bundle, 'app');
const node = join(candidate.bundle, 'runtime/node.exe');
const cli = join(app, 'bin/emergence.cjs');
const root = await mkdtemp(join(output, 'clean-'));
const home = join(root, 'home'),
  project = join(root, '中文 项目');
await mkdir(project);
const environment = Object.fromEntries(
  [
    'SystemRoot',
    'WINDIR',
    'COMSPEC',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'LOCALAPPDATA',
    'APPDATA',
    'PATHEXT',
  ].flatMap((key) => (process.env[key] ? [[key, process.env[key]!]] : [])),
);
environment.PATH = join(process.env.SystemRoot!, 'System32');
environment.INSTALLATION_FIXTURE_KEY = 'isolated-local-fixture';
const python = resolve(
  process.env.EMERGENCE_TEST_PYTHON ??
    (
      await execute(resolve('.data-venv/Scripts/python.exe'), [
        '-I',
        '-B',
        '-X',
        'utf8',
        '-c',
        'import sys; print(sys._base_executable)',
      ])
    ).stdout.trim(),
);
const wheels = resolve(process.env.EMERGENCE_TEST_WHEELS ?? join(output, 'wheels'));
const run = async (args: string[]) =>
  (
    await execute(node, [cli, '--home', home, ...args], {
      cwd: project,
      env: environment,
      windowsHide: true,
      timeout: 300000,
      maxBuffer: 4 * 1024 * 1024,
    })
  ).stdout;
const checks: Record<string, boolean> = {};
const server = await installationModelServer();
try {
  await assert.rejects(access(join(app, 'src')));
  await assert.rejects(access(join(app, '.data-venv')));
  assert.equal((await run(['--version'])).trim(), candidate.version);
  const before = JSON.parse(await run(['doctor', '--json']));
  assert.equal(before.ok, true);
  assert.equal(before.checks.find((check: { name: string }) => check.name === 'data').status, 'warning');
  await assert.rejects(access(home));
  checks.noSourceNoGlobalNodeMissingDataExplained = true;

  const installed = JSON.parse(
    await run(['data-init', '--python', python, '--offline', '--wheel-dir', wheels]),
  );
  assert.equal(installed.changed, true);
  assert.ok(installed.python.startsWith(home));
  assert.equal(JSON.parse(await run(['data-init', '--python', python, '--offline'])).changed, false);
  const pointers = await readdir(join(home, 'runtimes/data'));
  const active = join(home, 'runtimes/data', pointers[0], 'active.json');
  const activeBefore = await readFile(active, 'utf8');
  checks.hashLockedOfflineSetupAndIdempotence = true;

  await assert.rejects(
    run(['data-init', '--python', python, '--offline', '--force-data-init']),
    /原环境未切换/,
  );
  assert.equal(await readFile(active, 'utf8'), activeBefore);
  assert.equal(
    (await readdir(join(home, 'runtimes/data', pointers[0]))).filter((file) => !file.endsWith('.json'))
      .length,
    1,
  );
  const healthy = JSON.parse(await run(['doctor', '--json']));
  assert.equal(healthy.checks.find((check: { name: string }) => check.name === 'data').status, 'ok');
  checks.failedRebuildKeepsActiveEnvironment = true;

  const corruptWheels = join(root, 'corrupt-wheels');
  await mkdir(corruptWheels);
  const lock = JSON.parse(await readFile(join(app, 'dist/data/runtime-lock.json'), 'utf8'));
  const firstWheel = lock.packages[0].wheel;
  await writeFile(
    join(corruptWheels, firstWheel),
    Buffer.concat([await readFile(join(wheels, firstWheel)), Buffer.from('corrupted fixture')]),
  );
  await assert.rejects(
    run(['data-init', '--python', python, '--offline', '--wheel-dir', corruptWheels, '--force-data-init']),
    /DO NOT MATCH THE HASHES/,
  );
  assert.equal(await readFile(active, 'utf8'), activeBefore);
  checks.corruptWheelRejectedWithoutChangingActiveEnvironment = true;

  const rebuilt = JSON.parse(
    await run(['data-init', '--python', python, '--offline', '--wheel-dir', wheels, '--force-data-init']),
  );
  assert.equal(rebuilt.changed, true);
  assert.notEqual(rebuilt.python, installed.python);
  await access(installed.python);
  const runtimeFiles = await readdir(join(home, 'runtimes/data', pointers[0]));
  const backups = runtimeFiles.filter((file) => file.startsWith('active.backup-'));
  assert.equal(backups.length, 1);
  assert.equal(await readFile(join(home, 'runtimes/data', pointers[0], backups[0]), 'utf8'), activeBefore);
  assert.equal(runtimeFiles.filter((file) => !file.endsWith('.json')).length, 2);
  assert.notEqual(await readFile(active, 'utf8'), activeBefore);
  checks.successfulRebuildBacksUpPointerAndPreservesOldEnvironment = true;

  const config = structuredClone(defaultConfig);
  config.models[0].baseURL = server.baseURL;
  config.models[0].apiKeyEnv = 'INSTALLATION_FIXTURE_KEY';
  config.permissions.defaultMode = 'auto';
  config.extensions = [];
  config.mcp = [];
  await saveConfig(home, config);
  await writeFile(join(project, 'answer.txt'), 'original user text\n');
  const csv = 'id,amount\n001,12.50\n002,7.50\n';
  await writeFile(join(project, 'sales.csv'), csv);
  const transcript = await run([
    project,
    '--print',
    '核对本地安装：读取并更新 answer.txt，分析 sales.csv 并输出报告，不更改原始数据。',
  ]);
  await writeFile(join(root, 'transcript.json'), transcript);
  assert.match(transcript, /INSTALLATION_TOOL_SEQUENCE_FINISHED/);
  assert.equal(server.receipts.length, 8);
  assert.equal(await readFile(join(project, 'answer.txt'), 'utf8'), 'verified installed code\n');
  assert.equal(await readFile(join(project, 'sales.csv'), 'utf8'), csv);
  const runs = await readdir(join(home, 'core/data-runs'));
  let total = false,
    report = false;
  for (const name of runs) {
    const directory = join(home, 'core/data-runs', name);
    const result = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'));
    total ||= JSON.stringify(result.query?.rows) === '[["20.00"]]';
    if (result.analysis?.method === 'clean') {
      await access(join(directory, 'report.html'));
      await access(join(directory, 'replay.py'));
      report = true;
    }
  }
  assert.ok(total && report, 'Missing actual SQL calculation or analysis report');
  assert.ok((await readdir(join(home, 'core/code-runs'))).length > 0);
  checks.installedKimCodeDataAndReportUseActualTools = true;
  const resource = join(app, 'dist/data/worker.py');
  const original = await readFile(resource);
  try {
    await writeFile(resource, Buffer.concat([original, Buffer.from('\n# corruption fixture\n')]));
    const damaged = JSON.parse(await run(['doctor', '--json']));
    assert.equal(damaged.checks.find((check: { name: string }) => check.name === 'data').status, 'warning');
    await assert.rejects(run(['data-init', '--python', python, '--offline']), /校验失败/);
  } finally {
    await writeFile(resource, original);
  }
  checks.corruptAssetsAreRejectedBeforeExecution = true;
  await writeFile(
    join(output, 'clean-runtime.json'),
    JSON.stringify(
      {
        passed: true,
        checks,
        root,
        bundle: candidate.bundle,
        isolatedEnvironment: true,
        externalModelRequests: false,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(checks));
} catch (error) {
  await writeFile(
    join(output, 'clean-runtime.json'),
    JSON.stringify({ passed: false, checks, root, error: String(error) }, null, 2),
  );
  throw error;
} finally {
  await server.close();
}
