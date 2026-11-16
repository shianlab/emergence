import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

// Generated/imported data is validated by its own provenance/hash checks.
export const generatedSources = new Set([
  'src/core/assets/catalog.ts',
  'src/app/tui/home-logo-data.ts',
  'src/app/tui/logo-data.ts',
]);
export async function ownedTypeScriptFiles(): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name).replaceAll('\\', '/');
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(path);
      else if (/\.tsx?$/.test(path) && !generatedSources.has(path)) files.push(path);
    }
  }
  for (const directory of ['src', 'scripts', 'tests', 'probes']) await visit(directory);
  return files.sort();
}
