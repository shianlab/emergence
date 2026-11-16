import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const dir = resolve('../artifacts/phase5');
await mkdir(dir, { recursive: true });
const steps = [
  ['前四阶段全部产品与安全回归', ['--import', 'tsx', 'scripts/inspect-phase4.ts']],
  [
    '第五阶段模板、权限、历史兼容、扩展生命周期与 MCP 故障隔离',
    ['--import', 'tsx', '--test', 'tests/phase5.test.ts'],
  ],
  [
    '第五阶段并发配置、子代理目录、MCP 退出与图片历史安全',
    ['--import', 'tsx', '--test', 'tests/audit-phase5.test.ts'],
  ],
  [
    '模板切换时的原生编辑器、草稿归档和慢释放',
    ['--experimental-ffi', '--import', 'tsx', 'tests/audit-template-ui.ts'],
  ],
  ['第五阶段 Windows 真实终端与原生子代理', ['--import', 'tsx', 'tests/phase5-terminal.ts']],
] as const;
const results = [];
for (const [name, args] of steps) {
  const start = performance.now(),
    result = spawnSync(process.execPath, [...args], {
      encoding: 'utf8',
      timeout: 240000,
      maxBuffer: 5_000_000,
    });
  results.push({
    name,
    exitCode: result.status,
    error: result.error?.message,
    durationMs: Math.round(performance.now() - start),
    stdout: result.stdout,
    stderr: result.stderr,
  });
  console.log(`${result.status === 0 ? 'PASS' : 'FAIL'} ${name}`);
  if (result.status !== 0) {
    console.error(result.stdout, result.stderr);
    break;
  }
}
const previous = JSON.parse(await readFile(resolve('../artifacts/phase4/inspection.json'), 'utf8'));
let terminal: { passed?: boolean; checks?: object } = {};
try {
  terminal = JSON.parse(await readFile(resolve(dir, 'terminal.json'), 'utf8'));
} catch {}
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const passed =
  results.length === steps.length &&
  results.every((r) => r.exitCode === 0) &&
  previous.passed &&
  terminal.passed;
const inspection = {
  timestamp: new Date().toISOString(),
  passed: !!passed,
  version: pkg.version,
  runtime: process.version,
  results,
  previousCheckGroups: previous.results.length,
  terminalChecks: terminal.checks,
  modelValidation:
    '本轮使用本机 HTTP/SSE 服务和真实 Harness、原生子代理、工具、Skill、MCP 与 Windows ConPTY。沿用阶段二、四 DeepSeek 实网证据；未重复收费调用。',
  limits: [
    '原生子代理的固定委派权限仍由 Harness 控制；需要额外审批的操作自动拒绝。',
    '本地扩展是受信任的进程内模块；异步任务和 activate 必须响应 AbortSignal，不能隔离恶意或无限循环代码。',
    '界面语言覆盖工作台控件；模型回复、Harness 原始诊断和部分命令说明保持原语言。',
    '模型 capabilities 是配置声明；不自动探测任意供应商的历史兼容性。',
    '另一真实供应商、物理输入法、其他终端与长时间压力测试留至第六阶段。',
  ],
};
await writeFile(resolve(dir, 'inspection.json'), JSON.stringify(inspection, null, 2));
await writeFile(
  resolve(dir, 'inspection-summary.md'),
  `# 第五阶段巡检\n\n结果：${passed ? '通过' : '未通过'}\n\n${results.map((r) => `- ${r.exitCode === 0 ? '通过' : '失败'}：${r.name}`).join('\n')}\n\n${inspection.modelValidation}\n\n${inspection.limits.map((s) => `- ${s}`).join('\n')}\n`,
);
if (!passed) process.exitCode = 1;
