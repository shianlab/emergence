import { type ToolExecution } from '@deepseek-ai/dsh-tools';
import type { PermissionMode } from '../domain/permissions.ts';
import { planningControlNames, safeBeforePlan } from '../domain/planning-tools.ts';
import { planningConfigSchema, type PlanningState } from '../domain/planning.ts';
import { isEvidenceRead, toolContract } from '../domain/tool-contract.ts';
type PlanningConfig = ReturnType<typeof planningConfigSchema.parse>;
export function planningGuard(
  exec: ToolExecution,
  facts: {
    enabled: boolean;
    state: PlanningState | undefined;
    contracted: boolean;
    reading: boolean;
    isRoot: boolean;
    mode: PermissionMode;
    config: PlanningConfig;
    bindingsValid: () => boolean;
  },
): string | undefined {
  const { state: s, config } = facts;
  if (!facts.enabled || !exec.agent) return;

  if (
    s?.analysis &&
    !facts.contracted &&
    facts.isRoot &&
    (s.analysis.intent === 'discuss' || s.analysis.intent === 'clarify' || s.analysis.questions?.length) &&
    !(safeBeforePlan.has(exec.name) || isEvidenceRead(exec.name, exec.arguments)) &&
    !(exec.name === 'working_directory' && !(exec.arguments as { cd?: string })?.cd)
  )
    return '当前仅讨论或存在需要用户决定的问题；先说明需求理解并澄清，收到后续执行指令再实施，不得自行把讨论变成执行。';
  const unclassifiedEffect =
    s?.route === 'direct' &&
    toolContract(exec.name, exec.arguments).sideEffect &&
    !planningControlNames.has(exec.name);
  // Owned child agents inherit an already-admitted delegation; they do not run a competing intake.
  // In Plan mode the authoritative permission layer denies effects directly.
  if (
    (s?.route === 'focused' || unclassifiedEffect) &&
    facts.isRoot &&
    facts.mode !== 'plan' &&
    !facts.contracted &&
    !s!.analysis &&
    !(safeBeforePlan.has(exec.name) || isEvidenceRead(exec.name, exec.arguments)) &&
    !(exec.name === 'working_directory' && !(exec.arguments as { cd?: string })?.cd)
  )
    return '内置核心要求先完成目标分析：请主动调用 emergence_analyze，明确目标、理由与路线，再实施；用户无需手动触发。';
  if (!s || s.route !== 'planned') return;
  if (
    isEvidenceRead(exec.name, exec.arguments) &&
    s.status !== 'ready' &&
    s.research >= config.researchCalls &&
    !facts.reading
  )
    return '规划读取预算已用完，请提交已有证据或说明缺口，不要换工具绕过';
  if (
    safeBeforePlan.has(exec.name) ||
    isEvidenceRead(exec.name, exec.arguments) ||
    (exec.name === 'working_directory' && !(exec.arguments as { cd?: string })?.cd)
  )
    return;
  if (s.status !== 'ready')
    return '复杂任务尚无有效计划：请先 emergence_capabilities，再读取来源并 emergence_plan；不确定目标时先提问';
  if (
    ['emergence_audit', 'emergence_review', 'emergence_repair', 'emergence_memory_propose'].includes(
      exec.name,
    ) &&
    s.executions?.includes(String((exec.arguments as Record<string, unknown>).task_id))
  )
    return;
  if (s.executions?.length) return '计划已交给任务调度器，请查看 /tasks；不要在当前规划轮次重复副作用';
  if (s.plan && JSON.stringify(s.plan).length > config.contextChars - 3000)
    return '计划超过当前上下文预算，请缩减并重新提交';
  if (!facts.bindingsValid()) return '计划的窗口、会话、项目或模型已变化，请重新查询能力并修订计划';
  if (exec.name === 'emergence_execute_plan') return;
  const capability = (exec.name.startsWith('mcp__') ? 'mcp-tool:' : 'tool:') + exec.name;
  if (!s.plan?.steps.some((step) => step.capabilities.includes(capability)))
    return '该操作未列入当前计划，请先修订能力选择';
}
