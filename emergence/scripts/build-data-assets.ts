import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { loadDataAssets } from '../src/domains/data/runtime.ts';

export async function buildDataAssets() {
  const source = (await loadDataAssets()).assets;
  const target = resolve('dist/data');
  await mkdir(target, { recursive: true });
  const names = [
    'worker.py',
    'analytics.py',
    'probe.py',
    'requirements.txt',
    'requirements-win32-py314.txt',
    'runtime-lock.json',
  ];
  const files: Record<string, string> = {};
  async function walk(path: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isSymbolicLink()) throw new Error('数据构建资源不能包含链接');
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) names.push(relative(source, file).replaceAll('\\', '/'));
    }
  }
  await walk(join(source, 'licenses'));
  for (const name of names) {
    await mkdir(join(target, name, '..'), { recursive: true });
    await cp(join(source, name), join(target, name));
    files[name] = createHash('sha256')
      .update(await readFile(join(target, name)))
      .digest('hex');
  }
  await writeFile(join(target, 'manifest.json'), JSON.stringify(files, null, 2) + '\n');
}
