// Opt-in small configured-provider acceptance. No credential values or raw provider responses are persisted.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { homeDirectory, loadConfig, saveConfig } from '../src/app/config.ts';
import { hydrateCredentials } from '../src/app/credentials.ts';
import { safeError } from '../src/core/adapters/redaction.ts';

if (!process.argv.includes('--live')) throw new Error('Explicit --live required');
const dir = resolve('../artifacts/core-phase6');
await mkdir(dir, { recursive: true });
const originalHome = homeDirectory(),
  original = await loadConfig(originalHome);
await hydrateCredentials(
  originalHome,
  original.models.map((m) => m.apiKeyEnv),
);
const results: unknown[] = [];
for (const route of original.models.slice(0, 4)) {
  const endpoint = new URL(route.baseURL),
    base = { id: route.id, model: route.model, protocol: route.api, host: endpoint.hostname };
  if (!process.env[route.apiKeyEnv]) {
    results.push({ ...base, status: 'not-configured', reason: 'credential absent' });
    continue;
  }
  const root = await mkdtemp(join(tmpdir(), 'emergence-core6-live-')),
    home = join(root, 'home'),
    project = join(root, 'project');
  await mkdir(project);
  await saveConfig(home, {
    ...original,
    defaultModel: route.id,
    models: [{ ...route, maxTokens: 1024 }],
    mcp: [],
    extensions: [],
    skillDirs: [],
    permissions: { defaultMode: 'edit', rules: [] },
    toolPolicy: {
      deny: ['pwsh', 'bash', 'subagent', 'mcp__*', 'web_search', 'web_fetch', 'emergence_memory_propose'],
      confirm: [],
    },
  });
  const run = async (prompt: string, resume?: string) => {
    const started = performance.now(),
      child = spawn(
        process.execPath,
        [
          'bin/emergence.cjs',
          project,
          '--home',
          home,
          ...(resume ? ['--resume', resume] : []),
          '--print',
          prompt,
        ],
        { cwd: process.cwd(), windowsHide: true, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (b) => {
      stdout += b;
      if (stdout.length > 500000) child.kill();
    });
    child.stderr.on('data', (b) => {
      stderr += b;
      if (stderr.length > 500000) child.kill();
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 90000);
    const code = await new Promise<number | null>((done, reject) => {
      child.once('error', reject);
      child.once('exit', done);
    }).finally(() => clearTimeout(timer));
    if (code !== 0 || timedOut)
      throw new Error(safeError(timedOut ? 'live request timed out' : stderr).slice(-1200));
    const payload = JSON.parse(stdout.trim().split('\n').at(-1)!);
    return { payload, ms: Math.round(performance.now() - started) };
  };
  try {
    const reply = await run('请只回复 EMERGENCE_CORE6_READY，不调用工具。');
    const text = (reply.payload.transcript as string[]).join('\n');
    if (!text.includes('EMERGENCE_CORE6_READY')) throw new Error('Real model reply marker absent');
    const chain = await run(
      '仅在当前目录用 write 工具创建 core6-proof.txt，内容精确为 EMERGENCE_CORE6_FILE；然后用 read 工具读回。不要运行命令、访问网络或其他路径，完成后回复 CORE6_FILE_OK。',
    );
    const lines = chain.payload.transcript as string[];
    if (
      (await readFile(join(project, 'core6-proof.txt'), 'utf8')).trim() !== 'EMERGENCE_CORE6_FILE' ||
      !lines.some((s) => s.startsWith('┌ 工具 write')) ||
      !lines.some((s) => s.startsWith('┌ 工具 read')) ||
      lines.some((s) => s.startsWith('└ 失败'))
    )
      throw new Error('Real file chain evidence incomplete');
    const resumed = await run('/tools', chain.payload.sessionId);
    if (!(resumed.payload.transcript as string[]).some((s) => s.includes('EMERGENCE_CORE6_FILE')))
      throw new Error('Persisted session missing prior tool evidence');
    results.push({
      ...base,
      status: 'passed',
      checks: { realReply: true, actualWrite: true, actualRead: true, crossProcessResume: true },
      durationMs: reply.ms + chain.ms + resumed.ms,
      maxOutputTokensPerCall: 1024,
      project,
    });
  } catch (error) {
    results.push({ ...base, status: 'failed', diagnostic: safeError(error).slice(-1200) });
  }
}
const passed = results.length > 0 && results.every((r) => (r as { status: string }).status === 'passed');
const report = {
  passed,
  timestamp: new Date().toISOString(),
  results,
  configuredMcp: original.mcp.map((s) => ({
    name: s.serverName,
    enabled: s.enabled,
    transport: s.transport,
    status: 'not-probed-by-this-script',
  })),
  scope:
    'Configured provider real CLI reply and sandbox-project native file tools. No real-provider claim for full planning/review quality. No API keys or raw responses in report.',
};
await writeFile(join(dir, 'live.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
if (!passed) process.exitCode = 1;
