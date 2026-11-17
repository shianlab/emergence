export const planningToolNames = new Set([
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
  'emergence_report',
]);
export const planningControlNames = new Set(['emergence_memory_propose']);
