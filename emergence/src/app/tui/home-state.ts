import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { LaunchConfig } from '../session-config.ts';

/** Same project key as WorkspaceController; the entry page never writes this file. */
export function snapshotPath(config: Pick<LaunchConfig, 'cwd' | 'home'>) {
  const key = createHash('sha256')
    .update(process.platform === 'win32' ? config.cwd.toLowerCase() : config.cwd)
    .digest('hex')
    .slice(0, 20);
  return join(config.home, 'workspaces', `${key}.json`);
}
export async function hasSnapshot(config: Pick<LaunchConfig, 'cwd' | 'home'>) {
  try {
    return (await stat(snapshotPath(config))).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
/** Selecting a new conversation preserves the previous workspace, byte for byte. */
export async function archiveSnapshot(config: Pick<LaunchConfig, 'cwd' | 'home'>) {
  const source = snapshotPath(config),
    archive = source.replace(/\.json$/, `.before-home-${randomUUID()}.json`);
  try {
    await copyFile(source, archive, constants.COPYFILE_EXCL);
    return archive;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}
export async function gitBranch(cwd: string, signal?: AbortSignal) {
  try {
    const { stdout } = await promisify(execFile)('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      timeout: 1500,
      windowsHide: true,
      signal,
    });
    return stdout.trim();
  } catch {
    return '';
  }
}
export function homeLayout(width: number, height: number) {
  const padding = width < 60 ? 1 : 2,
    contentWidth = Math.max(1, Math.min(88, width - padding * 2));
  const logo =
    contentWidth >= 56 && height >= 32
      ? ('home' as const)
      : contentWidth >= 48 && height >= 28
        ? ('small' as const)
        : contentWidth >= 40 && height >= 24
          ? ('tiny' as const)
          : undefined;
  const logoHeight = logo === 'home' ? 11 : logo === 'small' ? 10 : logo === 'tiny' ? 8 : 1;
  const infoRows = height >= 32 ? 4 : height >= 28 ? 3 : 2;
  return {
    logo,
    logoHeight,
    wordmark: logo !== undefined,
    contentWidth,
    padding,
    infoRows,
    topRows: height >= 38 ? 2 : height >= 20 ? 1 : 0,
    noticeRows: height >= 38 ? 2 : 1,
    statusGap: 1,
    hintGap: height >= 28 ? 1 : 0,
    linkGap: height >= 32 ? 1 : 0,
    showExit: height >= 36,
    heroHeight: logoHeight + (logo ? 4 : 0) + 1 + infoRows,
  };
}
