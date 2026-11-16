import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const dir = resolve('../artifacts/phase2');
await mkdir(dir, { recursive: true });
const steps = [
  ['构建正式入口与插件', ['--import', 'tsx', 'scripts/build.ts']],
  ['严格类型检查', ['node_modules/typescript/bin/tsc', '--noEmit']],
  [
    '配置、凭据与路由回归',
    [
      '--import',
      'tsx',
      '--test',
      'tests/config.test.ts',
      'tests/credentials.test.ts',
      'tests/isolation.test.ts',
    ],
  ],
  ['Harness 并发取消回归', ['--import', 'tsx', 'probes/harness.ts']],
  ['正式 profile 工具与持久化链路', ['--import', 'tsx', 'tests/phase2-e2e.ts']],
  ['Windows 真实终端交互', ['--import', 'tsx', 'tests/phase2-terminal.ts']],
  ['安装入口帮助', ['bin/emergence.cjs', '--help']],
] as const;
const results = [];
for (const [name, args] of steps) {
  const begin = performance.now();
  const result = spawnSync(process.execPath, [...args], {
    encoding: 'utf8',
    timeout: 90000,
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
const passed = results.length === steps.length && results.every((r) => r.exitCode === 0) && aligned;
let liveEvidence: { passed?: boolean; provider?: string; timestamp?: string } | undefined;
try {
  liveEvidence = JSON.parse(await readFile(resolve(dir, 'live-deepseek.json'), 'utf8'));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
const externalVerified = liveEvidence?.passed === true;
const inspection = {
  timestamp: new Date().toISOString(),
  passed,
  runtime: process.version,
  platform: process.platform,
  version: pkg.version,
  lockAligned: aligned,
  results,
  externalSuppliersTested: externalVerified,
  liveEvidence,
  pending: [
    ...(externalVerified ? ['另一家真实供应商调用'] : ['真实供应商密钥与外部网络调用']),
    '物理中文输入法与字体人工检查',
  ],
  shellPolicy: 'ask-local: 每次本地命令需要确认；--approve-command 仅允许完全相同的一次命令',
};
await writeFile(resolve(dir, 'inspection.json'), JSON.stringify(inspection, null, 2));
await writeFile(
  resolve(dir, 'inspection-summary.md'),
  `# 第二阶段巡检\n\n结果：${passed ? '通过' : '未通过'}\n\n${results.map((r) => `- ${r.exitCode === 0 ? '通过' : '失败'}：${r.name}`).join('\n')}\n\n依赖锁一致：${aligned}\n\n模型协议通过本地 HTTP/SSE 服务验证。${externalVerified ? `真实 DeepSeek 调用已通过，记录时间 ${liveEvidence?.timestamp}，见 live-deepseek.json；本次巡检不重复发起收费请求。另一家真实供应商仍待验证。` : '真实供应商未调用。'}\n\nWindows 终端驱动在确认应用及 shell 退出后显式结束，沿用阶段一对 node-pty 测试资源的处理。\n`,
);
if (!passed) process.exitCode = 1;
