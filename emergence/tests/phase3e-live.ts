import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homeDirectory, loadConfig } from '../src/app/config.ts';
import { ownedTypeScriptFiles } from '../scripts/source-files.ts';
import { liveLimits } from './fixtures/live-budget.ts';
import { observeUntil, stopOwnedProcess } from './fixtures/observation.ts';

if (!process.argv.includes('--live')) throw new Error('Explicit --live required');
const directory = resolve(
  process.env.EMERGENCE_PHASE3E_DIR ?? '../artifacts/iteration-20261112-phase3e/matrix-1',
);
await mkdir(directory, { recursive: true });
const files = [
  ...(await ownedTypeScriptFiles()),
  'package.json',
  'package-lock.json',
  'bin/emergence.cjs',
  'dist/cli.mjs',
  'dist/plugin.mjs',
];
async function hashes() {
  return Object.fromEntries(
    await Promise.all(
      files.map(async (file) => [
        file,
        createHash('sha256')
          .update(await readFile(file))
          .digest('hex'),
      ]),
    ),
  );
}
const initial = await hashes();
const config = await loadConfig(homeDirectory());
const models = ['glm-coding', 'deepseek'].map((id) => {
  const model = config.models.find((m) => m.id === id);
  assert.ok(model, `Missing configured model ${id}`);
  return {
    id,
    model: model.model,
    provider: model.provider,
    host: new URL(model.baseURL).hostname,
    api: model.api,
  };
});
const matrix = models.flatMap((model) =>
  ['same', 'cross', 'single'].flatMap((topology) =>
    [1, 2].map((round) => ({
      id: `${model.id}-${topology}-${round}`,
      master: model.id,
      worker: models.find((m) => m.id !== model.id)!.id,
      topology,
      round,
      sample: topology === 'single' ? (round === 1 ? 'code' : 'data') : 'notes',
      observerMs: topology === 'single' ? 300000 : 600000,
    })),
  ),
);
await writeFile(
  join(directory, 'manifest.json'),
  JSON.stringify(
    {
      version: 1,
      createdAt: new Date().toISOString(),
      hashes: initial,
      models,
      matrix,
      limits: liveLimits,
      parallelSeries: 2,
      policy:
        'One natural request, fixture-only approvals; no follow-up dispatch/audit/repair commands. No test-level retries or model fallback; production bounded request recovery remains enabled. A changed source/build invalidates the entire round. Receipt budget may overshoot by in-flight requests; missing usage is retained.',
    },
    null,
    2,
  ),
  { flag: 'wx' },
);
async function runSeries(master: string) {
  const results: Array<{
    id: string;
    passed: boolean;
    code: number | null;
    error?: string;
    findings?: unknown[];
  }> = [];
  const samples = matrix.filter((sample) => sample.master === master);
  for (const sample of samples) {
    assert.deepEqual(await hashes(), initial, 'Source/build changed; matrix invalid');
    const dir = join(directory, sample.id);
    await mkdir(dir);
    console.log(`START ${sample.id}`);
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        sample.topology === 'single' ? 'tests/phase3e-single-live.ts' : 'tests/master-team-live.ts',
        '--live',
      ],
      {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          EMERGENCE_LIVE_MASTER: sample.master,
          EMERGENCE_LIVE_WORKER: sample.worker,
          EMERGENCE_LIVE_TOPOLOGY: sample.topology,
          EMERGENCE_LIVE_SAMPLE: sample.sample,
          EMERGENCE_LIVE_TIMEOUT_MS: String(sample.observerMs),
          EMERGENCE_LIVE_OUTPUT_TOKENS: String(liveLimits.outputTokens),
          EMERGENCE_TEAM_LIVE_DIR: dir,
          EMERGENCE_LIVE_PLANNING_ONLY: '0',
        },
      },
    );
    let ended = false,
      code: number | null = null,
      log = '';
    child.on('exit', (value) => {
      code = value;
      ended = true;
    });
    child.on('error', (e) => {
      log += e.message;
      ended = true;
    });
    child.stdout.on('data', (b) => {
      log = (log + b).slice(-200000);
    });
    child.stderr.on('data', (b) => {
      log = (log + b).slice(-200000);
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
      await observeUntil(sample.id, async () => ended, {
        limitMs: sample.observerMs + 90000,
        snapshot: async () => ({ sample }),
        stop,
      });
    } finally {
      await stop();
      await writeFile(join(dir, 'runner.log'), log);
    }
    assert.deepEqual(await hashes(), initial, 'Source/build changed; matrix invalid');
    let evidence: { passed?: boolean; processExitConfirmed?: boolean; error?: string; findings?: unknown[] } =
      {};
    try {
      evidence = JSON.parse(
        await readFile(join(dir, sample.topology === 'single' ? 'result.json' : 'live-team.json'), 'utf8'),
      );
    } catch {}
    results.push({
      id: sample.id,
      passed: code === 0 && evidence.passed === true && evidence.processExitConfirmed === true,
      code,
      error: evidence.error,
      findings: evidence.findings,
    });
    await writeFile(
      join(directory, `${master}-results.json`),
      JSON.stringify(
        {
          complete: results.length === samples.length,
          passed: results.length === samples.length && results.every((r) => r.passed),
          results,
        },
        null,
        2,
      ),
    );
    console.log(`${results.at(-1)!.passed ? 'PASS' : 'FAIL'} ${sample.id}`);
  }
  return results;
}
// Separate homes/projects; keep each model/topology's two repetitions consecutive.
const series = await Promise.allSettled(models.map((model) => runSeries(model.id)));
const results = series.flatMap((item) => (item.status === 'fulfilled' ? item.value : []));
await writeFile(
  join(directory, 'results.json'),
  JSON.stringify(
    {
      complete: results.length === matrix.length,
      passed: results.length === matrix.length && results.every((r) => r.passed),
      results,
      errors: series.flatMap((item) => (item.status === 'rejected' ? [String(item.reason)] : [])),
    },
    null,
    2,
  ),
);
process.exitCode = results.length === matrix.length && results.every((r) => r.passed) ? 0 : 1;
