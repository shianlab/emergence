import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { saveConfig } from '../src/app/config.ts';
import { startModelConfiguration } from '../src/app/model-config.ts';
import { defaultConfig } from '../src/core/domain/configuration.ts';

if (process.platform !== 'win32') throw new Error('Native acceptance targets Windows');
const directory = resolve('../artifacts/model-configuration');
await mkdir(directory, { recursive: true });
const home = await mkdtemp(join(directory, 'native-lifecycle-')),
  config = structuredClone(defaultConfig);
// The UI acceptance opens Advanced and saves unchanged, covering the old numeric cap/Int32 overflow.
config.models[0].contextWindow = Number.MAX_SAFE_INTEGER;
config.models[0].maxTokens = 2147483648;
await saveConfig(home, config);
const initial = await readFile(join(home, 'config.json'), 'utf8'),
  executable = resolve('dist/model-config/涌现模型配置.exe');
const binary = await readFile(executable),
  header = binary.readUInt32LE(0x3c);
assert.equal(binary.readUInt16LE(header + 24 + 68), 2, 'Executable must use the Windows GUI subsystem');
async function launch(args: string[], url?: string) {
  const process = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: false });
  let output = '',
    diagnostic = '';
  process.stderr.on('data', (chunk) => (diagnostic += chunk));
  const exited = new Promise<number | null>((done) => process.once('exit', done));
  await new Promise<void>((done, reject) => {
    const timer = setTimeout(() => {
      process.kill();
      reject(new Error('Native window did not become ready: ' + diagnostic));
    }, 20000);
    process.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    process.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error('Native exit before ready: ' + code + ' ' + diagnostic));
    });
    process.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('"ready":true')) {
        clearTimeout(timer);
        done();
      }
    });
    if (url) process.stdin.write(JSON.stringify({ url }) + '\n');
  });
  return { process, exited, ready: JSON.parse(output.split('\n')[0]) as { backendPid: number } };
}
const service = await startModelConfiguration(home);
try {
  const attached = await launch(['--attach'], service.url);
  attached.process.stdin.write('{"action":"focus"}\n');
  attached.process.stdin.end('{"action":"close"}\n');
  assert.equal(await attached.exited, 0);
  assert.equal((await fetch(service.origin)).status, 404);
  // A second attached window can be opened after the first closes; the TUI service remains alive.
  const reopened = await launch(['--attach'], service.url);
  reopened.process.stdin.end();
  assert.equal(await reopened.exited, 0);
} finally {
  await service.close();
}
// The executable owns its hidden backend in standalone mode; closing it must terminate that process too.
const standalone = await launch(['--home', home]);
// No test-only UI command channel is exposed in standalone mode. Windows Close is exercised by UI acceptance.
await writeFile(
  join(directory, 'native-standalone-process.json'),
  JSON.stringify({ pid: standalone.process.pid, home }),
);
console.log('NATIVE_STANDALONE_READY ' + standalone.process.pid);
const timeout = setTimeout(() => standalone.process.kill(), 180000);
const exitCode = await standalone.exited;
clearTimeout(timeout);
assert.equal(exitCode, 0);
let backendAlive = true;
for (let attempt = 0; attempt < 30; attempt++) {
  try {
    process.kill(standalone.ready.backendPid, 0);
  } catch {
    backendAlive = false;
    break;
  }
  await new Promise((done) => setTimeout(done, 100));
}
assert.equal(backendAlive, false, 'Closing the native application must exit its hidden backend');
assert.equal(await readFile(join(home, 'config.json'), 'utf8'), initial);
const report = {
  passed: true,
  guiSubsystem: true,
  binaryBytes: binary.length,
  noConfigurationMutation: true,
  attachedReopen: true,
  parentPipeClosure: true,
  standaloneExit: true,
  hiddenBackendExit: true,
};
await writeFile(join(directory, 'native-lifecycle.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
