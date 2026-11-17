import type { RunDiagnostic } from '../../src/core/domain/run-diagnostics.ts';
import type { TaskRecord } from '../../src/core/domain/task.ts';
import type { CoordinationRecord } from '../../src/core/domain/legacy-coordination.ts';
import type { NativeJournal } from './native-evidence.ts';
import { approvalEvents } from './approval-events.ts';

export const acceptanceStages = [
  'planning',
  'dispatch',
  'execution',
  'approval',
  'verification',
  'aggregation',
  'transport',
] as const;
export type AcceptanceStage = (typeof acceptanceStages)[number];
export interface AcceptanceFinding {
  stage: AcceptanceStage;
  code: string;
  severity: 'error' | 'waiting' | 'warning';
  detail: string;
  task?: string;
  run?: string;
  session?: string;
  call?: string;
  approval?: string;
  project?: string;
}

/** Only the newest run per session after this goal started can stop its observer. */
export function terminalRunFailure(runs: RunDiagnostic[], since: number, sessions: string[]) {
  const latest = new Map<string, RunDiagnostic>();
  for (const run of runs) {
    if (run.startedAt < since || !sessions.includes(run.session)) continue;
    if ((latest.get(run.session)?.startedAt ?? -Infinity) < run.startedAt) latest.set(run.session, run);
  }
  const run = [...latest.values()].find(
    (r) => r.endedAt !== undefined && ['error', 'deadline', 'interrupted'].includes(r.outcome),
  );
  if (!run) return;
  const transport =
    run.outcome === 'error' &&
    /finish_reason|^5\d\d:|HTTP\s*5\d\d|status\s*(code\s*)?[:=]?\s*5\d\d|SERVER_ERROR|fetch failed|ECONNRESET/i.test(
      run.reason ?? '',
    );
  return {
    stage: transport ? 'transport' : run.task ? 'execution' : 'planning',
    code: transport ? 'model-transport-error' : 'terminal-run-' + run.outcome,
    severity: 'error',
    detail: run.reason ?? run.outcome,
    session: run.session,
    run: run.id,
    task: run.task,
  } satisfies AcceptanceFinding;
}

export function diagnoseAcceptance(input: {
  tasks: TaskRecord[];
  records: CoordinationRecord[];
  journals: NativeJournal[];
  runs: RunDiagnostic[];
  since: number;
  sessions: string[];
}): AcceptanceFinding[] {
  const findings: AcceptanceFinding[] = [];
  const terminal = terminalRunFailure(input.runs, input.since, input.sessions);
  if (terminal) findings.push(terminal);
  for (const journal of input.journals) {
    const approvals = approvalEvents(journal.events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    for (const request of approvals.pending)
      findings.push({
        stage: 'approval',
        code: 'approval-pending',
        severity: 'waiting',
        detail: request.toolName,
        session: journal.session,
        call: request.callId,
        approval: request.id,
        task: input.tasks.find((t) => t.targetSession === journal.session)?.id,
      });
  }
  for (const task of input.tasks) {
    if (task.result?.errors.length)
      findings.push({
        stage: task.assessment ? 'verification' : 'execution',
        code: 'unresolved-tool-errors',
        severity: 'error',
        detail: task.result.errors.join('\n'),
        task: task.id,
        run: task.runId,
        project: task.cwd,
      });
    if (['queued', 'dispatching'].includes(task.status))
      findings.push({
        stage: 'dispatch',
        code: 'dispatch-pending',
        severity: 'waiting',
        detail: task.status,
        task: task.id,
      });
    if (['failed', 'blocked', 'interrupted', 'needs_review'].includes(task.status))
      findings.push({
        stage: task.assessment ? 'verification' : 'execution',
        code: 'task-' + task.status,
        severity: 'error',
        detail: task.progress,
        task: task.id,
        run: task.runId,
      });
    // Diagnostic for this two-directory fixture, not a semantic contract validator or authorization rule.
    const shared = task.contract?.acceptance.filter((criterion) => /两个目录|每目录/.test(criterion)) ?? [];
    if (!task.assessment && shared.length && input.tasks.some((t) => !t.assessment && t.cwd !== task.cwd))
      findings.push({
        stage: 'planning',
        code: 'global-criteria-in-local-task',
        severity: 'warning',
        detail: shared.join('\n'),
        task: task.id,
        project: task.cwd,
      });
  }
  const goal = input.records.at(-1);
  if (goal && ['blocked', 'cancelled'].includes(goal.phase))
    findings.push({
      stage: goal.executions.length ? 'aggregation' : goal.planId ? 'dispatch' : 'planning',
      code: 'coordination-' + goal.phase,
      severity: 'error',
      detail: goal.blockReason ?? goal.phase,
      project: goal.project,
      session: goal.session,
      run: input.runs.filter((run) => run.session === goal.session).at(-1)?.id,
    });
  return findings;
}
