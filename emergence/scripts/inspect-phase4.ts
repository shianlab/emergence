import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const dir = resolve('../artifacts/phase4');
await mkdir(dir, { recursive: true });
const steps = [
  ['构建正式入口与插件', ['--import', 'tsx', 'scripts/build.ts']],
  ['严格类型检查', ['node_modules/typescript/bin/tsc', '--noEmit']],
  [
    '配置、凭据、路由、布局、Harness 工作台、协作队列与 Git 整合',
    [
      '--import',
      'tsx',
      '--test',
      'tests/config.test.ts',
      'tests/credentials.test.ts',
      'tests/isolation.test.ts',
      'tests/layout.test.ts',
      'tests/workspace.test.ts',
      'tests/collaboration.test.ts',
      'tests/integration.test.ts',
      'tests/pane-close.test.ts',
      'tests/audit-security.test.ts',
    ],
  ],
  ['Harness 生命周期与取消', ['--import', 'tsx', 'probes/harness.ts']],
  ['正式 profile 文件、命令、Skill、MCP 与两类模型协议回归', ['--import', 'tsx', 'tests/phase2-e2e.ts']],
  ['Windows 单窗口终端回归', ['--import', 'tsx', 'tests/phase2-terminal.ts']],
  ['Windows 多窗口独立模式回归', ['--import', 'tsx', 'tests/phase3-terminal.ts']],
  ['Windows 主控协作完整终端验收', ['--import', 'tsx', 'tests/phase4-terminal.ts']],
  ['Windows 关闭窗口、取消隔离与重启移除', ['--import', 'tsx', 'tests/pane-close-terminal.ts']],
  ['Windows 多实例、会话互斥与运行配置隔离', ['--import', 'tsx', 'tests/audit-terminal.ts']],
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
const lockAligned =
  JSON.stringify(pkg.dependencies) === JSON.stringify(lock.dependencies) &&
  JSON.stringify(pkg.devDependencies) === JSON.stringify(lock.devDependencies) &&
  pkg.version === lock.version;
const versionAligned = results.at(-1)?.stdout.trim() === pkg.version;
let terminal: { passed?: boolean; checks?: object } = {};
try {
  terminal = JSON.parse(await readFile(resolve(dir, 'terminal.json'), 'utf8'));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
const passed =
  results.length === steps.length &&
  results.every((r) => r.exitCode === 0) &&
  lockAligned &&
  versionAligned &&
  terminal.passed === true;
let liveEvidence: { passed?: boolean; timestamp?: string; provider?: string; model?: string } | undefined;
try {
  const value = JSON.parse(await readFile(resolve(dir, 'live-deepseek.json'), 'utf8'));
  liveEvidence = {
    passed: value.passed,
    timestamp: value.timestamp,
    provider: value.provider,
    model: value.model,
  };
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
const inspection = {
  timestamp: new Date().toISOString(),
  passed,
  runtime: process.version,
  platform: process.platform,
  version: pkg.version,
  lockAligned,
  versionAligned,
  results,
  terminalChecks: terminal.checks,
  liveEvidence,
  modelValidation: liveEvidence?.passed
    ? '协作故障与取消验收使用本地 HTTP/SSE 模型服务。另已用 DeepSeek Flash 实网完成一个主控、两个执行窗口的派发、文件写入/读回和回执验收。本巡检不重复收费调用。'
    : '协作验收使用本地 HTTP/SSE 模型服务，实际运行 Harness、正式 profile、文件与 shell 工具；实网协作状态见 live-deepseek.json。',
  limits: [
    '另一家真实供应商、物理输入法与其他终端仍待补验',
    '任务成功表示明确报告且轮次正常、没有已观察到的工具/命令失败，不证明代码语义正确',
    '共享文件保护只覆盖内部 write/edit 的重叠调用；Git 整合不自动运行测试或解决冲突',
    'Windows ConPTY 驱动在确认应用和 shell 退出后显式结束，绕过 node-pty conout worker 保留，不宣称全部测试资源自然回收',
  ],
};
await writeFile(resolve(dir, 'inspection.json'), JSON.stringify(inspection, null, 2));
await writeFile(
  resolve(dir, 'inspection-summary.md'),
  `# 第四阶段巡检\n\n结果：${passed ? '通过' : '未通过'}\n\n${results.map((r) => `- ${r.exitCode === 0 ? '通过' : '失败'}：${r.name}`).join('\n')}\n\n依赖锁与版本一致：${lockAligned && versionAligned}\n\n${inspection.modelValidation}\n\n${inspection.limits.map((s) => `- ${s}`).join('\n')}\n`,
);
if (!passed) process.exitCode = 1;
