import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const dir = resolve('../artifacts/experience-e1');
await mkdir(dir, { recursive: true });
const steps = [
  ['类型检查', ['node_modules/typescript/bin/tsc', '--noEmit']],
  ['构建本机运行版本', ['--import', 'tsx', 'scripts/build.ts']],
  ['请求身份、一次性响应与取消', ['--import', 'tsx', '--test', 'tests/interactions.test.ts']],
  [
    '原生键盘、草稿、选区、确认与焦点',
    ['--experimental-ffi', '--import', 'tsx', 'tests/experience-e1-ui.ts'],
  ],
  ['真实 ConPTY、工具执行和审批日志', ['--import', 'tsx', 'tests/experience-e1-terminal.ts']],
  ['首页进入、恢复与布局兼容', ['--experimental-ffi', '--import', 'tsx', 'tests/tui-phase1.ts']],
] as const;
const results = [];
for (const [name, args] of steps) {
  const start = performance.now();
  const result = spawnSync(process.execPath, [...args], {
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
const passed = results.length === steps.length && results.every((result) => result.exitCode === 0);
const report = {
  passed,
  timestamp: new Date().toISOString(),
  runtime: process.version,
  version: JSON.parse(await readFile('package.json', 'utf8')).version,
  results,
  scope:
    'Windows native OpenTUI + actual Harness and local HTTP/SSE model fixture. No paid model calls, packaging, publishing, or credential changes.',
};
await writeFile(join(dir, 'inspection.json'), JSON.stringify(report, null, 2));
if (!passed) process.exitCode = 1;
