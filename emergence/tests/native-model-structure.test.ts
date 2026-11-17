import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

test('native editor owns isolated drafts and connection cleanup rejects late responses', async (t) => {
  if (process.platform !== 'win32') return;
  const folder = await mkdtemp(join(tmpdir(), 'emergence-native-contract-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const executable = join(folder, 'contracts.exe');
  const sources = (await readdir('native/model-config')).filter((name) => name.endsWith('.cs')).sort();
  const run = promisify(execFile);
  await run(
    join(process.env.WINDIR ?? 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
    [
      '/nologo',
      '/target:exe',
      '/platform:x64',
      '/utf8output',
      '/codepage:65001',
      '/main:Emergence.ModelConfiguration.NativeModelConfigurationTests',
      `/out:${executable}`,
      ...[
        'System',
        'System.Core',
        'System.Drawing',
        'System.Windows.Forms',
        'System.Web.Extensions',
        'System.Net.Http',
      ].map((name) => `/reference:${name}.dll`),
      ...sources.map((name) => resolve('native/model-config', name)),
      resolve('tests/fixtures/NativeModelConfigurationTests.cs'),
    ],
    { windowsHide: true },
  );
  const result = await run(executable, [], { windowsHide: true });
  assert.match(result.stdout, /Native draft isolation, validation and repeated disposal passed/);
});
