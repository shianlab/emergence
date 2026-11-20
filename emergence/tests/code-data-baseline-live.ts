// Explicit, bounded live baseline. Never included by tests/*.test.ts.
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { homeDirectory, loadConfig, saveConfig } from '../src/app/config.ts';
import { resolveCredential } from '../src/app/credentials.ts';
import { SessionUsage } from '../src/app/tui/session-usage.ts';
import { safeError } from '../src/core/adapters/redaction.ts';
import { digest } from '../src/core/storage/execution-journal.ts';

if (!process.argv.includes('--live')) throw new Error('Use --live to run two real API tasks');
const output = resolve('../artifacts/code-data-phase1');
await mkdir(output, { recursive: true });
const originalHome = homeDirectory(),
  config = await loadConfig(originalHome);
const model = config.models.find((m) => m.id === config.defaultModel)!;
const credential = await resolveCredential(originalHome, model.apiKeyEnv);
if (!credential) throw new Error('Configured credential unavailable; no request sent');
const root = await mkdtemp(join(output, 'live-baseline-'));
const nodeCommand = (script: string) => `& '${process.execPath.replaceAll("'", "''")}' '${script}'`;
const scenarios = [
  {
    id: 'C1-js-boundary',
    files: {
      'range.cjs': 'module.exports = function range(n) { return Array.from({length:n+1},(_,i)=>i); };\n',
      'check.cjs':
        "const assert=require('node:assert/strict');const range=require('./range.cjs');assert.deepEqual(range(3),[0,1,2]);assert.deepEqual(range(0),[]);console.log('CODE_CHECK_PASSED');\n",
    },
    prompt:
      '修复 range.cjs：range(n) 对非负整数 n 返回从 0 到 n-1 的数组；n=0 返回空数组。只能修改 range.cjs，不改 check.cjs。读取文件、分析后修改，使用给定命令执行 check.cjs 验证，并报告真实结果。',
    script: 'check.cjs',
    marker: 'CODE_CHECK_PASSED',
  },
  {
    id: 'D1-csv-revenue',
    files: {
      'orders.csv':
        'order_id,region,status,amount\nA,east,paid,100\nB,west,paid,40\nB,west,paid,40\nC,east,refunded,60\nD,east,paid,20.5\nE,west,paid,\nF,west,paid,10\n',
    },
    prompt:
      '分析 orders.csv：按 order_id 去重（保留首次），只计 status=paid 且 amount 非空有效数字的收入；保留其他行的剔除计数。创建 analyze.cjs，用 Node 内置 fs 读取真实 CSV 并计算，写 metrics.json，字段固定为 totalRevenue、byRegion（east/west）、validOrders、duplicateRows、excludedRefunded、excludedMissingAmount。不得硬编码结果或修改 CSV。用给定命令执行脚本，成功后打印 DATA_CALCULATED。',
    script: 'analyze.cjs',
    marker: 'DATA_CALCULATED',
  },
];
const results: object[] = [];
for (const scenario of scenarios) {
  const cwd = join(root, scenario.id),
    home = join(cwd, 'profile');
  await mkdir(cwd);
  for (const [name, text] of Object.entries(scenario.files)) await writeFile(join(cwd, name), text!);
  const allowed = nodeCommand(scenario.script);
  const deny = [
    'subagent',
    'skill',
    'bash',
    'emergence_dispatch',
    'emergence_execute_plan',
    'emergence_audit',
    'emergence_memory_propose',
  ];
  const protectedPaths = scenario.id.startsWith('C') ? ['check.cjs'] : ['orders.csv'];
  await saveConfig(home, {
    ...config,
    defaultModel: model.id,
    models: [{ ...model, maxTokens: 2048 }],
    windowModels: { slots: {} },
    mcp: [],
    skillDirs: [],
    extensions: [],
    toolPolicy: { deny, confirm: [] },
    permissions: {
      defaultMode: 'edit',
      rules: protectedPaths.flatMap((path) =>
        ['write', 'edit'].map((tool) => ({ tool, path, effect: 'deny' as const })),
      ),
    },
  });
  const prompt =
    scenario.prompt +
    '\n仅使用 read/write/edit/pwsh 和内置需求分析；任务规模很小，无需派工。唯一已授权的运行命令（原样使用）：' +
    allowed;
  const cliHashAtStart = digest(await readFile('dist/cli.mjs', 'utf8'));
  const start = Date.now(),
    child = spawn(
      process.execPath,
      [
        'bin/emergence.cjs',
        cwd,
        '--home',
        home,
        '--permission',
        'edit',
        '--approve-command',
        allowed,
        '--print',
        prompt,
      ],
      {
        env: { ...process.env, [model.apiKeyEnv]: credential },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
  let stdout = '',
    stderr = '',
    timedOut = false;
  const append = (value: Buffer, channel: 'stdout' | 'stderr') => {
    if (channel === 'stdout') stdout += value;
    else stderr += value;
    if (stdout.length + stderr.length > 2_000_000) child.kill();
  };
  child.stdout.on('data', (b) => append(b, 'stdout'));
  child.stderr.on('data', (b) => append(b, 'stderr'));
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 120000);
  let passed = false,
    diagnostic: string | undefined,
    toolExecuted = false,
    toolCalls: number | null = null;
  let tokenUsage: { total: number; reported: number; missing: number } | null = null;
  let code: number | null = null;
  try {
    code = await new Promise<number | null>((done, reject) => {
      child.once('error', reject);
      child.once('exit', done);
    });
    assert.equal(code, 0, timedOut ? 'time budget exceeded' : safeError(stderr));
    const response = JSON.parse(stdout.trim().split('\n').at(-1)!);
    assert.ok(!response.error, response.error);
    const sessions = join(home, 'sessions');
    const sessionFile = (await readdir(sessions, { recursive: true })).find(
      (p) => p.endsWith('session.v4.jsonl') && p.includes(response.sessionId),
    );
    assert.ok(sessionFile, 'actual session log missing');
    const events = (await readFile(join(sessions, sessionFile), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const calls = events.filter((e) => e.type === 'tool/call');
    toolCalls = calls.length;
    const usage = new SessionUsage();
    for (const event of events) if (typeof event.seq === 'number') usage.append(event as SessionEvent);
    tokenUsage = { total: usage.total, reported: usage.reported, missing: usage.missing };
    const shellCalls = new Set(calls.filter((e) => e.data.name === 'pwsh').map((e) => e.data.callId));
    toolExecuted = events.some(
      (e) =>
        e.type === 'tool/result' &&
        shellCalls.has(e.data.message.toolCallId) &&
        !e.data.message.isError &&
        e.data.message.content.some(
          (b: { type: string; text?: string }) => b.type === 'text' && b.text?.includes(scenario.marker),
        ),
    );
    assert.ok(toolExecuted, 'no process tool observed');
    assert.ok(
      events.some(
        (e) => e.type === 'job/settled' && e.data.status === 'completed' && e.data.detail === 'exit code: 0',
      ),
      'successful process exit absent',
    );
    for (const name of protectedPaths)
      assert.equal(
        await readFile(join(cwd, name), 'utf8'),
        scenario.files[name as keyof typeof scenario.files],
        'input/check fixture modified',
      );
    if (scenario.id.startsWith('C')) {
      const source = await readFile(join(cwd, 'range.cjs'), 'utf8');
      // Functional held-out checks; VM is a timeout mechanism, not a security sandbox.
      for (const n of [0, 1, 3, 17]) {
        const value = runInNewContext(
          source + `;JSON.stringify(module.exports(${n}))`,
          { module: { exports: {} } },
          { timeout: 1000 },
        );
        assert.deepEqual(
          JSON.parse(value),
          Array.from({ length: n }, (_, i) => i),
        );
      }
    } else {
      const metrics = JSON.parse(await readFile(join(cwd, 'metrics.json'), 'utf8'));
      assert.deepEqual(metrics, {
        totalRevenue: 170.5,
        byRegion: { east: 120.5, west: 50 },
        validOrders: 4,
        duplicateRows: 1,
        excludedRefunded: 1,
        excludedMissingAmount: 1,
      });
      assert.ok(
        (await readFile(join(cwd, 'analyze.cjs'), 'utf8')).includes('readFile'),
        'source must read actual input',
      );
    }
    passed = true;
  } catch (error) {
    diagnostic = safeError(error);
  } finally {
    clearTimeout(timeout);
  }
  await writeFile(join(cwd, 'cli-output.log'), safeError(stdout + '\n' + stderr));
  const cliHashAtEnd = digest(await readFile('dist/cli.mjs', 'utf8'));
  if (cliHashAtStart !== cliHashAtEnd) {
    passed = false;
    diagnostic = 'CLI build changed during live task; sample is not version-stable';
  }
  const result = {
    id: scenario.id,
    passed,
    diagnostic,
    exitCode: code,
    timedOut,
    toolExecuted,
    toolCalls,
    tokenUsage,
    cliHashAtStart,
    cliHashAtEnd,
    durationMs: Date.now() - start,
    promptHash: digest(prompt),
    inputHashes: Object.fromEntries(Object.entries(scenario.files).map(([k, v]) => [k, digest(v)])),
    project: cwd,
  };
  results.push(result);
  console.log(JSON.stringify(result));
}
const report = {
  schemaVersion: 1,
  timestamp: new Date().toISOString(),
  kind: 'initial-live-smoke-baseline-not-quality-benchmark',
  model: {
    id: model.id,
    provider: model.provider,
    model: model.model,
    api: model.api,
    maxTokens: 2048,
    temperature: 'provider/default',
  },
  environment: { node: process.version, platform: process.platform },
  budgets: { timeoutMsPerTask: 120000, outputBytesPerTask: 2000000, toolCalls: null },
  cliHash: digest(await readFile('dist/cli.mjs', 'utf8')),
  runnerHash: digest(await readFile('tests/code-data-baseline-live.ts', 'utf8')),
  cost: null,
  results,
  limitations: [
    'Two small synthetic tasks, one sample each; no claim about overall model quality or improvement.',
    'Task process checks plus host output assertions; no general-purpose code/data domain engine yet.',
    'Null cost/tool budget means not measured/bounded, not zero. Token receipts may be partial. No comparison against the pre-change binary.',
    'No large-data, Excel, Parquet, SQL, LSP, statistical-inference or multiwindow quality measurement in this baseline.',
  ],
};
await writeFile(join(output, 'live-baseline.json'), JSON.stringify(report, null, 2));
if (results.some((r) => !(r as { passed: boolean }).passed)) process.exitCode = 1;
