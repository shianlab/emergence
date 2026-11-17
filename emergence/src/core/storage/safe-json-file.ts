import { randomUUID } from 'node:crypto';
import { lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

/** File mechanics only. Callers own directory validation, schema, locking and recovery. */
export async function readJsonFile(path: string, maxBytes: number, invalidMessage: string): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isFile() || info.size > maxBytes) throw new Error(invalidMessage);
      const bytes = await readFile(path);
      if (bytes.length > maxBytes) throw new Error(invalidMessage);
      return JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      // Windows replacement can briefly hide a directory entry from a concurrent
      // reader. Recheck this path and all validation; never substitute empty data.
      if (
        process.platform !== 'win32' ||
        attempt >= 3 ||
        !['ENOENT', 'EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')
      )
        throw error;
      await delay(5 * 2 ** attempt);
    }
  }
}

export async function replaceJsonFile(
  path: string,
  value: unknown,
  options: {
    invalidMessage: string;
    maxBytes?: number;
    budgetMessage?: string;
    pretty?: boolean;
    newline?: boolean;
  },
): Promise<void> {
  await checkTarget(path, options.invalidMessage);
  const text = JSON.stringify(value, null, options.pretty ? 2 : undefined) + (options.newline ? '\n' : '');
  if (options.maxBytes !== undefined && Buffer.byteLength(text) > options.maxBytes) {
    throw new Error(options.budgetMessage ?? options.invalidMessage);
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
    // Windows readers can briefly deny replacement. Retry only this same rename,
    // never rewrite in place, remove the destination, or replay the caller's work.
    for (let attempt = 0; ; attempt++) {
      await checkTarget(path, options.invalidMessage);
      try {
        await rename(temporary, path);
        break;
      } catch (error) {
        if (
          process.platform !== 'win32' ||
          attempt >= 4 ||
          !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')
        )
          throw error;
        await delay(20 * 2 ** attempt);
      }
    }
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

async function checkTarget(path: string, invalidMessage: string) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(invalidMessage);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
