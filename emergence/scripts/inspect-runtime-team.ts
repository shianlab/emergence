import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const dir = '../artifacts/runtime-team';
await mkdir(dir, { recursive: true });
const files = (await readdir('src', { recursive: true }))
  .filter((f) => /\.(ts|json)$/.test(f))
  .map((f) => join('src', f));
const hashes = async () =>
  Object.fromEntries(
    await Promise.all(
      files.map(async (f) => [
        f,
        createHash('sha256')
          .update(await readFile(f))
          .digest('hex'),
      ]),
    ),
  );
const before = await hashes(),
  tests = (await readdir('tests')).filter((f) => f.endsWith('.test.ts')).map((f) => join('tests', f));
const native = (name: string) => ['--experimental-ffi', '--import', 'tsx', `tests/${name}.ts`];
const steps: Array<[string, string[]]> = [
  ['类型检查', ['node_modules/typescript/bin/tsc', '--noEmit']],
  ['本机构建', ['--import', 'tsx', 'scripts/build.ts']],
  ['全部单元及 Harness 集成', ['--import', 'tsx', '--test', ...tests]],
  ['需求理解与后台资料', native('tui-intent')],
  ['鼠标编排与自动任务入口', native('tui-runtime-team')],
  ['会话与任务界面', native('tui-phase4')],
  ['中文命令和真实状态', native('tui-core-phase1')],
  ['规划交互', native('tui-core-phase3')],
  ['恢复审批', native('tui-core-phase4')],
  ['记忆审批', native('tui-core-phase5')],
  ['模型历史角色选择', native('experience-e5-ui')],
  ['Windows 输入命令', ['--import', 'tsx', 'tests/tui-phase3-terminal.ts']],
  ['Windows 审批', ['--import', 'tsx', 'tests/experience-e1-terminal.ts']],
];
const results = [];
for (const [name, args] of steps) {
  const start = performance.now(),
    r = spawnSync(process.execPath, args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 180000,
      maxBuffer: 6000000,
    });
  results.push({
    name,
    exitCode: r.status,
    durationMs: Math.round(performance.now() - start),
    error: r.error?.message,
    stdout: r.stdout,
    stderr: r.stderr,
  });
  console.log(`${r.status === 0 ? 'PASS' : 'FAIL'} ${name}`);
  if (r.status !== 0) {
    console.log(r.stdout, r.stderr);
    break;
  }
}
const after = await hashes(),
  changed = files.filter((f) => before[f] !== after[f]),
  passed = results.length === steps.length && results.every((r) => r.exitCode === 0) && !changed.length;
await writeFile(
  join(dir, 'inspection.json'),
  JSON.stringify(
    { passed, timestamp: new Date().toISOString(), results, sourceHashes: after, changedDuringRun: changed },
    null,
    2,
  ),
);
if (!passed) process.exitCode = 1;
