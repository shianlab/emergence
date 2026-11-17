import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
const output = resolve(process.argv[2] ?? '../artifacts/installation-benchmark');
await mkdir(output, { recursive: true });
const record = JSON.parse(await readFile('../artifacts/phase6/release-path.json', 'utf8'));
const files = JSON.parse(await readFile(join(record.bundle, 'manifest.sha256.json'), 'utf8'));
const manager = createRequire(import.meta.url)('../release/manage.cjs');
const groups = new Map<string, { bytes: number; files: number }>();
for (const file of files) {
  const segments = file.path.split('/');
  const key = file.path.startsWith('app/node_modules/')
    ? segments.slice(2, segments[2].startsWith('@') ? 4 : 3).join('/')
    : segments.slice(0, 2).join('/');
  const value = groups.get(key) ?? { bytes: 0, files: 0 };
  value.bytes += file.bytes;
  value.files++;
  groups.set(key, value);
}
await writeFile(
  join(output, 'footprint.json'),
  JSON.stringify(
    {
      version: record.version,
      files: files.length,
      bytes: files.reduce((n: number, f: { bytes: number }) => n + f.bytes, 0),
      packages: record.components,
      largest: [...groups]
        .map(([name, value]) => ({ name, ...value }))
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, 20),
      decision:
        'No dependency removed: dynamic profile/extension resolution remains supported. TypeScript is a live Code-domain dependency. This stage optimizes deployment IO without altering the dependency graph.',
    },
    null,
    2,
  ),
);
const samples = [];
for (const method of ['bounded', 'previous', 'previous', 'bounded']) {
  const destination = join(output, 'benchmark-' + method + '-' + Date.now());
  const started = performance.now();
  if (method === 'previous')
    await cp(record.bundle, destination, { recursive: true, force: false, errorOnExist: true });
  else await manager.copyRelease(record.bundle, destination, files);
  const copyMs = performance.now() - started;
  const verifying = performance.now();
  await manager.verify(destination, files);
  samples.push({
    method,
    copyMs: Math.round(copyMs),
    verifyMs: Math.round(performance.now() - verifying),
    destination,
  });
  await writeFile(
    join(output, 'copy-benchmark.json'),
    JSON.stringify(
      {
        source: record.bundle,
        samples,
        note: 'Two runs per method, reversed order; full destination integrity verified. Local filesystem measurement, not end-to-end internet install timing.',
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(samples.at(-1)));
}
