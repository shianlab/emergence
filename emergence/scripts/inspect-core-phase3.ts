import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const dir = resolve('../artifacts/core-phase3');
await mkdir(dir, { recursive: true });
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Use npm run inspect:core3');
const files = [
  'src/app/config.ts',
  'src/app/controller.ts',
  'src/app/settings.ts',
  'src/app/commands.ts',
  'src/app/workspace.ts',
  'src/core/adapters/permissions.ts',
  'src/app/capabilities.ts',
  'src/app/plugin.ts',
  ...(await readdir('src/core', { recursive: true }))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join('src/core', f)),
];
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
const steps = [
  ['类型与契约编译', ['node_modules/typescript/bin/tsc', '--noEmit']],
  ['本机构建与资产校验', ['--import', 'tsx', 'scripts/build.ts']],
  ['全部单元与 Harness 集成（含核心损坏、隔离、关闭与权限比较）', [npm, 'test']],
  ['规划命令与能力中文界面', ['--experimental-ffi', '--import', 'tsx', 'tests/tui-core-phase3.ts']],
  ['核心中文界面与多窗口隔离', ['--experimental-ffi', '--import', 'tsx', 'tests/tui-core-phase3.ts']],
  ['第一阶段菜单与状态回归', ['--experimental-ffi', '--import', 'tsx', 'tests/tui-core-phase1.ts']],
  ['模型、历史与角色选择回归', ['--experimental-ffi', '--import', 'tsx', 'tests/experience-e5-ui.ts']],
  ['实际文件、Shell、Skill、MCP 与模型协议', ['--import', 'tsx', 'tests/phase2-e2e.ts']],
  ['API 故障与会话恢复', ['--import', 'tsx', 'tests/phase6-faults.ts']],
  ['16 会话并发与资源释放', ['--import', 'tsx', 'tests/audit-stress.ts']],
  ['Windows ConPTY 命令与输入', ['--import', 'tsx', 'tests/tui-phase3-terminal.ts']],
  ['Windows ConPTY 工具审批', ['--import', 'tsx', 'tests/experience-e1-terminal.ts']],
] as const;
const results = [];
for (const [name, args] of steps) {
  const start = performance.now(),
    r = spawnSync(process.execPath, [...args], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 180000,
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
        'Core phase 3 planning, live capability resolution, permission gates, session-local persistence, existing scheduler dispatch and Windows ConPTY. Local controlled providers and real MCP peers; no paid API calls. UI visual redesign excluded.',
    },
    null,
    2,
  ),
);
if (!passed) process.exitCode = 1;
