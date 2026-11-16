import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homeDirectory, loadConfig } from '../src/app/config.ts';
import { readCredentials } from '../src/app/credentials.ts';
import { safeError } from '../src/core/adapters/redaction.ts';

const artifacts = resolve('../artifacts/phase2');
await mkdir(artifacts, { recursive: true });
const home = homeDirectory();
const config = await loadConfig(home);
const route = config.models.find((m) => m.id === 'deepseek');
assert.ok(
  route && new URL(route.baseURL).hostname === 'api.deepseek.com',
  'Live verification only targets the configured official DeepSeek endpoint',
);
const secrets = await readCredentials(home);
const key = process.env[route.apiKeyEnv] || secrets[route.apiKeyEnv];
assert.ok(key, 'DeepSeek credential must be configured first');
process.env[route.apiKeyEnv] = key;
const project = await mkdtemp(join(artifacts, 'live-deepseek-'));
const marker = `EMERGENCE_LIVE_${randomUUID()}`;
const prompt = `这是涌现应用的最小端到端验收。在当前工作目录中，仅使用 write 工具创建 live-proof.txt，内容精确为 ${marker}；然后用 read 工具读回确认。不使用 shell，不访问其他路径、不使用网络或其他工具。完成后仅回复 LIVE_VERIFIED。`;

async function run(args: string[]) {
  const started = performance.now();
  const child = spawn(
    process.execPath,
    [
      '--experimental-ffi',
      '--disable-warning=ExperimentalWarning',
      'dist/cli.mjs',
      project,
      '--home',
      home,
      '--model',
      'deepseek',
      ...args,
    ],
    { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (value) => (stdout += value));
  child.stderr.on('data', (value) => (stderr += value));
  const timeout = setTimeout(() => child.kill(), 120000);
  child.on('error', () => clearTimeout(timeout));
  const code = await new Promise<number | null>((resolveExit) => child.on('exit', resolveExit));
  clearTimeout(timeout);
  const cleanOutput = stdout.replaceAll(key!, '[已隐藏]');
  const line = cleanOutput
    .trim()
    .split('\n')
    .findLast((value) => value.startsWith('{'));
  if (code !== 0 || !line)
    throw new Error(`Live request failed: ${safeError(stderr || cleanOutput).slice(-1500)}`);
  return { payload: JSON.parse(line), durationMs: Math.round(performance.now() - started) };
}
try {
  const first = await run(['--print', prompt]);
  assert.equal((await readFile(join(project, 'live-proof.txt'), 'utf8')).trim(), marker);
  const transcript = first.payload.transcript as string[];
  assert.ok(transcript.some((line) => line.startsWith('┌ 工具 write')));
  assert.ok(transcript.some((line) => line.startsWith('┌ 工具 read')));
  assert.ok(!transcript.some((line) => line.startsWith('└ 失败')));
  assert.ok(transcript.some((line) => line.includes('LIVE_VERIFIED')));
  const restored = await run(['--resume', first.payload.sessionId, '--print', '/tools']);
  assert.ok((restored.payload.transcript as string[]).some((line) => line.includes('LIVE_VERIFIED')));
  const report = {
    timestamp: new Date().toISOString(),
    passed: true,
    provider: 'DeepSeek official',
    model: route.model,
    externalNetwork: true,
    authenticated: true,
    project,
    sessionId: first.payload.sessionId,
    checks: {
      realModelReply: true,
      fileWrite: true,
      fileRead: true,
      toolResultsSuccessful: true,
      crossProcessResume: true,
    },
    durationMs: first.durationMs + restored.durationMs,
    credentialsInReport: false,
  };
  await writeFile(join(artifacts, 'live-deepseek.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  const report = {
    timestamp: new Date().toISOString(),
    passed: false,
    model: route.model,
    project,
    error: safeError(error),
  };
  await writeFile(join(artifacts, 'live-deepseek.json'), JSON.stringify(report, null, 2));
  console.error(report.error);
  process.exitCode = 1;
}
