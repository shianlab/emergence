import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homeDirectory, loadConfig, saveConfig } from '../src/app/config.ts';
import { resolveCredential } from '../src/app/credentials.ts';
import { safeError } from '../src/core/adapters/redaction.ts';
import { checkLiveBudget, liveLimits, liveMetrics } from './fixtures/live-budget.ts';
import { diagnosticSnapshots, observeUntil, stopOwnedProcess } from './fixtures/observation.ts';

if (!process.argv.includes('--live')) throw new Error('Explicit --live required');
const dir = resolve(process.env.EMERGENCE_TEAM_LIVE_DIR!);
const home = join(dir, 'home'),
  project = join(dir, 'project');
await mkdir(project, { recursive: true });
const config = await loadConfig(homeDirectory());
const model = config.models.find((m) => m.id === process.env.EMERGENCE_LIVE_MASTER);
if (!model) throw new Error('Live model not configured');
const credential = await resolveCredential(homeDirectory(), model.apiKeyEnv);
assert.ok(credential, 'Live credentials unavailable');
const data = process.env.EMERGENCE_LIVE_SAMPLE === 'data';
const input = data
  ? 'channel,revenue\nA,100\nB,200\nA,50\n'
  : 'exports.sum = values => values.reduce((a,b) => a+b);\n';
const inputName = data ? 'sales.csv' : 'sum.cjs';
await writeFile(join(project, inputName), input);
const check = data
  ? "const a=require('node:assert/strict');a.deepEqual(require('./totals.json'),{A:150,B:200,total:350});console.log('data verified');\n"
  : "const a=require('node:assert/strict'),{sum}=require('./sum.cjs');a.equal(sum([]),0);a.equal(sum([1,2,3]),6);a.equal(sum([-2,2]),0);console.log('code verified');\n";
await writeFile(join(project, 'verify.cjs'), check);
const quote = (s: string) => "'" + s.replaceAll("'", "''") + "'";
const command = `& ${quote(process.execPath.replaceAll('\\', '/'))} './verify.cjs'`;
const prompt =
  (data
    ? '请读取 sales.csv，按 channel 汇总 revenue，并计算总收入。生成 totals.json，格式为各渠道数字键值加 total；不修改原数据。'
    : '请修复 sum.cjs，使空数组求和返回 0，并保持普通和负数数组的正确结果。') +
  `验收脚本 verify.cjs 不得改动，完成后只运行已授权的精确命令验证：${command}。命令前后不得追加语句，退出码由工具返回。当前为 Windows PowerShell；只修改本目录任务产物，不访问外部服务。`;
await writeFile(
  join(dir, 'input.json'),
  JSON.stringify({ prompt, command, model: model.id, limits: liveLimits, deadlineMs: 300000 }, null, 2),
);
await saveConfig(home, {
  ...config,
  defaultModel: model.id,
  models: [{ ...model, maxTokens: liveLimits.outputTokens }],
  windowModels: { slots: {} },
  mcp: [],
  extensions: [],
  skillDirs: [],
  permissions: {
    defaultMode: 'auto',
    rules: [
      { tool: 'write', path: join(project, 'verify.cjs'), effect: 'deny' },
      { tool: 'edit', path: join(project, 'verify.cjs'), effect: 'deny' },
    ],
  },
  toolPolicy: { deny: ['bash', 'subagent', 'mcp__*', 'web_search', 'web_fetch'], confirm: [] },
});
const started = Date.now();
const child = spawn(
  process.execPath,
  ['bin/emergence.cjs', project, '--home', home, '--approve-command', command, '--print', prompt],
  {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, [model.apiKeyEnv]: credential },
  },
);
let ended = false,
  code: number | null = null,
  output = '',
  stderr = '',
  passed = false,
  error: string | undefined;
child.once('exit', (value) => {
  code = value;
  ended = true;
});
child.once('error', (e) => {
  error = safeError(e);
  ended = true;
});
child.stdout.on('data', (b) => {
  output = (output + b).slice(-600000);
});
child.stderr.on('data', (b) => {
  stderr = (stderr + b).slice(-600000);
});
const stop = () =>
  stopOwnedProcess(
    {
      pid: child.pid!,
      kill: () => {
        child.kill();
      },
    },
    () => ended,
  );
try {
  await observeUntil(
    'single task completion',
    async () => {
      await checkLiveBudget(home);
      return ended;
    },
    {
      limitMs: 300000,
      snapshot: async () => ({ diagnostics: await diagnosticSnapshots(home) }),
      stop,
    },
  );
  assert.equal(code, 0, error ?? stderr);
  assert.equal(await readFile(join(project, 'verify.cjs'), 'utf8'), check);
  if (data) {
    assert.equal(await readFile(join(project, inputName), 'utf8'), input);
    assert.deepEqual(JSON.parse(await readFile(join(project, 'totals.json'), 'utf8')), {
      A: 150,
      B: 200,
      total: 350,
    });
  }
  const calls = new Set<string>();
  let verified = false;
  for (const file of (await readdir(join(home, 'sessions'), { recursive: true })).filter((f) =>
    f.endsWith('session.v4.jsonl'),
  )) {
    for (const line of (await readFile(join(home, 'sessions', file), 'utf8')).split('\n').filter(Boolean)) {
      const event = JSON.parse(line);
      if (
        event.type === 'tool/call' &&
        event.data.name === 'pwsh' &&
        JSON.parse(event.data.arguments).command === command
      )
        calls.add(event.data.callId);
      if (
        event.type === 'tool/result' &&
        calls.has(event.data.message.toolCallId) &&
        !event.data.message.isError &&
        JSON.stringify(event.data.message).includes(data ? 'data verified' : 'code verified')
      )
        verified = true;
    }
  }
  assert.ok(verified, 'Production agent must execute the unchanged real verifier successfully');
  const diagnostics = await diagnosticSnapshots(home);
  assert.ok(diagnostics.length > 0, 'Final runtime diagnostics are required');
  assert.ok(
    diagnostics.every((d) => d.runs.every((run) => run.outcome !== 'running')),
    'Runtime timing snapshot remained running after process exit; metrics are incomplete',
  );
  passed = true;
} catch (e) {
  error = safeError(e);
} finally {
  try {
    await stop();
  } catch (e) {
    passed = false;
    error = [error, safeError(e)].filter(Boolean).join('; ');
  }
  await writeFile(join(dir, 'output.txt'), safeError(output));
  await writeFile(join(dir, 'stderr.txt'), safeError(stderr));
  await writeFile(
    join(dir, 'result.json'),
    JSON.stringify(
      {
        passed,
        error,
        model: model.id,
        data,
        project,
        home,
        durationMs: Date.now() - started,
        processExitConfirmed: ended,
        metrics: await liveMetrics(home),
        diagnostics: await diagnosticSnapshots(home),
        verifierHash: createHash('sha256').update(check).digest('hex'),
      },
      null,
      2,
    ),
  );
}
console.log(passed ? 'PASS single real task' : 'FAIL single real task; see result.json');
process.exitCode = passed ? 0 : 1;
