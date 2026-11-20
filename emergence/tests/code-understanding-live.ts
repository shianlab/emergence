// Explicit two-turn live smoke. Local fixture only; never part of default tests.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homeDirectory, loadConfig, saveConfig } from '../src/app/config.ts';
import { resolveCredential } from '../src/app/credentials.ts';
import { SessionUsage } from '../src/app/tui/session-usage.ts';
import { safeError } from '../src/core/adapters/redaction.ts';
import { digest } from '../src/core/storage/execution-journal.ts';

if (!process.argv.includes('--live')) throw new Error('Use --live for a bounded real model test');
const directory = resolve('../artifacts/code-data-phase2');
await mkdir(directory, { recursive: true });
const root = await mkdtemp(join(directory, 'live-')),
  cwd = join(root, 'project'),
  home = join(root, 'profile');
await mkdir(join(cwd, 'src'), { recursive: true });
await mkdir(join(cwd, 'tests'));
const files = {
  'package.json': '{"name":"code-understanding-fixture","scripts":{"test":"node --test"}}',
  'src/revenue.ts':
    'export function computeRevenue(price: number, count: number) { return price * count; }\n',
  'src/main.ts': "import { computeRevenue } from './revenue';\nexport const value = computeRevenue(12, 3);\n",
  'tests/revenue.test.ts':
    "import { computeRevenue } from '../src/revenue';\nexport const zeroCase = computeRevenue(0, 3) === 0;\n",
  'src/revenue.py': 'def compute_revenue(price, count):\n    return price * count\n',
  'src/main.py': 'from revenue import compute_revenue\nvalue = compute_revenue(12, 3)\n',
};
for (const [path, text] of Object.entries(files)) await writeFile(join(cwd, path), text);
const config = await loadConfig(homeDirectory()),
  model = config.models.find((m) => m.id === config.defaultModel)!;
const credential = await resolveCredential(homeDirectory(), model.apiKeyEnv);
if (!credential) throw new Error('No configured credential; no requests sent');
await saveConfig(home, {
  ...config,
  models: [{ ...model, maxTokens: 1400 }],
  windowModels: { slots: {} },
  mcp: [],
  skillDirs: [],
  extensions: [],
  permissions: { defaultMode: 'plan', rules: [] },
  toolPolicy: { deny: ['skill', 'subagent'], confirm: [] },
});
const cliHash = digest(await readFile('dist/cli.mjs', 'utf8'));
const pluginHash = digest(await readFile('dist/plugin.mjs', 'utf8'));
async function run(prompt: string, resume?: string) {
  const child = spawn(
    process.execPath,
    [
      'bin/emergence.cjs',
      cwd,
      '--home',
      home,
      '--permission',
      'plan',
      ...(resume ? ['--resume', resume] : []),
      '--print',
      prompt,
    ],
    {
      windowsHide: true,
      env: { ...process.env, [model.apiKeyEnv]: credential },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (b) => {
    stdout += b;
    if (stdout.length > 2_000_000) child.kill();
  });
  child.stderr.on('data', (b) => {
    stderr += b;
  });
  const timer = setTimeout(() => child.kill(), 120000);
  try {
    const code = await new Promise<number | null>((done, reject) => {
      child.once('exit', done);
      child.once('error', reject);
    });
    assert.equal(code, 0, safeError(stderr));
    return JSON.parse(stdout.trim().split('\n').at(-1)!);
  } finally {
    clearTimeout(timer);
    await writeFile(join(root, resume ? 'resumed.log' : 'initial.log'), safeError(stdout + '\n' + stderr));
  }
}
let passed = false,
  diagnostic: string | undefined;
const started = Date.now();
let counts: object | undefined;
try {
  const first = await run(
    '请定位项目中 computeRevenue 的定义、实际调用方和相关测试，再定位 Python 的 compute_revenue。给出文件和行号，区分语义引用和名称线索。只读，不修改文件，不运行项目代码。',
  );
  assert.ok(!first.error);
  const sessionPath = (await readdir(join(home, 'sessions'), { recursive: true })).find(
    (p) => p.endsWith('session.v4.jsonl') && p.includes(first.sessionId),
  )!;
  const events = (await readFile(join(home, 'sessions', sessionPath), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const calls = events.filter((e) => e.type === 'tool/call');
  assert.ok(
    calls.some((e) => e.data.name.startsWith('emergence_code_')),
    'model did not discover native Code tools',
  );
  const outputs = events
    .filter((e) => e.type === 'tool/result' && !e.data.message.isError)
    .flatMap((e) => e.data.message.content)
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  assert.ok(outputs.includes('typescript-semantic'));
  assert.ok(outputs.includes('python-ast-name-hint'));
  assert.ok(outputs.includes('tests/revenue.test.ts'));
  assert.ok(outputs.includes('src/main.ts'));
  for (const [path, text] of Object.entries(files))
    assert.equal(await readFile(join(cwd, path), 'utf8'), text);
  await writeFile(
    join(cwd, 'src/revenue.ts'),
    'export function updatedRevenue(price: number, count: number) { return price * count; }\n',
  );
  const resumed = await run(
    '继续核对：我刚把 TS 函数改名为 updatedRevenue。请重新定位这个新名称，并指出旧调用方是否还引用旧名字。只读，用当前源码核对，不沿用旧定位。',
    first.sessionId,
  );
  assert.ok(!resumed.error);
  assert.equal(resumed.sessionId, first.sessionId);
  const changed = (await readFile(join(home, 'sessions', sessionPath), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const laterResults = changed
    .slice(events.length)
    .filter((e) => e.type === 'tool/result' && !e.data.message.isError);
  assert.ok(
    laterResults.some((e) => JSON.stringify(e.data.message.content).includes('updatedRevenue')),
    'fresh source evidence missing',
  );
  const usage = new SessionUsage();
  for (const event of changed) if (typeof event.seq === 'number') usage.append(event);
  counts = {
    tools: changed.filter((e) => e.type === 'tool/call').map((e) => e.data.name),
    tokens: usage.total,
    missingUsage: usage.missing,
  };
  assert.equal(digest(await readFile('dist/cli.mjs', 'utf8')), cliHash, 'CLI changed during live test');
  assert.equal(
    digest(await readFile('dist/plugin.mjs', 'utf8')),
    pluginHash,
    'Harness changed during live test',
  );
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
  permission: 'plan',
  counts,
  scope:
    'One live model, two turns: natural-language native code discovery and refresh after a controlled source change. Not a general coding benchmark; no project scripts executed.',
};
await writeFile(join(directory, 'live.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
if (!passed) process.exitCode = 1;
