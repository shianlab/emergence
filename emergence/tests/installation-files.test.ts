import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

const manager = createRequire(import.meta.url)('../release/manage.cjs') as {
  validateFiles(root: string, files: unknown): void;
  verify(root: string, files: unknown): Promise<void>;
  copyRelease(source: string, destination: string, files: unknown): Promise<void>;
};
const required = [
  'release.json',
  'runtime/node.exe',
  'app/bin/emergence.cjs',
  'manage.cjs',
  'health.cjs',
  'app/dist/cli.mjs',
  'app/dist/plugin.mjs',
  'app/dist/data/manifest.json',
  'app/dist/data/worker.py',
  'app/dist/data/analytics.py',
  'app/dist/data/runtime-lock.json',
  'app/dist/data/probe.py',
  '涌现模型配置.exe',
];
const data = Buffer.from('fixture');
const files = required.map((path) => ({
  path,
  sha256: createHash('sha256').update(data).digest('hex'),
  bytes: data.length,
}));

test('installation manifest rejects Windows path aliases, duplicates and malformed records', () => {
  const root = join(tmpdir(), 'emergence-files');
  manager.validateFiles(root, files);
  for (const path of [
    '../outside',
    'C:/outside',
    'file:stream',
    'a/../b',
    'dir//file',
    'name.',
    'con.txt',
    'a\\file',
    'APP/DIST/CLI.MJS',
  ])
    assert.throws(() => manager.validateFiles(root, [...files, { ...files[0], path }]), /invalid/i, path);
  for (const value of [null, { path: 'new', sha256: 'no', bytes: 2 }, { ...files[0], bytes: -1 }])
    assert.throws(() => manager.validateFiles(root, [...files, value]));
  assert.throws(() =>
    manager.validateFiles(
      root,
      files.filter((f) => f.path !== 'health.cjs'),
    ),
  );
});

test('bounded deployment copies only declared files and verifies destination bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'emergence-files-'));
  const source = join(root, '源文件');
  const stage = join(root, '安装 暂存');
  for (const file of files) {
    await mkdir(dirname(join(source, file.path)), { recursive: true });
    await writeFile(join(source, file.path), data);
  }
  await writeFile(join(source, 'manifest.sha256.json'), JSON.stringify(files));
  await writeFile(join(source, 'unexpected.txt'), 'not shipped');
  await manager.copyRelease(source, stage, files);
  await manager.verify(stage, files);
  await assert.rejects(readFile(join(stage, 'unexpected.txt')));
  await assert.rejects(manager.copyRelease(source, stage, files), /EEXIST/);
  assert.deepEqual(await readFile(join(stage, 'runtime/node.exe')), data);
  await writeFile(join(stage, 'app/dist/cli.mjs'), 'damaged');
  await assert.rejects(manager.verify(stage, files), /integrity/);
});
