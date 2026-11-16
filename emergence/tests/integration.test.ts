import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { performIntegration, prepareIntegration } from '../src/app/integration.ts';

test('Git worktree integration merges committed work, preserves conflicts and refuses dirty or unrelated projects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'emergence-integration-')),
    main = join(root, '主项目'),
    worker = join(root, '工作树'),
    other = join(root, '其他项目');
  await mkdir(main);
  await mkdir(other);
  const git = async (cwd: string, ...args: string[]) =>
    (await promisify(execFile)('git', args, { cwd, windowsHide: true })).stdout.trim();
  for (const path of [main, other]) {
    await git(path, 'init', '-q');
    await git(path, 'config', 'user.name', 'Fixture');
    await git(path, 'config', 'user.email', 'fixture@example.test');
  }
  await writeFile(join(main, 'shared.txt'), 'base');
  await git(main, 'add', '.');
  await git(main, 'commit', '-qm', 'base');
  await git(main, 'worktree', 'add', '--detach', worker, 'HEAD');
  await writeFile(join(worker, 'result.txt'), 'verified work');
  await git(worker, 'add', '.');
  await git(worker, 'commit', '-qm', 'worker result');
  const source = { id: 'worker', cwd: worker },
    target = { id: 'main', cwd: main };
  const record = await prepareIntegration(source, target);
  await performIntegration(record);
  assert.equal(record.status, 'merged');
  assert.equal(await readFile(join(main, 'result.txt'), 'utf8'), 'verified work');
  await writeFile(join(main, 'shared.txt'), 'main version');
  await git(main, 'add', '.');
  await git(main, 'commit', '-qm', 'main edit');
  await writeFile(join(worker, 'shared.txt'), 'worker version');
  await git(worker, 'add', '.');
  await git(worker, 'commit', '-qm', 'worker edit');
  const conflict = await prepareIntegration(source, target);
  await performIntegration(conflict);
  assert.equal(conflict.status, 'conflict');
  assert.ok(conflict.conflicts.includes('shared.txt'));
  assert.ok((await readFile(join(main, 'shared.txt'), 'utf8')).includes('<<<<<<<'));
  await assert.rejects(prepareIntegration(source, target), /未提交|合并/);
  await assert.rejects(prepareIntegration({ id: 'other', cwd: other }, target), /跨项目/);
});
