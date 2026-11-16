import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { diagnosticFileSchema } from '../../src/core/domain/run-diagnostics.ts';
import { readJsonFile } from '../../src/core/storage/safe-json-file.ts';

export async function diagnosticSnapshots(home: string) {
  const path = join(home, 'core', 'run-diagnostics');
  try {
    const names = (await readdir(path)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).slice(-32);
    return await Promise.all(
      names.map(async (name) =>
        diagnosticFileSchema.parse(
          await readJsonFile(join(path, name), 128000, 'Invalid diagnostic snapshot'),
        ),
      ),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export class ObservationDeadline extends Error {
  readonly kind = 'observation-deadline';
  constructor(
    readonly label: string,
    readonly limitMs: number,
    readonly lastState: unknown,
    readonly cleanupError?: string,
  ) {
    super(
      `测试观察期限已到：${label}（${limitMs} ms）；不是生产预算结论${cleanupError ? '；停止未确认：' + cleanupError : '；测试执行已停止'}`,
    );
  }
}

/** Tests supply their own process handle; never terminate a process discovered by name. */
export async function stopOwnedProcess(process: { pid: number; kill(): void }, exited: () => boolean) {
  if (exited()) return;
  if (!Number.isSafeInteger(process.pid) || process.pid <= 0) throw new Error('Invalid owned PID');
  if (globalThis.process.platform === 'win32') {
    try {
      await promisify(execFile)('taskkill.exe', ['/PID', String(process.pid), '/T', '/F'], {
        windowsHide: true,
        timeout: 5000,
      });
    } catch (error) {
      if (!exited()) throw error;
    }
  } else process.kill();
  for (let i = 0; i < 50 && !exited(); i++) await delay(100);
  if (!exited()) throw new Error('测试拥有的进程未确认退出');
}

/** Observation timeout owns cleanup, not production retry or budget decisions. */
export async function observeUntil(
  label: string,
  predicate: (signal: AbortSignal) => Promise<boolean>,
  options: { limitMs: number; snapshot(): Promise<unknown>; stop(): Promise<void> },
) {
  const abort = new AbortController();
  const expired = Symbol('observation deadline');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const polling = async () => {
    while (!abort.signal.aborted) {
      if (await predicate(abort.signal)) return;
      await delay(100, undefined, { signal: abort.signal });
    }
  };
  try {
    await Promise.race([
      polling(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(expired), options.limitMs);
      }),
    ]);
  } catch (error) {
    if (error !== expired) throw error;
    abort.abort();
    let state: unknown, cleanupError: string | undefined;
    let snapshotTimer: ReturnType<typeof setTimeout> | undefined;
    // A broken diagnostic read must never delay termination of the owned process.
    const snapshot = Promise.race([
      Promise.resolve().then(() => options.snapshot()),
      new Promise<never>((_, reject) => {
        snapshotTimer = setTimeout(() => reject(new Error('snapshot timeout')), 1000);
      }),
    ])
      .then(
        (value) => {
          state = value;
        },
        () => {
          state = { unavailable: '未取得最后状态，不能推测运行结果' };
        },
      )
      .finally(() => clearTimeout(snapshotTimer));
    const stop = Promise.resolve()
      .then(() => options.stop())
      .catch(() => {
        cleanupError = '拥有的执行进程未确认退出';
      });
    await Promise.all([snapshot, stop]);
    throw new ObservationDeadline(label, options.limitMs, state, cleanupError);
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}
