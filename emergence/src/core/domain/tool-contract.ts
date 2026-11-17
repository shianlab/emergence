/** Host-owned policy facts. Never populate this catalog from tool descriptions,
 * model arguments, MCP annotations, Skills, or persisted session metadata. */
export type ToolContract = {
  readonly version: 1;
  readonly authority: 'host' | 'unknown';
  readonly operation: 'read' | 'write' | 'command' | 'delegate' | 'control' | 'unknown';
  readonly permission: 'read' | 'edit' | 'delegate' | 'ask';
  /** Additional host policy names whose restrictions also apply to this tool. */
  readonly policyAliases?: readonly string[];
  readonly evidence: 'file' | 'query' | 'command' | 'other' | 'none';
  readonly resource: 'file' | 'query-root' | 'project' | 'unbounded' | 'none';
  readonly input: 'file-path' | 'query' | 'command' | 'control' | 'unknown';
  readonly output:
    'file-content' | 'file-change' | 'file-check' | 'query-result' | 'process-result' | 'control' | 'unknown';
  readonly sideEffect: boolean;
  readonly parallelFileTask: boolean;
  readonly cancellation: 'signal' | 'unknown';
  readonly externalEffects: Readonly<{ network: 'none' | 'unknown'; database: 'none' | 'unknown' }>;
  // Null means no independently verified per-tool bound. Task budgets still apply.
  readonly budget: Readonly<{ timeoutMs: number | null; outputBytes: number | null }>;
};

function contract(
  values: Omit<ToolContract, 'version' | 'authority' | 'budget' | 'externalEffects'>,
): ToolContract {
  const external = ['command', 'delegate', 'unknown'].includes(values.operation) ? 'unknown' : 'none';
  return Object.freeze({
    version: 1,
    authority: 'host',
    ...values,
    externalEffects: Object.freeze({ network: external, database: external }),
    budget: Object.freeze({ timeoutMs: null, outputBytes: null }),
  });
}

const fileRead = contract({
  operation: 'read',
  permission: 'read',
  evidence: 'file',
  resource: 'file',
  input: 'file-path',
  output: 'file-content',
  sideEffect: false,
  parallelFileTask: true,
  cancellation: 'signal',
});
const fileWrite = contract({
  ...fileRead,
  operation: 'write',
  permission: 'edit',
  evidence: 'other',
  output: 'file-change',
  sideEffect: true,
});
const query = contract({
  ...fileRead,
  evidence: 'query',
  resource: 'query-root',
  input: 'query',
  output: 'query-result',
  parallelFileTask: false,
});
const codeQuery: ToolContract = Object.freeze({
  ...query,
  resource: 'project',
  budget: Object.freeze({ timeoutMs: null, outputBytes: 24000 }),
});
const command = contract({
  operation: 'command',
  permission: 'ask',
  evidence: 'command',
  resource: 'unbounded',
  input: 'command',
  output: 'process-result',
  sideEffect: true,
  parallelFileTask: false,
  cancellation: 'signal',
});
const control = contract({
  operation: 'control',
  permission: 'read',
  evidence: 'none',
  resource: 'none',
  input: 'control',
  output: 'control',
  sideEffect: false,
  parallelFileTask: false,
  cancellation: 'unknown',
});
const delegation = contract({ ...control, operation: 'delegate', permission: 'delegate', sideEffect: true });
const mutation = contract({ ...control, permission: 'ask', sideEffect: true });
const unknown: ToolContract = Object.freeze({
  ...command,
  authority: 'unknown',
  operation: 'unknown',
  evidence: 'other',
  input: 'unknown',
  output: 'unknown',
  cancellation: 'unknown',
});

const catalog = new Map<string, ToolContract>([
  ...['emergence_data_profile', 'emergence_data_query', 'read', 'read_image'].map(
    (name) => [name, fileRead] as const,
  ),
  ...['write', 'edit'].map((name) => [name, fileWrite] as const),
  ['emergence_code_restore', Object.freeze({ ...fileWrite, parallelFileTask: false })],
  ['emergence_code_work', control],
  ['emergence_data_methods', control],
  [
    'emergence_data_analyze',
    Object.freeze({
      ...fileRead,
      evidence: 'command',
      output: 'query-result',
      parallelFileTask: false,
      budget: Object.freeze({ timeoutMs: 30000, outputBytes: 24000 }),
    }),
  ],
  ['emergence_data_definition', contract({ ...control, sideEffect: true })],
  ...['glob', 'grep'].map((name) => [name, query] as const),
  ['emergence_inspect', Object.freeze({ ...query, policyAliases: Object.freeze(['read']) })],
  [
    'emergence_verify_file',
    Object.freeze({ ...fileRead, output: 'file-check', policyAliases: Object.freeze(['read']) }),
  ],
  ...['emergence_code_project', 'emergence_code_locate', 'emergence_code_context'].map(
    (name) => [name, codeQuery] as const,
  ),
  ...['pwsh', 'bash', 'read_process'].map((name) => [name, command] as const),
  ...[
    'skill',
    'ask_user_question',
    'todo_write',
    'list_subagent_models',
    'emergence_report',
    'emergence_memory_search',
    'emergence_receipts',
    'emergence_capabilities',
    'emergence_plan',
    'emergence_analyze',
  ].map((name) => [name, control] as const),
  ['subagent', delegation],
  // Existing deny/ask rules for the former entry must still restrict local plan execution.
  [
    'emergence_execute_plan',
    Object.freeze({ ...delegation, policyAliases: Object.freeze(['emergence_dispatch']) }),
  ],
  ['emergence_memory_propose', mutation],
]);

// These controls are already allowed inside a host-bounded file task.
for (const name of [
  'emergence_report',
  'emergence_memory_search',
  'ask_user_question',
  'todo_write',
  'list_subagent_models',
]) {
  catalog.set(name, contract({ ...control, parallelFileTask: true }));
}

export function toolArguments(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

export function toolContract(name: string, input?: unknown): ToolContract {
  if (name === 'working_directory')
    return toolArguments(input).cd === undefined ? workingDirectoryRead : mutation;
  return catalog.get(name) ?? unknown;
}
const workingDirectoryRead = contract({ ...control, parallelFileTask: true });

export function toolPath(input: unknown): string | undefined {
  const args = toolArguments(input);
  return typeof args.file_path === 'string'
    ? args.file_path
    : typeof args.path === 'string'
      ? args.path
      : undefined;
}

export function isEvidenceRead(name: string, input?: unknown): boolean {
  return ['file', 'query'].includes(toolContract(name, input).evidence);
}

export function isFileCapability(id: string): boolean {
  if (!id.startsWith('tool:')) return false;
  const value = toolContract(id.slice(5));
  return value.authority === 'host' && value.resource === 'file' && value.parallelFileTask;
}

/** Shared success interpretation; process launch/background promotion is not completion. */
export function toolOutcome(
  name: string,
  value: unknown,
  isError: boolean,
  aborted: boolean,
): 'succeeded' | 'failed' | 'cancelled' | 'pending' {
  const result = toolArguments(value);
  if (aborted || result.aborted || result.stopped || result.signal) return 'cancelled';
  if (isError || result.timedOut || (typeof result.exitCode === 'number' && result.exitCode !== 0))
    return 'failed';
  if (toolContract(name, value).output === 'file-check')
    return result.passed === true ? 'succeeded' : 'failed';
  if (result.kind === 'background' || result.kind === 'promoted') return 'pending';
  if (toolContract(name).evidence === 'command' && result.exitCode !== 0) return 'pending';
  return 'succeeded';
}
