import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const directory = resolve(process.env.EMERGENCE_AUDIT_DIR ?? '../artifacts/code-data-phase1');
await mkdir(directory, { recursive: true });
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
async function sourceHashes() {
  const values: Record<string, string> = {};
  for (const root of ['src', 'tests', 'scripts'])
    for (const file of await readdir(root, { recursive: true })) {
      if (/\.(ts|tsx|py|txt|ps1)$/.test(file))
        values[join(root, file)] = hash(await readFile(join(root, file)));
    }
  for (const file of ['package.json', 'package-lock.json', 'tsconfig.json'])
    values[file] = hash(await readFile(file));
  return values;
}
const before = await sourceHashes();
const units = (await readdir('tests')).filter((p) => p.endsWith('.test.ts')).map((p) => 'tests/' + p);
const checks: Array<[string, string[]]> = [
  ['typecheck', ['node_modules/typescript/bin/tsc', '--noEmit']],
  ['build', ['--import', 'tsx', 'scripts/build.ts']],
  ['unit-and-harness', ['--import', 'tsx', '--test', '--test-concurrency=4', ...units]],
  ['native-tools-skill-mcp-protocols', ['--import', 'tsx', 'tests/phase2-e2e.ts']],
  ['fault-recovery', ['--import', 'tsx', 'tests/phase6-faults.ts']],
  ['permissions-interaction', ['--experimental-ffi', '--import', 'tsx', 'tests/experience-e2-ui.ts']],
  ['planning-feedback', ['--experimental-ffi', '--import', 'tsx', 'tests/tui-core-phase4.ts']],
  ['terminal-workspace', ['--import', 'tsx', 'tests/phase4-terminal.ts']],
];
const results = [];
for (const [name, args] of checks) {
  const start = Date.now();
  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 180000,
    maxBuffer: 6000000,
  });
  await writeFile(join(directory, name + '.log'), (result.stdout ?? '') + '\n' + (result.stderr ?? ''));
  results.push({
    name,
    command: args,
    exitCode: result.status,
    durationMs: Date.now() - start,
    error: result.error?.message,
  });
  console.log(`${result.status === 0 ? 'PASS' : 'FAIL'} ${name}`);
  if (result.status !== 0)
    console.error((result.stdout ?? '').slice(-4000), (result.stderr ?? '').slice(-1500));
}
const after = await sourceHashes();
const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
  (p) => before[p] !== after[p],
);
const passed = results.every((r) => r.exitCode === 0) && !changed.length;
await writeFile(
  join(directory, 'inspection.json'),
  JSON.stringify(
    {
      timestamp: new Date().toISOString(),
      passed,
      runtime: process.version,
      changedDuringRun: changed,
      sourceHashes: after,
      results,
      scope:
        'Code/data contracts and domain integration, full unit regressions, local protocol/MCP fixtures and affected UI/terminal flows. Live API samples recorded separately. No installation or release.',
    },
    null,
    2,
  ),
);
if (!passed) process.exitCode = 1;
