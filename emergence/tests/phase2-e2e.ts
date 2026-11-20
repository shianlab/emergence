import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { saveConfig } from '../src/app/config.ts';
import { modelServer } from './fixtures/model-server.ts';

const artifacts = resolve('../artifacts/phase2');
await mkdir(artifacts, { recursive: true });
const root = await mkdtemp(join(artifacts, 'e2e-'));
const project = join(root, '中文 项目');
const home = join(root, 'home');
await mkdir(project);
const skill = join(project, '.agents/skills/phase2-proof');
await mkdir(skill, { recursive: true });
await writeFile(
  join(skill, 'SKILL.md'),
  '---\nname: phase2-proof\ndescription: Local stage two integration proof\n---\nSKILL_BODY_VERIFIED\n',
);
const fixtureKeyName = 'PHASE2_RELAY_AUTH';
const fixtureKey = 'phase2-test-secret';
const verifyCommand = `if (Test-Path Env:${fixtureKeyName}) { throw 'Fixture model credential present' }; Write-Output 'SHELL_ENV_ISOLATED'; Get-Content -LiteralPath 'stage2-output.txt'`;
const server = await modelServer({ command: verifyCommand, value: fixtureKey });
await saveConfig(home, {
  version: 1,
  defaultModel: 'local',
  permissions: { defaultMode: 'auto', rules: [{ tool: 'mcp__proof__echo', effect: 'allow' }] },
  models: [
    {
      id: 'local',
      provider: 'Local OpenAI fixture',
      model: 'fixture-openai',
      api: 'openai-completions',
      baseURL: server.baseURL,
      apiKeyEnv: fixtureKeyName,
      contextWindow: 128000,
      maxTokens: 8192,
    },
    {
      id: 'anthropic',
      provider: 'Local Anthropic fixture',
      model: 'fixture-anthropic',
      api: 'anthropic-messages',
      baseURL: server.baseURL,
      apiKeyEnv: fixtureKeyName,
      contextWindow: 128000,
      maxTokens: 8192,
    },
  ],
  shellMode: 'ask-local',
  skillDirs: [join(project, '.agents/skills')],
  mcp: [
    {
      serverName: 'proof',
      transport: 'stdio',
      command: process.execPath,
      args: [resolve('tests/fixtures/mcp.cjs'), '--absent-env=' + fixtureKeyName],
    },
  ],
});
async function run(args: string[], key = true) {
  const child = spawn(process.execPath, ['bin/emergence.cjs', project, '--home', home, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, [fixtureKeyName]: key ? fixtureKey : '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (s) => (stdout += s));
  child.stderr.on('data', (s) => (stderr += s));
  const timeout = setTimeout(() => child.kill(), 30000);
  const code = await new Promise<number | null>((resolveExit) => child.on('exit', resolveExit));
  clearTimeout(timeout);
  const result = { code, stdout, stderr };
  console.log('case', args, code, stdout.slice(-700), stderr.slice(-1200));
  return result;
}
try {
  const chain = await run(['--print', 'phase2:chain', '--approve-command', verifyCommand]);
  await writeFile(join(root, 'chain-result.json'), JSON.stringify(chain, null, 2));
  assert.equal(chain.code, 0, chain.stderr);
  assert.ok(chain.stdout.includes('CHAIN_COMPLETE'), chain.stdout);
  assert.ok(!chain.stdout.includes('└ 失败'), 'Every real tool in the chain must succeed');
  assert.equal(await readFile(join(project, 'stage2-output.txt'), 'utf8'), 'verified version');
  assert.ok(chain.stdout.includes('SHELL_ENV_ISOLATED'), 'Shell did not inherit the custom model key');
  assert.ok(chain.stdout.includes('SKILL_BODY_VERIFIED'), 'Skill body loaded');
  assert.ok(chain.stdout.includes('MCP:verified'), 'MCP tool executed');
  const first = JSON.parse(chain.stdout.trim().split('\n').at(-1)!);
  const resume = await run(['--resume', first.sessionId, '--print', '/tools']);
  assert.equal(resume.code, 0, resume.stderr);
  assert.ok(resume.stdout.includes('CHAIN_COMPLETE'));
  const second = await run(['--model', 'anthropic', '--print', 'hello']);
  assert.equal(second.code, 0, second.stderr);
  assert.ok(second.stdout.includes('ANTHROPIC_OK'));
  const missing = await run(['--print', 'hello'], false);
  assert.equal(missing.code, 1);
  assert.ok(missing.stderr.includes(fixtureKeyName));
  const denied = await run(['--print', 'phase2:error']);
  assert.equal(denied.code, 1);
  assert.ok(!(denied.stdout + denied.stderr).includes(fixtureKey));
  const sessions = join(home, 'sessions');
  const logs = (await readdir(sessions, { recursive: true })).filter((file) => file.endsWith('.jsonl'));
  const persisted = await Promise.all(logs.map((file) => readFile(join(sessions, file), 'utf8')));
  assert.ok(
    persisted.some((text) => text.includes('Unauthorized [已隐藏]')),
    '401 was recorded after redaction',
  );
  assert.ok(
    persisted.every((text) => !text.includes(fixtureKey)),
    'Session persistence never sees the raw key',
  );
  await writeFile(
    join(artifacts, 'e2e.json'),
    JSON.stringify(
      {
        passed: true,
        root,
        scenarios: [
          'file-write-read-edit',
          'PowerShell',
          'Skill',
          'MCP',
          'persist-resume',
          'OpenAI HTTP/SSE',
          'Anthropic HTTP/SSE',
          'missing-key',
          'HTTP401-redaction',
          'persisted-provider-error-redaction',
        ],
        calls: server.calls,
      },
      null,
      2,
    ),
  );
} finally {
  await server.close();
}
