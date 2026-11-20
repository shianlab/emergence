import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { EventEmitter } from 'node:events';
import type { CodeEvidencePort } from './code-evidence-port.ts';
import type { AppConfig, ModelConfig } from '../domain/configuration.ts';
import type { PermissionMode, PermissionSnapshot } from '../domain/permissions.ts';
import type { Capability } from '../domain/planning.ts';
import type { CoreObserver } from './observer.ts';
import type { CorePlanning } from './planning-service.ts';
import type { TaskEngine } from './task-engine.ts';
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
  hasModelCredential(ref?: string): boolean;
  executionModel(agent: Agent): ModelConfig | undefined;
  readonly busy: boolean;
  readonly pending: { readonly id: string; readonly version: number } | undefined;
  readonly core: CoreObserver;
  readonly planning: CorePlanning;
  readonly diagnostics: RunDiagnostics;
  readonly codeWork: CodeEvidencePort;
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
  draft: string;
  scrollTop: number;
  error?: string;
}

/** Window/session operations needed by orchestration, not rendering or input widgets. */
export interface WorkspacePort extends Pick<EventEmitter, 'on' | 'off'> {
  readonly ctx: Context;
  readonly launch: SessionLaunch;
  readonly path: string;
  readonly panes: Map<string, PanePort>;
  readonly taskEngine: TaskEngine;
  readonly capabilities: { snapshot(): Capability[] };
  focused: string;
  notice: string;
  available(id: string): boolean;
  changed(): void;
  save(): Promise<void>;
}
