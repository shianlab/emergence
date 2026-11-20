import { lstat, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { readJsonFile, replaceJsonFile } from '../../core/storage/safe-json-file.ts';

export interface InstallationLocation {
  kind: 'managed' | 'portable' | 'development';
  root?: string;
  release?: string;
}
export async function safePath(file: string) {
  for (let cursor = resolve(file); ; cursor = dirname(cursor)) {
    try {
      if ((await lstat(cursor)).isSymbolicLink()) throw Error('更新目录包含链接，已停止操作');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (dirname(cursor) === cursor) break;
  }
}

export async function hasInstallTransaction(root: string) {
  const file = join(root, 'install-transaction.json');
  await safePath(file);
  try {
    if (!(await lstat(file)).isFile()) throw Error('安装事务路径无效');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
export async function installationLocation(
  from = fileURLToPath(import.meta.url),
): Promise<InstallationLocation> {
  for (let cursor = dirname(from); ; cursor = dirname(cursor)) {
    try {
      const release = JSON.parse(await readFile(join(cursor, 'release.json'), 'utf8'));
      if (release.product === 'emergence') {
        const root = resolve(cursor, '../..');
        if (dirname(cursor).toLowerCase() === join(root, 'versions').toLowerCase()) {
          await safePath(root);
          const owner = (await readJsonFile(join(root, 'installation.json'), 65536, '安装记录无效')) as {
            product?: string;
            schema?: number;
          };
          if (owner.product === 'emergence' && owner.schema === 2)
            return { kind: 'managed', root, release: cursor };
        }
        return { kind: 'portable', release: cursor };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { kind: 'development' };
    }
    if (dirname(cursor) === cursor) return { kind: 'development' };
  }
}
const stateSchema = z
  .object({
    enabled: z.boolean().default(true),
    checkedAt: z.number().default(0),
    sequence: z.number().int().nonnegative().default(0),
    envelope: z.unknown().optional(),
    dismissed: z.string().optional(),
    error: z.string().max(500).optional(),
    installed: z.string().optional(),
  })
  .strict();
export type UpdateState = z.infer<typeof stateSchema>;
export class UpdateStore {
  readonly file: string;
  constructor(readonly root: string) {
    this.file = join(root, 'updates/state.json');
  }
  async read(): Promise<UpdateState> {
    await safePath(this.file);
    try {
      return stateSchema.parse(await readJsonFile(this.file, 100000, '更新缓存无效'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return stateSchema.parse({});
      throw error;
    }
  }
  async write(value: UpdateState) {
    await safePath(this.file);
    const owner = (await readJsonFile(join(this.root, 'installation.json'), 65536, '安装所有权记录无效')) as {
      product?: string;
      schema?: number;
    };
    if (owner.product !== 'emergence' || owner.schema !== 2)
      throw Error('安装已移除或发生变化，未写入更新缓存');
    await mkdir(dirname(this.file), { recursive: true });
    await replaceJsonFile(this.file, stateSchema.parse(value), {
      invalidMessage: '更新缓存无效',
      maxBytes: 100000,
    });
  }
}
