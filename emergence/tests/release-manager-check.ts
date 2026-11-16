// Deferred packaging validation, deliberately outside the default *.test.ts local-debug suite.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
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
