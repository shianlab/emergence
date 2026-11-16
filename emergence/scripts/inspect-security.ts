import { spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { homeDirectory } from '../src/app/config.ts';
import { readCredentials } from '../src/app/credentials.ts';

// Credentials stay in memory; output contains only counts and redacted paths.
const output = resolve(process.env.EMERGENCE_AUDIT_DIR ?? '../artifacts/review-2026-10-30');
await mkdir(output, { recursive: true });
const home = homeDirectory();
const secrets = Object.values(await readCredentials(home)).filter((value) => value.length >= 8);
const needles = secrets.map((value) => Buffer.from(value));
const overlap = Math.max(1, ...needles.map((value) => value.length)) - 1;
let scannedFiles = 0;
const matches: string[] = [],
  errors: string[] = [];
async function scan(path: string, recursive = true, optional = false) {
  try {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || ['node_modules', '.git'].includes(entry.name)) continue;
      const full = join(path, entry.name);
      if (entry.isDirectory()) {
        if (recursive) await scan(full);
        continue;
      }
      if (!entry.isFile()) continue;
      scannedFiles++;
      let tail: Buffer = Buffer.alloc(0),
        found = false;
      for await (const chunk of createReadStream(full)) {
        const buffer = Buffer.concat([tail, Buffer.from(chunk)]);
        if (needles.some((secret) => buffer.includes(secret))) {
          found = true;
          break;
        }
        tail = overlap ? buffer.subarray(Math.max(0, buffer.length - overlap)) : Buffer.alloc(0);
      }
      if (found) matches.push(full);
    }
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
    errors.push(`${path}: ${(error as NodeJS.ErrnoException).code ?? 'read error'}`);
  }
}
for (const path of [
  'src',
  'native',
  'tests',
  'scripts',
  'probes',
  'examples',
  'bin',
  'dist',
  '../docs',
  '../artifacts',
])
  await scan(resolve(path));
await scan(home, true, true);
await scan(resolve('.'), false);
await scan(resolve('..'), false);
const redact = (value: string) =>
  secrets.reduce((text, secret) => text.replaceAll(secret, '[已隐藏]'), value);
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Use npm run inspect:security');
const checked = spawnSync(
  process.execPath,
  [npmCli, 'audit', '--registry=https://registry.npmjs.org', '--json'],
  { encoding: 'utf8', timeout: 120000, maxBuffer: 4000000 },
);
await writeFile(join(output, 'npm-audit.json'), checked.stdout ?? '');
let audit: { metadata?: { vulnerabilities?: { total?: number } } } = {};
try {
  audit = JSON.parse(checked.stdout);
} catch {
  errors.push('npm audit did not return valid JSON');
}
if (checked.status !== 0) errors.push('npm audit failed or reported vulnerabilities');
const report = {
  timestamp: new Date().toISOString(),
  passed: !matches.length && !errors.length && audit.metadata?.vulnerabilities?.total === 0,
  credentialCount: secrets.length,
  credentialScan: secrets.length ? 'checked-known-credentials' : 'no-saved-credentials-to-compare',
  scannedFiles,
  plaintextMatches: matches.map((path) => redact(relative(resolve('..'), path))),
  errors: errors.map(redact),
  dependencies: audit.metadata?.vulnerabilities,
  scope:
    'Known saved credentials, local source/build/docs/artifacts and user state. User-supplied Desktop key.txt excluded; no values printed. Unknown secrets are not automatically identified.',
};
await writeFile(join(output, 'security.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
if (!report.passed) process.exitCode = 1;
