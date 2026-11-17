import { z } from 'zod';
import { runClockSchema } from './run-budget.ts';
import {
  requestSourceSchema,
  requirementsSchema,
  requirementSuggestionsSchema,
  requirementBindingSchema,
} from './requirements.ts';
import type { ToolContract } from './tool-contract.ts';
import { planSchema, type TaskPlan } from './task-plan.ts';
import { workDraftSchema } from './legacy-work-draft.ts';
export { planSchema, type TaskPlan } from './task-plan.ts';

import { intentAnalysisSchema } from './intent.ts';

const text = z.string().trim().min(1).max(1000);
export const planningConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    submission: z.enum(['steps', 'whole']).default('steps'),
    researchCalls: z.number().int().min(1).max(50).default(12),
    revisions: z.number().int().min(1).max(12).default(4),
    contextChars: z.number().int().min(6000).max(24000).default(16000),
  })
  .strict();
export type Capability = {
  id: string;
  kind: 'tool' | 'mcp-tool' | 'model' | 'skill' | 'method' | 'role' | 'mcp';
  registered: boolean;
  connected: boolean | null;
  callable: boolean;
  verified: boolean;
  detail: string;
  model?: string;
  contract?: ToolContract;
};
export type PlanWindow = {
  stale?: boolean;
  id: string;
  session: string;
  project: string;
  projectId?: string;
  model: string;
  dispatchable: boolean;
  capabilities: string[];
  capabilityFacts?: Capability[];
};
export type Inventory = {
  snapshot?: { version: 1; revision: string };
  capabilities: Capability[];
  windows: PlanWindow[];
  mode: 'independent' | 'collaborate';
  currentWindow: string;
  diagnostics: string[];
};
export const receiptSchema = z
  .object({ id: z.string().max(200), tool: z.string().max(200), read: z.boolean() })
  .strict();
