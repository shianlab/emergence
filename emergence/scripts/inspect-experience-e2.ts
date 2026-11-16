import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const dir = resolve('../artifacts/experience-e2');
await mkdir(dir, { recursive: true });
const steps = [
  ['类型检查', ['node_modules/typescript/bin/tsc', '--noEmit']],
  ['构建本机运行版本', ['--import', 'tsx', 'scripts/build.ts']],
  ['权限决策、实际 Harness、任务继承与配置迁移', ['--import', 'tsx', '--test', 'tests/permissions.test.ts']],
  [
    '原生快捷键、每窗口模式、菜单、草稿与焦点',
    ['--experimental-ffi', '--import', 'tsx', 'tests/experience-e2-ui.ts'],
  ],
  ['真实 ConPTY 四模式、实际文件和 Shell、授权日志', ['--import', 'tsx', 'tests/experience-e2-terminal.ts']],
] as const;
const results = [];
for (const [name, args] of steps) {
  const start = performance.now(),
    result = spawnSync(process.execPath, [...args], {
      encoding: 'utf8',
      timeout: 90000,
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
        'Windows native renderer, real Harness, ConPTY, local model fixture. No paid model calls or packaging/publication.',
    },
    null,
    2,
  ),
);
if (!passed) process.exitCode = 1;
