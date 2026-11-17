import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ownedSourceFiles } from './source-files.ts';

// Formatting changes only layout. Static fixes require a separate reviewed change.
const write = process.argv.includes('--write');
const language = process.argv.find((arg) => ['python', 'native', 'powershell'].includes(arg));
if (!language) throw new Error('Choose python, native or powershell');
if (process.platform !== 'win32') throw new Error('The maintained quality toolchain targets Windows x64');
function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true, timeout: 120_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal})`);
}

if (language === 'python') {
  const files = await ownedSourceFiles(['.py']);
  const python = resolve('.quality-tools/python/Scripts/python.exe');
  run(python, ['-I', '-m', 'ruff', 'format', ...(!write ? ['--check'] : []), ...files]);
  if (!write) run(python, ['-I', '-m', 'ruff', 'check', ...files]);
} else if (language === 'native') {
  const files = await ownedSourceFiles(['.cs']);
  const sdk = JSON.parse(await readFile('global.json', 'utf8')).sdk.version;
  const actual = spawnSync('dotnet', ['--version'], { encoding: 'utf8', windowsHide: true });
  if (actual.status !== 0 || actual.stdout.trim() !== sdk)
    throw new Error(`Install .NET SDK ${sdk}; see docs/structure/coding-standards.md`);
  // Folder mode needs no project, restore, reference package or user runtime SDK.
  for (const folder of new Set(files.map(dirname))) {
    run('dotnet', ['format', 'whitespace', folder, '--folder', ...(!write ? ['--verify-no-changes'] : [])]);
  }
  if (!write) {
    const folder = await mkdtemp(join(tmpdir(), 'emergence-native-check-'));
    try {
      run(join(process.env.WINDIR ?? 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), [
        '/nologo',
        '/target:library',
        '/platform:x64',
        '/utf8output',
        '/codepage:65001',
        '/warn:4',
        '/warnaserror+',
        '/langversion:5',
        `/out:${join(folder, 'checked.dll')}`,
        ...[
          'System',
          'System.Core',
          'System.Drawing',
          'System.Windows.Forms',
          'System.Web.Extensions',
          'System.Net.Http',
        ].map((name) => `/reference:${name}.dll`),
        ...files.map((file) => resolve(file)),
      ]);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }
  console.log(`${files.length} owned C# files checked`);
} else {
  const folder = await mkdtemp(join(tmpdir(), 'emergence-powershell-check-'));
  try {
    const list = join(folder, 'files.json');
    await writeFile(list, JSON.stringify(await ownedSourceFiles(['.ps1', '.psd1'])));
    run('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      'scripts/check-powershell.ps1',
      '-FileList',
      list,
      ...(write ? ['-Write'] : []),
    ]);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
