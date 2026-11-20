import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { VERSION } from '../version.ts';
import { safeError } from '../../core/adapters/redaction.ts';
import { replaceJsonFile } from '../../core/storage/safe-json-file.ts';
import { childEnvironment, windowsPowerShell } from '../../platform/child-environment.ts';
import { verifyManifest } from './manifest.ts';
import { installationLocation, safePath, type InstallationLocation } from './storage.ts';
import { UpdateService } from './service.ts';

export async function installOnline(
  location: InstallationLocation,
  envelope: unknown,
  progress: (message: string) => void,
  validate: (value: unknown) => unknown = verifyManifest,
) {
  if (location.kind !== 'managed' || !location.root || !location.release) throw Error('需要受管安装');
  validate(envelope);
  const folder = join(location.root, 'updates');
  await safePath(folder);
  await mkdir(folder, { recursive: true });
  const file = join(folder, 'request-' + randomUUID() + '.json');
  await writeFile(file, JSON.stringify(envelope), { flag: 'wx', mode: 0o600 });
  try {
    const environment = childEnvironment();
    for (const name of Object.keys(environment))
      if (name.toLowerCase() === 'psmodulepath') delete environment[name];
    const child = spawn(
      windowsPowerShell(),
      [
        '-NoLogo',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        join(location.release, 'bootstrap.ps1'),
        '-InstallRoot',
        location.root,
        '-SignedManifest',
        file,
        '-Update',
      ],
      { windowsHide: true, env: environment, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let pending = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (text) => {
      pending = (pending + text).slice(-8192);
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines)
        if (line.trim() && !line.startsWith('{'))
          progress(line.replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, 160));
    });
    let failure = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (text) => {
      failure = (failure + text).slice(-4096);
    });
    const code = await new Promise<number | null>((done, reject) => {
      child.once('error', reject);
      child.once('close', done);
    });
    if (code !== 0) {
      const diagnostic = join(folder, 'failure.json');
      try {
        await safePath(diagnostic);
        await replaceJsonFile(
          diagnostic,
          {
            stage: 'bootstrap',
            code,
            timestamp: new Date().toISOString(),
            detail: safeError(failure).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, ''),
          },
          { invalidMessage: '更新诊断路径无效', maxBytes: 20000 },
        );
      } catch {
        /* Diagnostic failure must not replace the original installation failure. */
      }
      throw Error('更新安装失败；请查看安装目录 updates/failure.json 和下载缓存中的诊断记录');
    }
  } finally {
    await safePath(file);
    await unlink(file).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
export async function createUpdateService() {
  const location = await installationLocation();
  return new UpdateService(location, VERSION, {
    install: (envelope, progress) => installOnline(location, envelope, progress),
  });
}
