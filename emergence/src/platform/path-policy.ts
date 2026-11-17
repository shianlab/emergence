import { isAbsolute, relative, sep } from 'node:path';

export const pathIdentity = (path: string) => (process.platform === 'win32' ? path.toLowerCase() : path);
export function inside(root: string, target: string) {
  const r = relative(pathIdentity(root), pathIdentity(target));
  return !r || (!isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep));
}
