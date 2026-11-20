import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, access, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { createInstaller, engineFiles } = require('../release/installation/service.cjs');
const T = require('../release/installation/transaction.cjs');
const W = require('../release/installation/windows.cjs');
const F = require('../release/installation/files.cjs');
const baseFiles = [
  'release.json',
  'runtime/node.exe',
  'app/bin/emergence.cjs',
  'app/dist/cli.mjs',
  'app/dist/plugin.mjs',
  'app/dist/data/manifest.json',
  'app/dist/data/worker.py',
  'app/dist/data/analytics.py',
  'app/dist/data/runtime-lock.json',
  'app/dist/data/probe.py',
  '涌现模型配置.exe',
];
async function fixture(root: string, version: string) {
  const directory = join(root, '发行包 ' + version);
  const names = [
    ...new Set<string>([...baseFiles, ...engineFiles, ...(Object.values(T.bridges) as string[])]),
  ];
  const entries = [];
  for (const name of names) {
    const bytes = Buffer.from(
      name === 'release.json'
        ? JSON.stringify({
            product: 'emergence',
            platform: 'win32-x64',
            version,
            configSchema: 1,
            installationSchema: 2,
          })
        : name + ' ' + version,
    );
    await mkdir(dirname(join(directory, name)), { recursive: true });
    await writeFile(join(directory, name), bytes);
    entries.push({
      path: name,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  await writeFile(join(directory, 'manifest.sha256.json'), JSON.stringify(entries));
  return directory;
}
async function setup() {
  const folder = await mkdtemp(join(tmpdir(), 'emergence-transactions-')),
    root = join(folder, '安装 中文');
  const state = { path: 'before', busy: new Set<string>(), unknown: false };
  const windows = {
    lock: W.lock,
    holdFile: async (file: string) => (state.busy.has(file) ? null : async () => {}),
    capturePath: async () => ({ before: state.path, after: 'installed' }),
    applyPath: async () => {
      state.path = 'installed';
    },
    restorePath: async (plan: { before: string }) => {
      state.path = plan.before;
    },
    updatePath: async () => {},
    inUse: async () => (state.unknown ? 'unknown' : null),
  };
  const health = async () => {};
  const run = (options: Record<string, unknown> = {}) => createInstaller({ windows, health, ...options }).run;
  const read = async (name = 'current.json') => JSON.parse(await readFile(join(root, name), 'utf8'));
  const one = await fixture(folder, '1.0.0'),
    two = await fixture(folder, '2.0.0'),
    three = await fixture(folder, '3.0.0');
  await run()({ action: 'install', root, source: one });
  return { folder, root, state, windows, health, run, read, one, two, three };
}
test('upgrade, running-safe same-version repair, rollback and retention share one state machine', async () => {
  const f = await setup();
  await f.run()({ action: 'update', root: f.root, source: f.two });
  assert.equal((await f.read()).version, '2.0.0');
  assert.equal((await f.read('current.previous.json')).version, '1.0.0');
  await writeFile(join(f.root, 'versions/2.0.0/app/dist/cli.mjs'), 'broken');
  // Failed health is determined by destination bytes, not version labels.
  const health = async (folder: string) => {
    if ((await readFile(join(folder, 'app/dist/cli.mjs'), 'utf8')) === 'broken') throw Error('broken');
  };
  f.state.busy.add(join(f.root, '.usage/2.0.0.lock'));
  await f.run({ health })({ action: 'repair', root: f.root, source: f.two });
  const repaired = await f.read();
  assert.match(repaired.directory, /^2\.0\.0-repair\./);
  assert.equal(await readFile(join(f.root, 'versions/2.0.0/app/dist/cli.mjs'), 'utf8'), 'broken');
  assert.equal((await f.read('current.previous.json')).version, '1.0.0');
  await f.run({ health })({ action: 'rollback', root: f.root });
  assert.equal((await f.read()).version, '1.0.0');
  assert.equal((await f.read()).manager, repaired.directory);
  await access(join(f.root, 'versions', repaired.directory, 'manage.cjs'));
});
test('failure at every activation boundary restores entry files, pointer and PATH', async (t) => {
  for (const failure of [
    'preparing',
    'prepared',
    'entry:run-manager.ps1',
    'entry:bin/emergence.ps1',
    'path',
    'activated',
    'post-probe',
  ]) {
    await t.test(failure, async () => {
      const f = await setup(),
        before = await T.snapshot(f.root);
      const checkpoint = async (name: string) => {
        if (name === failure) throw Error('injected failure');
      };
      await assert.rejects(
        f.run({ checkpoint })({ action: 'update', root: f.root, source: f.two }),
        /injected/,
      );
      assert.deepEqual(await T.snapshot(f.root), before);
      assert.equal(f.state.path, 'installed');
      await assert.rejects(access(join(f.root, 'install-transaction.json')));
      assert.ok(!(await readdir(f.root)).some((n) => n.startsWith('.stage-')));
      await access(join(f.root, 'versions/1.0.0/app/dist/cli.mjs'));
    });
  }
});
test('post-activation startup failure rolls back and damaged source never activates', async () => {
  const f = await setup();
  await assert.rejects(
    f.run({
      health: async (folder: string) => {
        if (folder === join(f.root, 'versions/2.0.0')) throw Error('candidate cannot start');
      },
    })({ action: 'update', root: f.root, source: f.two }),
    /cannot start/,
  );
  assert.equal((await f.read()).version, '1.0.0');
  await writeFile(join(f.two, 'app/dist/cli.mjs'), 'corrupt');
  await assert.rejects(f.run()({ action: 'update', root: f.root, source: f.two }), /integrity/);
  assert.equal((await f.read()).version, '1.0.0');
});
test('simultaneous mutation is refused and custom launchers are preserved', async () => {
  const f = await setup();
  let ready!: () => void, release!: () => void;
  const prepared = new Promise<void>((done) => (ready = done)),
    blocked = new Promise<void>((done) => (release = done));
  const first = f.run({
    checkpoint: async (name: string) => {
      if (name === 'prepared') {
        ready();
        await blocked;
      }
    },
  })({ action: 'update', root: f.root, source: f.two });
  await prepared;
  await assert.rejects(f.run()({ action: 'repair', root: f.root, source: f.one }), /owns/);
  release();
  await first;
  await writeFile(join(f.root, 'bin/emergence.ps1'), 'custom launcher');
  await assert.rejects(f.run()({ action: 'update', root: f.root, source: f.three }), /自定义/);
  assert.equal(await readFile(join(f.root, 'bin/emergence.ps1'), 'utf8'), 'custom launcher');
  assert.equal((await f.read()).version, '2.0.0');
});
test('cleanup retains shared leases, unknown processes, previous version and management engine', async () => {
  const f = await setup();
  await f.run()({ action: 'update', root: f.root, source: f.two });
  f.state.busy.add(join(f.root, '.usage/1.0.0.lock'));
  await f.run()({ action: 'update', root: f.root, source: f.three });
  await access(join(f.root, 'versions/1.0.0'));
  f.state.busy.clear();
  f.state.unknown = true;
  await f.run()({ action: 'cleanup', root: f.root });
  await access(join(f.root, 'versions/1.0.0'));
  f.state.unknown = false;
  const result = await f.run()({ action: 'cleanup', root: f.root });
  assert.deepEqual(result.removed, ['1.0.0']);
  await assert.rejects(access(join(f.root, 'versions/1.0.0')));
  await access(join(f.root, 'versions/2.0.0'));
  await access(join(f.root, 'versions/3.0.0'));
});
test('actual process death recovers an uncommitted switch and preserves a committed one', async (t) => {
  for (const boundary of ['preparing', 'prepared', 'activated', 'committed']) {
    await t.test(boundary, async () => {
      const f = await setup();
      const helper = join(f.folder, 'crash.cjs');
      await writeFile(
        helper,
        'const{createInstaller}=require(' +
          JSON.stringify(require.resolve('../release/installation/service.cjs')) +
          ');' +
          'const w=require(' +
          JSON.stringify(require.resolve('../release/installation/windows.cjs')) +
          ');' +
          'createInstaller({health:async()=>{},windows:{...w,holdFile:async()=>async()=>{},inUse:async()=>null},checkpoint:async(name)=>{if(name===' +
          JSON.stringify(boundary) +
          ')process.exit(77)}}).run(' +
          JSON.stringify({ action: 'update', root: f.root, source: f.two, noPath: true }) +
          ').catch(e=>{console.error(e);process.exitCode=1});',
      );
      const child = spawn(process.execPath, [helper], { windowsHide: true, stdio: 'pipe' });
      let errors = '';
      child.stderr.on('data', (b) => (errors += b));
      const code = await new Promise<number | null>((done, reject) => {
        child.once('error', reject);
        child.once('close', done);
      });
      assert.equal(code, 77, errors);
      const journal = await f.read('install-transaction.json');
      assert.equal(journal.engine, boundary === 'preparing' ? '1.0.0' : '2.0.0');
      await f.run()({ action: 'recover', root: f.root });
      assert.equal((await f.read()).version, boundary === 'committed' ? '2.0.0' : '1.0.0');
      await assert.rejects(access(join(f.root, 'install-transaction.json')));
    });
  }
});

test('disk-full copy and partially failed PATH operation keep the old installation usable', async () => {
  const f = await setup();
  const fileSystem = require('node:fs/promises') as typeof import('node:fs/promises');
  const copy = fileSystem.copyFile;
  try {
    fileSystem.copyFile = async (...args: Parameters<typeof copy>) => {
      if (String(args[1]).includes('.stage-'))
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      return copy(...args);
    };
    await assert.rejects(f.run()({ action: 'update', root: f.root, source: f.two }), /disk full/);
  } finally {
    fileSystem.copyFile = copy;
  }
  assert.equal((await f.read()).version, '1.0.0');
  assert.ok(!(await readdir(f.root)).some((name) => name.startsWith('.stage-')));
  const diagnostic = await f.read('install-diagnostics.json');
  assert.equal(diagnostic.ok, false);
  assert.ok(
    diagnostic.timings.some(
      (timing: { phase: string; failed?: boolean }) => timing.phase === '部署候选文件' && timing.failed,
    ),
  );
  assert.ok(!JSON.stringify(diagnostic).includes(f.root));
  f.state.path = 'user-path';
  const windows = {
    ...f.windows,
    applyPath: async () => {
      f.state.path = 'installed';
      throw Error('PATH write failed');
    },
  };
  await assert.rejects(f.run({ windows })({ action: 'update', root: f.root, source: f.two }), /PATH write/);
  assert.equal(f.state.path, 'user-path');
  assert.equal((await f.read()).version, '1.0.0');
});
test('rollback rejects incompatible data formats without changing activation', async () => {
  const f = await setup();
  const file = join(f.two, 'release.json'),
    metadata = JSON.parse(await readFile(file, 'utf8'));
  metadata.configSchema = 2;
  const bytes = Buffer.from(JSON.stringify(metadata));
  await writeFile(file, bytes);
  const manifest = JSON.parse(await readFile(join(f.two, 'manifest.sha256.json'), 'utf8'));
  const entry = manifest.find((item: { path: string }) => item.path === 'release.json');
  entry.bytes = bytes.length;
  entry.sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(join(f.two, 'manifest.sha256.json'), JSON.stringify(manifest));
  await f.run()({ action: 'update', root: f.root, source: f.two });
  await assert.rejects(f.run()({ action: 'rollback', root: f.root }), /格式不兼容/);
  assert.equal((await f.read()).version, '2.0.0');
});

test('updates respect prerelease ordering and never downgrade stable to prerelease', async () => {
  assert.equal(F.compareVersions('1.0.0-rc.10', '1.0.0-rc.2'), 1);
  assert.equal(F.compareVersions('1.0.0', '1.0.0-rc.10'), 1);
  assert.equal(F.compareVersions('1.0.0-beta', '1.0.0-beta.1'), -1);
  const f = await setup();
  const source = await fixture(f.folder, '1.0.0-rc.1');
  await assert.rejects(f.run()({ action: 'update', root: f.root, source }), /不能降级/);
  assert.equal((await f.read()).version, '1.0.0');
});

test('retention preserves user files added under a retired version', async () => {
  const f = await setup();
  await writeFile(join(f.root, 'versions/1.0.0/my-notes.txt'), 'user content');
  await f.run()({ action: 'update', root: f.root, source: f.two });
  const result = await f.run()({ action: 'update', root: f.root, source: f.three });
  assert.ok(result.cleanup.retained.some((entry: { reason: string }) => entry.reason === 'unmanaged-files'));
  assert.equal(await readFile(join(f.root, 'versions/1.0.0/my-notes.txt'), 'utf8'), 'user content');
});
