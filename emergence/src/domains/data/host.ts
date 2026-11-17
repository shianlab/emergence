import type { CapabilityAccess } from '../../core/adapters/capability-access.ts';
import type { PermissionMode } from '../../core/domain/permissions.ts';

export interface DataHost extends CapabilityAccess {
  readonly home: string;
  readonly permissionMode: PermissionMode;
  confirmDecision(title: string, valid?: () => boolean): Promise<boolean>;
}
