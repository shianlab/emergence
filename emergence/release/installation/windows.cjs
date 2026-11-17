const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn } = require('node:child_process');
async function powershell(script, input = '') {
  const encoded = Buffer.from(
    "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);$ErrorActionPreference='Stop';" +
      script,
    'utf16le',
  ).toString('base64');
  return new Promise((resolve, reject) => {
    const environment = { ...process.env };
    delete environment.PSModulePath; // PS 7 module paths must not shadow Windows PowerShell modules.
    const child = spawn(
      path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoLogo', '-NoProfile', '-EncodedCommand', encoded],
      {
        windowsHide: true,
        env: environment,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let out = '',
      err = '';
    child.stdout.on('data', (b) => (out += b.toString('utf8')));
    child.stderr.on('data', (b) => (err += b.toString('utf8')));
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Windows settings operation timed out'));
    }, 30000);
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      code === 0
        ? resolve(out.trim())
        : reject(new Error('Windows settings operation failed: ' + err.slice(0, 1000)));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
async function updatePath(root, install, registryKey = 'Environment') {
  const plan = await capturePath(root, registryKey);
  if (!install) {
    const bin = path.join(root, 'bin').toLowerCase();
    plan.after.value = plan.before.value
      .split(';')
      .filter((p) => path.resolve(p).toLowerCase() !== bin)
      .join(';');
  }
  await applyPath(plan);
}
async function lock(root) {
  const name =
    '\\\\.\\pipe\\emergence-install-' + crypto.createHash('sha256').update(root.toLowerCase()).digest('hex');
  return lockName(name);
}
async function lockName(name) {
  const server = net.createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', () => reject(new Error('Another installation operation owns this directory')));
    server.listen(name, resolve);
  });
  return () => new Promise((resolve) => server.close(resolve));
}
async function lockUpdates(root) {
  const releases = [];
  try {
    for (const kind of ['update-install:', 'update-check:']) {
      const key = kind + root.toLowerCase();
      releases.push(
        await lockName('\\\\.\\pipe\\emergence-' + crypto.createHash('sha256').update(key).digest('hex')),
      );
    }
  } catch (error) {
    for (const release of releases) await release();
    throw error;
  }
  return async () => {
    for (const release of releases) await release();
  };
}

function quote(value) {
  return "'" + value.replaceAll("'", "''") + "'";
}
function registryKey(value = 'Environment') {
  if (value !== 'Environment' && !/^Software\\EmergenceInstallValidation\\[a-f0-9-]{36}$/.test(value))
    throw new Error('Invalid PATH registry scope');
  return value;
}
async function pathValue(key = 'Environment') {
  key = registryKey(key);
  return JSON.parse(
    await powershell(
      '$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(' +
        quote(key) +
        ");$exists=$k -and ($k.GetValueNames() -contains 'Path');$value=if($exists){$k.GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)}else{''};$kind=if($exists){$k.GetValueKind('Path').ToString()}else{'ExpandString'};ConvertTo-Json -Compress @{exists=[bool]$exists;value=[string]$value;kind=$kind}",
    ),
  );
}
async function capturePath(root, key = 'Environment') {
  const before = await pathValue(key),
    bin = path.join(root, 'bin');
  const items = before.value
    ? before.value.split(';').filter((p) => path.resolve(p).toLowerCase() !== bin.toLowerCase())
    : [];
  return {
    registryKey: key,
    before,
    after: { exists: true, kind: before.kind, value: [bin, ...items].join(';') },
  };
}
async function writePath(value, key) {
  key = registryKey(key);
  if (
    !['String', 'ExpandString'].includes(value.kind) ||
    typeof value.value !== 'string' ||
    typeof value.exists !== 'boolean'
  )
    throw new Error('Invalid PATH snapshot');
  await powershell(
    '$v=[Console]::In.ReadToEnd()|ConvertFrom-Json;$k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey(' +
      quote(key) +
      ");if($v.exists){$kind=[Microsoft.Win32.RegistryValueKind][Enum]::Parse([Microsoft.Win32.RegistryValueKind],[string]$v.kind);$k.SetValue('Path',[string]$v.value,$kind)}else{$k.DeleteValue('Path',$false)};$k.Dispose();Add-Type 'using System;using System.Runtime.InteropServices;public class PathBroadcast{[DllImport(\"user32.dll\",CharSet=CharSet.Unicode)]public static extern IntPtr SendMessageTimeout(IntPtr h,uint m,UIntPtr w,string l,uint f,uint t,out UIntPtr r);}';$r=[UIntPtr]::Zero;[void][PathBroadcast]::SendMessageTimeout([IntPtr]0xffff,0x1a,[UIntPtr]::Zero,'Environment',2,2000,[ref]$r)",
    JSON.stringify(value),
  );
}
const samePath = (a, b) => a.exists === b.exists && a.value === b.value && a.kind === b.kind;
async function applyPath(plan) {
  if (!samePath(await pathValue(plan.registryKey), plan.before))
    throw new Error('PATH 已被其他程序修改，请重新执行安装');
  await writePath(plan.after, plan.registryKey);
}
async function restorePath(plan) {
  const current = await pathValue(plan.registryKey);
  if (samePath(current, plan.before)) return;
  if (!samePath(current, plan.after)) throw new Error('PATH 有并发修改，已保留；请核对后再执行恢复');
  await writePath(plan.before, plan.registryKey);
}

async function holdFile(file) {
  const environment = { ...process.env };
  delete environment.PSModulePath;
  const script =
    "$ErrorActionPreference='Stop';try{$f=[IO.File]::Open(" +
    quote(file) +
    ",[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);[Console]::WriteLine('READY');[Console]::Out.Flush();[void][Console]::In.ReadToEnd();$f.Dispose()}catch{exit 73}";
  const child = spawn(
    path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoLogo', '-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { env: environment, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] },
  );
  return new Promise((resolve) => {
    let ready = false,
      text = '';
    const timer = setTimeout(() => child.kill(), 10000);
    child.stdin.on('error', () => {});
    const closed = new Promise((done) => child.once('close', done));
    child.once('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.once('close', () => {
      clearTimeout(timer);
      if (!ready) resolve(null);
    });
    child.stdout.on('data', (chunk) => {
      text += chunk.toString();
      if (!ready && text.includes('READY')) {
        ready = true;
        clearTimeout(timer);
        resolve(async () => {
          child.stdin.end();
          await closed;
        });
      }
    });
  });
}
async function processes() {
  const raw = await powershell(
    "@(Get-CimInstance Win32_Process | Where-Object {$_.Name -in @('node.exe','涌现模型配置.exe')} | Select-Object ProcessId,ExecutablePath,CommandLine,@{Name='Started';Expression={if($_.CreationDate){$_.CreationDate.ToUniversalTime().Ticks.ToString()}}}) | ConvertTo-Json -Compress",
  );
  const value = raw ? JSON.parse(raw) : [];
  return Array.isArray(value) ? value : [value];
}
async function inUse(directory) {
  const prefix = path.resolve(directory).toLowerCase() + path.sep;
  try {
    const list = await processes();
    for (const item of list) {
      if (item.ProcessId === process.pid) continue;
      if (!item.ExecutablePath && !item.CommandLine) return 'unknown';
      if (item.ExecutablePath && path.resolve(item.ExecutablePath).toLowerCase().startsWith(prefix))
        return 'running';
      if (item.CommandLine && item.CommandLine.toLowerCase().includes(prefix)) return 'running';
    }
    return null;
  } catch {
    return 'unknown';
  }
}
module.exports = {
  powershell,
  updatePath,
  lock,
  lockUpdates,
  capturePath,
  applyPath,
  restorePath,
  holdFile,
  inUse,
};
