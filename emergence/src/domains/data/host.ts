import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import type { CapabilityAccess } from '../../core/adapters/capability-access.ts';
import type { PermissionMode, ToolConfirmation } from '../../core/domain/permissions.ts';

export interface DataHost extends CapabilityAccess {
  readonly home: string;
  readonly permissionMode: PermissionMode;
  confirmToolDecision(tool: ToolExecution, title: string, valid: () => boolean): Promise<ToolConfirmation>;
}
