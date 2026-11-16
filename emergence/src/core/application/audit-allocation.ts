import type { Assessment } from '../domain/assurance.ts';
import type { TaskRecord } from '../domain/task.ts';
import { settledTaskStatuses as terminal } from '../domain/task.ts';
import type { PanePort as PaneState, WorkspacePort as WorkspaceController } from './runtime-ports.ts';

type AuditWorkspace = Pick<WorkspaceController, 'collaboration' | 'available'>;

export class AuditCapacityError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/** Idle is not sufficient: reject implementation, opposite-audit and personal conversation history. */
export function independentAuditContext(
  w: AuditWorkspace,
  pane: PaneState,
  subject: TaskRecord,
  kind: Assessment['kind'],
  model: string,
): boolean {
  const c = pane.controller;
  if (
    !c?.id ||
    pane.id === subject.issuer ||
    c.id === subject.targetSession ||
    c.cwd !== subject.cwd ||
    pane.modelId !== model
  )
    return false;
  const tasks = w.collaboration.state.tasks.filter((t) => t.targetSession === c.id);
  if (tasks.some((t) => !t.assessment || t.assessment.kind !== kind)) return false;
  const known = new Set(tasks.map((t) => t.id));
  return !c.agent.session
    .snapshotEvents()
    .some(
      (e) =>
        e.type === 'user/message' &&
        (e.data.source.kind === 'user' ||
          (e.data.source.kind === 'emergence-task' && !known.has(e.data.source.taskId))),
    );
}

export function availableAuditContext(w: AuditWorkspace, pane: PaneState, reserved: Set<string>): boolean {
  return (
    !!pane.controller &&
    !pane.controller.busy &&
    !pane.controller.pending &&
    !pane.draft &&
    w.available(pane.id) &&
    !reserved.has(pane.id) &&
    !w.collaboration.state.owned.includes(pane.id) &&
    !w.collaboration.state.tasks.some((t) => t.target === pane.id && !terminal.has(t.status))
  );
}
