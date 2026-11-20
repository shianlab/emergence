import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { safeError } from '../../core/adapters/redaction.ts';
import { readJsonFile } from '../../core/storage/safe-json-file.ts';
import { acquireLease } from '../../core/storage/lease.ts';
import { compareVersions, verifyManifest, type ReleaseManifest } from './manifest.ts';
import { fetchManifest } from './transport.ts';
import {
  hasInstallTransaction,
  UpdateStore,
  type InstallationLocation,
  type UpdateState,
} from './storage.ts';

export interface UpdateSnapshot {
  status: 'idle' | 'checking' | 'current' | 'available' | 'installing' | 'ready' | 'error' | 'unsupported';
  message: string;
  enabled: boolean;
  checkedAt?: number;
  release?: ReleaseManifest;
  dismissed?: string;
}
interface Dependencies {
  request(signal: AbortSignal): Promise<unknown>;
  verify(value: unknown): ReleaseManifest;
  install(envelope: unknown, progress: (message: string) => void): Promise<void>;
  now(): number;
}
export class UpdateService extends EventEmitter {
  private state: UpdateSnapshot = { status: 'idle', enabled: true, message: '尚未检查更新' };
  private timer?: ReturnType<typeof setInterval>;
  private request?: Promise<UpdateSnapshot>;
  private operation?: Promise<void>;
  private closed = false;
  private abort = new AbortController();
  readonly store?: UpdateStore;
  private readonly deps: Dependencies;
  constructor(
    readonly location: InstallationLocation,
    readonly currentVersion: string,
    dependencies: Partial<Dependencies> = {},
  ) {
    super();
    if (location.kind === 'managed' && location.root) this.store = new UpdateStore(location.root);
    this.deps = {
      request: fetchManifest,
      verify: verifyManifest,
      now: Date.now,
      install: async () => {
        throw Error('此运行方式尚未连接安装器');
      },
      ...dependencies,
    };
    if (!this.store)
      this.state = {
        status: 'unsupported',
        enabled: false,
        message: '便携版或开发版：请使用完整发行包安装后更新，不会覆盖源码',
      };
  }
  get snapshot(): UpdateSnapshot {
    return structuredClone(this.state);
  }
  private publish(value: UpdateSnapshot) {
    if (!this.closed) {
      this.state = value;
      this.emit('change');
    }
  }
  private async isActiveVersion(root: string, version: string): Promise<boolean> {
    if (await hasInstallTransaction(root)) return false;
    const active = (await readJsonFile(join(root, 'current.json'), 16384, '安装指针无效')) as {
      product?: string;
      version?: string;
    } | null;
    return (
      active?.product === 'emergence' && active.version === version && !(await hasInstallTransaction(root))
    );
  }
  private async project(saved: UpdateState): Promise<UpdateSnapshot> {
    const release = saved.envelope ? this.deps.verify(saved.envelope) : undefined;
    const available = !!release && compareVersions(release.version, this.currentVersion) > 0;
    const ready =
      available &&
      !!this.store &&
      (await this.isActiveVersion(this.store.root, release.version).catch(() => false));
    return {
      status: ready
        ? 'ready'
        : saved.error
          ? 'error'
          : available
            ? 'available'
            : saved.checkedAt
              ? 'current'
              : 'idle',
      message: ready
        ? '更新已就绪，下次启动生效；当前任务继续运行'
        : (saved.error ??
          (available
            ? `发现新版本 ${release!.version} · /update 查看并更新`
            : saved.checkedAt
              ? '当前没有可用的新稳定版'
              : '尚未检查更新')),
      release,
      enabled: saved.enabled,
      checkedAt: saved.checkedAt,
      dismissed: saved.dismissed,
    };
  }
  async inspect() {
    if (!this.store) return this.snapshot;
    try {
      return await this.project(await this.store.read());
    } catch {
      return { ...this.snapshot, status: 'error' as const, message: '更新缓存或签名不可用，请重新检查' };
    }
  }
  start() {
    if (this.timer || this.closed || !this.store) return;
    void this.check();
    this.timer = setInterval(() => void this.check(), 6 * 60 * 60 * 1000);
    this.timer.unref();
  }
  check(force = false): Promise<UpdateSnapshot> {
    if (this.request) return this.request;
    if (!this.store || this.closed || this.operation) return Promise.resolve(this.snapshot);
    const started = this.deps.now();
    this.request = (async () => {
      let releaseLock: (() => Promise<void>) | undefined;
      try {
        releaseLock = await acquireLease('update-check:' + this.store!.root.toLowerCase(), '版本检查', 5500);
        if (this.closed) return this.snapshot;
        const saved = await this.store!.read();
        const age = this.deps.now() - saved.checkedAt;
        if (
          (!force && (!saved.enabled || (age >= 0 && age < 6 * 3600000))) ||
          (force && saved.checkedAt >= started)
        ) {
          this.publish(await this.project(saved));
          return this.snapshot;
        }
        this.publish({
          ...this.state,
          status: 'checking',
          enabled: saved.enabled,
          message: '正在检查官方稳定版…',
        });
        try {
          const envelope = await this.deps.request(
            AbortSignal.any([this.abort.signal, AbortSignal.timeout(5000)]),
          );
          const manifest = this.deps.verify(envelope);
          if (manifest.sequence < saved.sequence) throw Error('版本清单已过期，拒绝倒退');
          if (saved.envelope) {
            // Same sequence cannot silently point to different signed content.
            if (
              manifest.sequence === saved.sequence &&
              (saved.envelope as { payload?: string }).payload !== (envelope as { payload?: string }).payload
            )
              throw Error('同一发行序号的内容发生变化');
          }
          if (this.closed) return this.snapshot;
          Object.assign(saved, {
            envelope,
            sequence: manifest.sequence,
            checkedAt: this.deps.now(),
            error: undefined,
          });
        } catch {
          if (this.closed) return this.snapshot;
          saved.checkedAt = this.deps.now();
          saved.error = '暂时无法安全检查更新；网络或清单校验失败，可手动重试';
        }
        await this.store!.write(saved);
        this.publish(await this.project(saved));
      } catch {
        this.publish({ ...this.state, status: 'error', message: '更新检查暂不可用；不影响正常使用' });
      } finally {
        await releaseLock?.();
      }
      return this.snapshot;
    })().finally(() => {
      this.request = undefined;
    });
    return this.request;
  }
  async preference(enabled?: boolean, dismiss = false) {
    if (!this.store || this.closed) return;
    const unlock = await acquireLease('update-check:' + this.store.root.toLowerCase(), '版本设置', 6000);
    try {
      const saved = await this.store.read();
      if (enabled !== undefined) saved.enabled = enabled;
      if (dismiss) saved.dismissed = this.state.release?.version;
      await this.store.write(saved);
      if (this.state.status === 'installing')
        this.publish({ ...this.state, enabled: saved.enabled, dismissed: saved.dismissed });
      else this.publish(await this.project(saved));
    } finally {
      await unlock();
    }
  }
  private async recordInstallResult(
    store: UpdateStore,
    checked: UpdateState,
    result: { version: string } | { error: string },
  ) {
    try {
      const unlock = await acquireLease('update-check:' + store.root.toLowerCase(), '版本设置');
      try {
        const latest = await store.read();
        if (latest.sequence !== checked.sequence || latest.checkedAt !== checked.checkedAt) return;
        if ('version' in result) latest.installed = result.version;
        latest.error = 'error' in result ? result.error : undefined;
        await store.write(latest);
      } finally {
        await unlock();
      }
    } catch {
      // The installer and its transaction determine the result. Cache writes are best effort.
    }
  }
  install(expected: string): Promise<void> {
    if (this.operation) return this.operation;
    const store = this.store;
    if (!store || this.closed) return Promise.reject(Error('当前安装方式不支持在线更新'));
    this.operation = (async () => {
      let unlock: (() => Promise<void>) | undefined;
      let attempted: UpdateState | undefined;
      try {
        await this.request;
        if (this.closed) throw Error('更新服务已关闭');
        unlock = await acquireLease('update-install:' + store.root.toLowerCase(), '更新安装');
        const saved = await store.read();
        const release = this.deps.verify(saved.envelope);
        if (
          saved.error ||
          release.version !== expected ||
          compareVersions(release.version, this.currentVersion) <= 0
        )
          throw Error('更新目标已变化，请重新检查并选择');
        this.publish({ ...this.state, release, status: 'installing', message: '准备下载并校验更新…' });
        attempted = saved;
        await this.deps.install(saved.envelope, (message) => {
          if (this.state.status === 'installing') this.publish({ ...this.state, message });
        });
        if (!(await this.isActiveVersion(store.root, release.version).catch(() => false)))
          throw Error('未确认新版已启用，请检查安装状态后重试');
        this.publish({
          ...this.state,
          status: 'ready',
          message: '更新已就绪，下次启动生效；当前任务继续运行',
        });
        await this.recordInstallResult(store, saved, { version: release.version });
      } catch (error) {
        const detail = safeError(error).replace(/\s+/g, ' ').trim();
        const message = ('更新未完成，' + detail).slice(0, 500);
        this.publish({ ...this.state, status: 'error', message });
        if (attempted) await this.recordInstallResult(store, attempted, { error: message });
        throw error;
      } finally {
        await unlock?.().catch(() => {});
      }
    })().finally(() => {
      this.operation = undefined;
    });
    return this.operation;
  }
  dispose() {
    this.closed = true;
    clearInterval(this.timer);
    this.abort.abort();
    this.removeAllListeners();
  }
}
