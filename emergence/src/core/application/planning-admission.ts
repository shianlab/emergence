import { createHash } from 'node:crypto';
import { readPlanInput } from '../adapters/plan-input.ts';
import { safeError } from '../adapters/redaction.ts';
import { parseProtocol } from '../adapters/tool-protocol.ts';
import {
  planSchema,
  planningConfigSchema,
  validatePlan,
  type Inventory,
  type PlanningState,
} from '../domain/planning.ts';
import {
  RequirementError,
  assertRequirementIntegrity,
  establishRequirements,
} from '../domain/requirements.ts';
import { AllocationChanged } from './dispatch-admission.ts';
import { assertPlanAdmission } from './task-admission.ts';
type PlanningConfig = ReturnType<typeof planningConfigSchema.parse>;
/** Validate a detached draft; the request owner commits it only if its source is still current. */
export async function reviewPlan(
  draft: PlanningState,
  input: unknown,
  signal: AbortSignal,
  config: PlanningConfig,
  collectInventory: (signal: AbortSignal) => Promise<Inventory>,
  establish: (
    analysis: Parameters<typeof establishRequirements>[2],
  ) => NonNullable<PlanningState['requirements']>,
) {
  const json = typeof input === 'string' ? input : JSON.stringify(input);
  if (json.length > config.contextChars - 3000) throw new Error('计划超过上下文预算，请缩减步骤与描述');
  const admission = readPlanInput(safeError(json), draft.requirements, (legacy) =>
    establish(draft.analysis ?? legacy),
  );
  const { requirements } = admission;
  draft.suggestions = admission.proposal.suggestions;
  const materialized = admission.materialize();
  const inventory = await collectInventory(signal);
  const plan = parseProtocol(planSchema, materialized);
  signal.throwIfAborted();
  assertPlanAdmission(plan, config.contextChars);
  const issues = validatePlan(plan, inventory, draft.receipts);
  draft.analysis ??= {
    objective: plan.objective,
    reason: plan.reason,
    constraints: plan.constraints,
    acceptance: plan.acceptance,
    questions: plan.unknowns
      .filter((u) => u.blocking)
      .map((u) => u.question)
      .slice(0, 4),
  };
  draft.plan = plan;
  draft.requirementBinding = {
    revision: requirements.revision,
    steps: admission.proposal.steps.map(({ id, requirementIds }) => ({
      id,
      requirementIds,
      localCriteria: plan.steps.find((s) => s.id === id)?.localCriteria,
    })),
  };
  draft.issues = issues;
  draft.status = issues.length ? 'blocked' : plan.unknowns.some((u) => u.blocking) ? 'needs-input' : 'ready';

  return {
    status: draft.status,
    issues,
    plan,
    requirements,
    planId: createHash('sha256').update(JSON.stringify(plan)).digest('hex'),
    note: 'ready 仅表示检查通过。工作台可用 emergence_execute_plan 提交执行图；提交后本轮停止，执行任务将由既有调度器启动。',
  };
}
export async function validateReadyPlan(
  state: PlanningState,
  enabled: boolean,
  config: PlanningConfig,
  inventory: () => Promise<Inventory>,
) {
  if (
    state.analysis?.intent === 'discuss' ||
    state.analysis?.intent === 'clarify' ||
    state.analysis?.questions?.length
  )
    throw new Error('当前仅讨论或存在待确认问题；请先补充执行指令，不能直接运行计划');
  if (!enabled || state.status !== 'ready' || !state.plan)
    throw new Error('当前没有通过检查的计划；先完成任务规划');
  if (!state.requirements)
    throw new RequirementError('ANALYSIS_REQUIRED', 'requirements', '旧计划缺少需求契约，请重新分析。');
  assertRequirementIntegrity(state.requirements, state.plan, state.requirementBinding);
  assertPlanAdmission(state.plan, config.contextChars);
  const issues = validatePlan(state.plan, await inventory(), state.receipts);
  if (issues.length) throw new AllocationChanged(issues.join('\n'));
  return structuredClone(state.plan);
}
