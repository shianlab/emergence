import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const dir = resolve('../artifacts/core-phase6');
await mkdir(dir, { recursive: true });
const files = (await readdir('src', { recursive: true }))
  .filter((f) => /\.(ts|json)$/.test(f))
  .map((f) => join('src', f));
async function hashes() {
  return Object.fromEntries(
    await Promise.all(
      files.map(async (f) => [
        f,
        createHash('sha256')
          .update(await readFile(f))
          .digest('hex'),
      ]),
    ),
  );
}
const before = await hashes();
const tests = (await readdir('tests')).filter((f) => f.endsWith('.test.ts')).map((f) => join('tests', f));
const script = (name: string, native = false) => [
  ...(native ? ['--experimental-ffi'] : []),
  '--import',
  'tsx',
  `tests/${name}.ts`,
];
const steps: Array<[string, string[], number?]> = [
  ['类型检查', ['node_modules/typescript/bin/tsc', '--noEmit']],
  ['本机构建', ['--import', 'tsx', 'scripts/build.ts']],
  ['全部单元与 Harness 集成（含闭环、压缩和 MCP 超时）', ['--import', 'tsx', '--test', ...tests]],
  ['记忆与原生审批', script('tui-core-phase5', true)],
  ['执行与恢复交互', script('tui-core-phase4', true)],
  ['规划与多窗口隔离', script('tui-core-phase3', true)],
  ['中文菜单与状态', script('tui-core-phase1', true)],
  ['模型历史角色选择器', script('experience-e5-ui', true)],
  ['模型协议、实际文件、Shell、Skill 与 MCP', script('phase2-e2e')],
  ['API 故障与进程恢复', script('phase6-faults')],
  ['核心开关开销对照', ['--expose-gc', ...script('core-benchmark')]],
  ['16 会话并发与释放', script('audit-stress')],
  ['Windows ConPTY 中文输入与命令', script('tui-phase3-terminal')],
  ['Windows ConPTY 操作审批', script('experience-e1-terminal')],
  ['Windows ConPTY 会话任务导航', script('tui-phase4-terminal')],
  ['五分钟四窗口流式稳定性', ['--experimental-ffi', '--expose-gc', ...script('phase6-stability')], 420000],
];
const results = [];
for (const [name, args, timeout = 180000] of steps) {
  const start = performance.now();
  const r = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout,
    maxBuffer: 6000000,
  });
  results.push({
    name,
    exitCode: r.status,
    error: r.error?.message,
    durationMs: Math.round(performance.now() - start),
    stdout: r.stdout,
    stderr: r.stderr,
  });
  console.log(`${r.status === 0 ? 'PASS' : 'FAIL'} ${name}`);
  if (r.status !== 0) {
    console.error(r.stdout, r.stderr);
    break;
  }
}
const after = await hashes(),
  changed = files.filter((f) => before[f] !== after[f]);
const passed = results.length === steps.length && results.every((r) => r.exitCode === 0) && !changed.length;
await writeFile(
  join(dir, 'inspection.json'),
  JSON.stringify(
    {
      passed,
      timestamp: new Date().toISOString(),
      runtime: process.version,
      results,
      sourceHashes: after,
      changedDuringRun: changed,
      scope:
        'Core phase 6 local complete lifecycle, native TUI, ConPTY, protocols, faults and five-minute stability. Real configured-provider checks are separately recorded in live.json; this runner makes no paid API calls.',
    },
    null,
    2,
  ),
);
if (!passed) process.exitCode = 1;
