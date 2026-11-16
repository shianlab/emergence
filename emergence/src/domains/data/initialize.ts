import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { safeError } from '../../core/adapters/redaction.ts';
import { canonicalDirectory, withLease } from '../../core/storage/lease.ts';
import { replaceJsonFile } from '../../core/storage/safe-json-file.ts';
import { dataEnvironmentRoot, loadDataAssets } from './runtime.ts';

const execute = promisify(execFile);
async function pythonRun(python: string, args: string[], cwd: string, timeout: number) {
  try {
    const { stdout } = await execute(python, ['-I', '-B', '-X', 'utf8', ...args], {
      cwd,
      windowsHide: true,
      timeout,
      maxBuffer: 2 * 1024 * 1024,
      env: {
        SystemRoot: process.env.SystemRoot,
        PATH: dirname(python),
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
      },
    });
    return stdout.trim();
  } catch (error) {
    const details = (error as { stderr?: string }).stderr;
    throw new Error(`数据环境初始化失败，原环境未切换：${safeError(details || error).slice(-4000)}`);
  }
}

/** Build in a new permanent path; activate only after imports, versions and pip consistency pass. */
export async function initializeData(
  home: string,
  options: { python: string; wheelDirectory?: string; offline?: boolean; force?: boolean },
) {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw new Error('当前数据初始化仅验收 Windows x64 / Python 3.14');
  const assets = await loadDataAssets();
  const python = await realpath(resolve(options.python));
  const version = await pythonRun(
    python,
    [
      '-c',
      'import sys,struct; print(str(sys.version_info.major)+"."+str(sys.version_info.minor)+":"+str(struct.calcsize("P")*8))',
    ],
    assets.root,
    10000,
  );
  if (version !== '3.14:64') throw new Error('请选择 Python 3.14 的 64 位 python.exe；现有环境未更改');
  const base = dataEnvironmentRoot(home, assets.lockHash);
  await mkdir(base, { recursive: true });
  const baseReal = await realpath(base);
  if (!baseReal.toLowerCase().startsWith((await realpath(home)).toLowerCase() + '\\'))
    throw new Error('数据环境不能位于配置目录外');
  return withLease(`data-runtime:${await canonicalDirectory(base)}`, '数据环境初始化', async () => {
    const active = join(base, 'active.json');
    let previous: string | undefined;
    try {
      const info = await lstat(active);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw new Error('数据环境指针无效');
      previous = await readFile(active, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (previous && !options.force) {
      const pointer = JSON.parse(previous);
      if (
        pointer.version === 1 &&
        pointer.lockHash === assets.lockHash &&
        /^[a-f0-9-]{36}$/.test(pointer.directory)
      ) {
        const env = join(base, pointer.directory);
        if ((await realpath(env)) !== join(baseReal, pointer.directory)) throw new Error('数据环境目录无效');
        await pythonRun(
          join(env, 'Scripts/python.exe'),
          [join(assets.assets, 'probe.py'), join(assets.assets, 'runtime-lock.json')],
          assets.root,
          20000,
        );
        return { changed: false, python: join(env, 'Scripts/python.exe'), lockHash: assets.lockHash };
      }
      throw new Error('原数据环境指针损坏；请核对后用 --force-data-init 重建，旧环境保留');
    }
    const id = randomUUID(),
      environment = join(base, id),
      executable = join(environment, 'Scripts/python.exe');
    let activated = false;
    try {
      await pythonRun(python, ['-m', 'venv', '--copies', '--without-pip', environment], assets.root, 30000);
      await pythonRun(executable, ['-m', 'ensurepip', '--default-pip'], assets.root, 90000);
      const install = [
        '-m',
        'pip',
        '--isolated',
        'install',
        '--disable-pip-version-check',
        '--no-input',
        '--require-hashes',
        '--only-binary=:all:',
        '--no-cache-dir',
        '--retries',
        '0',
        '--timeout',
        '15',
        '-r',
        join(assets.assets, 'requirements-win32-py314.txt'),
      ];
      if (options.offline) install.push('--no-index');
      else install.push('--index-url', 'https://pypi.org/simple');
      if (options.wheelDirectory)
        install.push('--find-links', await realpath(resolve(options.wheelDirectory)));
      await pythonRun(executable, install, assets.root, 240000);
      await pythonRun(
        executable,
        ['-m', 'pip', '--isolated', 'check', '--disable-pip-version-check'],
        assets.root,
        20000,
      );
      const verified = JSON.parse(
        await pythonRun(
          executable,
          [join(assets.assets, 'probe.py'), join(assets.assets, 'runtime-lock.json')],
          assets.root,
          20000,
        ),
      );
      if (previous)
        await writeFile(join(base, `active.backup-${randomUUID()}.json`), previous, {
          flag: 'wx',
          mode: 0o600,
        });
      await replaceJsonFile(
        active,
        { version: 1, directory: id, lockHash: assets.lockHash },
        { invalidMessage: '无法切换数据环境' },
      );
      activated = true;
      return { changed: true, python: executable, lockHash: assets.lockHash, verified };
    } finally {
      if (!activated) {
        // Only this attempt's UUID directory may be removed; never delete an active or previous environment.
        try {
          const current = await realpath(environment);
          if (relative(baseReal, current) !== id || (await lstat(environment)).isSymbolicLink())
            throw new Error('拒绝清理非本次数据目录');
          await rm(environment, { recursive: true, force: false });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
    }
  });
}
