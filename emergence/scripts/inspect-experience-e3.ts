import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const dir = resolve('../artifacts/experience-e3');
await mkdir(dir, { recursive: true });
const steps = [
  ['类型检查', ['node_modules/typescript/bin/tsc', '--noEmit']],
  ['构建本机版本', ['--import', 'tsx', 'scripts/build.ts']],
  [
    '作用域、继承、预算、恢复、初始化权限与并发保护',
    ['--import', 'tsx', '--test', 'tests/instructions.test.ts'],
  ],
  [
    '真实 ConPTY、规则来源、初始化确认、模型上下文和多项目隔离',
    ['--import', 'tsx', 'tests/experience-e3-terminal.ts'],
  ],
] as const;
const results = [];
for (const [name, args] of steps) {
  const start = performance.now(),
    result = spawnSync(process.execPath, [...args], {
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 3_000_000,
    });
  results.push({
    name,
    exitCode: result.status,
    error: result.error?.message,
    durationMs: Math.round(performance.now() - start),
    stdout: result.stdout,
    stderr: result.stderr,
  });
  console.log(`${result.status === 0 ? 'PASS' : 'FAIL'} ${name}`);
  if (result.status !== 0) {
    console.error(result.stdout, result.stderr);
    break;
  }
}
const passed = results.length === steps.length && results.every((r) => r.exitCode === 0);
await writeFile(
  join(dir, 'inspection.json'),
  JSON.stringify(
    {
      passed,
      timestamp: new Date().toISOString(),
      runtime: process.version,
      results,
      scope:
        'Actual Harness, native OpenTUI through Windows ConPTY, local HTTP/SSE model and real files. No paid model calls, installation or publication.',
    },
    null,
    2,
  ),
);
if (!passed) process.exitCode = 1;
