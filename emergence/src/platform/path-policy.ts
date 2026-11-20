import { isAbsolute, relative, sep } from 'node:path';

export const pathIdentity = (path: string) => (process.platform === 'win32' ? path.toLowerCase() : path);
export function inside(root: string, target: string) {
  const r = relative(pathIdentity(root), pathIdentity(target));
  return !r || (!isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep));
}

export function unsupportedFilePath(path: string) {
  if (path.includes('\x00')) return true;
  if (process.platform !== 'win32') return false;
  if (/^[\\/]{2}[?.][\\/]/.test(path) || /:/.test(path.replace(/^[A-Za-z]:/, ''))) return true;
  return path.split(/[\\/]/).some((segment) => {
    const device = segment.split('.')[0].replace(/ +$/, '');
    return /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i.test(device);
  });
}
