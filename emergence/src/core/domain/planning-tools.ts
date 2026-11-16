import { isEvidenceRead, toolArguments } from './tool-contract.ts';

export const planningToolNames = new Set([
  'emergence_decide',
  'emergence_plan_work',
  'emergence_plan_step',
  'emergence_plan_remove',
  'emergence_plan_commit',
  'emergence_team',
  'emergence_analyze',
  'emergence_memory_search',
  'emergence_assess',
  'emergence_receipts',
  'emergence_capabilities',
  'emergence_plan',
]);
export const safeBeforePlan = new Set([
  ...planningToolNames,
  'emergence_data_methods',
  'ask_user_question',
  'skill',
  'list_subagent_models',
  'emergence_tasks',
  'emergence_wait',
  'emergence_report',
]);
export const coordinatorControlNames = new Set([
  'emergence_memory_propose',
  'emergence_audit',
  'emergence_review',
  'emergence_repair',
]);
/** The coordinator menu and execution gate share this boundary. Arguments are
 * still rechecked at execution (working_directory may query, but not change cwd). */
export function coordinatorToolAllowed(name: string, input?: unknown) {
  return (
    safeBeforePlan.has(name) ||
    isEvidenceRead(name, input) ||
    coordinatorControlNames.has(name) ||
    name === 'emergence_execute_plan' ||
    (name === 'working_directory' && toolArguments(input).cd === undefined)
  );
}