export const legacyPlanningStateSchema = z
  .object({
    version: z.literal(1),
    scope: z.string().regex(/^[a-f0-9]{64}$/),
    requestIds: z.array(z.string().max(200)).max(32),
    request: z.string().max(6000),
    route: z.enum(['direct', 'focused', 'planned']),
    routeReason: z.string().max(200),
    plan: planSchema.optional(),
    attempts: z.number().int().min(0).max(12),
    research: z.number().int().min(0).max(1000),
    receipts: z.array(receiptSchema).max(64),
    status: z.enum(['draft', 'ready', 'needs-input', 'blocked']),
    issues: z.array(z.string().max(1000)).max(30),
    executions: z.array(z.string().max(128)).max(12).optional(),
    analysis: intentAnalysisSchema.optional(),
    coordination: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    autonomy: z
      .object({
        timing: runClockSchema.optional(),
        nudges: z.number().int().min(0).max(2),
        steps: z.number().int().min(0).max(24),
        startedAt: z.number(),
        decision: z.enum(['answer', 'blocked']).optional(),
        reason: text.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const planningStateSchema = legacyPlanningStateSchema
  .extend({
    version: z.literal(2),
    source: requestSourceSchema.optional(),
    requirements: requirementsSchema.optional(),
    inheritedRequirements: requirementsSchema.optional(),
    requirementBinding: requirementBindingSchema.optional(),
    suggestions: requirementSuggestionsSchema.optional(),
    draft: workDraftSchema.optional(),
  })
  .strict();
export type PlanningState = z.infer<typeof planningStateSchema>;

/** Cheap routing only. The selected model, not these heuristics, interprets the task. */
export function routeRequest(input: string): Pick<PlanningState, 'route' | 'routeReason'> {
  if (
    input.length < 300 &&
    /^(什么是|解释(?:一下)?|介绍(?:一下)?|如何理解|为什么|what is\b|explain\b|define\b)/i.test(
      input.trim(),
    ) &&
    !/(并|然后|同时|以及).*(实现|规划|修改|修复)|\b(and|then)\b.*\b(implement|fix|plan)\b/i.test(input)
  )
    return { route: 'direct', routeReason: '简短知识问答，直接回答' };
  if (
    /规划|方案|架构|整合|重构|多个项目|不同项目|多窗口|多阶段|全套|整体|从零|plan\b|architect|multi.project|refactor/i.test(
      input,
    ) ||
    input.length > 700 ||
    (input.match(/(?:^|\n)\s*\d+[.、，]/g)?.length ?? 0) >= 2
  )
    return { route: 'planned', routeReason: '多步骤、跨范围或明确规划请求；先核实能力与来源' };
  if (
    /修复|修改|实现|增加|添加|开发|帮我做|帮我写|做一个|写一个|检查|优化|fix\b|implement|build\b|create\b|review\b/i.test(
      input,
    )
  )
    return { route: 'focused', routeReason: '具体任务；按需读取、实现和验证' };
  return { route: 'direct', routeReason: '简短问答或单项请求，直接进入现有执行循环' };
}
export function planDependencyIssues(plan: TaskPlan): string[] {
  const issues: string[] = [],
    ids = new Set(plan.steps.map((s) => s.id));
  if (ids.size !== plan.steps.length) issues.push('步骤 ID 重复');
  const visited = new Set<string>(),
    active = new Set<string>();
  function visit(id: string) {
    if (active.has(id)) {
      issues.push('步骤依赖成环');
      return;
    }
    if (visited.has(id)) return;
    visited.add(id);
    active.add(id);
    for (const dep of plan.steps.find((s) => s.id === id)?.dependsOn ?? []) {
      if (!ids.has(dep)) issues.push('依赖步骤不存在：' + dep);
      else visit(dep);
    }
    active.delete(id);
  }
  for (const step of plan.steps) visit(step.id);
  return [...new Set(issues)];
}
export function validatePlan(
  plan: TaskPlan,
  inventory: Inventory,
  receipts: PlanningState['receipts'],
): string[] {
  const issues = planDependencyIssues(plan);
  for (const step of plan.steps) {
    const window = inventory.windows.find((w) => w.id === step.window);
    if (
      !window ||
      window.session !== step.session ||
      window.project !== step.project ||
      window.model !== step.model
    )
      issues.push(`${step.id}：窗口、会话、项目或模型绑定已失效`);
    else {
      if (window.id !== inventory.currentWindow && !window.dispatchable)
        issues.push(`${step.id}：当前不能派发到 ${window.id}，请由用户配置协作模式`);
      if (!inventory.capabilities.some((c) => c.id === 'model:' + step.model && c.callable))
        issues.push(`${step.id}：模型尚不可调用`);
      for (const id of step.capabilities)
        if (!window.capabilities.includes(id)) issues.push(`${step.id}：目标窗口缺少能力 ${id}`);
    }
    if (!inventory.capabilities.some((c) => c.id === 'role:' + step.role && c.callable))
      issues.push(`${step.id}：执行角色不存在`);
    const roleModel = inventory.capabilities.find((c) => c.id === 'role:' + step.role)?.model;
    if (roleModel && roleModel !== step.model) issues.push(`${step.id}：角色要求模型 ${roleModel}`);
    for (const id of step.capabilities)
      if (!inventory.capabilities.some((c) => c.id === id && c.callable))
        issues.push(`${step.id}：能力不可调用 ${id}`);
  }
  for (const id of plan.evidence)
    if (!receipts.some((r) => r.id === id && r.read)) issues.push('证据不是本任务已成功的读取回执：' + id);
  if (
    plan.steps.some((s) =>
      s.capabilities.some((c) =>
        /^(tool:(write|edit|bash|pwsh|subagent|emergence_dispatch)|mcp-tool:)/.test(c),
      ),
    ) &&
    !plan.evidence.some((id) => receipts.some((r) => r.id === id && r.read))
  )
    issues.push('涉及实现或外部操作，必须先读取相关来源并引用回执；读取成功不等于内容已验证');
  return [...new Set(issues)].slice(0, 30);
}
