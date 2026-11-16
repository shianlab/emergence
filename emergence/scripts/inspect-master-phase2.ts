import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const directory = '../artifacts/master-phase2';
await mkdir(directory, { recursive: true });
const files = [
  'src/core/adapters/planning.ts',
  'src/core/domain/planning.ts',
  'src/core/domain/team.ts',
  'src/core/application/work-allocation.ts',
  'src/core/application/task-allocation.ts',
  'src/core/application/execution-evidence.ts',
  'src/core/application/task-coordinator.ts',
  'src/core/application/team-coordinator.ts',
  'src/app/workspace.ts',
  'src/app/controller.ts',
  'src/core/adapters/permissions.ts',
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
const checks: Array<[string, string[]]> = [
  ['类型检查', ['node_modules/typescript/bin/tsc', '--noEmit']],
  ['本机构建', ['--import', 'tsx', 'scripts/build.ts']],
  [
    '自动派工、权限、规划与原生核心完整闭环',
    [
      '--import',
      'tsx',
      '--test',
      'tests/master-dispatch.test.ts',
      'tests/permissions.test.ts',
      'tests/core-planning.test.ts',
      'tests/core-acceptance.test.ts',
    ],
  ],
];
for (const [name, args] of checks) {
  const r = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120000,
    maxBuffer: 3000000,
  });
  results.push({ name, exitCode: r.status, stdout: r.stdout, stderr: r.stderr, error: r.error?.message });
  console.log(`${r.status === 0 ? 'PASS' : 'FAIL'} ${name}`);
  if (r.status !== 0) break;
}
const after = await hashes(),
  changed = files.filter((file) => before[file] !== after[file]);
const passed = results.length === checks.length && results.every((r) => r.exitCode === 0) && !changed.length;
await writeFile(
  directory + '/targeted-inspection.json',
  JSON.stringify(
    {
      passed,
      timestamp: new Date().toISOString(),
      scope:
        'Stage 2 owned execution files and targeted regressions; not an immutable whole-repository acceptance.',
      sourceHashes: after,
      changedDuringRun: changed,
      results,
    },
    null,
    2,
  ),
);
if (!passed) process.exitCode = 1;
