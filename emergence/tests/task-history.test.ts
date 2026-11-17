import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { captureToolEvidence } from '../src/core/application/tool-evidence.ts';
import { contractSchema, roleSchema } from '../src/core/domain/orchestration.ts';
import { taskSchema, type TaskRecord } from '../src/core/domain/task.ts';
import { historicalObjective, storedTaskStateSchema } from '../src/core/storage/task-history.ts';
import { executionFixture } from './fixtures/core-execution.ts';

function record(id: string, fields: Partial<TaskRecord> = {}): TaskRecord {
  return taskSchema.parse({
    id,
    requestKey: id,
    objective: '核对已有产物',
    issuer: 'old-master',
    issuerSession: 'old-master-session',
    target: id,
    targetSession: id + '-session',
    cwd: '.',
    modelId: 'old-model',
    dependsOn: [],
    status: 'succeeded',
    progress: '历史记录',
    createdAt: '2026-11-16T00:00:00Z',
    updatedAt: '2026-11-16T00:00:01Z',
    endedAt: '2026-11-16T00:00:01Z',
    runId: id + '-run',
    report: { outcome: 'success', summary: '已读取真实文件', artifacts: [] },
    result: { summary: '已读取真实文件', errors: [], artifacts: [], fromSeq: 1, toSeq: 2 },
    ...fields,
  });
}
function legacy(tasks: TaskRecord[]) {
  return {
    version: 1,
    mode: 'collaborate',
    paused: true,
    master: 'old-master',
    workers: ['old-worker'],
    owned: [],
    autoWorkers: true,
    tasks,
    coordinations: [
      {
        id: 'a'.repeat(64),
        master: 'old-master',
        session: 'old-master-session',
        project: '.',
        requestIds: ['original-message'],
        request: '保留的总目标',
        createdAt: '2026-11-16',
        updatedAt: '2026-11-16',
        phase: 'completed',
        teamAtIntake: [],
        executions: [tasks[0]?.id].filter(Boolean),
      },
    ],
  };
}

test('legacy task metadata migrates to a read-only envelope and survives current checkpoints', () => {
  const original = record('original'),
    repair = record('repair', { repairOf: original.id });
  const saved = legacy([original, repair]),
    state = storedTaskStateSchema.parse(saved);
  assert.equal(state.version, 2);
  assert.equal('master' in state, false);
  assert.equal('mode' in state, false);
  assert.equal(state.history?.master, saved.master);
  assert.deepEqual(state.tasks, saved.tasks);
  assert.equal(historicalObjective(state, repair), '保留的总目标');
  assert.deepEqual(
    storedTaskStateSchema.parse(JSON.parse(JSON.stringify(state))),
    JSON.parse(JSON.stringify(state)),
  );
});

test('old and current task envelopes share graph validation without throwing from safeParse', () => {
  for (const tasks of [
    [record('a'), record('a')],
    [record('a', { dependsOn: ['missing'] })],
    [record('a', { dependsOn: ['b'] }), record('b', { repairOf: 'a' })],
    [record('a', { assessment: { subject: 'missing', kind: 'review', version: 'v' } })],
  ]) {
    for (const input of [legacy(tasks), { version: 2, paused: false, tasks }])
      assert.equal(storedTaskStateSchema.safeParse(input).success, false);
  }
  const duplicate = legacy([record('a')]);
  duplicate.coordinations.push(duplicate.coordinations[0]);
  assert.equal(storedTaskStateSchema.safeParse(duplicate).success, false);
  assert.equal(storedTaskStateSchema.safeParse({ version: 3, paused: false, tasks: [] }).success, false);
});

