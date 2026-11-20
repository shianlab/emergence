import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { VERSION } from '../version.ts';
import { safeError } from '../../core/adapters/redaction.ts';
import { replaceJsonFile } from '../../core/storage/safe-json-file.ts';
import { childEnvironment, windowsPowerShell } from '../../platform/child-environment.ts';
import { verifyManifest } from './manifest.ts';
import {
  hasInstallTransaction,
  installationLocation,
  safePath,
  type InstallationLocation,
} from './storage.ts';
import { UpdateService } from './service.ts';

// Leave room beyond the bootstrap's 15-minute transfer budget for extraction and health checks.
const installTimeoutMs = 20 * 60_000;
const recoveryTimeoutMs = 2 * 60_000;

function runInstaller(
  script: string,
  args: string[],
  timeoutMs: number,
  progress: (message: string) => void,
) {
  const env = childEnvironment();
  for (const name of Object.keys(env)) if (name.toLowerCase() === 'psmodulepath') delete env[name];
  return new Promise<{ code: number | null; detail: string; timedOut: boolean; stopped: boolean }>(
    (done, reject) => {
      const child = spawn(
        windowsPowerShell(),
        ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
        { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let pending = '';
      let detail = '';
      let timedOut = false;
      let grace: ReturnType<typeof setTimeout> | undefined;
      let stoppingTree: Promise<boolean> | undefined;
      const timer = setTimeout(() => {
        timedOut = true;
        // Give taskkill time to stop the whole tree before waiting for the child's close.
        if (child.pid && child.exitCode === null && child.signalCode === null) {
          stoppingTree = new Promise((resolve) => {
            execFile(
              join(env.SystemRoot ?? 'C:/Windows', 'System32/taskkill.exe'),
              ['/pid', String(child.pid), '/t', '/f'],
              { env, windowsHide: true, timeout: 4000 },
              (error) => {
                if (error && child.exitCode === null && child.signalCode === null) child.kill();
                resolve(!error);
              },
            );
          });
        }
        grace = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          done({ code: null, detail, timedOut, stopped: false });
        }, 8000);
      }, timeoutMs);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (text: string) => {
        if (timedOut) return;
        pending = (pending + text).slice(-8192);
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? '';
        for (const line of lines)
          if (line.trim() && !line.startsWith('{'))
            progress(line.replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, 160));
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (text: string) => {
        detail = (detail + text).slice(-4096);
      });
      child.once('error', (error) => {
        if (!timedOut) {
          clearTimeout(timer);
          reject(error);
        }
      });
      child.once('close', async (code) => {
        clearTimeout(timer);
        const stopped = !timedOut || (await stoppingTree) === true;
        clearTimeout(grace);
        done({ code, detail, timedOut, stopped });
      });
    },
  );
}

async function recoverInstallation(root: string, progress: (message: string) => void) {
  if (!(await hasInstallTransaction(root))) return;
  const script = join(root, 'run-manager.ps1');
  await safePath(script);
  progress('正在核对和恢复安装事务…');
  const result = await runInstaller(
    script,
    ['-Action', 'recover', '-InstallRoot', root, '-NoPath', '-Quiet'],
    recoveryTimeoutMs,
    progress,
  );
  if (result.timedOut || result.code !== 0 || (await hasInstallTransaction(root)))
    throw Error('安装事务恢复尚未完成，下次启动将再次尝试');
}

export async function installOnline(
  location: InstallationLocation,
  envelope: unknown,
  progress: (message: string) => void,
  validate: (value: unknown) => unknown = verifyManifest,
  timeoutMs = installTimeoutMs,
) {
  if (location.kind !== 'managed' || !location.root || !location.release) throw Error('需要受管安装');
  validate(envelope);
  const folder = join(location.root, 'updates');
  await safePath(folder);
  await mkdir(folder, { recursive: true });
  const file = join(folder, 'request-' + randomUUID() + '.json');
  await writeFile(file, JSON.stringify(envelope), { flag: 'wx', mode: 0o600 });
  let code: number | null = null;
  let detail = '';
  let failureDetail: string | undefined;
  try {
    const script = join(location.release, 'bootstrap.ps1');
    await safePath(script);
    const result = await runInstaller(
      script,
      ['-InstallRoot', location.root, '-SignedManifest', file, '-Update'],
      timeoutMs,
      progress,
    );
    ({ code, detail } = result);
    const installerMessage = code ? safeError(detail).trim().split(/\r?\n/, 1)[0].slice(0, 180) : '';
    const failure = result.timedOut
      ? '更新安装超时'
      : code !== 0
        ? `更新安装失败（退出码 ${code ?? '未知'}）${installerMessage ? '，' + installerMessage : ''}`
        : undefined;
    let recovery: string | undefined;
    if (result.stopped) {
      try {
        await recoverInstallation(location.root, progress);
      } catch (error) {
        recovery = safeError(error);
      }
    } else recovery = '安装进程未确认停止，请关闭涌现后重新启动以检查安装状态';
    if (failure || recovery)
      throw Error(
        [failure, recovery, '详情见安装目录 updates/failure.json 和下载缓存中的诊断记录']
          .filter(Boolean)
          .join('。'),
      );
  } catch (error) {
    failureDetail = safeError(error);
    throw error;
  } finally {
    let cleanup: string | undefined;
    try {
      await safePath(file);
      await unlink(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') cleanup = safeError(error);
    }
    if (failureDetail !== undefined || cleanup) {
      const diagnostic = join(folder, 'failure.json');
      try {
        await safePath(diagnostic);
        await replaceJsonFile(
          diagnostic,
          {
            stage: failureDetail === undefined ? 'request-cleanup' : 'bootstrap',
            code,
            timestamp: new Date().toISOString(),
            detail: [failureDetail, safeError(detail)].filter(Boolean).join('\n'),
            cleanup,
          },
          { invalidMessage: '更新诊断路径无效', maxBytes: 20000 },
        );
      } catch {
        /* Diagnostic failure must not replace the original installation failure. */
      }
    }
  }
}
export async function createUpdateService() {
  const location = await installationLocation();
  return new UpdateService(location, VERSION, {
    install: (envelope, progress) => installOnline(location, envelope, progress),
  });
}
