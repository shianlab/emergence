import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { saveConfig } from '../src/app/config.ts';
import { defaultConfig } from '../src/core/domain/configuration.ts';
import { phase6Server } from './fixtures/phase6-model-server.ts';

const dir = resolve('../artifacts/phase6');
await mkdir(dir, { recursive: true });
const root = await mkdtemp(join(dir, 'faults-')),
  home = join(root, 'home'),
  cwd = join(root, '故障 项目');
await mkdir(cwd);
const server = await phase6Server(),
  config = structuredClone(defaultConfig);
config.models[0] = {
  ...config.models[0],
  id: 'fixture',
  provider: 'fixture',
  model: 'fixture',
  apiKeyEnv: 'PHASE6_TEST_KEY',
  baseURL: server.baseURL,
};
config.defaultModel = 'fixture';
await saveConfig(home, config);
const checks: Record<string, boolean> = {};
function launch(args: string[]) {
  const child = spawn(
    process.execPath,
    ['--experimental-ffi', resolve('dist/cli.mjs'), cwd, '--home', home, ...args],
    {
      cwd: process.cwd(),
      env: { ...process.env, PHASE6_TEST_KEY: 'phase6-test-secret' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (b) => (stdout += b));
  child.stderr.on('data', (b) => (stderr += b));
  const ended = new Promise<number | null>((done, reject) => {
    child.once('error', reject);
    child.once('exit', done);
  });
  return {
    child,
    async result() {
      const timer = setTimeout(() => child.kill(), 25000);
      const code = await ended;
      clearTimeout(timer);
      return { code, stdout, stderr };
    },
  };
}
try {
  const truncated = await launch(['--print', 'phase6:truncated']).result();
  assert.equal(truncated.code, 1, 'token truncation must not exit successfully');
  assert.match(truncated.stdout, /Token 上限/);
  assert.ok(!truncated.stdout.includes('本轮已完成'));
  checks.tokenTruncationIsIncomplete = true;
  for (const scenario of ['rate', 'server', 'disconnect']) {
    const before = server.calls.length,
      result = await launch(['--print', `phase6:${scenario}`]).result();
    assert.equal(result.code, 1, JSON.stringify(result));
    assert.equal(server.calls.length - before, 3, 'initial request plus two bounded request retries');
    assert.ok(!(result.stdout + result.stderr).includes('phase6-test-secret'));
    checks[scenario + 'StopsAfterRetryBudget'] = true;
  }
  const before = server.calls.length,
    once = await launch(['--print', 'phase6:once']).result();
  assert.equal(once.code, 1);
  assert.equal(server.calls.length - before, 5, 'analysis, write, then three failed follow-up attempts');
  assert.equal(await readFile(join(cwd, 'phase6-once.txt'), 'utf8'), 'written exactly once');
  const last = JSON.parse(await readFile(join(home, 'last-session.json'), 'utf8')),
    count = server.calls.length;
  const resumed = await launch(['--resume', last.id, '--print', '/tools']).result();
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(server.calls.length, count);
  assert.equal(
    (JSON.parse(resumed.stdout.trim().split('\n').at(-1)!).transcript as string[]).filter((s) =>
      s.startsWith('┌ 工具 write'),
    ).length,
    1,
  );
  checks.sideEffectNotReplayedAfterNetworkFailure = true;
  const running = launch(['--print', 'phase6:hang']);
  for (let i = 0; !server.activeStreams && i < 300; i++) await delay(25);
  assert.equal(server.activeStreams, 1);
  const interrupted = JSON.parse(await readFile(join(home, 'last-session.json'), 'utf8'));
  running.child.kill('SIGKILL');
  await running.result();
  for (let i = 0; server.activeStreams && i < 300; i++) await delay(25);
  assert.equal(server.activeStreams, 0, 'orphan Harness must close its stream');
  const requests = server.calls.length,
    recovered = await launch(['--resume', interrupted.id, '--print', '/tools']).result();
  assert.equal(recovered.code, 0, recovered.stderr);
  assert.equal(server.calls.length, requests);
  checks.killedLauncherReleasesHarnessAndRecoversWithoutReplay = true;
  const output = { passed: true, timestamp: new Date().toISOString(), checks, root, calls: server.calls };
  await (
    await import('node:fs/promises')
  ).writeFile(join(dir, 'faults.json'), JSON.stringify(output, null, 2));
  console.log(JSON.stringify(checks));
} finally {
  await server.close();
}
