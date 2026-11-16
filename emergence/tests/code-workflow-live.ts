// Explicit bounded live sample; no user project or configuration is modified.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homeDirectory, loadConfig, saveConfig } from '../src/app/config.ts';
import { hydrateCredentials } from '../src/app/credentials.ts';
import { SessionUsage } from '../src/app/tui/session-usage.ts';
import { safeError } from '../src/core/adapters/redaction.ts';
import { digest } from '../src/core/storage/execution-journal.ts';

if (!process.argv.includes('--live')) throw new Error('Use --live for the real model sample');
const directory = resolve('../artifacts/code-data-phase3');
await mkdir(directory, { recursive: true });
const root = await mkdtemp(join(directory, 'live-')),
  cwd = join(root, '中文项目'),
  home = join(root, 'profile');
await mkdir(join(cwd, 'tests'), { recursive: true });
const unchanged = {
  'package.json': '{"name":"code-fix-fixture","type":"module","scripts":{"test":"node --test"}}',
  'EMERGENCE.md':
    '这是小型加法项目。只修复计算.js，保留现有测试与配置，不安装依赖。使用项目已有 npm 测试脚本验证。',
  'tests/calc.test.js':
    "import { add } from '../计算.js';\nimport assert from 'node:assert/strict';\nimport { test } from 'node:test';\ntest('positive', () => assert.equal(add(2,3),5));\ntest('negative', () => assert.equal(add(-2,-3),-5));\n",
};
for (const [path, text] of Object.entries(unchanged)) await writeFile(join(cwd, path), text);
await writeFile(join(cwd, '计算.js'), 'export const add = (a, b) => a - b;\r\n');
const config = await loadConfig(homeDirectory()),
  model = config.models.find((m) => m.id === config.defaultModel)!;
await hydrateCredentials(homeDirectory(), [model.apiKeyEnv]);
if (!process.env[model.apiKeyEnv]) throw new Error('No configured credential; no request sent');
await saveConfig(home, {
  ...config,
  models: [{ ...model, maxTokens: 1400 }],
  windowModels: { slots: {} },
  mcp: [],
  skillDirs: [],
  extensions: [],
  permissions: {
    defaultMode: 'auto',
    rules: ['npm run test', 'npm test'].map((command) => ({
      tool: 'pwsh',
      command,
      effect: 'allow' as const,
    })),
  },
  toolPolicy: { deny: ['skill', 'subagent'], confirm: [] },
});
const cliHash = digest(await readFile('dist/cli.mjs', 'utf8')),
  pluginHash = digest(await readFile('dist/plugin.mjs', 'utf8'));
const started = Date.now();
let passed = false,
  diagnostic: string | undefined,
  counts: object | undefined;
try {
  const child = spawn(
    process.execPath,
    [
      'bin/emergence.cjs',
      cwd,
      '--home',
      home,
      '--permission',
      'auto',
      '--print',
      '这个项目的加法结果算错了，请复现错误，修复实现并运行现有测试确认。保留现有测试和配置，说明实际修改和验证结果。',
    ],
    {
      windowsHide: true,
      env: { ...process.env, PATH: dirname(process.execPath) + ';' + process.env.PATH },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '',
    errors = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
    if (output.length > 2_000_000) child.kill();
  });
  child.stderr.on('data', (chunk) => {
    errors += chunk;
  });
  const timer = setTimeout(() => child.kill(), 180000);
  const code = await new Promise<number | null>((done, reject) => {
    child.once('exit', done);
    child.once('error', reject);
  }).finally(() => clearTimeout(timer));
  await writeFile(join(root, 'transcript.log'), safeError(output + '\n' + errors));
  assert.equal(code, 0, safeError(errors));
  const result = JSON.parse(output.trim().split('\n').at(-1)!);
  assert.ok(!result.error, result.error);
  const sessionPath = (await readdir(join(home, 'sessions'), { recursive: true })).find(
    (p) => p.endsWith('session.v4.jsonl') && p.includes(result.sessionId),
  )!;
  const events = (await readFile(join(home, 'sessions', sessionPath), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const records = (await readdir(join(home, 'core/code-runs'))).filter((p) => p.endsWith('.json'));
  assert.equal(records.length, 1);
  const run = JSON.parse(await readFile(join(home, 'core/code-runs', records[0]), 'utf8'));
  assert.ok(run.checks.some((c: any) => c.phase === 'baseline' && c.exitCode !== 0));
  assert.ok(
    run.checks.some(
      (c: any) => c.phase === 'after' && c.exitCode === 0 && c.status === 'succeeded' && c.stable,
    ),
  );
  assert.ok(events.some((e) => e.type === 'tool/call' && e.data.name === 'emergence_analyze'));
  assert.ok(events.some((e) => e.type === 'tool/call' && e.data.name === 'emergence_code_work'));
  assert.ok(!events.some((e) => e.type === 'tool/call' && e.data.name === 'skill'));
  for (const [path, text] of Object.entries(unchanged))
    assert.equal(await readFile(join(cwd, path), 'utf8'), text);
  const usage = new SessionUsage();
  for (const event of events) if (typeof event.seq === 'number') usage.append(event);
  counts = {
    tools: events.filter((e) => e.type === 'tool/call').map((e) => e.data.name),
    tokens: usage.total,
    missingUsage: usage.missing,
    checks: run.checks.map((c: any) => ({
      callId: c.callId,
      phase: c.phase,
      status: c.status,
      exitCode: c.exitCode,
    })),
  };
  assert.equal(digest(await readFile('dist/cli.mjs', 'utf8')), cliHash);
  assert.equal(digest(await readFile('dist/plugin.mjs', 'utf8')), pluginHash);
  passed = true;
} catch (error) {
  diagnostic = safeError(error);
}
const report = {
  timestamp: new Date().toISOString(),
  passed,
  diagnostic,
  durationMs: Date.now() - started,
  cliHash,
  pluginHash,
  project: cwd,
  model: { id: model.id, model: model.model, api: model.api, maxTokens: 1400 },
  counts,
  scope:
    'One natural-language coding repair; real configured model, native tools and actual npm tests. Not a broad coding benchmark or a live multi-model team benchmark.',
};
await writeFile(join(directory, 'live.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
if (!passed) process.exitCode = 1;
