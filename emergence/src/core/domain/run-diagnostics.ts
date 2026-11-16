import { z } from 'zod';
import type { BudgetPolicy } from './run-budget.ts';

export const phases = ['host', 'model-wait', 'model-output', 'tool', 'approval', 'resource'] as const;
export type RunPhase = (typeof phases)[number];
const durations = z
  .object(
    Object.fromEntries(phases.map((phase) => [phase, z.number().nonnegative()])) as Record<
      RunPhase,
      z.ZodNumber
    >,
  )
  .strict();
export const runDiagnosticSchema = z
  .object({
    id: z.string(),
    session: z.string(),
    task: z.string().optional(),
    startedAt: z.number(),
    at: z.number(),
    endedAt: z.number().optional(),
    phase: z.enum(phases),
    durations,
    requests: z.number().int().nonnegative(),
    lastOutputAt: z.number().optional(),
    outcome: z.enum(['running', 'ended', 'cancelled', 'error', 'interrupted', 'deadline']),
    reason: z.string().max(1000).optional(),
  })
  .strict();
export type RunDiagnostic = z.infer<typeof runDiagnosticSchema>;
export const diagnosticFileSchema = z
  .object({ version: z.literal(1), session: z.string(), runs: z.array(runDiagnosticSchema).max(32) })
  .strict();
export const phaseLabels: Record<RunPhase, string> = {
  host: '宿主处理',
  'model-wait': '等待模型首段响应',
  'model-output': '模型输出',
  tool: '工具执行',
  approval: '等待用户确认',
  resource: '等待可用窗口',
};
export function phaseLimits(policy: BudgetPolicy) {
  // Reuse existing configurable budgets, without changing persisted configuration semantics.
  return {
    'model-wait': policy.planningMs,
    'model-output': Math.min(600000, policy.totalMs),
    tool: Math.min(600000, policy.totalMs),
    approval: policy.approvalMs,
    resource: policy.queueMs,
    host: policy.totalMs,
  };
}
export function chargeRun(run: RunDiagnostic, phase: RunPhase, now: number) {
  if (run.endedAt !== undefined) return;
  run.durations[run.phase] += Math.max(0, now - run.at);
  run.at = Math.max(now, run.at);
  run.phase = phase;
}
export function diagnosticText(run: RunDiagnostic | undefined) {
  if (!run) return '本轮阶段计时未记录（历史记录不能补算）';
  const ms = (n: number) => (n / 1000).toFixed(1) + ' 秒';
  const outcome = {
    running: '进行中',
    ended: '本轮结束（不等于总任务验收）',
    cancelled: '已取消',
    error: '执行错误',
    interrupted: '记录中断',
    deadline: '期限已到',
  }[run.outcome];
  return (
    `${phaseLabels[run.phase]} · ${outcome}\n` +
    phases.map((phase) => `${phaseLabels[phase]} ${ms(run.durations[phase])}`).join(' · ') +
    `\n本轮历时 ${ms(run.at - run.startedAt)} · 模型请求 ${run.requests} 次；供应商内部排队/计算用时未知` +
    (run.reason ? '\n' + run.reason : '')
  );
}
