import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const dir = resolve('../artifacts/phase6');
await mkdir(dir, { recursive: true });
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Use npm run inspect');
const releaseMode = process.argv.includes('--release');
const results: Array<{
  name: string;
  exitCode: number | null;
  error?: string;
  durationMs: number;
  stdout: string;
  stderr: string;
}> = [];
function run(name: string, args: string[], timeout = 300000) {
  const started = performance.now(),
    output = spawnSync(process.execPath, args, { encoding: 'utf8', timeout, maxBuffer: 6_000_000 });
  results.push({
    name,
    exitCode: output.status,
    error: output.error?.message,
    durationMs: Math.round(performance.now() - started),
    stdout: output.stdout ?? '',
    stderr: output.stderr ?? '',
  });
  console.log(`${output.status === 0 ? 'PASS' : 'FAIL'} ${name}`);
  if (output.status !== 0)
    throw new Error(output.stdout + '\n' + output.stderr + '\n' + (output.error?.message ?? ''));
}
let passed = false,
  reusedSoak = false;
try {
  run('前五阶段功能、安全及终端回归', ['--import', 'tsx', 'scripts/inspect-phase5.ts']);
  run('E1 确认交互、命令入口和终端按键', ['--import', 'tsx', 'scripts/inspect-experience-e1.ts']);
  run('E2 执行模式、权限继承和终端授权', ['--import', 'tsx', 'scripts/inspect-experience-e2.ts']);
  run('E3 规则加载、来源、初始化和多项目隔离', ['--import', 'tsx', 'scripts/inspect-experience-e3.ts']);
  run('E4 角色、契约、预算和验收', ['--import', 'tsx', 'scripts/inspect-experience-e4.ts']);
  run('E5 导航、历史、选择器与工作流', ['--import', 'tsx', 'scripts/inspect-experience-e5.ts']);
  run('本地配置迁移、诊断、长历史、启动退出与临时配置清理', [
    '--import',
    'tsx',
    '--test',
    'tests/phase6.test.ts',
  ]);
  run('断线、限流、服务器失败和运行时异常恢复', ['--import', 'tsx', 'tests/phase6-faults.ts']);
  if (releaseMode) {
    run('安装 PATH 的隔离注册表验证', ['--import', 'tsx', '--test', 'tests/release-manager-check.ts']);
    let release: { version?: string; inputHashes?: Record<string, string> } = {};
    try {
      release = JSON.parse(await readFile(join(dir, 'release-path.json'), 'utf8'));
    } catch {}
    const pkg = JSON.parse(await readFile('package.json', 'utf8'));
    let current = release.version === pkg.version && !!release.inputHashes;
    if (current)
      for (const [file, expected] of Object.entries(release.inputHashes!))
        if (
          createHash('sha256')
            .update(await readFile(file))
            .digest('hex') !== expected
        )
          current = false;
    if (!current) {
      run('锁定生产依赖的独立安装', [npmCli, 'run', 'release:prepare']);
      run('构建 Windows 离线发行包与许可清单', [npmCli, 'run', 'release:pack']);
    }
    run('实际 ZIP 的安装、升级、卸载和数据保留', ['--import', 'tsx', 'tests/phase6-release.ts'], 600000);
  }
  run('本机三种终端宿主、中文与 emoji、鼠标、关闭和异常恢复', [
    '--import',
    'tsx',
    'tests/phase6-terminal.ts',
    ...(releaseMode ? ['--release'] : []),
  ]);
  let soak: { passed?: boolean; timestamp?: string; configuredDurationMs?: number; runtime?: string } = {};
  try {
    soak = JSON.parse(await readFile(join(dir, 'stability.json'), 'utf8'));
  } catch {}
  const sampled = Date.parse(soak.timestamp ?? '');
  const fresh = (
    await Promise.all(
      [
        'src/app/tui/navigation.ts',
        'src/app/commands.ts',
        'src/app/tui/command-list.ts',
        'src/core/domain/orchestration.ts',
        'src/core/application/task-coordinator.ts',
        'src/app/controller.ts',
        'src/core/adapters/permissions.ts',
        'src/app/instruction-files.ts',
        'src/app/instruction-init.ts',
        'src/app/instructions.ts',
        'src/core/domain/ui-preferences.ts',
        'src/app/workspace.ts',
        'src/app/workspace-ui.ts',
        'src/app/interactions.ts',
        'src/app/interaction-ui.ts',
        'src/app/terminal-actions.ts',
        'tests/phase6-stability.ts',
        'tests/fixtures/harness.ts',
        'package-lock.json',
      ].map((p) => stat(p)),
    )
  ).every((s) => s.mtimeMs <= sampled);
  reusedSoak =
    !!soak.passed && soak.runtime === process.version && (soak.configuredDurationMs ?? 0) >= 300000 && fresh;
  if (!reusedSoak)
    run(
      '五分钟持续输出、输入响应及释放',
      ['--experimental-ffi', '--expose-gc', '--import', 'tsx', 'tests/phase6-stability.ts'],
      420000,
    );
  passed = true;
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
}
const inspection = {
  passed,
  mode: releaseMode ? 'release' : 'local',
  packagingDeferred: !releaseMode,
  timestamp: new Date().toISOString(),
  version: JSON.parse(await readFile('package.json', 'utf8')).version,
  runtime: process.version,
  results,
  reusedSoak,
  limits: [
    'Windows 11 x64, Windows PowerShell 5.1 / PowerShell 7 / cmd under ConPTY were exercised; physical IME candidate windows and real-font behavior remain manual.',
    'Other actual model providers need their own credentials and acceptance; fault tests use local services and DeepSeek live evidence is recorded separately.',
    'Five-minute synthetic-stream performance is bounded validation, not a day-long workload guarantee.',
    releaseMode
      ? 'Release mode includes isolated installation validation.'
      : 'Packaging and publication are deferred by user request; this local run performs no installation or release packaging.',
    'No public upload or publication was performed.',
  ],
};
await writeFile(
  join(dir, releaseMode ? 'inspection-release.json' : 'inspection.json'),
  JSON.stringify(inspection, null, 2),
);
if (!passed) process.exitCode = 1;
