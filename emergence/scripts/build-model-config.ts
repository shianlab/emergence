import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** Uses the Windows-provided Framework compiler; this WinExe needs no browser or NuGet dependency. */
export async function buildNativeModelConfiguration() {
  if (process.platform !== 'win32') return;
  const out = resolve('dist/model-config');
  await mkdir(out, { recursive: true });
  const executable = join(out, '涌现模型配置.exe'),
    stamp = join(out, 'native-build.json');
  const fingerprint = createHash('sha256');
  for (const source of [
    'native/model-config/Program.cs',
    'native/model-config/app.manifest',
    'assets/brand/pixel/yongxian-pixel-fine.png',
  ])
    fingerprint.update(await readFile(source));
  fingerprint.update(await readFile(new URL(import.meta.url)));
  const sourceHash = fingerprint.digest('hex');
  async function entryCopy() {
    for (const suffix of ['', '.config']) {
      const bytes = await readFile(executable + suffix),
        target = resolve('../涌现模型配置.exe' + suffix);
      try {
        if (bytes.equals(await readFile(target))) continue;
      } catch {
        /* First build. */
      }
      await copyFile(executable + suffix, target);
    }
  }
  try {
    const previous = JSON.parse(await readFile(stamp, 'utf8'));
    if (
      previous.sourceHash === sourceHash &&
      previous.binaryHash ===
        createHash('sha256')
          .update(await readFile(executable))
          .digest('hex')
    ) {
      await entryCopy();
      console.log('Native model configuration: unchanged');
      return;
    }
  } catch {
    /* Compile missing or changed output. */
  }
  const icon = join(out, 'emergence.ico');
  // Packaging the approved wordmark, preserving its silhouette and aspect ratio.
  const script = `Add-Type -AssemblyName System.Drawing
$source = [Drawing.Image]::FromFile([IO.Path]::GetFullPath('assets/brand/pixel/yongxian-pixel-fine.png'))
$bitmap = [Drawing.Bitmap]::new(64,64)
$graphics = [Drawing.Graphics]::FromImage($bitmap)
$graphics.Clear([Drawing.Color]::White)
$attributes = [Drawing.Imaging.ImageAttributes]::new()
$matrix = [Drawing.Imaging.ColorMatrix]::new()
$matrix.Matrix00=0; $matrix.Matrix11=0; $matrix.Matrix22=0
$matrix.Matrix40=0.16; $matrix.Matrix41=0.16; $matrix.Matrix42=0.16
$attributes.SetColorMatrix($matrix)
$graphics.DrawImage($source,[Drawing.Rectangle]::new(3,20,58,24),0,0,$source.Width,$source.Height,[Drawing.GraphicsUnit]::Pixel,$attributes)
$stream = [IO.File]::Create([IO.Path]::GetFullPath('dist/model-config/emergence.ico'))
$icon = [Drawing.Icon]::FromHandle($bitmap.GetHicon()); $icon.Save($stream)
$stream.Dispose(); $icon.Dispose(); $attributes.Dispose(); $graphics.Dispose(); $bitmap.Dispose(); $source.Dispose()
`;
  async function run(command: string, args: string[]) {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    const code = await new Promise<number | null>((done, reject) => {
      child.once('error', reject);
      child.once('exit', done);
    });
    if (code !== 0) throw new Error(`Native model configuration build failed (${code}): ${output}`);
  }
  await run('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ]);
  await run(join(process.env.WINDIR ?? 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), [
    '/nologo',
    '/target:winexe',
    '/platform:x64',
    '/optimize+',
    '/utf8output',
    '/codepage:65001',
    `/out:${executable}`,
    '/reference:System.dll',
    '/reference:System.Core.dll',
    '/reference:System.Drawing.dll',
    '/reference:System.Windows.Forms.dll',
    '/reference:System.Web.Extensions.dll',
    '/reference:System.Net.Http.dll',
    `/win32manifest:${resolve('native/model-config/app.manifest')}`,
    `/win32icon:${icon}`,
    `/resource:${resolve('assets/brand/pixel/yongxian-pixel-fine.png')},Wordmark`,
    resolve('native/model-config/Program.cs'),
  ]);
  await writeFile(
    executable + '.config',
    '<?xml version="1.0"?><configuration><startup><supportedRuntime version="v4.0" sku=".NETFramework,Version=v4.8"/></startup><System.Windows.Forms.ApplicationConfigurationSection><add key="DpiAwareness" value="PerMonitorV2"/></System.Windows.Forms.ApplicationConfigurationSection></configuration>',
  );
  await entryCopy();
  await writeFile(
    stamp,
    JSON.stringify({
      sourceHash,
      binaryHash: createHash('sha256')
        .update(await readFile(executable))
        .digest('hex'),
    }),
  );
  const bytes = await readFile(executable);
  console.log(`Native model configuration: ${Math.ceil(bytes.length / 1024)} KB`);
}
