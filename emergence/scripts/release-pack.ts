import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, cp, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';

if (process.platform !== 'win32' || process.arch !== 'x64')
  throw new Error('This release builder targets Windows x64');
const dir = resolve('../artifacts/phase6'),
  releases = resolve('../artifacts/releases');
const directoryOnly = process.argv.includes('--directory-only');
await mkdir(releases, { recursive: true });
const pkg = JSON.parse(await readFile('package.json', 'utf8')),
  lockRaw = await readFile('package-lock.json', 'utf8'),
  lock = JSON.parse(lockRaw);
if (lock.version !== pkg.version || lock.packages['']?.version !== pkg.version)
  throw new Error('Package and lockfile versions must match before packing');
const builtVersion = execFileSync(process.execPath, [resolve('bin/emergence.cjs'), '--version'], {
  encoding: 'utf8',
  timeout: 30_000,
  windowsHide: true,
}).trim();
if (builtVersion !== pkg.version)
  throw new Error(
    `Built CLI version ${builtVersion} does not match package version ${pkg.version}; rebuild before packing`,
  );
const production = JSON.parse(await readFile(join(dir, 'production-path.json'), 'utf8'));
if (
  production.version !== pkg.version ||
  production.lockHash !== createHash('sha256').update(lockRaw).digest('hex').slice(0, 16)
)
  throw new Error('Run npm run release:prepare for this lockfile first');
const bundle = join(dir, `build-${randomUUID()}`, `Emergence-${pkg.version}-win32-x64`),
  app = join(bundle, 'app');
await mkdir(app, { recursive: true });
for (const path of [
  'bin',
  'dist/cli.mjs',
  'dist/plugin.mjs',
  'dist/small-text.ps1',
  'dist/model-config/涌现模型配置.exe',
  'dist/model-config/涌现模型配置.exe.config',
  'examples',
  'vendor/meta-kim',
  'package.json',
  'package-lock.json',
  'THIRD_PARTY_NOTICES.md',
  'LICENSE',
  'vendor/upstream-notices',
])
  await cp(resolve(path), join(app, path), { recursive: true });
const dataAssets = JSON.parse(await readFile('dist/data/manifest.json', 'utf8')) as Record<string, string>;
await mkdir(join(app, 'dist/data'), { recursive: true });
await copyFile('dist/data/manifest.json', join(app, 'dist/data/manifest.json'));
for (const [name, expected] of Object.entries(dataAssets)) {
  if (!/^(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+$/.test(name) || name.split('/').includes('..'))
    throw new Error('Invalid data resource path');
  const source = resolve('dist/data', name);
  if ((await hash(source)) !== expected) throw new Error('Data resource hash mismatch: ' + name);
  await mkdir(dirname(join(app, 'dist/data', name)), { recursive: true });
  await copyFile(source, join(app, 'dist/data', name));
}
// Emergence disables the upstream HMR row in every generated profile.
// Omit its sole vulnerable glob dependency from the release (GHSA-fc5q-39xc-vjpf).
const runtimeModules = join(production.path, 'node_modules');
const unusedGlob = join(runtimeModules, 'picomatch');
const globConsumers = Object.entries(lock.packages)
  .filter(([, entry]) =>
    ['dependencies', 'optionalDependencies', 'peerDependencies'].some(
      (kind) => (entry as Record<string, Record<string, string>>)[kind]?.picomatch,
    ),
  )
  .map(([name]) => name);
if (
  globConsumers.length !== 1 ||
  globConsumers[0] !== 'node_modules/@deepseek-ai/dsh-hmr' ||
  lock.packages['node_modules/picomatch']?.version !== '4.0.7'
)
  throw new Error('Recheck the HMR glob dependency exclusion for this lockfile');
await cp(runtimeModules, join(app, 'node_modules'), {
  recursive: true,
  filter: (source) => source !== unusedGlob,
});
await writeFile(join(app, 'package.json'), JSON.stringify({ ...pkg, emergencePortable: true }, null, 2));
await mkdir(join(bundle, 'runtime'));
await copyFile('node_modules/node/bin/node.exe', join(bundle, 'runtime/node.exe'));
await copyFile('dist/model-config/涌现模型配置.exe', join(bundle, '涌现模型配置.exe'));
await copyFile('dist/model-config/涌现模型配置.exe.config', join(bundle, '涌现模型配置.exe.config'));
async function hash(path: string) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}
const nodeHash = await hash(join(bundle, 'runtime/node.exe'));
if (nodeHash !== '14319838b3f355e0398c13569a90270bce4fc68f25189f58c59b03dadae0e6d5')
  throw new Error('The bundled Node runtime does not match the verified Node 26.13.0 binary');
for (const path of [
  'install.ps1',
  'uninstall.ps1',
  'run-manager.ps1',
  'manage.cjs',
  'health.cjs',
  'installation',
  'launch-support.ps1',
  'maintenance.ps1',
  'emergence.ps1',
  'emergence.cmd',
  'README.md',
  'licenses',
])
  await cp(join('release', path), join(bundle, path), { recursive: true });
