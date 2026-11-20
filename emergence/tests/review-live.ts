// Explicit live smoke test for the configured provider; never part of automatic regression.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homeDirectory, loadConfig, saveConfig } from '../src/app/config.ts';
import { resolveCredential } from '../src/app/credentials.ts';
import { safeError } from '../src/core/adapters/redaction.ts';

const dir = resolve('../artifacts/review-2026-10-30');
await mkdir(dir, { recursive: true });
const originalHome = homeDirectory(),
  config = await loadConfig(originalHome);
const model = config.models.find((m) => m.id === config.defaultModel)!;
const credential = await resolveCredential(originalHome, model.apiKeyEnv);
if (!credential) throw new Error('Configured provider credential unavailable; no request sent');
const root = await mkdtemp(join(dir, 'live-')),
  home = join(root, 'home'),
  cwd = join(root, 'project');
await mkdir(cwd);
const proof = 'AUDIT_' + randomUUID();
await writeFile(join(cwd, 'proof.txt'), proof);
await saveConfig(home, {
  ...config,
  defaultModel: model.id,
  models: [{ ...model, maxTokens: 1024 }],
  mcp: [],
  skillDirs: [],
  extensions: [],
});
async function run(args: string[]) {
  const child = spawn(
    process.execPath,
    ['bin/emergence.cjs', cwd, '--home', home, '--permission', 'plan', ...args],
    {
      env: { ...process.env, [model.apiKeyEnv]: credential },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (b) => (stdout += b));
  child.stderr.on('data', (b) => (stderr += b));
  const timer = setTimeout(() => child.kill(), 90000);
  try {
    const code = await new Promise<number | null>((done, reject) => {
      child.once('error', reject);
      child.once('exit', done);
    });
    assert.equal(code, 0, safeError(stderr));
    return JSON.parse(stdout.trim().split('\n').at(-1)!) as {
      sessionId: string;
      transcript: string[];
      error?: string;
    };
  } finally {
    clearTimeout(timer);
  }
}
let passed = false,
  diagnostic: string | undefined;
try {
  const first = await run([
    '--print',
    '请使用 read 工具读取当前目录 proof.txt，原样回复其中的字符串。只读取这个文件，不调用其他工具。',
  ]);
  assert.ok(!first.error);
  assert.ok(first.transcript.some((line) => line.includes('read')));
  assert.ok(first.transcript.some((line) => line.includes(proof)));
  const previousLength = first.transcript.length;
  const resumed = await run([
    '--resume',
    first.sessionId,
    '--print',
    '不要再调用工具。请只回复上一轮文件里的完整字符串。',
  ]);
  assert.ok(!resumed.error);
  assert.equal(resumed.sessionId, first.sessionId);
  assert.ok(resumed.transcript.slice(previousLength).some((line) => line.includes(proof)));
  passed = true;
} catch (error) {
  diagnostic = safeError(error);
}
const report = {
  timestamp: new Date().toISOString(),
  passed,
  provider: model.provider,
  model: model.model,
  api: model.api,
  configuredModels: config.models.map((m) => ({ id: m.id, provider: m.provider, api: m.api })),
  configuredMcp: config.mcp.map((m) => ({ name: m.serverName, enabled: m.enabled, transport: m.transport })),
  scope:
    'Actual provider through built CLI: native read tool and resumed context. Temporary project; plan mode; no user-file writes. Third-party MCP services not invoked by this smoke test.',
  diagnostic,
};
await writeFile(join(dir, 'live-api.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
if (!passed) process.exitCode = 1;
