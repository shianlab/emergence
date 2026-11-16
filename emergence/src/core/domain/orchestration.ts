import { z } from 'zod';
import { permissionModeSchema, permissionRuleSchema } from './permissions.ts';
import { budgetPolicySchema, orchestrationLimits } from './run-budget.ts';
import { projectBindingSchema } from './project-contract.ts';

export const roleSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
    description: z.string().min(1).max(500),
    prompt: z.string().min(1).max(6000),
    mode: permissionModeSchema.default('edit'),
    modelId: z.string().max(32).optional(),
    deny: z
      .array(z.string().regex(/^[\w.:-]+\*?$/))
      .max(100)
      .default([]),
    rules: z.array(permissionRuleSchema).max(100).default([]),
    skills: z.array(z.string().max(200)).max(20).default([]),
  })
  .strict();
export const orchestrationSchema = z
  .object({
    budgets: budgetPolicySchema.default(() => budgetPolicySchema.parse({})),
    maxConcurrent: z.number().int().min(1).max(15).default(4),
    roles: z.array(roleSchema).max(32).default([]),
  })
  .strict()
  .refine((v) => new Set(v.roles.map((r) => r.id)).size === v.roles.length, '角色 ID 重复');
export const TASK_CONTEXT_CHARS = 8000;
export const contractSchema = z
  .object({
    role: z.string().default('developer'),
    scope: z.array(z.string().min(1).max(1000)).min(1).max(30),
    acceptance: z.array(z.string().min(1).max(1000)).min(1).max(20),
    deliverables: z.array(z.string().max(1000)).max(30).default([]),
    context: z.string().max(TASK_CONTEXT_CHARS).default(''),
    binding: projectBindingSchema.optional(),
    maxSteps: z.number().int().min(1).max(200).default(40),
    maxDurationMs: z.number().int().min(1000).max(3600000).default(orchestrationLimits.taskExecutionMs),
    maxRepairs: z.number().int().min(0).max(3).default(1),
  })
  .strict();
export type Contract = z.infer<typeof contractSchema>;
export const builtInRoles = [
  {
    id: 'planner',
    description: '拆分目标和验收标准',
    prompt: 'Read and plan. Deliver a bounded task plan with dependencies and acceptance criteria.',
    mode: 'plan',
  },
  {
    id: 'researcher',
    description: '读取与研究',
    prompt:
      'Investigate sources and report evidence, uncertainties and file references. Do not modify files.',
    mode: 'plan',
  },
  {
    id: 'developer',
    description: '实现并验证',
    prompt:
      'Implement the scoped task. Load applicable rules and skills, validate changes and report actual results.',
    mode: 'edit',
  },
  {
    id: 'verifier',
    description: '独立验证与检查回执',
    prompt:
      'Independently run checks against acceptance criteria. Use actual exit status and tool receipts. Do not modify implementation artifacts; commands remain subject to approval.',
    mode: 'ask',
    deny: ['write', 'edit', 'subagent', 'emergence_dispatch', 'emergence_repair', 'emergence_execute_plan'],
  },
  {
    id: 'reviewer',
    description: '只读审查与证据核对',
    prompt:
      'Independently inspect changes and evidence against each acceptance criterion. Report defects and missing evidence; do not modify files.',
    mode: 'plan',
  },
].map((r) => roleSchema.parse(r));
export function roles(config: z.infer<typeof orchestrationSchema>) {
  const result = new Map(builtInRoles.map((r) => [r.id, r]));
  config.roles.forEach((r) => result.set(r.id, r));
  return [...result.values()];
}
