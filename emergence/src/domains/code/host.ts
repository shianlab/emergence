import type { CapabilityAccess } from '../../core/adapters/capability-access.ts';

export interface CodeWorkHost extends CapabilityAccess {
  readonly home: string;
}
