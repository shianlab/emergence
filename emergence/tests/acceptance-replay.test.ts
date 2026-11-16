import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  bytesHash,
  evaluateAcceptance,
  evidencePath,
  type AcceptanceSnapshot,
} from './fixtures/acceptance-oracle.ts';
import { diagnoseAcceptance, terminalRunFailure } from './fixtures/acceptance-diagnostics.ts';
import { approvalEvents } from './fixtures/approval-events.ts';
import { completeNativeEvents, indexNativeEvidence } from './fixtures/native-evidence.ts';
import { observeUntil } from './fixtures/observation.ts';
import { digest, stableDigest } from '../src/core/storage/execution-journal.ts';
import type { RunDiagnostic } from '../src/core/domain/run-diagnostics.ts';

async function fixture(id = 'deepseek-cross-2'): Promise<AcceptanceSnapshot> {
  return JSON.parse(
    await readFile(new URL(`./fixtures/acceptance-replay/${id}.json`, import.meta.url), 'utf8'),
  ).snapshot;
}
const targetCall = 'call_1ece0e0298e64453b381b193';
function candidate(s: AcceptanceSnapshot) {
  const task = s.tasks.find((t) => t.receipts.some((r) => r.id === targetCall))!;
  const receipt = task.receipts.find((r) => r.id === targetCall)!;
  const journal = s.journals.find((j) => j.session === task.targetSession)!;
  const event = journal.events.find(
    (e) => e.type === 'tool/call' && (e.data as { callId: string }).callId === targetCall,
  )!;
  const call = event.data as { callId: string; name: string; arguments: string };
  const result = journal.events.find(
    (e) =>
      e.type === 'tool/result' &&
      (e.data as { message: { toolCallId: string } }).message.toolCallId === targetCall,
  )!;
  return { task, receipt, journal, event, call, result };
}

test('R1 real cross-project trace: effective cwd evidence succeeds where the old task-cwd oracle failed', async () => {
  const s = await fixture(),
    native = indexNativeEvidence(s.journals);
  const old = s.projects.every((p) =>
    s.tasks.some(
      (t) =>
        evidencePath(t.cwd) === evidencePath(p.cwd) &&
        t.assessment?.kind === 'verify' &&
        t.status === 'succeeded' &&
        t.receipts.some((r) => {
          const call = native.get(t.targetSession)?.calls.get(r.id);
          return (
            r.kind === 'command' &&
            r.exitCode === 0 &&
            call &&
            JSON.parse(call.arguments).command === s.verification
          );
        }),
    ),
  );
  assert.equal(old, false);
  const result = evaluateAcceptance(s);
  assert.equal(result.passed, true, JSON.stringify(result.findings));
  assert.equal(new Set(result.accepted.map((a) => a.project)).size, 2);
  const cross = result.accepted.find((a) => a.call === targetCall)!;
  assert.notEqual(evidencePath(s.tasks.find((t) => t.id === cross.task)!.cwd), evidencePath(cross.project));
  assert.equal(result.findings.filter((f) => f.code === 'global-criteria-in-local-task').length, 2);
});

test('R2 replay validates a host-bound receipt without redundant reads and rejects invalid bindings', async () => {
  // Adapt one receipt in memory, not the whole legacy cross-directory audit. The R1 fixture stays unchanged.
  async function boundSnapshot() {
    const snapshot = await fixture();
    const c = candidate(snapshot);
    const cwd = evidencePath(JSON.parse(c.call.arguments).workdir);
    const project = snapshot.projects.find((p) => evidencePath(p.cwd) === cwd)!;
    const projectId = digest(['emergence-project-v1', cwd]);
    const spec = {
      id: 'fixture-check',
      tool: 'pwsh' as const,
      command: snapshot.verification,
      cwd,
      criteria: [0],
      inputs: [evidencePath('notes.txt', cwd)],
      configuration: [evidencePath('verify.cjs', cwd)],
      projectId,
      baseline: [{ path: evidencePath('verify.cjs', cwd), hash: snapshot.scriptHash }],
    };
    c.task.contract!.binding = {
      version: 1,
      project: { version: 1, id: projectId, root: cwd },
      readProjects: [],
      scope: [cwd],
      criterionIds: ['a1'],
      verifications: [spec],
    };
    c.receipt.verification = { id: spec.id, projectId, cwd, specHash: stableDigest(spec) };
    c.receipt.manifest!.inputs = project.files.map((f) => ({
      path: evidencePath(f.name, cwd),
      hash: f.hash,
      state: 'present',
    }));
    return { snapshot, ...c };
  }
  const valid = await boundSnapshot();
  const removed = new Set(valid.task.receipts.filter((r) => r.kind === 'read').map((r) => r.id));
  valid.task.receipts.splice(
    0,
    valid.task.receipts.length,
    ...valid.task.receipts.filter((r) => !removed.has(r.id)),
  );
  for (const check of valid.task.assessment!.checks!)
    check.receipts = check.receipts.filter((id) => !removed.has(id));
  const accepted = evaluateAcceptance(valid.snapshot);
  assert.ok(
    accepted.accepted.some((r) => r.call === targetCall),
    JSON.stringify(accepted.findings),
  );
  for (const change of ['hash', 'project', 'input', 'baseline'] as const) {
    const bad = await boundSnapshot();
    if (change === 'hash') bad.receipt.verification!.specHash = '0'.repeat(64);
    if (change === 'project') bad.receipt.verification!.projectId = '0'.repeat(64);
    if (change === 'input') bad.receipt.manifest!.inputs = [];
    if (change === 'baseline') bad.task.contract!.binding!.verifications[0].baseline[0].hash = '0'.repeat(64);
    const result = evaluateAcceptance(bad.snapshot);
    assert.equal(result.passed, false, change);
    assert.ok(!result.accepted.some((r) => r.call === targetCall), change);
    assert.ok(
      result.findings.some((f) => f.call === targetCall && f.code === 'missing-version-observation'),
      change,
    );
  }
});

