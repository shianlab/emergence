import { createHash } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function canonicalDirectory(path: string, create = true) {
  if (create) await mkdir(path, { recursive: true });
  const canonical = await realpath(path);
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}
/** OS-owned IPC lease: Windows releases it on process death; it never contains user data. */
export async function acquireLease(key: string, label: string, waitMs = 0): Promise<() => Promise<void>> {
  const digest = createHash('sha256').update(key).digest('hex');
  const path =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\emergence-${digest}`
      : process.platform === 'linux'
        ? `\0emergence-${digest}`
        : join(tmpdir(), `emergence-${digest.slice(0, 32)}.sock`);
  const deadline = Date.now() + waitMs;
  while (true) {
    const server = createServer((socket) => socket.destroy());
    server.unref();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(path, () => {
          server.off('error', reject);
          resolve();
        });
      });
      let closing: Promise<void> | undefined;
      return () =>
        (closing ??= new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ));
    } catch (error) {
      server.removeAllListeners();
      if (!['EADDRINUSE', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      if (Date.now() >= deadline)
        throw new Error(`${label}正在被其他操作使用，请稍后重试或先关闭另一个涌现实例`);
      await delay(30);
    }
  }
}
export async function withLease<T>(key: string, label: string, action: () => Promise<T>): Promise<T> {
  const release = await acquireLease(key, label, 15000);
  try {
    return await action();
  } finally {
    await release();
  }
}
