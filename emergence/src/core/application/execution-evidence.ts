import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { toolContract } from '../domain/tool-contract.ts';
import type { ResourceVersion } from '../domain/run-manifest.ts';
import { stableDigest } from '../storage/execution-journal.ts';

/** Bounded read-only observation, not proof that an unknown operation did or did not happen. */
export async function fileObservation(
  path: string,
  countText = false,
): Promise<{
  hash: string;
  fileSize?: number;
  trailingNewline?: 'LF' | 'CRLF' | 'none' | 'empty';
  utf8Bom?: boolean;
  utf8Valid?: boolean;
  characters?: number;
  hanCharacters?: number;
}> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile()) return { hash: 'unknown:not-regular' };
    if (stat.size > 8 * 1024 * 1024) return { hash: 'unknown:over-budget' };
    const bytes = await readFile(path);
    let utf8Valid = true;
    let text: string | undefined;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      utf8Valid = false;
    }
    let characters = 0,
      hanCharacters = 0;
    if (countText && text !== undefined) {
      const han = /\p{Script=Han}/u;
      for (const character of text) {
        characters++;
        if (han.test(character)) hanCharacters++;
      }
    }
    return {
      hash: createHash('sha256').update(bytes).digest('hex'),
      fileSize: bytes.length,
      utf8Valid,
      ...(!countText || text === undefined ? {} : { characters, hanCharacters }),
      utf8Bom: bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191])),
      trailingNewline: !bytes.length
        ? 'empty'
        : bytes.at(-1) === 10
          ? bytes.at(-2) === 13
            ? 'CRLF'
            : 'LF'
          : 'none',
    };
  } catch (e) {
    return { hash: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unknown:unreadable' };
  }
}
export async function fileFingerprint(path: string): Promise<string> {
  return (await fileObservation(path)).hash;
}
export async function directoryObservation(path: string) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('目录不是普通真实目录');
  const entries = await readdir(path, { withFileTypes: true });
  if (entries.length > 1000) throw new Error('目录清单超过 1000 项预算，请缩小范围');
  const names = entries
    .map((e) => ({
      name: e.name,
      kind: e.isSymbolicLink() ? 'link' : e.isDirectory() ? 'directory' : e.isFile() ? 'file' : 'other',
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { entries: names, hash: stableDigest(names) };
}
export async function resourceFingerprint(resource: ResourceVersion) {
  if (resource.kind !== 'directory') return fileFingerprint(resource.path);
  try {
    return (await directoryObservation(resource.path)).hash;
  } catch {
    return 'unknown:directory';
  }
}
export const sideEffectTool = (name: string, args?: unknown) => toolContract(name, args).sideEffect;
