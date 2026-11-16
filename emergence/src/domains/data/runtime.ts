import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { readJsonFile } from '../../core/storage/safe-json-file.ts';

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const dataLockSchema = z.object({
  version: z.literal(1),
  python: z.literal('3.14'),
  platform: z.literal('win32'),
  arch: z.literal('x64'),
  packages: z
    .array(
      z.object({
        name: z.string().regex(/^[a-z0-9-]+$/),
        version: z.string().regex(/^\d+(\.\d+)+$/),
        wheel: z.string().regex(/^[a-zA-Z0-9_.-]+\.whl$/),
        sha256,
      }),
    )
    .min(1)
    .max(32),
});
const pointerSchema = z.object({ version: z.literal(1), directory: z.string().uuid(), lockHash: sha256 });
export type DataAssets = Awaited<ReturnType<typeof loadDataAssets>>;

export async function applicationRoot() {
  let root = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++, root = dirname(root)) {
    try {
      if (JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).name === 'emergence-tui')
        return root;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  throw new Error('找不到涌现应用目录');
}

/** Packaged applications must verify their own data assets; never fall back to an author's source tree. */
export async function loadDataAssets(application?: string) {
  const root = application ?? (await applicationRoot());
  const packaged = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).emergencePortable === true;
  const assets = join(root, packaged ? 'dist/data' : 'src/domains/data');
  if (packaged) {
    const manifest = z
      .record(z.string(), sha256)
      .parse(await readJsonFile(join(assets, 'manifest.json'), 65536, '数据资源清单无效'));
    for (const required of [
      'worker.py',
      'analytics.py',
      'requirements.txt',
      'requirements-win32-py314.txt',
      'runtime-lock.json',
      'probe.py',
    ])
      if (!manifest[required]) throw new Error('数据资源清单缺少 ' + required);
    for (const [name, hash] of Object.entries(manifest)) {
      if (!/^(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+$/.test(name) || name.split('/').includes('..'))
        throw new Error('数据资源路径无效');
      const file = join(assets, name);
      const info = await lstat(file);
      const actual = relative(await realpath(assets), await realpath(file));
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        actual.startsWith('..') ||
        digest(await readFile(file)) !== hash
      )
        throw new Error('数据资源校验失败：' + name);
    }
  }
  const lock = dataLockSchema.parse(
    await readJsonFile(join(assets, 'runtime-lock.json'), 32768, '数据依赖锁无效'),
  );
  const requirements = lock.packages
    .map((p) => `${p.name}==${p.version} --hash=sha256:${p.sha256}`)
    .join('\n');
  const pinned = (await readFile(join(assets, 'requirements-win32-py314.txt'), 'utf8'))
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('#'))
    .join('\n');
  if (pinned !== requirements) throw new Error('数据依赖锁与安装清单不一致');
  return { root, assets, packaged, lock, lockHash: digest(JSON.stringify(lock)) };
}

export function dataEnvironmentRoot(home: string, lockHash: string) {
  // Keep Windows package paths short; the complete digest is still checked in active.json.
  return join(resolve(home), 'runtimes', 'data', lockHash.slice(0, 16));
}

export async function dataRuntime(
  home = resolve(process.env.EMERGENCE_HOME ?? join(homedir(), '.emergence')),
) {
  const assets = await loadDataAssets();
  const directory = dataEnvironmentRoot(home, assets.lockHash);
  let pointer: z.infer<typeof pointerSchema> | undefined;
  try {
    pointer = pointerSchema.parse(
      await readJsonFile(join(directory, 'active.json'), 4096, '数据环境指针无效'),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let python: string;
  if (pointer) {
    if (pointer.lockHash !== assets.lockHash) throw new Error('数据环境版本与当前应用不一致');
    const env = join(directory, pointer.directory);
    if ((await realpath(env)) !== join(await realpath(directory), pointer.directory))
      throw new Error('数据环境目录不能是外部链接');
    python = join(env, 'Scripts/python.exe');
  } else {
    // Existing source checkouts remain usable. Packaged runs never reuse development environments.
    python = assets.packaged
      ? join(directory, 'not-initialized', 'Scripts/python.exe')
      : join(assets.root, '.data-venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  }
  return {
    root: assets.root,
    python,
    worker: join(assets.assets, 'worker.py'),
    probe: join(assets.assets, 'probe.py'),
    lock: join(assets.assets, 'runtime-lock.json'),
  };
}
