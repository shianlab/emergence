import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const dir = resolve('../artifacts/core-phase1');
await mkdir(dir, { recursive: true });
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Use npm run inspect:core1');
const steps = [
  ['严格类型检查', ['node_modules/typescript/bin/tsc', '--noEmit']],
  ['本机 CLI 构建', ['--import', 'tsx', 'scripts/build.ts']],
  ['单元与 Harness 集成', [npmCli, 'test']],
  ['新增中文菜单、帮助与真实状态事件', ['--experimental-ffi', '--import', 'tsx', 'tests/tui-core-phase1.ts']],
  ['首页、Logo、会话恢复', ['--experimental-ffi', '--import', 'tsx', 'tests/tui-phase1.ts']],
  ['输入、工具、排队和取消', ['--experimental-ffi', '--import', 'tsx', 'tests/tui-phase3.ts']],
  ['审批与焦点', ['--experimental-ffi', '--import', 'tsx', 'tests/experience-e1-ui.ts']],
  ['模型、历史和角色选择器', ['--experimental-ffi', '--import', 'tsx', 'tests/experience-e5-ui.ts']],
  ['多窗口与任务侧栏', ['--experimental-ffi', '--import', 'tsx', 'tests/tui-phase4.ts']],
  ['Windows ConPTY 中文命令与输入', ['--import', 'tsx', 'tests/tui-phase3-terminal.ts']],
  ['Windows ConPTY 真实工具审批', ['--import', 'tsx', 'tests/experience-e1-terminal.ts']],
] as const;
const results = [];
for (const [name, args] of steps) {
  const start = performance.now();
  const result = spawnSync(process.execPath, [...args], {
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 4_000_000,
    windowsHide: true,
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
await writeFile(
  join(dir, 'inspection.json'),
  JSON.stringify(
    {
      passed,
      timestamp: new Date().toISOString(),
      runtime: process.version,
      results,
      scope:
        'Core integration phase 1 only: native OpenTUI, real Windows ConPTY, actual Harness and controlled local model fixtures. No live paid provider requests or Meta_Kim installation.',
    },
    null,
    2,
  ),
);
if (!passed) process.exitCode = 1;
