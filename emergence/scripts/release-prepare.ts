import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const dir = resolve('../artifacts/phase6');
await mkdir(dir, { recursive: true });
const pkg = JSON.parse(await readFile('package.json', 'utf8')),
  lock = await readFile('package-lock.json', 'utf8');
const key = createHash('sha256').update(lock).digest('hex').slice(0, 16),
  cache = join(dir, `production-${key}`);
await mkdir(cache, { recursive: true });
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Use npm run release:prepare');
let prepared = false;
try {
  await access(join(cache, 'prepared.json'));
  prepared = true;
} catch {}
if (!prepared) {
  await copyFile('package.json', join(cache, 'package.json'));
  await copyFile('package-lock.json', join(cache, 'package-lock.json'));
  console.log('Installing the locked production tree into an isolated release folder…');
  const child = spawn(
    process.execPath,
    [
      npmCli,
      'ci',
      '--omit=dev',
      '--ignore-scripts',
      '--prefer-offline',
      '--no-fund',
      '--registry=https://registry.npmjs.org',
    ],
    { cwd: cache, stdio: 'inherit', windowsHide: true },
  );
  const code = await new Promise<number | null>((done, reject) => {
    child.once('error', reject);
    child.once('exit', done);
  });
  if (code !== 0) throw new Error(`Clean production install failed (${code})`);
  await writeFile(
    join(cache, 'prepared.json'),
    JSON.stringify(
      {
        version: pkg.version,
        lockHash: key,
        installedAt: new Date().toISOString(),
        scripts: false,
        dev: false,
      },
      null,
      2,
    ),
  );
}
await writeFile(
  join(dir, 'production-path.json'),
  JSON.stringify({ path: cache, lockHash: key, version: pkg.version }, null, 2),
);
console.log(`Production dependencies ready: ${cache}`);
