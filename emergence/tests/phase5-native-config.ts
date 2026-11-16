import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const output = resolve('../artifacts/iteration-20261116-phase5');
await mkdir(output, { recursive: true });
const record = JSON.parse(await readFile('../artifacts/phase6/release-path.json', 'utf8'));
const home = await mkdtemp(join(output, 'native-'));
function launch(command: string, args: string[]) {
  const child = spawn(command, args, {
    cwd: home,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      PATH: join(process.env.SystemRoot!, 'System32'),
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
    },
  });
  child.stderr.resume();
  const exited = new Promise<number | null>((done, reject) => {
    child.once('exit', done);
    child.once('error', reject);
  });
  const ready = new Promise<string>((done, reject) => {
    let buffer = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Candidate configuration did not start'));
    }, 20000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error('Exited before ready: ' + code));
    });
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.includes('\n')) {
        clearTimeout(timeout);
        done(buffer.split('\n')[0]);
      }
    });
  });
  return { child, exited, ready };
}
const service = launch(join(record.bundle, 'runtime/node.exe'), [
  '--experimental-ffi',
  '--disable-warning=ExperimentalWarning',
  join(record.bundle, 'app/dist/cli.mjs'),
  'model-config',
  '--native-service',
  '--home',
  home,
]);
let window: ChildProcessWithoutNullStreams | undefined;
try {
  const { url } = JSON.parse(await service.ready);
  const address = new URL(url);
  assert.equal((await fetch(address.origin + '/api/state')).status, 401);
  const response = await fetch(address.origin + '/api/state', {
    headers: { Authorization: 'Bearer ' + new URLSearchParams(address.hash.slice(1)).get('session') },
  });
  assert.equal(response.status, 200);
  assert.ok((await response.json()).models.length > 0);
  const native = launch(join(record.bundle, '涌现模型配置.exe'), ['--attach']);
  window = native.child;
  native.child.stdin.write(JSON.stringify({ url }) + '\n');
  assert.equal(JSON.parse(await native.ready).ready, true);
  native.child.stdin.end('{"action":"close"}\n');
  assert.equal(await native.exited, 0);
  window = undefined;
  service.child.stdin.end();
  assert.equal(await service.exited, 0);
  await assert.rejects(fetch(address.origin + '/api/state'));
  const result = {
    passed: true,
    noGlobalNode: true,
    installedService: true,
    authorizedState: true,
    unauthorizedDenied: true,
    nativeAttach: true,
    nativeExit: true,
    serviceExit: true,
  };
  await writeFile(join(output, 'native-config.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  window?.kill();
  service.child.kill();
}
