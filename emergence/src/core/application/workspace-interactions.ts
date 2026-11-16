import type { Interaction, InteractionAnswer, InteractionRef } from '../domain/interaction.ts';
import { stableDigest } from '../storage/execution-journal.ts';

interface Owner {
  readonly id: string | undefined;
  readonly pending: Interaction | undefined;
  readonly pendingInteractions: readonly Interaction[];
  respondInteraction(id: string, version: number, answer: InteractionAnswer): void;
}
interface Host {
  readonly panes: ReadonlyMap<string, { cwd: string; controller?: Owner }>;
}
const fingerprint = (r: Interaction) =>
  stableDigest({
    session: r.sessionId,
    agent: r.agentId,
    kind: r.kind,
    title: r.title,
    options: r.options,
    allowCustom: r.allowCustom,
    binding: r.binding,
  });

/** Live projection of the existing queues; no persisted pending list or alternate approval authority. */
export class WorkspaceInteractions {
  constructor(private host: Host) {}
  list() {
    return [...this.host.panes].flatMap(([pane, p]) => {
      const owner = p.controller;
      return owner?.id
        ? owner.pendingInteractions.map((request) => ({
            ref: {
              pane,
              ownerSession: owner.id!,
              id: request.id,
              version: request.version,
              fingerprint: fingerprint(request),
            } satisfies InteractionRef,
            request,
            ready: owner.pending === request,
            project: p.cwd,
          }))
        : [];
    });
  }
  reference(pane: string, request: Interaction): InteractionRef {
    const entry = this.list().find(
      (e) =>
        e.ref.pane === pane &&
        e.request.id === request.id &&
        e.request.version === request.version &&
        e.ref.fingerprint === fingerprint(request),
    );
    if (!entry) throw new Error('确认请求已过期或窗口已关闭');
    return entry.ref;
  }
  respond(ref: InteractionRef, answer: InteractionAnswer) {
    const entry = this.list().find(
      (e) =>
        e.ref.pane === ref.pane &&
        e.ref.ownerSession === ref.ownerSession &&
        e.ref.id === ref.id &&
        e.ref.version === ref.version &&
        e.ref.fingerprint === ref.fingerprint,
    );
    if (!entry || !entry.ready) throw new Error('确认请求已过期、被替换或尚未轮到处理');
    this.host.panes.get(ref.pane)!.controller!.respondInteraction(ref.id, ref.version, answer);
  }
}
