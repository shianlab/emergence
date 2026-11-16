import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const output = resolve('../artifacts/review-2026-10-30');
await mkdir(output, { recursive: true });
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Use npm run inspect:backend');
const steps = [
  ['严格类型检查', ['node_modules/typescript/bin/tsc', '--noEmit']],
  ['构建正式 CLI 和插件', ['--import', 'tsx', 'scripts/build.ts']],
  ['全部单元及 Harness 集成测试', [npmCli, 'test']],
  ['Harness 生命周期、工具与取消', ['--import', 'tsx', 'probes/harness.ts']],
  ['实际文件/Shell/Skill/MCP 与 OpenAI、Anthropic 协议', ['--import', 'tsx', 'tests/phase2-e2e.ts']],
  ['API 故障、流断开、恢复不重放副作用', ['--import', 'tsx', 'tests/phase6-faults.ts']],
  ['16 会话并发与释放', ['--import', 'tsx', 'tests/audit-stress.ts']],
  ['当前依赖漏洞与凭据泄漏检查', [npmCli, 'run', 'inspect:security']],
] as const;
const tracked = [
  'config',
  'controller',
  'collaboration',
  'orchestration',
  'permissions',
  'instructions',
  'instruction-files',
  'instruction-init',
  'capabilities',
  'local-policy',
  'credentials',
  'workspace',
  'settings',
];
async function hashes() {
  return Object.fromEntries(
    await Promise.all(
      tracked.map(async (name) => [
        name,
        createHash('sha256')
          .update(await readFile(`src/app/${name}.ts`))
          .digest('hex'),
      ]),
    ),
  );
}
const before = await hashes(),
  results = [];
for (const [name, args] of steps) {
  const started = performance.now();
  const result = spawnSync(process.execPath, [...args], {
    encoding: 'utf8',
    timeout: 180000,
    maxBuffer: 6000000,
  });
  results.push({
    name,
    exitCode: result.status,
    durationMs: Math.round(performance.now() - started),
    error: result.error?.message,
    stdout: result.stdout,
    stderr: result.stderr,
  });
  console.log(`${result.status === 0 ? 'PASS' : 'FAIL'} ${name}`);
  if (result.status !== 0) console.error(result.stdout, result.stderr);
}
const after = await hashes(),
  changed = tracked.filter((name) => before[name] !== after[name]);
const passed = results.every((result) => result.exitCode === 0) && !changed.length;
await writeFile(
  join(output, 'backend.json'),
  JSON.stringify(
    {
      timestamp: new Date().toISOString(),
      passed,
      runtime: process.version,
      results,
      inputHashes: after,
      changedDuringRun: changed,
      scope:
        'Backend and actual CLI runtime only. Latest UI acceptance is explicitly deferred by user; local model fixtures do not prove live vendor connectivity. Explicit live API evidence is stored separately.',
    },
    null,
    2,
  ),
);
if (!passed) process.exitCode = 1;
