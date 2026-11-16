// Explicit, bounded real-provider acceptance: two small requests per configured route, no key values in artifacts.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { homeDirectory, loadConfig, saveConfig } from '../src/app/config.ts';
import { hydrateCredentials, resolveCredential } from '../src/app/credentials.ts';
import { testModelConnection } from '../src/app/model-configuration.ts';
import { safeError } from '../src/core/adapters/redaction.ts';

if (!process.argv.includes('--live'))
  throw new Error('Use --live to send two small real requests per configured model');
const home = homeDirectory(),
  config = await loadConfig(home),
  reportDirectory = resolve('../artifacts/model-configuration');
await mkdir(reportDirectory, { recursive: true });
await hydrateCredentials(
  home,
  config.models.map((model) => model.apiKeyEnv),
);
const results: Array<{
  id: string;
  model: string;
  host: string;
  status: string;
  connection?: unknown;
  actualCliReply?: boolean;
  diagnostic?: string;
}> = [];
for (const model of config.models.slice(0, 4)) {
  const facts = { id: model.id, model: model.model, host: new URL(model.baseURL).hostname };
  const secret = await resolveCredential(home, model.apiKeyEnv);
  if (!secret) {
    results.push({ ...facts, status: 'not-configured' });
    continue;
  }
  try {
    const connection = await testModelConnection(model, secret);
    assert.equal(connection.ok, true, connection.message);
    const root = await mkdtemp(join(tmpdir(), 'emergence-config-live-')),
      isolated = join(root, 'home'),
      project = join(root, 'project');
    await mkdir(project);
    await saveConfig(isolated, {
      ...config,
      defaultModel: model.id,
      models: [{ ...model, maxTokens: 1024 }],
      windowModels: { slots: {} },
      mcp: [],
      extensions: [],
      skillDirs: [],
      core: { ...config.core, mode: 'off' },
      instructions: { ...config.instructions, rootMode: 'launch', agents: false, claude: false },
      permissions: { defaultMode: 'plan', rules: [] },
      toolPolicy: {
        deny: ['pwsh', 'bash', 'write', 'edit', 'subagent', 'web_search', 'web_fetch', 'mcp__*'],
        confirm: [],
      },
    });
    const child = spawn(
      process.execPath,
      [
        'bin/emergence.cjs',
        project,
        '--home',
        isolated,
        '--model',
        model.id,
        '--print',
        '请只回复 EMERGENCE_MODEL_CONFIG_VERIFIED，不调用任何工具。',
      ],
      { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill(), 90000);
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('exit', resolve);
      child.once('error', reject);
    }).finally(() => clearTimeout(timer));
    assert.equal(code, 0, safeError(stderr));
    assert.ok(stdout.includes('EMERGENCE_MODEL_CONFIG_VERIFIED'), 'Expected real-model reply absent');
    assert.ok(!stdout.includes(secret));
    results.push({ ...facts, status: 'passed', connection, actualCliReply: true });
  } catch (error) {
    results.push({ ...facts, status: 'failed', diagnostic: safeError(error).slice(0, 1000) });
  }
}
const report = {
  passed:
    results.some((result) => result.status === 'passed') &&
    results.every((result) => result.status !== 'failed'),
  timestamp: new Date().toISOString(),
  scope:
    'Current configured credentials only; does not certify unconfigured vendor accounts or subscriptions.',
  results,
};
await writeFile(join(reportDirectory, 'audit-live.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
