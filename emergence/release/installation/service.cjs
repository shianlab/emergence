const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const F = require('./files.cjs');
const W = require('./windows.cjs');
const T = require('./transaction.cjs');
const { createRetention } = require('./retention.cjs');
const { createDiagnostics } = require('./diagnostics.cjs');
const { checkInstallation } = require('../health.cjs');
const engineFiles = [
  'manage.cjs',
  'health.cjs',
  'installation/files.cjs',
  'installation/windows.cjs',
  'installation/transaction.cjs',
  'installation/service.cjs',
  'installation/retention.cjs',
  'installation/diagnostics.cjs',
  'launch-support.ps1',
  'run-manager.ps1',
  'maintenance.ps1',
];
const directoryOf = (value) => value?.directory ?? value?.version;
function createInstaller({ windows = W, health = checkInstallation, checkpoint = async () => {} } = {}) {
  async function readPointer(root, name = 'current.json') {
    const file = path.join(root, name);
    await F.ancestors(file);
    return (await F.exists(file)) ? F.pointer(await F.json(file)) : null;
  }
  const { gate, unused, prune, uninstall } = createRetention(windows, readPointer);
  async function owner(root, create, readOnly = false) {
    await F.ancestors(root);
    const protectedPaths = [
      path.parse(root).root,
      process.env.USERPROFILE,
      process.env.USERPROFILE && path.join(process.env.USERPROFILE, '.emergence'),
    ].filter(Boolean);
    if (protectedPaths.some((p) => path.resolve(p).toLowerCase() === root.toLowerCase()))
      throw new Error('请选择独立的应用安装目录');
    const file = path.join(root, 'installation.json');
    await F.ancestors(file);
    if (!(await F.exists(file))) {
      if (!create || ((await F.exists(root)) && (await fs.readdir(root)).length))
        throw new Error('目录不属于涌现，未覆盖任何文件');
      await fs.mkdir(root, { recursive: true });
      await F.atomic(file, { product: 'emergence', schema: 1, id: crypto.randomUUID() });
    }
    const value = await F.json(file);
    if (value.product !== 'emergence' || ![1, 2].includes(value.schema))
      throw new Error('安装所有权记录无效');
    if (!value.id) {
      if (readOnly) return value;
      value.id = crypto.randomUUID();
      await F.atomic(file, value);
    }
    if (!/^[a-f0-9-]{36}$/.test(value.id)) throw new Error('安装身份无效');
    return value;
  }
  async function release(folder, newEngine = false) {
    await F.ancestors(folder);
    await F.noLinks(folder);
    const metadata = await F.json(path.join(folder, 'release.json'));
    if (
      metadata.product !== 'emergence' ||
      metadata.platform !== 'win32-x64' ||
      !F.versionPattern.test(metadata.version) ||
      !Number.isInteger(metadata.configSchema)
    )
      throw new Error('发行包身份或配置协议无效');
    const files = await F.json(path.join(folder, 'manifest.sha256.json'));
    const legacy = metadata.installationSchema !== 2;
    await F.verify(folder, files, legacy);
    if (newEngine && (legacy || engineFiles.some((name) => !files.some((f) => f.path === name))))
      throw new Error('请使用带安装事务支持的完整发行包');
    return { metadata, files, legacy, manifestHash: await F.hash(path.join(folder, 'manifest.sha256.json')) };
  }
  async function healthy(root, pointer) {
    if (!pointer) return null;
    try {
      const folder = F.versionPath(root, pointer),
        info = await release(folder);
      if (info.metadata.version !== pointer.version) throw new Error('Version mismatch');
      await health(folder, pointer.version, { legacy: info.legacy });
      return { ...pointer, configSchema: info.metadata.configSchema };
    } catch {
      return null;
    }
  }
  async function receipt(root, id, pointer, info) {
    const folder = path.join(root, '.versions');
    await F.ancestors(folder);
    await fs.mkdir(folder, { recursive: true });
    await F.atomic(path.join(folder, directoryOf(pointer) + '.json'), {
      installation: id,
      directory: directoryOf(pointer),
      version: pointer.version,
      manifestHash: info.manifestHash,
      protocol: info.metadata.installationSchema ?? 1,
      verifiedAt: new Date().toISOString(),
    });
  }
  async function recover(root, identity) {
    const journal = await T.load(root);
    if (!journal) return { recovered: false };
    if (journal.state !== 'committed') {
      await gate(root, async () => {
        await T.restore(root, journal);
        if (journal.path) await windows.restorePath(journal.path);
      });
      const stage = path.join(root, '.stage-' + journal.id);
      if (await F.exists(stage)) await F.removeOwned(root, stage);
      if (
        journal.created &&
        journal.candidate &&
        journal.candidate !== directoryOf(await readPointer(root))
      ) {
        const folder = path.join(root, 'versions', journal.candidate);
        if (await F.exists(folder))
          await gate(root, () => unused(root, journal.candidate, () => F.removeOwned(root, folder)));
        const record = path.join(root, '.versions', journal.candidate + '.json');
        await F.ancestors(record);
        if (!(await F.exists(folder)) && (await F.exists(record))) {
          const saved = await F.json(record);
          if (saved.installation === identity.id && saved.directory === journal.candidate)
            await fs.unlink(record);
        }
      }
    }
    await fs.unlink(path.join(root, 'install-transaction.json'));
    return { recovered: true, state: journal.state, cleanup: await prune(root, identity) };
  }
  async function transition(root, source, action, identity, noPath, measure) {
    const before = await T.snapshot(root),
      current = await readPointer(root),
      previous = await readPointer(root, 'current.previous.json');
    const journal = {
      schema: 1,
      id: crypto.randomUUID(),
      action,
      state: 'preparing',
      before,
      after: {},
      candidate: null,
      engine: current?.manager ?? null,
      created: false,
      path: null,
    };
    let target, info, engine;
    try {
      if (action === 'rollback') {
        target = await healthy(root, previous);
        if (!target) throw new Error('没有通过验证的上一版本可回退');
        const activeInfo = await F.json(path.join(F.versionPath(root, current), 'release.json'));
        if (target.configSchema !== activeInfo.configSchema) throw new Error('数据格式不兼容，不能自动回退');
        engine = current.manager;
        if (!engine) throw new Error('旧安装需要先用新版完整发行包升级安装管理器');
        info = await release(F.versionPath(root, target));
        journal.candidate = directoryOf(target);
      } else {
        source = await fs.realpath(source);
        if (source.toLowerCase() === root.toLowerCase() || F.inside(root, source) || F.inside(source, root))
          throw new Error('请使用安装目录之外的完整发行包');
        info = await measure('验证发行包', () => release(source, true));
        if (action === 'repair' && (!current || current.version !== info.metadata.version))
          throw new Error('修复需要与当前版本一致的完整发行包');
        if (action === 'update' && current) {
          if (F.compareVersions(info.metadata.version, current.version) < 0)
            throw new Error('更新不能降级；请使用回退命令');
        }
        if (current?.version === info.metadata.version && action !== 'repair') {
          const valid = await healthy(root, current);
          if (
            valid &&
            (await F.hash(path.join(F.versionPath(root, current), 'manifest.sha256.json'))) ===
              info.manifestHash
          )
            return { changed: false, current, cleanup: await prune(root, identity) };
        }
        const plain = path.join(root, 'versions', info.metadata.version);
        const directory = (await F.exists(plain))
          ? info.metadata.version + '-repair.' + crypto.randomUUID()
          : info.metadata.version;
        target = {
          product: 'emergence',
          version: info.metadata.version,
          directory,
          configSchema: info.metadata.configSchema,
        };
        engine = directory;
        journal.candidate = directory;
        journal.engine = engine;
        journal.created = true;
      }
      target = { ...target, manager: engine, activatedAt: new Date().toISOString() };
      await T.save(root, journal);
      await checkpoint('preparing', journal);
      if (action !== 'rollback') {
        const stage = path.join(root, '.stage-' + journal.id);
        await measure('部署候选文件', () => F.copyRelease(source, stage, info.files));
        await measure('验证候选文件', () => F.verify(stage, info.files));
        await measure('验证实际启动', () => health(stage, target.version, { legacy: false }));
        await F.ancestors(path.join(root, 'versions'));
        await fs.mkdir(path.join(root, 'versions'), { recursive: true });
        await fs.rename(stage, F.versionPath(root, target));
        await receipt(root, identity.id, target, info);
      }
      let fallback =
        action === 'rollback'
          ? await healthy(root, current)
          : ((await healthy(root, current)) ?? (await healthy(root, previous)));
      if (fallback) {
        const oldInfo = await release(F.versionPath(root, fallback));
        await receipt(root, identity.id, fallback, oldInfo);
      }
      if (fallback) fallback = { ...fallback, manager: engine };
      journal.after = await T.planEntries(
        root,
        path.join(root, 'versions', engine),
        { ...identity, pathManaged: identity.pathManaged ?? !noPath },
        before,
      );
      journal.after['current.json'] = T.serialize(target);
      journal.after['current.previous.json'] = fallback ? T.serialize(fallback) : null;
      if (!noPath) journal.path = await windows.capturePath(root);
      journal.state = 'prepared';
      await T.save(root, journal);
      await checkpoint('prepared', journal);
      await measure('切换并验证入口', () =>
        gate(root, async () => {
          journal.state = 'activating';
          await T.save(root, journal);
          for (const [name, value] of Object.entries(journal.after)) {
            if (name === 'current.json') continue;
            const file = path.join(root, name);
            await F.ancestors(file);
            await fs.mkdir(path.dirname(file), { recursive: true });
            if (value === null) await fs.rm(file, { force: true });
            else await F.atomic(file, value);
            await checkpoint('entry:' + name, journal);
          }
          if (journal.path) await windows.applyPath(journal.path);
          await checkpoint('path', journal);
          await F.atomic(path.join(root, 'current.json'), journal.after['current.json']);
          journal.state = 'activated';
          await T.save(root, journal);
          await checkpoint('activated', journal);
          await health(F.versionPath(root, target), target.version, { legacy: info.legacy });
          await checkpoint('post-probe', journal);
          journal.state = 'committed';
          await T.save(root, journal);
          await checkpoint('committed', journal);
        }),
      );
    } catch (error) {
      const pending = await T.load(root);
      if (pending?.state === 'committed')
        return { changed: true, current: target, cleanup: { warning: '版本已启用，事务收尾留待下次恢复' } };
      // A crash leaves the journal; ordinary failures synchronously restore before reporting failure.
      if (await T.load(root)) {
        try {
          await recover(root, identity);
        } catch (recoveryError) {
          throw new Error(
            error.message +
              '；自动恢复尚未完成：' +
              recoveryError.message +
              '。请运行安装恢复命令，勿手动删除事务记录。',
          );
        }
      }
      throw error;
    }
    try {
      await fs.unlink(path.join(root, 'install-transaction.json'));
    } catch {
      return { changed: true, current: target, cleanup: { warning: '版本已启用，事务收尾留待下次恢复' } };
    }
    let cleanup;
    try {
      cleanup = await prune(root, identity);
    } catch {
      cleanup = { warning: '新版已启用，清理暂缓；稍后可运行 installation cleanup' };
    }
    return { changed: true, current: target, cleanup };
  }
  async function transact(root, source, action, identity, noPath) {
    const diagnostics = createDiagnostics(root, action);
    try {
      const result = await transition(root, source, action, identity, noPath, diagnostics.measure);
      await diagnostics.finish(true, result.current?.version);
      return result;
    } catch (error) {
      await diagnostics.finish(false);
      throw error;
    }
  }
  async function run({ action, root, source, noPath = false }) {
    if (
      !['install', 'update', 'repair', 'rollback', 'recover', 'cleanup', 'status', 'uninstall'].includes(
        action,
      )
    )
      throw new Error('未知安装操作');
    root = path.resolve(root);
    const unlock = await windows.lock(root);
    let releaseUpdates;
    try {
      if (action === 'uninstall' && windows.lockUpdates) releaseUpdates = await windows.lockUpdates(root);
      const identity = await owner(root, action === 'install', action === 'status');
      noPath = noPath || identity.pathManaged === false;
      if (action === 'status')
        return {
          current: await readPointer(root),
          previous: await readPointer(root, 'current.previous.json'),
          recoveryPending: !!(await T.load(root)),
        };
      const recovery = await recover(root, identity);
      if (action === 'recover') return recovery;
      if (action === 'cleanup') return await prune(root, identity);
      if (action === 'uninstall') {
        const result = await uninstall(root, identity, noPath);
        if (await F.exists(path.join(root, '.usage'))) await F.removeOwned(root, path.join(root, '.usage'));
        await fs.rm(path.join(root, '.launch.lock'), { force: true });
        if (!(await fs.readdir(root)).length) await fs.rmdir(root);
        return result;
      }
      return await transact(root, source, action, await F.json(path.join(root, 'installation.json')), noPath);
    } finally {
      await releaseUpdates?.();
      await unlock();
    }
  }
  return { run };
}
module.exports = { createInstaller, engineFiles };
