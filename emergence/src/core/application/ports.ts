import type { ObservationSnapshot, PermissionFact } from '../domain/contracts.ts';

/** Intentionally cannot invoke tools, approve, dispatch or mutate project rules. */
export interface ObservationStore {
  read(scopeKey: string): Promise<ObservationSnapshot | undefined>;
  write(snapshot: ObservationSnapshot): Promise<void>;
}
export interface HarnessObservationPort {
  modelStep(actor: string): void;
  permissionCheck(actor: string, callKey: string, fact: PermissionFact): void;
  toolFinished(actor: string): void;
  idle(actor: string): void;
  error(actor: string): void;
}
