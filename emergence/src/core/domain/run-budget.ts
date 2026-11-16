import { z } from 'zod';

export const orchestrationLimits = Object.freeze({
  pollMs: 250,
  taskExecutionMs: 600000,
  planningSteps: 24,
  teamExecutionMs: 1800000,
  teamSteps: 1200,
  teamActions: 96,
  teamRepairs: 12,
});

export const budgetPolicySchema = z
  .object({
    queueMs: z.number().int().min(1000).max(3600000).default(600000),
    approvalMs: z.number().int().min(1000).max(7200000).default(1800000),
    totalMs: z.number().int().min(1000).max(14400000).default(3600000),
    planningMs: z.number().int().min(1000).max(600000).default(180000),
  })
  .strict();
export const runClockSchema = z
  .object({
    at: z.number(),
    mode: z.enum(['active', 'waiting', 'queued', 'paused']),
    active: z.number().nonnegative(),
    waiting: z.number().nonnegative(),
    queued: z.number().nonnegative(),
    paused: z.number().nonnegative(),
  })
  .strict();
export type RunClock = z.infer<typeof runClockSchema>;
export type BudgetPolicy = z.infer<typeof budgetPolicySchema>;
export const budgetReasonSchema = z.enum(['execution', 'approval', 'queue', 'overall']);
export type BudgetReason = z.infer<typeof budgetReasonSchema>;

/** Charge the previous mode before switching. The caller supplies time for deterministic tests. */
export function advanceClock(
  clock: RunClock | undefined,
  startedAt: number,
  mode: RunClock['mode'],
  now: number,
): RunClock {
  const value = clock ?? { at: startedAt, mode, active: 0, waiting: 0, queued: 0, paused: 0 };
  value[value.mode] += Math.max(0, now - value.at);
  value.at = Math.max(value.at, now);
  value.mode = mode;
  return value;
}

export function budgetExceeded(
  clock: RunClock,
  startedAt: number,
  activeMs: number,
  policy: BudgetPolicy,
  now: number,
): BudgetReason | undefined {
  if (now - startedAt >= policy.totalMs) return 'overall';
  if (clock.waiting >= policy.approvalMs) return 'approval';
  if (clock.queued >= policy.queueMs) return 'queue';
  if (clock.active >= activeMs) return 'execution';
}

export const budgetReasons: Record<BudgetReason, string> = {
  execution: '实际执行时长预算已耗尽',
  approval: '等待审批或用户回答超时',
  queue: '排队或等待资源超时',
  overall: '整体历时上限已到（包含暂停和等待）',
};
