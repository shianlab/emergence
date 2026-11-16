export type InteractionKind = 'permission' | 'singleChoice' | 'multiChoice' | 'text';
export interface InteractionOption {
  id: string;
  label: string;
  value: string;
}
/** Identity only. Permissions and executable arguments remain with the owning controller. */
export interface ApprovalBinding {
  nativeId?: string;
  callId?: string;
  tool: string;
  cwd: string;
  fingerprint: string;
  permissionVersion: string;
  turn?: number;
  taskId?: string;
  runId?: string;
}
export interface InteractionSpec {
  kind: InteractionKind;
  title: string;
  sessionId: string;
  agentId: string;
  options: readonly InteractionOption[];
  allowCustom: boolean;
  binding?: Readonly<ApprovalBinding>;
}
export type InteractionAnswer =
  { action: 'cancel' } | { action: 'submit'; selected?: string[]; text?: string };
export interface Interaction extends InteractionSpec {
  readonly id: string;
  readonly version: number;
  readonly status: 'pending' | 'resolved' | 'cancelled';
  /** Compatibility for headless callers; the same queue validates identity and lifetime. */
  respond(text: string): void;
}
export interface InteractionRef {
  pane: string;
  ownerSession: string;
  id: string;
  version: number;
  fingerprint: string;
}