test('restored cross-window and assessment tasks cannot start or retry through current engine entry points', async () => {
  const f = await executionFixture();
  try {
    const pane = f.w.current,
      subject = record('subject', { cwd: f.cwd });
    const old = record('old', {
      cwd: f.cwd,
      issuer: pane.id,
      issuerSession: pane.controller!.id,
      status: 'queued',
    });
    const audit = record('audit', {
      cwd: f.cwd,
      issuer: pane.id,
      target: pane.id,
      issuerSession: pane.controller!.id,
      targetSession: pane.controller!.id,
      status: 'queued',
      assessment: { subject: subject.id, kind: 'review', version: 'v' },
    });
    f.w.taskEngine.load(storedTaskStateSchema.parse(legacy([subject, old, audit])));
    for (const id of [old.id, audit.id]) {
      const task = f.w.taskEngine.task(id);
      assert.equal(task.status, 'interrupted');
      await assert.rejects(f.w.taskEngine.execution.start(task), /历史跨窗口/);
      await assert.rejects(
        f.w.taskEngine.recovery.recover(id, pane.id, '已经检查历史副作用，申请再次执行', true),
        /历史跨窗口/,
      );
    }
    assert.equal(f.writes(), 0);
    assert.equal(pane.controller!.pending, undefined);
    assert.equal(f.w.panes.size, 1);
    assert.ok(!f.ctx.tools.definitions(pane.controller!.agent).some((t) => t.name === 'emergence_assess'));
  } finally {
    await f.close();
  }
});

test('historical assurance requires real provenance and current inputs; it cannot be replaced by claimed success', async () => {
  const f = await executionFixture();
  try {
    const path = join(f.cwd, 'evidence.txt');
    await writeFile(path, '原始证据');
    const subject = record('subject', {
      cwd: f.cwd,
      role: roleSchema.parse({
        id: 'researcher',
        description: '研究',
        prompt: '读取并核对来源',
        mode: 'plan',
      }),
      contract: contractSchema.parse({
        role: 'researcher',
        scope: ['evidence.txt'],
        acceptance: ['实际读取文件'],
      }),
    });
    f.w.taskEngine.load(storedTaskStateSchema.parse(legacy([subject])));
    const version = await f.w.taskEngine.assurance.version(subject);
    const audits: TaskRecord[] = [];
    for (const kind of ['review', 'verify'] as const) {
      const task = record(kind, { cwd: f.cwd, assessment: { subject: subject.id, kind, version } });
      await captureToolEvidence(
        {
          callId: kind + '-receipt',
          name: 'read',
          arguments: { file_path: path },
          cwd: f.cwd,
          taskId: task.id,
          runId: task.runId,
          sessionId: task.targetSession,
          signal: new AbortController().signal,
        },
        async () => ({ value: await readFile(path, 'utf8') }),
        async (receipt) => {
          f.w.taskEngine.lifecycle.recordReceipt(task, receipt);
        },
      );
      f.w.taskEngine.lifecycle.amend(task, {
        assessment: {
          ...task.assessment!,
          checks: [{ criterion: 0, passed: true, receipts: [task.receipts[0].id], note: '引用实际读取回执' }],
        },
      });
      audits.push(task);
    }
    const pristine = legacy([subject, ...audits]);
    f.w.taskEngine.load(storedTaskStateSchema.parse(pristine));
    const proof = await f.w.taskEngine.assurance.status(subject.id);
    assert.equal(proof.review, true);
    assert.equal(proof.verification, true);
    assert.ok(await f.w.taskEngine.assurance.proof(subject.id, f.w.focused));
    const corruptions: Array<(task: TaskRecord) => void> = [
      (task) => {
        task.receipts[0].manifest!.runId = 'foreign-run';
      },
      (task) => {
        task.receipts[0].manifest!.sessionId = subject.targetSession;
      },
      (task) => {
        task.receipts[0].manifest!.taskId = 'foreign-task';
      },
      (task) => {
        delete task.receipts[0].manifest;
      },
      (task) => {
        task.assessment!.checks![0].receipts = ['invented'];
      },
      (task) => {
        task.assessment!.checks![0].passed = false;
      },
      (task) => {
        task.receipts[0].ok = false;
      },
      (task) => {
        task.result!.errors.push('真实检查失败');
      },
    ];
    for (const corrupt of corruptions) {
      const state = storedTaskStateSchema.parse(structuredClone(pristine));
      corrupt(state.tasks[1]);
      f.w.taskEngine.load(state);
      assert.equal((await f.w.taskEngine.assurance.status(subject.id)).review, false);
      await assert.rejects(f.w.taskEngine.assurance.proof(subject.id, f.w.focused), /缺少/);
    }
    f.w.taskEngine.load(storedTaskStateSchema.parse(pristine));
    await writeFile(path, '证据已改变');
    const stale = await f.w.taskEngine.assurance.status(subject.id);
    assert.equal(stale.review, false);
    assert.equal(stale.verification, false);
    assert.equal(f.writes(), 0);
  } finally {
    await f.close();
  }
});
