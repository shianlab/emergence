import { readdir, readFile, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { replaceJsonFile } from '../core/storage/safe-json-file.ts';
const name = /^emergence-[a-f0-9-]{36}$/;
const ownedFiles = ['package.json', 'cordis.patch.yml', 'cordis.yml', 'lifecycle.json'];
function alive(pid: number | undefined) {
  if (!Number.isSafeInteger(pid) || !pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
export async function markProfile(path: string, harnessPid?: number) {
  await replaceJsonFile(
    join(path, 'lifecycle.json'),
    { product: 'emergence', cliPid: process.pid, harnessPid, createdAt: Date.now() },
    { invalidMessage: '进程标记路径不是普通文件，未覆盖' },
  );
}
export async function removeProfile(path: string) {
  // Never recursively remove a profile; unknown files are retained for diagnosis.
  await Promise.allSettled(ownedFiles.map((file) => unlink(join(path, file))));
  await rmdir(path).catch((error) => {
    if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error;
  });
}
export async function cleanStaleProfiles(home: string) {
  const root = join(home, 'harness/profiles');
  let removed = 0;
  const entries = await readdir(root, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !name.test(entry.name)) continue;
    const path = join(root, entry.name);
    let marker;
    try {
      marker = JSON.parse(await readFile(join(path, 'lifecycle.json'), 'utf8'));
    } catch {
      continue;
    }
    if (
      marker.product !== 'emergence' ||
      !Number.isFinite(marker.createdAt) ||
      Date.now() - marker.createdAt < 60000 ||
      alive(marker.cliPid) ||
      alive(marker.harnessPid)
    )
      continue;
    await removeProfile(path);
    removed++;
  }
  return removed;
}
