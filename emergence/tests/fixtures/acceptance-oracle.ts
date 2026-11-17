import { createHash } from 'node:crypto';
import { posix, win32 } from 'node:path';
import { subjectEvidenceVersion } from '../../src/core/application/assurance.ts';
import type { EvidenceReceipt } from '../../src/core/domain/assurance.ts';
import type { TaskRecord } from '../../src/core/domain/task.ts';
import type { CoordinationRecord } from '../../src/core/domain/legacy-coordination.ts';
import type { RunDiagnostic } from '../../src/core/domain/run-diagnostics.ts';
import { toolPath } from '../../src/core/domain/tool-contract.ts';
import { unresolvedTaskErrors } from '../../src/core/domain/task-failure.ts';
import { digest, stableDigest, type ExecutionEffect } from '../../src/core/storage/execution-journal.ts';
import { indexNativeEvidence, type NativeJournal } from './native-evidence.ts';
import { diagnoseAcceptance } from './acceptance-diagnostics.ts';

export const bytesHash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
export const fixtureScript =
  "const fs=require('fs');if(fs.readFileSync('notes.txt','utf8')!=='欢迎使用涌现\\n')process.exit(7);console.log('content and newline verified');\n";
const paths = (path: string) => (/^[a-z]:[\\/]|^\\\\/i.test(path) ? win32 : posix);
export const evidencePath = (path: string, cwd = path) => {
  const p = paths(cwd),
    resolved = p.resolve(cwd, path);
  return p === win32 ? resolved.toLowerCase() : resolved;
};
export interface FixtureProject {
  cwd: string;
  files: Array<{ name: string; hash: string }>;
}
export interface AcceptanceSnapshot {
  version: 1;
  tasks: TaskRecord[];
  records: CoordinationRecord[];
  journals: NativeJournal[];
  effects: ExecutionEffect[];
  projects: FixtureProject[];
  verification: string;
  scriptHash: string;
  runs: RunDiagnostic[];
  since: number;
  sessions: string[];
}

