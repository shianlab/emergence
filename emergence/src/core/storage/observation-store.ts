import { lstat, mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { ObservationStore } from '../application/ports.ts';
import { observationSnapshotSchema, type ObservationSnapshot } from '../domain/contracts.ts';
import { readJsonFile, replaceJsonFile } from './safe-json-file.ts';

/** Bounded diagnostic snapshots; deliberately not a durable execution repository. */
export class FileObservationStore implements ObservationStore {
  constructor(private home: string) {}
  private async directory(create: boolean) {
    const home = await realpath(this.home);
    let dir = home;
    for (const name of ['core', 'observations']) {
      dir = join(dir, name);
      if (create)
        await mkdir(dir).catch((e) => {
          if (e.code !== 'EEXIST') throw e;
        });
      const stat = await lstat(dir);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('CORE_STORE_UNSAFE_PATH');
    }
    return dir;
  }
  async read(scopeKey: string) {
    if (!/^[a-f0-9]{64}$/.test(scopeKey)) throw new Error('CORE_STORE_SCOPE_INVALID');
    try {
      const path = join(await this.directory(false), scopeKey + '.json');
      const value = observationSnapshotSchema.parse(
        await readJsonFile(path, 128000, 'CORE_STORE_INVALID_FILE'),
      );
      if (value.scopeKey !== scopeKey) throw new Error('CORE_STORE_SCOPE_MISMATCH');
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new Error('CORE_STORE_READ_FAILED');
    }
  }
  async write(input: ObservationSnapshot) {
    const value = observationSnapshotSchema.parse(input),
      dir = await this.directory(true),
      path = join(dir, value.scopeKey + '.json');
    await replaceJsonFile(path, value, { invalidMessage: 'CORE_STORE_UNSAFE_PATH' });
  }
}
