import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { createUpdateService } from './updates/runtime.ts';

/** Installer operations belong to the release manager, never the Agent execution loop. */
export async function runInstallationCommand(
  appRoot: string,
  args: string[],
  source?: string,
  check = false,
) {
  const action = args[0] === 'installation' ? args[1] : args[0];
  if (check && (action !== 'update' || source))
    throw Error('--check 仅用于在线检查，不能与 --source 或其他维护操作组合');
  const allowed =
    args[0] === 'installation' ? ['status', 'cleanup', 'recover'] : ['update', 'repair', 'rollback'];
  if (!allowed.includes(action) || args.length !== (args[0] === 'installation' ? 2 : 1))
    throw new Error(
      '用法：emergence update|repair --source <完整发行包目录>；emergence rollback；emergence installation status|cleanup|recover',
    );
  if (action === 'update' && !source) {
    const service = await createUpdateService();
    try {
      const state = await service.check(true);
      if (check) {
        console.log(JSON.stringify(state));
        return;
      }
      if (state.status !== 'available' || !state.release) {
        console.log(state.message);
        if (['error', 'unsupported'].includes(state.status)) process.exitCode = 1;
        return;
      }
      service.on('change', () => console.log(service.snapshot.message));
      await service.install(state.release.version);
    } finally {
      service.dispose();
    }
    return;
  }
  if (action === 'repair' && !source) throw new Error('修复请用 --source 指定当前版本的完整发行包');
  const releaseRoot = resolve(appRoot, '../..');
  const root = resolve(releaseRoot, '../..');
  let marker: { product?: string; schema?: number };
  try {
    marker = JSON.parse(await readFile(join(root, 'installation.json'), 'utf8'));
    if (
      basename(dirname(releaseRoot)).toLowerCase() !== 'versions' ||
      marker.product !== 'emergence' ||
      marker.schema !== 2
    )
      throw new Error('not managed');
  } catch {
    throw new Error(
      '此入口属于便携版、开发版或旧安装。请使用完整发行包的 install.ps1 安装到独立目录；不会覆盖源码或自定义入口。',
    );
  }
  const parameters = [
    '-NoLogo',
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    join(root, 'maintenance.ps1'),
    '-Action',
    action,
    '-InstallRoot',
    root,
  ];
  if (source) parameters.push('-Source', resolve(source));
  const child = spawn(
    join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    parameters,
    { windowsHide: true, stdio: 'inherit' },
  );
  const code = await new Promise<number | null>((done, reject) => {
    child.once('error', reject);
    child.once('exit', done);
  });
  process.exitCode = code ?? 1;
}
