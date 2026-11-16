import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { fixtureDecision, fixtureWorkdir, fixtureFileOperation } from './fixtures/live-approvals.ts';

test('fixture decisions require exact call and arguments; conflicting or unknown answers never approve', () => {
  const base = { callId: 'one', fingerprint: 'args-hash' };
  for (const decision of ['allow', 'deny', 'cancel'])
    assert.equal(fixtureDecision({ ...base, decision }, 'one', 'args-hash'), decision);
  assert.equal(fixtureDecision({ ...base, approved: true }, 'one', 'args-hash'), 'allow');
  for (const value of [
    undefined,
    {},
    { ...base, approved: false },
    { ...base, decision: 'yes' },
    { ...base, decision: 'allow', approved: false },
    { ...base, decision: 'allow', fingerprint: 'changed' },
    { ...base, decision: 'allow', callId: 'other' },
  ])
    assert.equal(fixtureDecision(value, 'one', 'args-hash'), undefined);
});

test('fixture file approval accepts the exact edit with or without its existing LF and rejects changed bytes or roots', () => {
  const owner = resolve('fixture/a'),
    projects = [owner];
  for (const lf of ['', '\n']) {
    const args = { file_path: 'notes.txt', old_string: 'Welcome' + lf, new_string: '欢迎使用涌现' + lf };
    assert.ok(fixtureFileOperation('edit', args, owner, projects));
    if (process.platform === 'win32')
      assert.ok(
        fixtureFileOperation(
          'edit',
          { ...args, file_path: resolve(owner, 'notes.txt').toUpperCase() },
          owner,
          projects,
        ),
      );
    for (const changes of [
      { file_path: '../b/notes.txt' },
      { file_path: 'verify.cjs' },
      { new_string: 'unexpected' },
      { new_string: '欢迎使用涌现\n\n' },
      { old_string: 'Welcome\r\n' },
    ])
      assert.ok(!fixtureFileOperation('edit', { ...args, ...changes }, owner, projects));
  }
  assert.ok(
    !fixtureFileOperation(
      'edit',
      { file_path: 'notes.txt', old_string: 'Welcome\n', new_string: '欢迎使用涌现' },
      owner,
      projects,
    ),
  );
  assert.ok(
    !fixtureFileOperation('write', { file_path: 'notes.txt', content: '欢迎使用涌现' }, owner, projects),
  );
  assert.ok(!fixtureFileOperation('read', { file_path: 'notes.txt' }, resolve('fixture/private'), projects));
});

test('cross-window verification is limited to provisioned fixture projects', () => {
  const projects = [resolve('fixture/a'), resolve('fixture/b')];
  assert.ok(fixtureWorkdir(projects[1], projects[0], projects));
  assert.ok(fixtureWorkdir(undefined, projects[0], projects));
  assert.ok(fixtureWorkdir('.', projects[0], projects));
  assert.ok(fixtureWorkdir('../b', projects[0], projects));
  if (process.platform === 'win32') {
    assert.ok(fixtureWorkdir(projects[1].toUpperCase(), projects[0], projects));
    assert.ok(fixtureWorkdir(projects[1].toLowerCase().replaceAll('\\', '/'), projects[0], projects));
  }
  assert.ok(!fixtureWorkdir('..', projects[0], projects));
  assert.ok(!fixtureWorkdir('../private', projects[0], projects));
  assert.ok(!fixtureWorkdir('../b/..', projects[0], projects));
  assert.ok(!fixtureWorkdir('../b/nested', projects[0], projects));
  assert.ok(!fixtureWorkdir('\0', projects[0], projects));
  assert.ok(!fixtureWorkdir({}, projects[0], projects));
});
