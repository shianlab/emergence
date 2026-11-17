import { readFile, writeFile } from 'node:fs/promises';
import * as prettier from 'prettier';
import { ownedSourceFiles } from './source-files.ts';

const files = await ownedSourceFiles(['.ts', '.tsx', '.js', '.mjs', '.cjs']);
const write = process.argv.includes('--write');
let changed = 0;
for (const file of files) {
  const source = await readFile(file, 'utf8');
  const options = { ...(await prettier.resolveConfig(file)), filepath: file };
  const formatted = await prettier.format(source, options);
  if (source === formatted) continue;
  changed++;
  if (write) await writeFile(file, formatted);
  else console.error(`Format required: ${file}`);
}
console.log(
  `${files.length} owned TypeScript/JavaScript files checked; ${changed} ${write ? 'formatted' : 'need formatting'}`,
);
if (changed && !write) process.exitCode = 1;
