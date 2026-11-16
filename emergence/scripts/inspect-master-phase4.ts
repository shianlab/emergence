import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';

const dir = '../artifacts/master-phase4';
await mkdir(dir, { recursive: true });
const files = [
  'src/core/application/team-followthrough.ts',
  'src/core/application/team-coordinator.ts',
  'src/core/application/task-coordinator.ts',
  'src/app/workspace.ts',
  'src/core/application/assurance.ts',
  'src/core/application/execution-evidence.ts',
  'src/core/domain/assurance.ts',
  'src/core/domain/team.ts',
  'src/core/adapters/planning.ts',
  'src/core/adapters/permissions.ts',
  'src/app/workspace-ui.ts',
  'src/app/tui/task-inspector.ts',
  'src/app/tui/team-bar.ts',
  'src/app/tui/team-feedback.ts',
];
const hashes = async () =>
  Object.fromEntries(
    await Promise.all(
      files.map(async (file) => [
        file,
        createHash('sha256')
          .update(await readFile(file))
          .digest('hex'),
      ]),
    ),
  );
const before = await hashes(),
  results = [];
const tests = (await readdir('tests'))
  .filter((file) => file.endsWith('.test.ts'))
  .map((file) => 'tests/' + file);
const checks: Array<[string, string[]]> = [
  ['类型检查', ['node_modules/typescript/bin/tsc', '--noEmit']],
  [
    '本机 CLI 与 Harness 构建（配置工具由另一聊天维护）',
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      "import {build} from 'esbuild'; import {loadCoreCatalog} from './src/core/adapters/catalog.ts'; loadCoreCatalog(); await build({entryPoints:{cli:'src/app/cli.ts',plugin:'src/app/plugin.ts'},outdir:'dist',outExtension:{'.js':'.mjs'},bundle:true,platform:'node',format:'esm',target:'node26',packages:'external',sourcemap:true});",
    ],
  ],
  ['全部单元与 Harness 集成', ['--import', 'tsx', '--test', ...tests]],
  ['原生主控菜单与团队交互', ['--experimental-ffi', '--import', 'tsx', 'tests/tui-runtime-team.ts']],
  ['原生恢复审批', ['--experimental-ffi', '--import', 'tsx', 'tests/tui-core-phase4.ts']],
  ['主控协调反馈与点击操作', ['--experimental-ffi', '--import', 'tsx', 'tests/tui-master-phase4.ts']],
  ['原有任务侧栏、窄屏与焦点回归', ['--experimental-ffi', '--import', 'tsx', 'tests/tui-phase4.ts']],
];
for (const [name, args] of checks) {
  const start = Date.now(),
    r = spawnSync(process.execPath, args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 180000,
      maxBuffer: 6000000,
    });
  results.push({
    name,
    exitCode: r.status,
    durationMs: Date.now() - start,
    stdout: r.stdout,
    stderr: r.stderr,
    error: r.error?.message,
  });
  console.log(`${r.status === 0 ? 'PASS' : 'FAIL'} ${name}`);
  if (r.status !== 0) {
    console.log(r.stdout, r.stderr);
    break;
  }
}
const after = await hashes(),
  changed = files.filter((file) => before[file] !== after[file]);
const passed = results.length === checks.length && results.every((r) => r.exitCode === 0) && !changed.length;
await writeFile(
  dir + '/inspection.json',
  JSON.stringify(
    {
      passed,
      timestamp: new Date().toISOString(),
      scope:
        'All unit/Harness tests plus native team and recovery interaction. Source lock covers orchestration-owned files; this is not a whole-UI redesign acceptance.',
      sourceHashes: after,
      changedDuringRun: changed,
      results,
    },
    null,
    2,
  ),
);
if (!passed) process.exitCode = 1;
