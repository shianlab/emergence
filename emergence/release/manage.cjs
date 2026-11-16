// Offline installation manager. Built-in Node APIs handle Windows long paths consistently.
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn } = require('node:child_process');
const [action, rootArg, sourceArg, noPath] = process.argv.slice(2);
const versionPattern = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/;
const inside = (root, value) => {
  const relative = path.relative(root, value);
  return (
    relative !== '' &&
    !relative.startsWith('..' + path.sep) &&
    relative !== '..' &&
    !path.isAbsolute(relative)
  );
};
async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}
async function noLinks(root, recursive = true) {
  const stat = await fs.lstat(root);
  if (stat.isSymbolicLink()) throw new Error(`Managed path is a link: ${root}`);
  if (recursive && stat.isDirectory())
    for (const entry of await fs.readdir(root)) await noLinks(path.join(root, entry));
}
async function ancestors(root) {
  for (let p = root; ; p = path.dirname(p)) {
    if (await exists(p)) await noLinks(p, false);
    if (path.dirname(p) === p) break;
  }
}
async function hash(p) {
  const digest = crypto.createHash('sha256');
  for await (const chunk of createReadStream(p)) digest.update(chunk);
  return digest.digest('hex');
}
async function json(p) {
  return JSON.parse(await fs.readFile(p, 'utf8'));
}
async function atomic(p, value) {
  const temporary = `${p}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  await fs.rename(temporary, p);
}
async function verify(root, files) {
  if (!Array.isArray(files) || files.length < 5 || files.length > 100000)
    throw new Error('Invalid release file list');
  for (const required of [
    'release.json',
    'runtime/node.exe',
    'app/bin/emergence.cjs',
    'manage.cjs',
    'app/dist/cli.mjs',
    'app/dist/plugin.mjs',
    'app/dist/data/manifest.json',
    'app/dist/data/worker.py',
    'app/dist/data/analytics.py',
    'app/dist/data/runtime-lock.json',
    'app/dist/data/probe.py',
    '涌现模型配置.exe',
  ])
    if (!files.some((f) => f.path === required)) throw new Error('Incomplete release manifest');
  let index = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (index < files.length) {
        const file = files[index++],
          full = path.resolve(root, file.path);
        if (typeof file.path !== 'string' || !inside(root, full) || !/^[a-f0-9]{64}$/.test(file.sha256))
          throw new Error('Release path or hash is invalid');
        if ((await hash(full)) !== file.sha256)
          throw new Error(`Release integrity check failed: ${file.path}`);
      }
    }),
  );
}
async function powershell(script, input = '') {
  const encoded = Buffer.from(
    "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);$ErrorActionPreference='Stop';" +
      script,
    'utf16le',
  ).toString('base64');
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '',
      err = '';
    child.stdout.on('data', (b) => (out += b.toString('utf8')));
    child.stderr.on('data', (b) => (err += b.toString('utf8')));
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0
        ? resolve(out.trim())
        : reject(new Error('Windows settings operation failed: ' + err.slice(0, 1000))),
    );
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
async function updatePath(root, install, registryKey = 'Environment') {
  if (!/^[A-Za-z0-9_\\-]{1,160}$/.test(registryKey)) throw new Error('Invalid registry key');
  const bin = path.join(root, 'bin');
  const raw = await powershell(
    `$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${registryKey}');$v=if($k){$k.GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)}else{''};[Console]::Write((ConvertTo-Json -Compress ([string]$v)))`,
  );
  const previous = JSON.parse(raw),
    items = previous
      ? previous.split(';').filter((p) => path.resolve(p).toLowerCase() !== bin.toLowerCase())
      : [];
  if (install) items.unshift(bin);
  await powershell(
    `$v=[Console]::In.ReadToEnd();$k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('${registryKey}');$kind=[Microsoft.Win32.RegistryValueKind]::ExpandString;try{$kind=$k.GetValueKind('Path')}catch{};$k.SetValue('Path',$v,$kind);$k.Dispose();Add-Type 'using System;using System.Runtime.InteropServices;public class EnvBroadcast{[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern IntPtr SendMessageTimeout(IntPtr h,uint m,UIntPtr w,string l,uint f,uint t,out UIntPtr r);}';$r=[UIntPtr]::Zero;[void][EnvBroadcast]::SendMessageTimeout([IntPtr]0xffff,0x1a,[UIntPtr]::Zero,'Environment',2,2000,[ref]$r)`,
    items.join(';'),
  );
}
async function lock(root) {
  const name =
    '\\\\.\\pipe\\emergence-install-' + crypto.createHash('sha256').update(root.toLowerCase()).digest('hex');
  const server = net.createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', () => reject(new Error('Another installation operation owns this directory')));
    server.listen(name, resolve);
  });
  return () => new Promise((resolve) => server.close(resolve));
}
async function main() {
  if (!['install', 'uninstall'].includes(action) || !rootArg || !sourceArg)
    throw new Error('Invalid installation invocation');
  const root = path.resolve(rootArg),
    source = await fs.realpath(path.resolve(sourceArg));
  const protectedPaths = [
    path.parse(root).root,
    process.env.USERPROFILE,
    path.join(process.env.USERPROFILE || '', '.emergence'),
  ]
    .filter(Boolean)
    .map((p) => path.resolve(p).toLowerCase());
  if (protectedPaths.includes(root.toLowerCase()))
    throw new Error('Choose a dedicated application directory');
  await ancestors(root);
  if (await exists(root)) await noLinks(root);
  const marker = path.join(root, 'installation.json'),
    releaseLock = await lock(root);
  try {
    if (action === 'install') {
      if (root.toLowerCase() === source.toLowerCase() || inside(root, source) || inside(source, root))
        throw new Error('Source and installation must be separate directories');
      await noLinks(source);
      const release = await json(path.join(source, 'release.json'));
      if (
        release.product !== 'emergence' ||
        release.platform !== 'win32-x64' ||
        !versionPattern.test(release.version)
      )
        throw new Error('Invalid release manifest');
      const files = await json(path.join(source, 'manifest.sha256.json'));
      console.log('Verifying release integrity…');
      await verify(source, files);
      if ((await exists(root)) && !(await exists(marker)) && (await fs.readdir(root)).length)
        throw new Error('Target exists without an Emergence ownership marker; nothing was overwritten');
      if ((await exists(marker)) && (await json(marker)).product !== 'emergence')
        throw new Error('Invalid installation ownership marker');
      await fs.mkdir(root, { recursive: true });
      if (!(await exists(marker)))
        await atomic(marker, { product: 'emergence', schema: 1, createdAt: new Date().toISOString() });
      const versions = path.join(root, 'versions'),
        version = path.join(versions, release.version);
      await fs.mkdir(versions, { recursive: true });
      if (!inside(root, version)) throw new Error('Version directory escapes installation root');
      if (!(await exists(version))) {
        const stage = path.join(root, '.stage-' + crypto.randomUUID());
        if (!inside(root, stage)) throw new Error('Unsafe staging directory');
        try {
          console.log('Copying the complete application…');
          await fs.cp(source, stage, { recursive: true, force: false, errorOnExist: true });
          await verify(stage, files);
          await fs.rename(stage, version);
        } finally {
          if (await exists(stage)) {
            const canonicalRoot = await fs.realpath(root),
              canonicalStage = await fs.realpath(stage);
            if (
              !inside(canonicalRoot, canonicalStage) ||
              path.basename(canonicalStage) !== path.basename(stage)
            )
              throw new Error('Unsafe staging cleanup');
            await noLinks(stage);
            await fs.rm(stage, { recursive: true, force: false });
          }
        }
      } else await verify(version, files);
      const bin = path.join(root, 'bin');
      await fs.mkdir(bin, { recursive: true });
      for (const name of ['emergence.ps1', 'emergence.cmd'])
        await atomic(path.join(bin, name), await fs.readFile(path.join(source, name), 'utf8'));
      for (const name of ['manage.cjs', 'run-manager.ps1', 'uninstall.ps1'])
        await atomic(path.join(root, name), await fs.readFile(path.join(source, name), 'utf8'));
      const current = path.join(root, 'current.json');
      if (await exists(current))
        await atomic(path.join(root, 'current.previous.json'), await fs.readFile(current, 'utf8'));
      await atomic(current, {
        product: 'emergence',
        version: release.version,
        activatedAt: new Date().toISOString(),
      });
      if (noPath !== '--no-path') await updatePath(root, true);
      console.log(
        `Installed Emergence ${release.version} at ${root}\nConfiguration, credentials, sessions and templates were preserved. Open a new terminal and run emergence.`,
      );
    } else {
      if (!(await exists(marker)) || (await json(marker)).product !== 'emergence')
        throw new Error('Refusing removal without a valid Emergence ownership marker');
      const processes = JSON.parse(
        await powershell(
          '@(Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | Select-Object ProcessId,ExecutablePath) | ConvertTo-Json -Compress',
        ),
      );
      if (
        (Array.isArray(processes) ? processes : [processes]).some(
          (p) => p && p.ExecutablePath && inside(root, path.resolve(p.ExecutablePath)),
        )
      )
        throw new Error('Close running Emergence instances before uninstalling');
      // Recursive removals are restricted to these canonical, verified application children.
      for (const name of ['versions', 'bin']) {
        const target = path.resolve(root, name);
        if (!inside(root, target)) throw new Error('Uninstall target escapes application directory');
        if (await exists(target)) {
          await noLinks(target);
          await fs.rm(target, { recursive: true, force: false });
        }
      }
      if (noPath !== '--no-path') await updatePath(root, false);
      for (const name of [
        'current.json',
        'current.previous.json',
        'installation.json',
        'manage.cjs',
        'run-manager.ps1',
        'uninstall.ps1',
      ])
        try {
          await fs.unlink(path.join(root, name));
        } catch (e) {
          if (e.code !== 'ENOENT') throw e;
        }
      if ((await fs.readdir(root)).length === 0) await fs.rmdir(root);
      console.log(
        'Application removed. Configuration, encrypted credentials, sessions, templates and project files were preserved.',
      );
    }
  } finally {
    await releaseLock();
  }
}
module.exports = { updatePath, powershell };
if (require.main === module)
  main().catch((error) => {
    console.error('Emergence installation: ' + error.message);
    process.exitCode = 1;
  });
