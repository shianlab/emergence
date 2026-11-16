import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const artifactDir = resolve(import.meta.dirname, '../../artifacts/phase1');

export async function report(name: string, value: unknown): Promise<void> {
  await mkdir(artifactDir, { recursive: true });
  await writeFile(resolve(artifactDir, name), JSON.stringify(value, null, 2) + '\n');
}
