import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const dir = resolve('../artifacts/phase3');
await mkdir(dir, { recursive: true });
const steps = [
  ['构建正式入口与插件', ['--import', 'tsx', 'scripts/build.ts']],
  ['严格类型检查', ['node_modules/typescript/bin/tsc', '--noEmit']],
  [
    '配置、凭据、布局、路由与 Harness 工作台回归',
    [
      '--import',
      'tsx',
      '--test',
      'tests/config.test.ts',
      'tests/credentials.test.ts',
      'tests/isolation.test.ts',
      'tests/layout.test.ts',
      'tests/workspace.test.ts',
    ],
  ],
  ['Harness 生命周期与取消回归', ['--import', 'tsx', 'probes/harness.ts']],
  ['正式 profile 文件、命令、Skill、MCP 与两类模型协议回归', ['--import', 'tsx', 'tests/phase2-e2e.ts']],
  ['Windows 单窗格交互回归', ['--import', 'tsx', 'tests/phase2-terminal.ts']],
  ['Windows 多窗格真实终端验收', ['--import', 'tsx', 'tests/phase3-terminal.ts']],
  ['启动帮助', ['bin/emergence.cjs', '--help']],
  ['启动版本', ['bin/emergence.cjs', '--version']],
] as const;
const results = [];
for (const [name, args] of steps) {
  const begin = performance.now();
  const result = spawnSync(process.execPath, [...args], {
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 4_000_000,
  });
  results.push({
    name,
    exitCode: result.status,
    error: result.error?.message,
    durationMs: Math.round(performance.now() - begin),
    stdout: result.stdout,
    stderr: result.stderr,
  });
  console.log(`${result.status === 0 ? 'PASS' : 'FAIL'} ${name}`);
  if (result.status !== 0) {
    console.error(result.stdout, result.stderr);
    break;
  }
}
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const lock = JSON.parse(await readFile('package-lock.json', 'utf8')).packages[''];
const aligned =
  JSON.stringify(pkg.dependencies) === JSON.stringify(lock.dependencies) &&
  JSON.stringify(pkg.devDependencies) === JSON.stringify(lock.devDependencies) &&
  pkg.version === lock.version;
const versionAligned = results.at(-1)?.stdout.trim() === pkg.version;
const passed =
  results.length === steps.length && results.every((r) => r.exitCode === 0) && aligned && versionAligned;
const terminal = JSON.parse(await readFile(resolve(dir, 'terminal.json'), 'utf8'));
const inspection = {
  timestamp: new Date().toISOString(),
  passed,
  runtime: process.version,
  platform: process.platform,
  version: pkg.version,
  lockAligned: aligned,
  versionAligned,
  results,
  terminalChecks: terminal.checks,
  modelValidation:
    '多窗格测试使用本地 HTTP/SSE 模型服务和真实 Harness/profile/文件及命令工具。第二阶段 DeepSeek 实网证据沿用，未重复收费调用。',
  limits: [
    '本次没有第二家真实供应商验证',
    '物理中文输入法、字体及其他终端仍需人工检查',
    '共享文件冲突保护覆盖本工作台内 write/edit 的重叠执行，不覆盖 shell/MCP/外部编辑器',
    '终端测试驱动确认应用与 shell 退出后显式退出，以绕过 node-pty Windows conout worker 保留；不据此宣称全部测试资源自然回收',
  ],
};
await writeFile(resolve(dir, 'inspection.json'), JSON.stringify(inspection, null, 2));
await writeFile(
  resolve(dir, 'inspection-summary.md'),
  `# 第三阶段巡检\n\n结果：${passed ? '通过' : '未通过'}\n\n${results.map((r) => `- ${r.exitCode === 0 ? '通过' : '失败'}：${r.name}`).join('\n')}\n\n依赖锁和版本一致：${aligned && versionAligned}\n\n${inspection.modelValidation}\n\n${inspection.limits.map((s) => `- ${s}`).join('\n')}\n`,
);
if (!passed) process.exitCode = 1;