await copyFile('THIRD_PARTY_NOTICES.md', join(bundle, 'THIRD_PARTY_NOTICES.md'));
await copyFile('LICENSE', join(bundle, 'LICENSE'));
const trust = JSON.parse(await readFile('src/app/updates/trust.json', 'utf8'));
const bootstrap = await readFile('../install.ps1', 'utf8');
const embeddedTrust = /\$encodedTrust = '([^']+)'/.exec(bootstrap)?.[1];
if (
  !embeddedTrust ||
  JSON.stringify(JSON.parse(Buffer.from(embeddedTrust, 'base64').toString('utf8'))) !== JSON.stringify(trust)
)
  throw Error('Installer and application signing trust anchors differ');
await copyFile('../install.ps1', join(bundle, 'bootstrap.ps1'));
const sbom: Array<{
  name: string;
  version: string;
  license: unknown;
  integrity?: string;
  licenseFiles: string[];
}> = [];
for (const [location, metadata] of Object.entries(lock.packages) as Array<[string, { integrity?: string }]>) {
  if (!location.startsWith('node_modules/')) continue;
  const path = join(app, location);
  try {
    const manifest = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
    sbom.push({
      name: manifest.name,
      version: manifest.version,
      license: manifest.license ?? 'NOASSERTION',
      integrity: metadata.integrity,
      licenseFiles: (await readdir(path))
        .filter((name) => /^(license|copying|notice)(\.|$)/i.test(name))
        .map((name) => relative(bundle, join(path, name)).replaceAll('\\', '/')),
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
await writeFile(
  join(bundle, 'sbom.json'),
  JSON.stringify(
    {
      product: 'emergence',
      version: pkg.version,
      runtime: {
        name: 'Node.js',
        version: '26.13.0',
        sha256: nodeHash,
        license: 'licenses/Node-LICENSE.txt',
      },
      components: sbom,
    },
    null,
    2,
  ),
);
await writeFile(
  join(bundle, 'release.json'),
  JSON.stringify(
    {
      product: 'emergence',
      version: pkg.version,
      platform: 'win32-x64',
      createdAt: new Date().toISOString(),
      configSchema: 1,
      installationSchema: 2,
      node: '26.13.0',
      lockHash: production.lockHash,
    },
    null,
    2,
  ),
);
const files: Array<{ path: string; sha256: string; bytes: number }> = [];
async function walk(path: string) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Release contains a link: ${full}`);
    if (entry.isDirectory()) await walk(full);
    else if (entry.isFile())
      files.push({
        path: relative(bundle, full).replaceAll('\\', '/'),
        sha256: await hash(full),
        bytes: (await stat(full)).size,
      });
  }
}
await walk(bundle);
files.sort((a, b) => a.path.localeCompare(b.path));
await writeFile(join(bundle, 'manifest.sha256.json'), JSON.stringify(files));
const archive = join(releases, `${basename(bundle)}.zip`),
  temporary = archive + `.${randomUUID()}.zip`;
console.log(
  `${directoryOnly ? 'Prepared local candidate:' : 'Archiving'} ${files.length} files (${Math.round(files.reduce((n, f) => n + f.bytes, 0) / 1024 / 1024)} MiB)…`,
);
let archiveHash: string | null = null;
if (!directoryOnly) {
  const tar = spawn('tar.exe', ['-a', '-cf', temporary, '-C', dirname(bundle), basename(bundle)], {
    stdio: 'inherit',
    windowsHide: true,
  });
  const code = await new Promise<number | null>((done, reject) => {
    tar.once('error', reject);
    tar.once('exit', done);
  });
  if (code !== 0) throw new Error(`Archive failed: ${code}`);
  await rename(temporary, archive);
  archiveHash = await hash(archive);
  await writeFile(archive + '.sha256', `${archiveHash}  ${basename(archive)}\n`);
}
const record = {
  version: pkg.version,
  bundle,
  archive: directoryOnly ? null : archive,
  sha256: archiveHash,
  files: files.length,
  bytes: directoryOnly ? files.reduce((sum, file) => sum + file.bytes, 0) : (await stat(archive)).size,
  components: sbom.length,
  nodeHash,
  lockHash: production.lockHash,
};
const inputHashes = Object.fromEntries(
  await Promise.all(
    [
      'package.json',
      'package-lock.json',
      'bin/emergence.cjs',
      'dist/cli.mjs',
      'dist/plugin.mjs',
      'dist/small-text.ps1',
      'dist/cli.mjs.map',
      'dist/plugin.mjs.map',
      'release/install.ps1',
      '../install.ps1',
      'src/app/updates/trust.json',
      'release/uninstall.ps1',
      'release/run-manager.ps1',
      'release/manage.cjs',
      'release/health.cjs',
      'release/installation/files.cjs',
      'release/installation/windows.cjs',
      'release/installation/transaction.cjs',
      'release/installation/service.cjs',
      'release/installation/retention.cjs',
      'release/installation/diagnostics.cjs',
      'release/launch-support.ps1',
      'release/maintenance.ps1',
      'release/emergence.ps1',
      'release/emergence.cmd',
      'release/README.md',
      'release/licenses/Node-LICENSE.txt',
      'examples/project-notes.mjs',
      'THIRD_PARTY_NOTICES.md',
    ].map(async (file) => [file, await hash(file)]),
  ),
);
await writeFile(join(dir, 'release-path.json'), JSON.stringify({ ...record, inputHashes }, null, 2));
console.log(JSON.stringify(record, null, 2));
