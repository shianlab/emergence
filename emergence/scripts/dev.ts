import { spawn } from 'node:child_process';
await import('./build.ts');
const child = spawn(process.execPath, ['bin/emergence.cjs', ...process.argv.slice(2)], { stdio: 'inherit' });
process.on('SIGINT', () => {
  if (process.platform !== 'win32') child.kill('SIGINT');
});
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.once('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once('exit', (code) => {
  process.exitCode = code ?? 1;
});
