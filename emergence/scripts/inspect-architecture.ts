import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeDependencies } from './architecture-graph.ts';

// Read-only inventory of application code. This records debt; it does not waive it.
const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.env.EMERGENCE_AUDIT_DIR ?? join(app, '../artifacts/architecture'));
const slash = (value: string) => value.replaceAll('\\', '/');
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
async function files(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(path)));
    else if (entry.isFile()) result.push(path);
  }
  return result.sort();
}
const sources = (await files(join(app, 'src'))).filter((path) => /\.(ts|tsx|py)$/.test(path));
const nodes = [];
const sourceTexts = [];
for (const path of sources) {
  const bytes = await readFile(path),
    text = bytes.toString('utf8'),
    local = slash(relative(app, path));
  nodes.push({ path: local, bytes: bytes.length, lines: text.split('\n').length, sha256: hash(bytes) });
  sourceTexts.push({ path: local, text });
}
const { edges, declarations, computedImports, wiring, dependencies } = analyzeDependencies(app, sourceTexts);
const reverse = edges.filter((edge) => edge.from.startsWith('src/core/') && edge.to.startsWith('src/app/'));
const inputs = [];
for (const area of [
  'src',
  'native',
  'scripts',
  'tests',
  'probes',
  'release',
  'quality',
  'bin',
  'assets',
  'vendor',
]) {
  for (const path of await files(join(app, area))) {
    if (/[/\\](__pycache__|node_modules)[/\\]|\.pyc$/.test(path)) continue;
    inputs.push({ path: slash(relative(app, path)), sha256: hash(await readFile(path)) });
  }
}
for (const path of [
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  '.prettierrc.json',
  '.editorconfig',
  'global.json',
  'ruff.toml',
  '../install.ps1',
  '../.github/workflows/ci.yml',
  '../.gitattributes',
  '../.gitignore',
])
  inputs.push({ path, sha256: hash(await readFile(join(app, path))) });
const sourceFingerprint = hash(JSON.stringify(nodes.map(({ path, sha256 }) => ({ path, sha256 }))));
const inputFingerprint = hash(JSON.stringify(inputs));
await mkdir(output, { recursive: true });
await writeFile(
  join(output, 'architecture.json'),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      sourceFingerprint,
      inputFingerprint,
      scope:
        'TypeScript syntactic import graph plus source hashes (including Python). Type-only imports are separated; value edges are a conservative approximation before compiler elision. C#/Python imports, computed loads and event wiring require manual review. Wiring locations are not proof of runtime subscription or disposal.',
      nodes,
      edges,
      reverse,
      declarations,
      dependencies,
      computedImports,
      wiring,
      inputs,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    sources: nodes.length,
    lines: nodes.reduce((sum, node) => sum + node.lines, 0),
    imports: edges.length,
    reverse: reverse.length,
    reverseRuntime: reverse.filter((edge) => !edge.typeOnly).length,
    valueImportCycles: dependencies.valueImportCycles.length,
    allImportCycles: dependencies.allImportCycles.length,
    computedImports: computedImports.length,
    wiringLocations: wiring.length,
    sourceFingerprint,
    inputFingerprint,
  }),
);
