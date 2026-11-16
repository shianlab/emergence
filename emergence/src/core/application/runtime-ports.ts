import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { EventEmitter } from 'node:events';
import type { CodeWorkHarness } from '../../domains/code/work-harness.ts';
import type { AppConfig, ModelConfig } from '../domain/configuration.ts';
import type { PermissionMode, PermissionSnapshot } from '../domain/permissions.ts';
import type { Capability } from '../domain/planning.ts';
import type { CoreObserver } from './observer.ts';
import type { CorePlanning } from './planning-service.ts';
import type { Collaboration } from './task-coordinator.ts';
import type { TeamCoordinator } from './team-coordinator.ts';
import type { RunDiagnostics } from './run-diagnostics.ts';

export interface SessionLaunch {
  home: string;
  cwd: string;
  modelId: string;
  appConfig: AppConfig;
  prompt?: string;
}

/** Runtime capabilities used by governance, independent of the TUI controller class. */
export interface SessionPort extends Pick<EventEmitter, 'on' | 'off'> {
  readonly ctx: Context;
  readonly id: string | undefined;
  readonly agent: Agent;
  readonly cwd: string;
  readonly model: ModelConfig;
  executionModel(agent: Agent): ModelConfig | undefined;
  readonly busy: boolean;
  readonly pending: { readonly id: string; readonly version: number } | undefined;
  readonly core: CoreObserver;
  readonly planning: CorePlanning;
  readonly diagnostics: RunDiagnostics;
  readonly codeWork: CodeWorkHarness;
  readonly launch: SessionLaunch;
  readonly permissionMode: PermissionMode;
  notice: string;
  lastError?: string;
  owns(agent?: Agent): boolean;
  changed(): void;
  cancel(): Promise<void>;
  permissionSnapshot(): PermissionSnapshot;
  permissionConstraints(agent?: Agent): PermissionSnapshot[];
  confirmDecision(title: string, valid?: () => boolean): Promise<boolean>;
}

export interface PanePort {
  id: string;
  controller?: SessionPort;
  sessionId?: string;
  cwd: string;
  modelId: string;
  permissionMode?: PermissionMode;
  rolePreference?: string;
  draft: string;
  scrollTop: number;
  error?: string;
}

/** Window/session operations needed by orchestration, not rendering or input widgets. */
export interface WorkspacePort extends Pick<EventEmitter, 'on' | 'off'> {
  /** The shipped workbench owns independent sessions; historical engine fixtures may use workspace scope. */
  readonly executionScope: 'session' | 'workspace';
  readonly ctx: Context;
  readonly launch: SessionLaunch;
  readonly path: string;
  readonly panes: Map<string, PanePort>;
  readonly collaboration: Collaboration;
  readonly team: TeamCoordinator;
  readonly capabilities: { snapshot(): Capability[] };
  readonly paneCapacity: { available: number; pending: number };
  focused: string;
  notice: string;
  available(id: string): boolean;
  changed(): void;
  save(): Promise<void>;
  split(axis: 'row' | 'column', cwd?: string, modelId?: string, target?: string): Promise<PanePort>;
  discardUnusedPane(id: string, session: string, sequence: number): Promise<void>;
}
