import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { TaskRecord } from '../domain/task.ts';
import type { TaskFailure } from '../domain/task-failure.ts';
import { toolContract } from '../domain/tool-contract.ts';
import { safeError } from '../adapters/redaction.ts';
import { evidenceIsCurrent } from './tool-evidence.ts';

function readReplacements(task: TaskRecord, failure: TaskFailure) {
  const receipt = task.receipts.find((r) => r.id === failure.callId);
  const manifest = receipt?.manifest;
  if (
    !receipt ||
    !manifest ||
    manifest.status !== 'failed' ||
    !failure.tool ||
    receipt.tool !== failure.tool ||
    manifest.taskId !== task.id ||
    manifest.runId !== task.runId
  )
    return [];
  const contract = toolContract(failure.tool);
  if (contract.authority !== 'host' || contract.operation !== 'read' || contract.sideEffect) return [];
  return task.receipts
    .slice(task.receipts.indexOf(receipt) + 1)
    .filter(
      (r) =>
        r.tool === receipt.tool &&
        (r.argumentsHash === receipt.argumentsHash || receipt.failure === 'invalid-arguments') &&
        r.manifest?.taskId === task.id &&
        r.manifest.runId === task.runId &&
        r.manifest.sessionId === manifest.sessionId &&
        Date.parse(r.manifest.startedAt) >= Date.parse(manifest.endedAt),
    )
    .slice(0, 2);
}

/** Reconcile actual observations once at turn settlement, never by matching error text. */
export async function taskFailures(
  task: TaskRecord,
  events: readonly SessionEvent[],
  repairedChecks: ReadonlyMap<string, string>,
): Promise<TaskFailure[]> {
  const calls = new Map(
    events.flatMap((e) => (e.type === 'tool/call' ? [[e.data.callId, e.data.name] as const] : [])),
  );
  const failures: TaskFailure[] = events.flatMap((e) =>
    e.type === 'tool/result' && e.data.message.isError
      ? [
          {
            callId: e.data.message.toolCallId,
            tool: calls.get(e.data.message.toolCallId),
            detail: safeError(
              e.data.message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n'),
            ).slice(0, 1000),
          },
        ]
      : [],
  );
  for (const issue of task.executionIssues)
    if (!failures.some((f) => f.callId === issue.callId)) failures.push({ ...issue });
  for (const failure of failures) {
    const repaired = failure.callId && repairedChecks.get(failure.callId);
    if (repaired) {
      failure.resolution = { kind: 'code-repair', by: repaired };
      continue;
    }
    const metadata =
      failure.tool === 'emergence_report'
        ? task.report?.outcome === 'success'
        : failure.tool === 'emergence_assess' && !!task.assessment?.checks;
    if (metadata) {
      const index = events.findIndex(
        (e) => e.type === 'tool/result' && e.data.message.toolCallId === failure.callId,
      );
      const corrected = events
        .slice(index + 1)
        .find(
          (e) =>
            e.type === 'tool/result' &&
            !e.data.message.isError &&
            calls.get(e.data.message.toolCallId) === failure.tool,
        );
      if (corrected?.type === 'tool/result')
        failure.resolution = { kind: 'submission', by: corrected.data.message.toolCallId };
      continue;
    }
    // Same query, or native input rejection followed by corrected arguments, within two attempts.
    // Commands and unknown tools never acquire read-recovery semantics.
    const replacement = readReplacements(task, failure).find(
      (r) => r.ok && r.manifest!.status === 'succeeded',
    );
    if (replacement && (await evidenceIsCurrent(replacement)))
      failure.resolution = { kind: 'read-retry', by: replacement.id };
  }
  if (failures.length > 128)
    return [...failures.slice(0, 127), { detail: '失败观察超过记录上限，需要拆分任务核对' }];
  return failures;
}

/** Recheck replacement evidence at acceptance, including after restoration from the journal. */
export async function resolvedEvidenceCurrent(task: TaskRecord): Promise<boolean> {
  for (const failure of task.result?.failures ?? []) {
    if (!failure.resolution || failure.resolution.kind === 'submission') continue;
    const receipt = task.receipts.find((r) => r.id === failure.resolution!.by);
    if (
      !receipt?.ok ||
      receipt.manifest?.taskId !== task.id ||
      receipt.manifest.runId !== task.runId ||
      !(await evidenceIsCurrent(receipt))
    )
      return false;
    if (failure.resolution.kind === 'read-retry' && !readReplacements(task, failure).includes(receipt))
      return false;
    if (failure.resolution.kind === 'code-repair') {
      const code = task.result?.code;
      const earlier = code?.checks.find((check) => check.callId === failure.callId);
      const corrected = code?.checks.find((check) => check.callId === receipt.id);
      if (
        !code?.verified ||
        code.criteriaChanged ||
        !earlier ||
        !corrected ||
        earlier.status !== 'failed' ||
        corrected.status !== 'succeeded' ||
        corrected.exitCode !== 0 ||
        earlier.command !== corrected.command ||
        earlier.version === corrected.version
      )
        return false;
    }
  }
  return true;
}