const invalid: Array<[string, string, (s: AcceptanceSnapshot) => void]> = [
  [
    'tampered verification script',
    'fixture-artifact-mismatch',
    (s) => {
      s.projects[0].files.find((f) => f.name === 'verify.cjs')!.hash = bytesHash('process.exit(0)');
    },
  ],
  [
    'stale output bytes',
    'fixture-artifact-mismatch',
    (s) => {
      s.projects[0].files.find((f) => f.name === 'notes.txt')!.hash = bytesHash('Welcome\n');
    },
  ],
  [
    'old audit version',
    'stale-subject-version',
    (s) => {
      candidate(s).task.assessment!.version = '0'.repeat(64);
    },
  ],
  [
    'old run receipt',
    'receipt-ownership',
    (s) => {
      candidate(s).receipt.manifest!.runId = 'previous-run';
    },
  ],
  [
    'other task receipt',
    'receipt-ownership',
    (s) => {
      candidate(s).receipt.manifest!.taskId = s.tasks[0].id;
    },
  ],
  [
    'other session receipt',
    'receipt-ownership',
    (s) => {
      candidate(s).receipt.manifest!.sessionId = 'other-session';
    },
  ],
  [
    'forged result hash',
    'receipt-integrity',
    (s) => {
      const r = candidate(s).receipt;
      r.hash = r.manifest!.resultHash = '1'.repeat(64);
    },
  ],
  [
    'missing execution ledger',
    'receipt-ownership',
    (s) => {
      s.effects = s.effects.filter((e) => e.call !== targetCall);
    },
  ],
  [
    'nonzero exit',
    'verification-command-invalid',
    (s) => {
      candidate(s).receipt.exitCode = 7;
    },
  ],
  [
    'failed native result',
    'native-result-invalid',
    (s) => {
      (candidate(s).result.data as { message: { isError: boolean } }).message.isError = true;
    },
  ],
  [
    'receipt outside run event range',
    'native-result-invalid',
    (s) => {
      candidate(s).task.result!.toSeq = 1;
    },
  ],
  [
    'stale input read',
    'stale-input-version',
    (s) => {
      const t = candidate(s).task,
        path = evidencePath('notes.txt', s.projects[0].cwd);
      t.receipts.find((r) => r.path && evidencePath(r.path) === path)!.fileHash = '2'.repeat(64);
    },
  ],
  [
    'uncited command',
    'verification-command-invalid',
    (s) => {
      for (const c of candidate(s).task.assessment!.checks!)
        c.receipts = c.receipts.filter((id) => id !== targetCall);
    },
  ],
  [
    'requested cwd disagrees with real returned cwd',
    'execution-project-mismatch',
    (s) => {
      const c = candidate(s),
        args = JSON.parse(c.call.arguments);
      args.workdir = 'M:\\nonexistent-project';
      c.call.arguments = JSON.stringify(args);
      c.receipt.argumentsHash = c.receipt.manifest!.argumentsHash = digest(args);
      s.effects.find((e) => e.call === targetCall)!.argumentsHash = digest(args);
    },
  ],
  [
    'successful call from another session',
    'missing-project-verification',
    (s) => {
      const c = candidate(s);
      c.journal.events = c.journal.events.filter((e) => e !== c.event && e !== c.result);
      s.journals.push({ session: 'unrelated-session', events: [c.event, c.result] });
    },
  ],
];
for (const [name, code, mutate] of invalid)
  test(`R1 rejects ${name}`, async () => {
    const s = await fixture();
    mutate(s);
    const result = evaluateAcceptance(s);
    assert.equal(result.passed, false);
    assert.ok(
      result.findings.some((f) => f.code === code),
      JSON.stringify(result.findings),
    );
  });

