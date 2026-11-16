// Explicit, small real-provider readiness check. Not included in default local regressions.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homeDirectory, loadConfig, saveConfig } from '../src/app/config.ts';
import { hydrateCredentials } from '../src/app/credentials.ts';
import { safeError } from '../src/core/adapters/redaction.ts';
const dir = resolve('../artifacts/phase6');
await mkdir(dir, { recursive: true });
const originalHome = homeDirectory(),
  config = await loadConfig(originalHome);
const model = config.models.find((m) => new URL(m.baseURL).hostname.endsWith('deepseek.com'));
if (!model) throw new Error('No configured DeepSeek route; no request was sent');
await hydrateCredentials(originalHome, [model.apiKeyEnv]);
if (!process.env[model.apiKeyEnv]) throw new Error('No configured credential; no request was sent');
const root = await mkdtemp(join(dir, 'live-local-')),
  home = join(root, 'home'),
  cwd = join(root, 'project');
await mkdir(cwd);
await saveConfig(home, {
  ...config,
  defaultModel: model.id,
  models: [{ ...model, maxTokens: 64 }],
  mcp: [],
  skillDirs: [],
  extensions: [],
});
const child = spawn(
  process.execPath,
  [
    'bin/emergence.cjs',
    cwd,
    '--home',
    home,
    '--print',
    '请只回复 EMERGENCE_LOCAL_READY，不调用工具，不修改文件。',
  ],
  { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] },
);
let stdout = '',
  stderr = '';
child.stdout.on('data', (b) => (stdout += b));
child.stderr.on('data', (b) => (stderr += b));
const timer = setTimeout(() => child.kill(), 45000);
const code = await new Promise<number | null>((done, reject) => {
  child.once('error', reject);
  child.once('exit', done);
});
clearTimeout(timer);
let passed = false;
try {
  assert.equal(code, 0, safeError(stderr));
  const result = JSON.parse(stdout.trim().split('\n').at(-1)!);
  passed =
    result.transcript.some((s: string) => s.includes('EMERGENCE_LOCAL_READY')) &&
    !result.transcript.some((s: string) => s.startsWith('┌ 工具'));
  assert.ok(passed, safeError(stdout));
} finally {
  await writeFile(
    join(dir, 'live-local.json'),
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        passed,
        provider: model.provider,
        model: model.model,
        runtime: process.version,
        maxOutputTokens: 64,
        scope:
          'One explicit real-provider local CLI readiness request; temporary home, no user project files, no tools requested.',
        diagnostics: passed ? undefined : safeError(stderr).slice(-2000),
      },
      null,
      2,
    ),
  );
}
console.log(passed ? 'PASS DeepSeek local CLI readiness: EMERGENCE_LOCAL_READY' : 'FAIL live readiness');
