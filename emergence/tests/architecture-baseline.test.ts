import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { WorkspaceController } from '../src/app/workspace.ts';
import { executionFixture, until } from './fixtures/core-execution.ts';

test('restart takes task truth from SQLite while retaining layout drafts, without accepting a stale JSON success', async () => {
  const fixture = await executionFixture();
  let restored: WorkspaceController | undefined;
  try {
    const master = fixture.w.focused;
    const worker = await fixture.w.split('row');
    const task = await fixture.w.taskEngine.enqueue(
      worker.id,
      worker.id,
      'baseline-authority',
      'fixture:write',
      [],
      { role: 'developer', scope: ['result.txt'], acceptance: ['读取真实文件确认内容'] },
    );
    await until(() => task.status === 'needs_review');
    await fixture.w.close();
    const writes = fixture.writes();
    const saved = JSON.parse(await readFile(fixture.w.path, 'utf8'));
    const staleTask = saved.collaboration.tasks.find((entry: { id: string }) => entry.id === task.id);
    staleTask.status = 'succeeded';
    staleTask.review = {
      accepted: true,
      evidence: 'stale layout must not certify completion',
      at: new Date().toISOString(),
      actor: 'user',
    };
    saved.panes.find((pane: { id: string }) => pane.id === master).draft = '保留未提交草稿';
    await writeFile(fixture.w.path, JSON.stringify(saved));

    restored = new WorkspaceController(fixture.ctx, fixture.launch);
    await restored.initialize();
    const actual = restored.taskEngine.task(task.id);
    assert.equal(actual.status, 'needs_review');
    assert.notEqual(actual.review?.accepted, true);
    assert.deepEqual(actual.receipts, task.receipts);
    assert.equal(restored.panes.get(master)?.draft, '保留未提交草稿');
    assert.equal('master' in restored.taskEngine.state, false);
    assert.equal(restored.taskEngine.state.paused, false);
    assert.equal(fixture.writes(), writes);
  } finally {
    try {
      await restored?.close();
    } finally {
      await fixture.close();
    }
  }
});
