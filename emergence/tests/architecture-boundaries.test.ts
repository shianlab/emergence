import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { TaskLifecycle } from '../src/core/application/task-lifecycle.ts';
import type { TaskRecord } from '../src/core/domain/task.ts';
import { readJsonFile, replaceJsonFile } from '../src/core/storage/safe-json-file.ts';

test('settled attempts cannot restart or bypass the lifecycle through metadata', () => {
  const lifecycle = new TaskLifecycle({ journal: {} } as ConstructorParameters<typeof TaskLifecycle>[0]);
  for (const status of ['cancelled', 'interrupted', 'failed', 'succeeded', 'blocked'] as const) {
    const task = { status } as TaskRecord;
    assert.throws(() => lifecycle.transition(task, 'running'), /非法任务状态/);
    assert.throws(() => lifecycle.amend(task, { status: 'running' } as never), /transition/);
    assert.equal(task.status, status);
  }
  const task = { status: 'needs_review' } as TaskRecord;
  lifecycle.transition(task, 'succeeded');
  assert.equal(task.status, 'succeeded');
});

test('shared JSON storage rejects corruption and oversized replacement without losing the original', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'emergence-storage-boundary-'));
  try {
    const path = join(dir, 'state.json');
    await writeFile(path, '{broken');
    await assert.rejects(readJsonFile(path, 100, 'invalid'));
    assert.equal(await readFile(path, 'utf8'), '{broken');
    await replaceJsonFile(path, { version: 1 }, { invalidMessage: 'invalid', maxBytes: 100 });
    const original = await readFile(path, 'utf8');
    await assert.rejects(
      replaceJsonFile(path, { data: 'x'.repeat(100) }, { invalidMessage: 'budget', maxBytes: 20 }),
      /budget/,
    );
    assert.equal(await readFile(path, 'utf8'), original);
    assert.deepEqual(await readdir(dir), ['state.json']);
    await assert.rejects(readJsonFile(path, 1, 'oversized'), /oversized/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
