import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { unsupportedFilePath } from '../../platform/path-policy.ts';

import {
  evaluatePermissionWithPaths,
  evaluatePermissionsWithPaths,
  type PermissionCall,
  type PermissionSnapshot,
} from '../domain/permissions.ts';
/** Resolve the nearest existing ancestor too, so a new file behind a junction is not treated as in-project. */
export function canonicalPermissionPath(path: string, cwd: string): string {
  if (unsupportedFilePath(path) || unsupportedFilePath(cwd))
    throw new Error('路径包含不支持的设备名或数据流');
  const absolute = resolve(cwd, path);
  const physical = (p: string): string => {
    try {
      return realpathSync.native(p);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(p) === p) throw error;
      return resolve(physical(dirname(p)), basename(p));
    }
  };
  const result = physical(absolute);
  return process.platform === 'win32' ? result.toLowerCase() : result;
}
function within(root: string, target: string) {
  const p = relative(root, target);
  return !p || (!isAbsolute(p) && p !== '..' && !p.startsWith('..' + sep));
}

const paths = { canonical: canonicalPermissionPath, within };
export const evaluatePermission = (policy: PermissionSnapshot, call: PermissionCall) =>
  evaluatePermissionWithPaths(policy, call, paths);
export const evaluatePermissions = (policies: PermissionSnapshot[], call: PermissionCall) =>
  evaluatePermissionsWithPaths(policies, call, paths);
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, stable(v)]),
    );
  return value;
}
export function permissionFingerprint(value: unknown) {
  return createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex');
}
export function callFingerprint(call: PermissionCall) {
  const args = call.arguments as Record<string, unknown> | null;
  const raw = args && typeof args === 'object' ? (args.file_path ?? args.path) : undefined;
  return permissionFingerprint({
    ...call,
    cwd: canonicalPermissionPath(call.cwd, call.cwd),
    physicalPath: typeof raw === 'string' ? canonicalPermissionPath(raw, call.cwd) : undefined,
  });
}
