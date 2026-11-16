import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { completionArtifacts } from '../src/core/application/completion-evidence.ts';
import { taskSchema } from '../src/core/domain/task.ts';
import { canonicalPermissionPath } from '../src/core/adapters/permissions.ts';

function task(id: string, hash: string, dependsOn: string[] = []) {
  return taskSchema.parse({
    id,
    requestKey: id,
    objective: id,
    issuer: 'master',
    issuerSession: 'master-session',
    target: id,
    targetSession: id,
    cwd: process.cwd(),
    modelId: 'fixture',
    dependsOn,
    status: 'succeeded',
    progress: '',
    createdAt: '2026-11-12',
    updatedAt: '2026-11-12',
    artifactVersions: [{ path: resolve('shared.txt'), hash }],
  });
}

test('final artifact ownership follows dependencies, not completion timestamps or array order', () => {
  const first = task('first', 'old');
  const second = task('second', 'new', ['first']);
  const path = canonicalPermissionPath(resolve('shared.txt'), process.cwd());
  const result = completionArtifacts([second, first], [first, second]);
  assert.equal(result.final.get(path), 'new');
  assert.equal(result.superseded.get('first')?.get(path), 'old');
  const sharedObservation = task('research', 'old');
  assert.equal(
    completionArtifacts([first, sharedObservation], [first, sharedObservation]).final.get(path),
    'old',
  );
  assert.throws(() => completionArtifacts([first, task('unrelated', 'new')], [first]), /无依赖关系/);
});

test('artifact lineage survives repair and refuses dependency cycles', () => {
  const first = task('first', 'bad');
  const repaired = { ...task('repair', 'fixed'), repairOf: first.id };
  const second = task('second', 'final', [first.id]);
  const result = completionArtifacts([repaired, second], [first, repaired, second]);
  assert.equal([...result.final.values()][0], 'final');
  assert.equal([...result.superseded.get(repaired.id)!.values()][0], 'fixed');
  const cyclicFirst = task('first', 'a', ['second']);
  assert.throws(() => completionArtifacts([cyclicFirst, second], [cyclicFirst, second]), /无依赖关系/);
});