/** Fixture-specific oracle. It does not execute commands, grant permission, or trust model summaries. */
export function evaluateAcceptance(snapshot: AcceptanceSnapshot) {
  const findings = diagnoseAcceptance(snapshot);
  const native = indexNativeEvidence(snapshot.journals);
  const fileHashes = new Map(
    snapshot.projects.flatMap((p) => p.files.map((f) => [evidencePath(f.name, p.cwd), f.hash] as const)),
  );
  // Only diagnose quoted fixture-file literals; this is not a shell parser or an approval policy.
  for (const [session, journal] of native)
    for (const [callId, call] of journal.calls) {
      if (call.name !== 'pwsh') continue;
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(call.arguments);
      } catch {
        continue;
      }
      if (typeof args.command !== 'string') continue;
      for (const match of args.command.matchAll(
        /['"]([a-z]:[\\/][^'"\r\n]*(?:verify\.cjs|notes\.txt))['"]/gi,
      )) {
        if (!fileHashes.has(evidencePath(match[1])))
          findings.push({
            stage: 'verification',
            code: 'unregistered-fixture-path',
            severity: 'error',
            detail: match[1],
            session,
            call: callId,
          });
      }
    }
  const validated = new Map<string, { args: Record<string, unknown>; end: number; cwd?: string }>();
  const reject = (code: string, detail: string, task?: TaskRecord, receipt?: EvidenceReceipt) => {
    findings.push({
      stage: 'verification',
      code,
      severity: 'error',
      detail,
      task: task?.id,
      run: task?.runId,
      call: receipt?.id,
    });
  };

  function validate(task: TaskRecord, receipt: EvidenceReceipt) {
    const key = task.id + ':' + receipt.id;
    if (validated.has(key)) return validated.get(key);
    const m = receipt.manifest,
      journal = native.get(task.targetSession);
    const call = journal?.calls.get(receipt.id),
      result = journal?.results.get(receipt.id);
    const effects = snapshot.effects.filter(
      (e) =>
        e.task === task.id && e.run === task.runId && e.actor === task.targetSession && e.call === receipt.id,
    );
    const effect = effects.length === 1 ? effects[0] : undefined;
    let args: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(call?.arguments ?? 'null');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      args = parsed as Record<string, unknown>;
    } catch {
      reject('missing-native-call', 'Missing or malformed native arguments', task, receipt);
      return;
    }
    if (
      !m ||
      !task.runId ||
      m.taskId !== task.id ||
      m.runId !== task.runId ||
      m.sessionId !== task.targetSession ||
      m.callId !== receipt.id ||
      m.tool !== receipt.tool ||
      call?.name !== receipt.tool ||
      m.contract.authority !== 'host' ||
      (receipt.kind === 'command' && (!effect || effect.tool !== receipt.tool || effect.state !== 'returned'))
    ) {
      reject('receipt-ownership', 'Task/run/session/call/host execution identity mismatch', task, receipt);
      return;
    }
    if (
      !result ||
      result.isError ||
      !receipt.ok ||
      m.status !== 'succeeded' ||
      !task.result ||
      call.seq <= task.result.fromSeq ||
      result.seq > task.result.toSeq ||
      result.seq <= call.seq ||
      call.time > Date.parse(m.startedAt) ||
      result.time < Date.parse(m.endedAt)
    ) {
      reject(
        'native-result-invalid',
        'No successful native result within the task execution range',
        task,
        receipt,
      );
      return;
    }
    const hash = digest(args);
    if (
      receipt.argumentsHash !== hash ||
      m.argumentsHash !== hash ||
      (effect && effect.argumentsHash !== hash) ||
      receipt.hash !== m.resultHash ||
      (effect && effect.resultHash !== receipt.hash) ||
      m.checks.some((c) => !c.passed)
    ) {
      reject(
        'receipt-integrity',
        'Receipt hashes/checks disagree with native call or execution ledger',
        task,
        receipt,
      );
      return;
    }
    for (const version of [...m.inputs, ...m.outputs]) {
      if (version.state !== 'present' || fileHashes.get(evidencePath(version.path)) !== version.hash) {
        reject('stale-input-version', 'Captured file version is missing or has changed', task, receipt);
        return;
      }
    }
    if (receipt.path && fileHashes.get(evidencePath(receipt.path)) !== receipt.fileHash) {
      reject('stale-input-version', 'Read receipt is not the current file version', task, receipt);
      return;
    }
    const argumentPath = toolPath(args);
    if (
      receipt.path &&
      (argumentPath === undefined || evidencePath(argumentPath, task.cwd) !== evidencePath(receipt.path))
    ) {
      reject('read-project-mismatch', 'Read receipt path differs from its native arguments', task, receipt);
      return;
    }
    const value = { args, end: Date.parse(m.endedAt), cwd: result.cwd };
    validated.set(key, value);
    return value;
  }

  function currentSubject(subject: TaskRecord, audit: TaskRecord) {
    const files = [
      ...new Set([
        ...subject.artifactVersions.map((v) => v.path),
        ...(subject.result?.artifacts ?? []).map((p) => paths(subject.cwd).resolve(subject.cwd, p)),
      ]),
    ].map((path) => ({ path, hash: fileHashes.get(evidencePath(path)) ?? 'missing' }));
    if (
      !files.length ||
      files.some((f) => f.hash === 'missing') ||
      subject.artifactVersions.some((v) => fileHashes.get(evidencePath(v.path)) !== v.hash) ||
      audit.assessment?.version !== subjectEvidenceVersion(subject, files)
    ) {
      reject('stale-subject-version', 'Audit does not attest the current task/run/artifacts', audit);
      return false;
    }
    return true;
  }

  const audits = snapshot.tasks.filter(
    (t) =>
      t.assessment?.kind === 'verify' &&
      t.status === 'succeeded' &&
      t.report?.outcome === 'success' &&
      t.result &&
      !unresolvedTaskErrors(t).length,
  );
  const eligible = audits.filter((audit) => {
    const subject = snapshot.tasks.find((t) => t.id === audit.assessment!.subject);
    if (!subject || subject.status !== 'succeeded' || subject.targetSession === audit.targetSession) {
      reject('audit-independence', 'Audit has no successful independent subject', audit);
      return false;
    }
    return currentSubject(subject, audit);
  });
  const accepted: Array<{ project: string; task: string; run: string; session: string; call: string }> = [];
  for (const project of snapshot.projects) {
    if (
      project.files
        .map((f) => f.name)
        .sort()
        .join(',') !== 'notes.txt,verify.cjs' ||
      project.files.find((f) => f.name === 'notes.txt')?.hash !== bytesHash('欢迎使用涌现\n') ||
      project.files.find((f) => f.name === 'verify.cjs')?.hash !== snapshot.scriptHash ||
      snapshot.scriptHash !== bytesHash(fixtureScript)
    ) {
      reject('fixture-artifact-mismatch', project.cwd);
      continue;
    }
    const implementation = snapshot.tasks.find(
      (t) => !t.assessment && t.status === 'succeeded' && evidencePath(t.cwd) === evidencePath(project.cwd),
    );
    if (!implementation) {
      reject('missing-successful-implementation', project.cwd);
      continue;
    }
    if (
      !snapshot.tasks.some(
        (t) =>
          t.assessment?.kind === 'review' &&
          t.assessment.subject === implementation.id &&
          t.status === 'succeeded' &&
          t.report?.outcome === 'success' &&
          !unresolvedTaskErrors(t).length &&
          t.targetSession !== implementation.targetSession &&
          currentSubject(implementation, t),
      )
    ) {
      reject('missing-independent-review', project.cwd);
      continue;
    }
    let found = false;
    for (const audit of eligible) {
      if (audit.targetSession === implementation.targetSession) continue;
      for (const receipt of audit.receipts.filter((r) => r.kind === 'command')) {
        const call = native.get(audit.targetSession)?.calls.get(receipt.id);
        // Other inspected commands are not candidates; an approval is never evidence of execution.
        let command: unknown;
        try {
          command = JSON.parse(call?.arguments ?? '{}')?.command;
        } catch {
          reject('missing-native-call', 'Malformed native verification arguments', audit, receipt);
          continue;
        }
        if (!call || command !== snapshot.verification) continue;
        const value = validate(audit, receipt);
        if (!value) continue;
        const actual =
          typeof value.args.workdir === 'string'
            ? evidencePath(value.args.workdir, audit.cwd)
            : evidencePath(audit.cwd);
        if (
          !snapshot.projects.some((p) => evidencePath(p.cwd) === actual) ||
          !value.cwd ||
          evidencePath(value.cwd) !== actual
        ) {
          reject(
            'execution-project-mismatch',
            'Requested and returned cwd do not identify a fixture project',
            audit,
            receipt,
          );
          continue;
        }
        if (actual !== evidencePath(project.cwd)) continue;
        if (
          receipt.exitCode !== 0 ||
          receipt.manifest?.codeHash !== digest(snapshot.verification) ||
          !audit.assessment?.checks?.some((c) => c.passed && !c.blocked && c.receipts.includes(receipt.id))
        ) {
          reject(
            'verification-command-invalid',
            'Exact successful command is not cited by the audit',
            audit,
            receipt,
          );
          continue;
        }
        const spec = audit.contract?.binding?.verifications.find((s) => s.id === receipt.verification?.id);
        const boundInputs =
          !!spec &&
          receipt.verification?.specHash === stableDigest(spec) &&
          receipt.verification.projectId === audit.contract?.binding?.project.id &&
          spec.projectId === receipt.verification.projectId &&
          evidencePath(spec.cwd) === actual &&
          evidencePath(receipt.verification.cwd) === actual &&
          spec.command === snapshot.verification &&
          spec.tool === receipt.tool &&
          Date.parse(receipt.manifest!.startedAt) >= Date.parse(implementation.endedAt ?? '') &&
          spec.baseline.some(
            (v) =>
              evidencePath(v.path) === evidencePath('verify.cjs', project.cwd) &&
              v.hash === snapshot.scriptHash,
          ) &&
          ['notes.txt', 'verify.cjs'].every((name) =>
            receipt.manifest!.inputs.some(
              (v) =>
                evidencePath(v.path) === evidencePath(name, project.cwd) &&
                v.hash === fileHashes.get(evidencePath(v.path)) &&
                v.state === 'present',
            ),
          );
        const hasBinding = !!receipt.verification || !!audit.contract?.binding?.verifications.length;
        const filesObserved = hasBinding
          ? boundInputs
          : ['notes.txt', 'verify.cjs'].every((name) =>
              audit.receipts.some((r) => {
                if (r.kind !== 'read' || !r.path || evidencePath(r.path) !== evidencePath(name, project.cwd))
                  return false;
                const read = validate(audit, r);
                return (
                  !!read &&
                  read.end <= Date.parse(receipt.manifest!.startedAt) &&
                  read.end >= Date.parse(implementation.endedAt ?? '')
                );
              }),
            );
        if (!filesObserved || value.end < Date.parse(implementation.endedAt ?? '')) {
          reject(
            'missing-version-observation',
            'Command lacks current independent fixture input observations',
            audit,
            receipt,
          );
          continue;
        }
        accepted.push({
          project: project.cwd,
          task: audit.id,
          run: audit.runId!,
          session: audit.targetSession,
          call: receipt.id,
        });
        found = true;
      }
    }
    if (!found) reject('missing-project-verification', project.cwd);
  }
  if (snapshot.records.at(-1)?.phase !== 'completed')
    findings.push({
      stage: 'aggregation',
      code: 'coordination-not-completed',
      severity: 'error',
      detail: snapshot.records.at(-1)?.phase ?? 'No coordination record',
    });
  return {
    passed:
      snapshot.projects.length > 0 &&
      !findings.some((f) => f.severity === 'error' || f.severity === 'waiting'),
    accepted,
    findings,
  };
}
