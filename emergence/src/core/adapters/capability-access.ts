import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { PermissionSnapshot } from '../domain/permissions.ts';

/** Live session access for native capability adapters; no controller or UI state. */
export interface CapabilityAccess {
  readonly ctx: Context;
  owns(agent?: Agent): boolean;
  permissionSnapshot(): PermissionSnapshot;
  permissionConstraints(agent?: Agent): PermissionSnapshot[];
}
