import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { AppConfig, ModelConfig } from '../domain/configuration.ts';
import type { PermissionMode, PermissionSnapshot } from '../domain/permissions.ts';
import type { Capability, PlanningState } from '../domain/planning.ts';
import type { CoreObserver } from './observer.ts';
import type { RunDiagnostics } from './run-diagnostics.ts';
/** Facts needed for inventory, not a session controller or task engine. */
export interface PlanningWindow {
  readonly ctx: Context;
  readonly id: string | undefined;
  readonly agent: Agent;
  readonly cwd: string;
  readonly model: ModelConfig;
  readonly launch: { home: string; modelId: string; appConfig: AppConfig };
  executionModel(agent: Agent): ModelConfig | undefined;
  permissionSnapshot(): PermissionSnapshot;
  permissionConstraints(agent?: Agent): PermissionSnapshot[];
  readonly planning: { snapshot(agent?: Agent): PlanningState | undefined };
}
export interface PlanningHost extends PlanningWindow {
  readonly core: Pick<CoreObserver, 'enabled' | 'catalog'>;
  readonly diagnostics: Pick<RunDiagnostics, 'snapshot'>;
  readonly permissionMode: PermissionMode;
  owns(agent?: Agent): boolean;
  changed(): void;
}
export interface PlanningEnvironment {
  mode: 'independent';
  currentWindow: string;
  windows: Array<{ id: string; controller: PlanningWindow; dispatchable: boolean }>;
  mcp: Capability[];
}
