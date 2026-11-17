import { readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';

// Generated/imported data is validated by its own provenance/hash checks.
export const generatedSources = new Set([
  'src/core/assets/catalog.ts',
  'src/app/tui/home-logo-data.ts',
  'src/app/tui/logo-data.ts',
]);
export async function ownedTypeScriptFiles(): Promise<string[]> {
  return ownedSourceFiles(['.ts', '.tsx']);
}

/** Only maintained source roots; never walk dependencies, copied releases or imported assets. */
export async function ownedSourceFiles(extensions: readonly string[]): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name).replaceAll('\\', '/');
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(path);
      else if (extensions.includes(extname(path)) && !generatedSources.has(path)) files.push(path);
    }
  }
  for (const directory of ['src', 'scripts', 'tests', 'probes', 'native', 'release', 'bin', 'quality'])
    await visit(directory);
  if (extensions.includes('.ps1')) files.push('../install.ps1');
  return files.sort();
}
