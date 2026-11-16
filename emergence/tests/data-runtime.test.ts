import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { dataEnvironmentRoot, dataRuntime, loadDataAssets } from '../src/domains/data/runtime.ts';

test('packaged data resources verify required files and reject tampering or traversal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'emergence-assets-'));
  const directory = join(root, 'dist/data');
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'emergence-tui', emergencePortable: true }),
  );
  const manifest: Record<string, string> = {};
  for (const name of [
    'worker.py',
    'analytics.py',
    'probe.py',
    'runtime-lock.json',
    'requirements.txt',
    'requirements-win32-py314.txt',
  ]) {
    await cp(resolve('src/domains/data', name), join(directory, name));
    manifest[name] = createHash('sha256')
      .update(await readFile(join(directory, name)))
      .digest('hex');
  }
  const save = () => writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  await save();
  const assets = await loadDataAssets(root);
  assert.equal(assets.packaged, true);
  assert.equal(assets.lock.python, '3.14');
  await writeFile(join(directory, 'worker.py'), 'tampered');
  await assert.rejects(loadDataAssets(root), /校验失败/);
  await cp(resolve('src/domains/data/worker.py'), join(directory, 'worker.py'));
  manifest['../escape'] = '0'.repeat(64);
  await save();
  await assert.rejects(loadDataAssets(root), /路径无效/);
});

test('managed data environment cannot silently fall back after corrupt pointer or missing environment', async () => {
  const home = await mkdtemp(join(tmpdir(), 'emergence-data-pointer-'));
  const assets = await loadDataAssets();
  const base = dataEnvironmentRoot(home, assets.lockHash);
  await mkdir(base, { recursive: true });
  await writeFile(join(base, 'active.json'), '{broken');
  await assert.rejects(dataRuntime(home));
  await writeFile(
    join(base, 'active.json'),
    JSON.stringify({ version: 1, directory: '../../escape', lockHash: assets.lockHash }),
  );
  await assert.rejects(dataRuntime(home));
  await writeFile(
    join(base, 'active.json'),
    JSON.stringify({
      version: 1,
      directory: 'd0000000-0000-4000-8000-000000000000',
      lockHash: assets.lockHash,
    }),
  );
  await assert.rejects(dataRuntime(home), /ENOENT/);
});
