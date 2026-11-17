// Deferred packaging validation, deliberately outside the default *.test.ts local-debug suite.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { mkdir, mkdtemp } from 'node:fs/promises';
test('installer PATH changes are reversible in an isolated registry test key', async () => {
  const manager = createRequire(import.meta.url)('../release/manage.cjs');
  const key = 'Software\\EmergenceInstallValidation\\' + randomUUID(),
    root = join(tmpdir(), '应用 Emergence'),
    original = '%APPDATA%\\npm;C:\\existing path;';
  assert.match(key, /^Software\\EmergenceInstallValidation\\[a-f0-9-]{36}$/);
  const read = async () =>
    JSON.parse(
      await manager.powershell(
        `$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${key}');[Console]::Write((ConvertTo-Json -Compress @{value=$k.GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);kind=$k.GetValueKind('Path').ToString()}));$k.Dispose()`,
      ),
    );
  try {
    await manager.powershell(
      `$k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('${key}');$k.SetValue('Path',[Console]::In.ReadToEnd(),[Microsoft.Win32.RegistryValueKind]::ExpandString);$k.Dispose()`,
      original,
    );
    await manager.updatePath(root, true, key);
    await manager.updatePath(root, true, key);
    const installed = await read();
    assert.equal(installed.value, join(root, 'bin') + ';' + original);
    assert.equal(installed.kind, 'ExpandString');
    await manager.updatePath(root, false, key);
    assert.equal((await read()).value, original);
  } finally {
    await manager.powershell(`[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree('${key}',$false)`);
  }
});

test('transactional PATH snapshot restores type and refuses concurrent edits', async () => {
  const windows = createRequire(import.meta.url)('../release/installation/windows.cjs');
  const key = 'Software\\EmergenceInstallValidation\\' + randomUUID();
  try {
    await windows.powershell(
      `$k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('${key}');$k.SetValue('Path','C:\\original;',[Microsoft.Win32.RegistryValueKind]::String);$k.Dispose()`,
    );
    const plan = await windows.capturePath(join(tmpdir(), '应用'), key);
    assert.equal(plan.before.kind, 'String');
    await windows.applyPath(plan);
    assert.deepEqual((await windows.capturePath('C:\\unused', key)).before, plan.after);
    await windows.restorePath(plan);
    assert.deepEqual((await windows.capturePath('C:\\unused', key)).before, plan.before);
    await windows.applyPath(plan);
    await windows.powershell(
      `$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${key}',$true);$k.SetValue('Path','C:\\external',[Microsoft.Win32.RegistryValueKind]::String);$k.Dispose()`,
    );
    await assert.rejects(windows.restorePath(plan), /并发修改/);
    assert.equal((await windows.capturePath('C:\\unused', key)).before.value, 'C:\\external');
  } finally {
    await windows.powershell(`[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree('${key}',$false)`);
  }
});

test('Windows exclusive usage barrier prevents another maintenance handle', async () => {
  const windows = createRequire(import.meta.url)('../release/installation/windows.cjs');
  const root = await mkdtemp(join(tmpdir(), 'emergence-usage-'));
  await mkdir(join(root, '.usage'));
  const file = join(root, '.usage', '1.0.0.lock');
  const first = await windows.holdFile(file);
  assert.ok(first);
  try {
    assert.equal(await windows.holdFile(file), null);
  } finally {
    await first();
  }
  const next = await windows.holdFile(file);
  assert.ok(next);
  await next();
});
