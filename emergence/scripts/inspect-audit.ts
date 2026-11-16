import { spawnSync } from 'node:child_process';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import { homeDirectory } from '../src/app/config.ts';
import { readCredentials } from '../src/app/credentials.ts';
const dir = resolve('../artifacts/audit-2026-10-29');
await mkdir(dir, { recursive: true });
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('请使用 npm run inspect:audit 运行综合巡检');
const steps = [
  ['正式产品、安全回归与所有终端流程', ['--import', 'tsx', 'scripts/inspect-phase6.ts']],
  ['16 窗口短时并发与资源释放', ['--import', 'tsx', 'tests/audit-stress.ts']],
  ['npm 官方已知漏洞审计', [npmCli, 'audit', '--registry=https://registry.npmjs.org', '--json']],
] as const;
const results = [];
for (const [name, args] of steps) {
  const begin = performance.now(),
    result = spawnSync(process.execPath, [...args], {
      encoding: 'utf8',
      timeout: name.startsWith('正式') ? 1200000 : 240000,
      maxBuffer: 8_000_000,
    });
  results.push({
    name,
    exitCode: result.status,
    durationMs: Math.round(performance.now() - begin),
    error: result.error?.message,
    stdout: result.stdout,
    stderr: result.stderr,
  });
  if (name.startsWith('npm')) await writeFile(join(dir, 'npm-audit-after.json'), result.stdout);
  console.log(`${result.status === 0 ? 'PASS' : 'FAIL'} ${name}`);
  if (result.status !== 0) {
    console.error(result.stdout, result.stderr);
    break;
  }
}
const credentialHome = homeDirectory(),
  secrets = Object.values(await readCredentials(credentialHome)).filter((value) => value.length >= 8);
const extensions = new Set([
  '.ts',
  '.tsx',
  '.cjs',
  '.mjs',
  '.js',
  '.json',
  '.jsonl',
  '.yml',
  '.yaml',
  '.md',
  '.txt',
  '.ps1',
  '.cmd',
  '.map',
]);
const files: string[] = [];
async function walk(path: string) {
  try {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = join(path, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (extensions.has(extname(entry.name))) files.push(full);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
for (const path of [
  'src',
  'tests',
  'scripts',
  'probes',
  'examples',
  'release',
  'bin',
  'dist',
  '../docs',
  '../artifacts',
  credentialHome,
])
  await walk(resolve(path));
files.push(
  ...['package.json', 'package-lock.json', 'README.md', '../README.md'].map((path) => resolve(path)),
);
const matches: string[] = [];
for (const path of files) {
  if (!(await stat(path)).isFile()) continue;
  const text = await readFile(path, 'utf8');
  if (secrets.some((secret) => text.includes(secret)))
    matches.push(
      secrets.reduce((value, secret) => value.replaceAll(secret, '[已隐藏]'), relative(resolve('..'), path)),
    );
}
const credentialScan = {
  scannedFiles: files.length,
  credentialCount: secrets.length,
  plaintextMatches: matches.length,
  paths: matches,
  sourceKeyFileExcluded: true,
};
await writeFile(join(dir, 'credential-check.json'), JSON.stringify(credentialScan, null, 2));
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const phase4 = JSON.parse(await readFile(resolve('../artifacts/phase4/inspection.json'), 'utf8'));
const npmAudit = JSON.parse(await readFile(join(dir, 'npm-audit-after.json'), 'utf8'));
const [major, minor, patch] = process.versions.node.split('.').map(Number);
const runtimePatched = major > 26 || (major === 26 && (minor > 12 || (minor === 12 && patch >= 1)));
const passed =
  results.length === steps.length &&
  results.every((r) => r.exitCode === 0) &&
  credentialScan.credentialCount > 0 &&
  matches.length === 0 &&
  runtimePatched &&
  npmAudit.metadata?.vulnerabilities.total === 0;
await writeFile(
  join(dir, 'inspection.json'),
  JSON.stringify(
    {
      timestamp: new Date().toISOString(),
      passed,
      version: pkg.version,
      runtime: process.version,
      undici: process.versions.undici,
      openssl: process.versions.openssl,
      runtimePatched,
      results,
      knownVulnerabilities: npmAudit.metadata?.vulnerabilities,
      credentialScan,
      productCheckGroups: phase4.results.length,
      limits: [
        '短时并发不等于长时间压力验收',
        '物理输入法、字体、其他终端和另一家真实供应商仍待补验',
        '文件/命令/MCP 与第三方插件有本机权限边界，当前默认 ask-local 不是系统沙箱',
        'macOS/Linux 的 IPC 租约未在本机实测',
        '本轮不重复收费模型请求，实网协作证据沿用第四阶段',
      ],
    },
    null,
    2,
  ),
);
console.log(`${passed ? 'PASS' : 'FAIL'} 综合检查：运行时、依赖、凭据与产品回归`);
if (!passed) process.exitCode = 1;