test('R1 real parallel approvals remain bound to their sessions; deciding one does not consume the other', async () => {
  const s = await fixture('glm-coding-cross-2');
  const pending = diagnoseAcceptance(s).filter((f) => f.code === 'approval-pending');
  assert.equal(pending.length, 2);
  assert.equal(new Set(pending.map((p) => p.session)).size, 2);
  const owner = s.journals.find((j) => j.session === pending[0].session)!;
  owner.events.push({
    type: 'approval/decided',
    seq: owner.events.at(-1)!.seq + 1,
    time: Date.now(),
    data: { id: pending[0].approval, outcome: 'rejected' },
  });
  const remaining = diagnoseAcceptance(s).filter((f) => f.code === 'approval-pending');
  assert.deepEqual(
    remaining.map((f) => f.approval),
    [pending[1].approval],
  );
  assert.equal(
    approvalEvents(owner.events.map((e) => JSON.stringify(e)).join('\n') + '\n').decisions.get(
      pending[0].approval!,
    ),
    'rejected',
  );
});

test('R1 real wrong project literal stays visible separately from pending approval', async () => {
  const result = evaluateAcceptance(await fixture('glm-coding-cross-2'));
  assert.equal(result.passed, false);
  const finding = result.findings.find((f) => f.code === 'unregistered-fixture-path')!;
  assert.ok(finding.detail.startsWith('M:\\'));
  assert.equal(finding.call, 'call_00_6iLVJx3ui13tyki4ljtN5807');
  assert.equal(result.findings.filter((f) => f.stage === 'approval').length, 2);
});

test('R1 real recovered checks do not silently erase unresolved tool errors or declare aggregation complete', async () => {
  const s = await fixture('deepseek-cross-1'),
    result = evaluateAcceptance(s);
  const issue = result.findings.find((f) => f.code === 'unresolved-tool-errors')!;
  const task = s.tasks.find((t) => t.id === issue.task)!;
  assert.ok(task.receipts.some((r) => r.kind === 'command' && r.exitCode === 0));
  assert.ok(task.result!.errors.length > 0);
  assert.equal(result.passed, false);
  assert.ok(result.findings.some((f) => f.code === 'coordination-blocked'));
});

test('R1 real model stream failure ends observation before its deadline even without coordination/tasks', async () => {
  const s = await fixture('glm-coding-same-2');
  s.records = [];
  s.tasks = [];
  let polls = 0;
  await assert.rejects(
    observeUntil(
      'model stream',
      async () => {
        polls++;
        const failure = terminalRunFailure(s.runs, s.since, s.sessions);
        if (failure) throw new Error(failure.code);
        return false;
      },
      { limitMs: 3000, snapshot: async () => s, stop: async () => {} },
    ),
    /model-transport-error/,
  );
  assert.equal(polls, 1);
  const run = s.runs[0];
  assert.equal(terminalRunFailure(s.runs, run.startedAt + 1, s.sessions), undefined);
  assert.equal(terminalRunFailure(s.runs, s.since, ['unrelated']), undefined);
  assert.equal(
    terminalRunFailure(
      [
        ...s.runs,
        { ...run, id: 'retry', startedAt: run.startedAt + 1, outcome: 'running', endedAt: undefined },
      ],
      s.since,
      s.sessions,
    ),
    undefined,
  );
});

test('a pre-dispatch coordination stop is classified at its actual planning or admission boundary', async () => {
  const s = await fixture('deepseek-cross-1');
  const goal = s.records.at(-1)!;
  s.records = [goal];
  s.tasks = [];
  s.journals = [];
  goal.phase = 'blocked';
  goal.blockReason = '主控规划：实际执行时长预算已耗尽';
  goal.executions = [];
  goal.planId = undefined;
  const finding = () => diagnoseAcceptance(s).find((f) => f.code === 'coordination-blocked')!;
  assert.equal(finding().stage, 'planning');
  assert.equal(finding().project, goal.project);
  assert.equal(finding().session, goal.session);
  goal.planId = 'admitted-plan';
  assert.equal(finding().stage, 'dispatch');
  goal.executions = ['delivery'];
  assert.equal(finding().stage, 'aggregation');
});

test('native evidence rejects corrupt or ambiguous completed events and ignores only the unfinished tail', () => {
  const event = { type: 'tool/call', seq: 1, time: 1, data: { callId: 'x', name: 'pwsh', arguments: '{}' } };
  const line = JSON.stringify(event) + '\n';
  assert.equal(completeNativeEvents(line + '{').length, 1);
  assert.throws(() => completeNativeEvents(line + '{bad}\n'));
  assert.throws(() => completeNativeEvents(line + line));
  assert.throws(() => indexNativeEvidence([{ session: 'one', events: [event, { ...event, seq: 2 }] }]));
  assert.throws(() =>
    indexNativeEvidence([
      { session: 'one', events: [] },
      { session: 'one', events: [] },
    ]),
  );
});

test('R1 recorded upstream HTTP 500 is classified as transport, not a dispatch failure', async () => {
  const data: { runs: RunDiagnostic[] } = JSON.parse(
    await readFile(new URL('./fixtures/acceptance-replay/upstream-error.json', import.meta.url), 'utf8'),
  );
  const failure = terminalRunFailure(
    data.runs,
    0,
    data.runs.map((r) => r.session),
  );
  assert.equal(failure?.stage, 'transport');
  assert.equal(failure?.code, 'model-transport-error');
});
