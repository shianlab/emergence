import type { SessionEvent } from '@deepseek-ai/dsh-session';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homeDirectory, loadConfig, saveConfig } from '../src/app/config.ts';
import { hydrateCredentials } from '../src/app/credentials.ts';
import { SessionUsage } from '../src/app/tui/session-usage.ts';
import { safeError } from '../src/core/adapters/redaction.ts';
if (!process.argv.includes('--live')) throw new Error('Explicit --live required');
const directory = resolve(
  process.env.EMERGENCE_NATIVE_LIVE_DIR ?? '../artifacts/code-data-phase6/native-live',
);
await mkdir(directory, { recursive: true });
// Copy the completed build to a sibling directory before invoking this runner.
// Other UI development can rebuild dist without changing the accepted binary.
const build = resolve(process.env.EMERGENCE_LIVE_BUILD ?? 'dist');
async function buildHashes() {
  return Object.fromEntries(
    await Promise.all(
      ['cli.mjs', 'plugin.mjs'].map(async (name) => [
        name,
        createHash('sha256')
          .update(await readFile(join(build, name)))
          .digest('hex'),
      ]),
    ),
  );
}
async function metrics(home: string) {
  const tokenUsage = { total: 0, reported: 0, missing: 0 };
  let toolCalls = 0,
    toolErrors = 0,
    questions = 0;
  for (const file of await readdir(join(home, 'sessions'), { recursive: true })) {
    if (!file.endsWith('session.v4.jsonl')) continue;
    const usage = new SessionUsage();
    const events = (await readFile(join(home, 'sessions', file), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    for (const event of events) {
      if (typeof event.seq === 'number') usage.append(event as SessionEvent);
      if (event.type === 'tool/call') {
        toolCalls++;
        if (event.data.name === 'ask_user_question') questions++;
      }
      if (event.type === 'tool/result' && event.data.message?.isError) toolErrors++;
    }
    tokenUsage.total += usage.total;
    tokenUsage.reported += usage.reported;
    tokenUsage.missing += usage.missing;
  }
  return { toolCalls, toolErrors, questions, tokenUsage };
}
async function sample(repetition: number) {
  const root = await mkdtemp(join(directory, 'live-'));
  const cwd = join(root, '数据'),
    home = join(root, 'home');
  await mkdir(cwd);
  const csv = '渠道,时期,收入\n线上,前期,100\n线上,后期,80\n门店,前期,50\n门店,后期,90\n';
  await writeFile(join(cwd, 'sales.csv'), csv);
  const config = await loadConfig(homeDirectory()),
    model = config.models.find((m) => m.id === config.defaultModel)!;
  await hydrateCredentials(homeDirectory(), [model.apiKeyEnv]);
  await saveConfig(home, {
    ...config,
    models: [{ ...model, maxTokens: 8192 }],
    windowModels: { slots: {} },
    mcp: [],
    skillDirs: [],
    extensions: [],
    permissions: { defaultMode: 'plan', rules: [] },
    toolPolicy: { deny: ['skill', 'subagent'], confirm: [] },
  });
  const hashes = await buildHashes(),
    started = Date.now();
  let passed = false,
    diagnostic;
  try {
    const child = spawn(
      process.execPath,
      [
        '--experimental-ffi',
        '--disable-warning=ExperimentalWarning',
        join(build, 'cli.mjs'),
        cwd,
        '--home',
        home,
        '--permission',
        'plan',
        '--print',
        '请用 sales.csv 分析前期到后期的收入变化，按渠道拆解贡献并对账。生成中文报告、结果表和图表，附可重放产物。粒度为渠道与时期，单位元，仅说明组成变化，不推断因果；不保存长期口径，不修改原文件。',
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '',
      error = '';
    child.stdout.on('data', (b) => (output += b));
    child.stderr.on('data', (b) => (error += b));
    const timer = setTimeout(() => {
      if (child.pid)
        spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        }).on('error', () => child.kill());
    }, 300000);
    const code = await new Promise((done, reject) => {
      child.once('error', reject);
      child.once('exit', done);
    }).finally(() => clearTimeout(timer));
    await writeFile(join(root, 'transcript.log'), safeError(output + '\n' + error));
    assert.equal(code, 0, error);
    const dirs = await readdir(join(home, 'core/data-runs'));
    let found = false;
    for (const dir of dirs) {
      try {
        const value = JSON.parse(await readFile(join(home, 'core/data-runs', dir, 'result.json'), 'utf8'));
        if (
          value.analysis?.method === 'attribution' &&
          Number(value.analysis.summary.totalChange) === 20 &&
          value.analysis.checks.every((c: { passed: boolean }) => c.passed)
        ) {
          await readFile(join(home, 'core/data-runs', dir, 'report.html'));
          await readFile(join(home, 'core/data-runs', dir, 'chart.svg'));
          found = true;
        }
      } catch {}
    }
    assert.ok(found, '缺少实际归因对账与交付产物');
    assert.equal(await readFile(join(cwd, 'sales.csv'), 'utf8'), csv);
    assert.deepEqual(await buildHashes(), hashes);
    passed = true;
  } catch (e) {
    diagnostic = safeError(e);
  }
  const measured = await metrics(home).catch((error) => ({ measurementError: safeError(error) }));
  const result = {
    repetition,
    passed,
    diagnostic,
    model: { id: model.id, model: model.model, maxTokens: 8192 },
    durationMs: Date.now() - started,
    hashes,
    ...measured,
    root,
    scope:
      'Natural-language native attribution, reconciled changes and report/chart delivery; no remote data source',
  };
  await writeFile(join(directory, 'sample-' + repetition + '.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  return result;
}
const results = await Promise.all([1, 2, 3].map(sample));
await writeFile(
  join(directory, 'live.json'),
  JSON.stringify(
    { passed: results.every((r) => r.passed), timestamp: new Date().toISOString(), results },
    null,
    2,
  ),
);
if (results.some((r) => !r.passed)) process.exitCode = 1;
