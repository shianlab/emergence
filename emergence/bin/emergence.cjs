#!/usr/bin/env node
const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const pkg = require('../package.json');
const localNode = pkg.emergencePortable === true ? join(__dirname, '../../runtime', process.platform === 'win32' ? 'node.exe' : 'node')
  : join(__dirname, '../node_modules/node/bin', process.platform === 'win32' ? 'node.exe' : 'node');
const [major, minor, patch] = process.versions.node.split('.').map(Number);
if (!existsSync(localNode) && (major < 26 || major === 26 && (minor < 12 || minor === 12 && patch < 1))) {
  console.error('涌现需要安全更新后的 Node >=26.12.1；请在工程目录执行 npm ci 安装项目自带运行时。'); process.exit(1);
}
const executable = existsSync(localNode) ? localNode : process.execPath;
const child = spawn(executable, ['--experimental-ffi', '--disable-warning=ExperimentalWarning', join(__dirname, '../dist/cli.mjs'), ...process.argv.slice(2)], { stdio: 'inherit' });
process.on('SIGINT', () => { if (process.platform !== 'win32') child.kill('SIGINT'); });
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.on('error', error => { console.error('涌现启动失败：' + error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
