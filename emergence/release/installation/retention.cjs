const fs = require('node:fs/promises');
const path = require('node:path');
const F = require('./files.cjs');
const T = require('./transaction.cjs');
const directoryOf = (value) => value?.directory ?? value?.version;
function createRetention(windows, readPointer) {
  async function gate(root, run) {
    const file = path.join(root, '.launch.lock');
    await F.ancestors(file);
    const unlock = await windows.holdFile(file);
    if (!unlock) throw new Error('启动入口正忙，请稍后重试安装操作');
    try {
      return await run();
    } finally {
      await unlock();
    }
  }
  async function unused(root, directory, run) {
    const usage = path.join(root, '.usage');
    await F.ancestors(usage);
    await fs.mkdir(usage, { recursive: true });
    const file = path.join(usage, directory + '.lock');
    await F.ancestors(file);
    const unlock = await windows.holdFile(file);
    if (!unlock) return { skipped: 'in-use' };
    try {
      const busy = await windows.inUse(path.join(root, 'versions', directory));
      if (busy) return { skipped: busy };
      return await run();
    } finally {
      await unlock();
    }
  }
  async function prune(root, identity) {
    return gate(root, async () => {
      const current = await readPointer(root),
        previous = await readPointer(root, 'current.previous.json');
      const keep = new Set(
        [directoryOf(current), directoryOf(previous), current?.manager, previous?.manager].filter(Boolean),
      );
      const result = { removed: [], retained: [] };
      const versions = path.join(root, 'versions');
      await F.ancestors(versions);
      if (!(await F.exists(versions))) return result;
      for (const directory of await fs.readdir(versions)) {
        if (keep.has(directory) || !F.versionPattern.test(directory)) {
          result.retained.push({ directory, reason: 'referenced-or-unmanaged' });
          continue;
        }
        const record = path.join(root, '.versions', directory + '.json');
        try {
          await F.ancestors(record);
          if (!(await F.exists(record))) {
            result.retained.push({ directory, reason: 'unmanaged' });
            continue;
          }
          const saved = await F.json(record),
            folder = path.join(versions, directory);
          await F.ancestors(folder);
          if (saved.protocol !== 2) {
            result.retained.push({ directory, reason: 'legacy-launcher-without-lease' });
            continue;
          }
          if (
            saved.installation !== identity.id ||
            saved.directory !== directory ||
            saved.manifestHash !== (await F.hash(path.join(folder, 'manifest.sha256.json')))
          )
            throw new Error('ownership');
          const outcome = await unused(root, directory, async () => {
            const manifest = await F.json(path.join(folder, 'manifest.sha256.json'));
            F.validateFiles(folder, manifest);
            const owned = new Set(['manifest.sha256.json', ...manifest.map((file) => file.path)]);
            await F.noLinks(folder);
            for (const entry of await fs.readdir(folder, { recursive: true, withFileTypes: true })) {
              const relative = path
                .relative(folder, path.join(entry.parentPath, entry.name))
                .replaceAll('\\', '/');
              if (entry.isFile() && !owned.has(relative)) return { skipped: 'unmanaged-files' };
            }
            await F.removeOwned(root, folder);
            await fs.unlink(record);
            // The usage handle is authoritative; stale PID records cannot grant or deny deletion.
            const usage = path.join(root, '.usage');
            for (const name of await fs.readdir(usage))
              if (name.startsWith(directory + '.') && name.endsWith('.json')) {
                const file = path.join(usage, name);
                await F.ancestors(file);
                if ((await F.json(file)).directory === directory) await fs.unlink(file);
              }
            result.removed.push(directory);
            return {};
          });
          if (outcome.skipped) result.retained.push({ directory, reason: outcome.skipped });
        } catch {
          result.retained.push({ directory, reason: 'unsafe-or-cleanup-failed' });
        }
      }
      return result;
    });
  }
  async function uninstall(root, identity, noPath) {
    return gate(root, async () => {
      if (await windows.inUse(root)) throw new Error('请关闭所有涌现窗口和模型配置工具后卸载');
      const versions = path.join(root, 'versions');
      const unlocks = [];
      try {
        if (await F.exists(versions))
          for (const directory of await fs.readdir(versions)) {
            if (!F.versionPattern.test(directory)) throw new Error('安装目录有未知版本内容，停止卸载');
            const usage = path.join(root, '.usage');
            await F.ancestors(usage);
            await fs.mkdir(usage, { recursive: true });
            const file = path.join(usage, directory + '.lock');
            await F.ancestors(file);
            const unlock = await windows.holdFile(file);
            if (!unlock) throw new Error('仍有窗口正在使用安装版本');
            unlocks.push(unlock);
          }
        await F.noLinks(root);
        const updates = path.join(root, 'updates');
        if (await F.exists(updates)) {
          const names = await fs.readdir(updates);
          if (
            names.every(
              (name) =>
                ['state.json', 'failure.json'].includes(name) || /^request-[a-f0-9-]{36}\.json$/.test(name),
            )
          )
            await F.removeOwned(root, updates);
        }
        if (!noPath) await windows.updatePath(root, false);
        for (const name of ['versions', 'bin', '.versions'])
          if (await F.exists(path.join(root, name))) await F.removeOwned(root, path.join(root, name));
        for (const name of [
          ...Object.keys(T.bridges).filter((n) => !n.startsWith('bin/')),
          'current.json',
          'current.previous.json',
          'installation.json',
          'install-diagnostics.json',
          'manage.cjs',
          'health.cjs',
        ])
          await fs.rm(path.join(root, name), { force: true });
      } finally {
        for (const unlock of unlocks) await unlock();
      }
      return { uninstalled: true, installation: identity.id };
    });
  }

  return { gate, unused, prune, uninstall };
}
module.exports = { createRetention };
