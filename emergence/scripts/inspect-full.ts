import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// One current-version audit: run each check once, rather than nesting historical phase scripts.
const directory =
  process.env.EMERGENCE_AUDIT_DIR ?? `../artifacts/full-audit-${new Date().toISOString().slice(0, 10)}`;
await mkdir(directory, { recursive: true });
async function hashes() {
  const values: Record<string, string> = {};
  for (const root of [
    'src',
    'native',
    'scripts',
    'tests',
    'probes',
    'release',
    'quality',
    'assets',
    'bin',
    'vendor/meta-kim',
  ]) {
    for (const file of await readdir(root, { recursive: true }))
      if (/\.(ts|tsx|py|ps1|psd1|cjs|cs|manifest|json|md|txt|png|jpg)$/.test(file)) {
        const path = join(root, file);
        values[path] = createHash('sha256')
          .update(await readFile(path))
          .digest('hex');
      }
  }
  for (const path of [
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    '.prettierrc.json',
    '.editorconfig',
    'global.json',
    'ruff.toml',
    '../install.ps1',
    '../.github/workflows/ci.yml',
    '../.gitattributes',
    '../.gitignore',
  ])
    values[path] = createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
  return values;
}
const before = await hashes(),
  results: Array<{
    name: string;
    exitCode: number | null;
    durationMs: number;
    stdout: string;
    stderr: string;
    error?: string;
  }> = [];
const tests = (await readdir('tests')).filter((p) => p.endsWith('.test.ts')).map((p) => 'tests/' + p);
const checks: Array<[string, string[]]> = [
  ['TypeScript 格式规范', ['--import', 'tsx', 'scripts/check-typescript.ts']],
  ['Python 格式与静态检查', ['--import', 'tsx', 'scripts/check-languages.ts', 'python']],
  ['原生 C# 格式与严格编译', ['--import', 'tsx', 'scripts/check-languages.ts', 'native']],
  ['PowerShell 格式、语法与静态检查', ['--import', 'tsx', 'scripts/check-languages.ts', 'powershell']],
  ['严格类型检查', ['node_modules/typescript/bin/tsc', '--noEmit']],
  ['核心分层与任务状态写入边界', ['--import', 'tsx', 'scripts/check-architecture.ts']],
  ['完整本机构建（CLI / Harness / 原生配置工具）', ['--import', 'tsx', 'scripts/build.ts']],
  ['全部单元与 Harness 集成', ['--import', 'tsx', '--test', '--test-concurrency=4', ...tests]],
  [
    '模型配置真实 Harness 路由、凭据轮换与窗口分配',
    ['--import', 'tsx', 'tests/model-config-runtime.ts', '--audit'],
  ],
  ['文件 / PowerShell / Skill / MCP 与模型协议', ['--import', 'tsx', 'tests/phase2-e2e.ts']],
  ['断线、限流、失败与副作用恢复', ['--import', 'tsx', 'tests/phase6-faults.ts']],
  ['真实 HTTP 协议重试与取消', ['--import', 'tsx', 'tests/request-recovery-http.ts']],
  ['16 会话并发与释放', ['--import', 'tsx', 'tests/audit-stress.ts']],
  ...[
    'tui-phase1',
    'tui-phase2',
    'tui-phase3',
    'tui-phase4',
    'tui-core-phase1',
    'tui-core-phase2',
    'tui-core-phase3',
    'tui-core-phase4',
    'tui-core-phase5',
    'tui-intent',
    'tui-independent-windows',
    'tui-updates',
    'tui-aggregate',
    'tui-typography',
    'tui-typography-audit',
    'tui-approvals-r3',
    'experience-e1-ui',
    'experience-e2-ui',
    'experience-e5-ui',
  ].map(
    (name) => [name, ['--experimental-ffi', '--import', 'tsx', `tests/${name}.ts`]] as [string, string[]],
  ),
  ...[
    'phase2-terminal',
    'phase3-terminal',
    'pane-close-terminal',
    'audit-terminal',
    'experience-e1-terminal',
    'experience-e2-terminal',
    'experience-e3-terminal',
    'tui-phase1-terminal',
    'tui-phase2-terminal',
    'tui-phase3-terminal',
    'tui-phase4-terminal',
    'phase5-terminal',
    'phase6-terminal',
  ].map((name) => [name, ['--import', 'tsx', `tests/${name}.ts`]] as [string, string[]]),
];
for (const [name, args] of checks) {
  const start = Date.now(),
    r = spawnSync(process.execPath, args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 240000,
      maxBuffer: 6000000,
    });
  results.push({
    name,
    exitCode: r.status,
    durationMs: Date.now() - start,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    error: r.error?.message,
  });
  console.log(`${r.status === 0 ? 'PASS' : 'FAIL'} ${name}`);
  await writeFile(directory + '/checks.json', JSON.stringify(results, null, 2));
  if (r.status !== 0) console.error((r.stdout ?? '').slice(-5000), (r.stderr ?? '').slice(-3000));
}
const after = await hashes(),
  changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (p) => before[p] !== after[p],
  );
const pkg = JSON.parse(await readFile('package.json', 'utf8')),
  lock = JSON.parse(await readFile('package-lock.json', 'utf8')).packages[''];
const lockAligned =
  pkg.version === lock.version &&
  JSON.stringify(pkg.dependencies) === JSON.stringify(lock.dependencies) &&
  JSON.stringify(pkg.devDependencies) === JSON.stringify(lock.devDependencies) &&
  pkg.license === lock.license;
const passed = results.every((r) => r.exitCode === 0) && !changed.length && lockAligned;
await writeFile(
  directory + '/inspection.json',
  JSON.stringify(
    {
      passed,
      timestamp: new Date().toISOString(),
      runtime: process.version,
      lockAligned,
      changedDuringRun: changed,
      sourceHashes: after,
      results,
      scope:
        'Current source, full local build, unit/Harness integration and terminal workflows. Native desktop interaction, live APIs, dependency/credential scan and bounded soak have separate evidence; no installation or publication.',
    },
    null,
    2,
  ),
);
if (!passed) process.exitCode = 1;
