import { z } from 'zod';
import { assessmentSchema, receiptSchema } from './assurance.ts';
import { contractSchema, roleSchema } from './orchestration.ts';
import { permissionSnapshotSchema } from './permissions.ts';
import { planSchema } from './planning.ts';
import { budgetReasonSchema, runClockSchema } from './run-budget.ts';
import { taskFailureSchema } from './task-failure.ts';

export const taskStatus = z.enum([
  'queued',
  'dispatching',
  'running',
  'waiting_user',
  'succeeded',
  'failed',
  'needs_review',
  'cancelled',
  'blocked',
  'interrupted',
]);
const codeResultSchema = z
  .object({
    runId: z.string(),
    verified: z.boolean(),
    criteriaChanged: z.boolean(),
    paths: z.array(z.string().max(1000)).max(12),
    checks: z
      .array(
        z
          .object({
            callId: z.string(),
            command: z.string().max(1000),
            exitCode: z.number().nullable(),
            status: z.string(),
            version: z.string(),
          })
          .strict(),
      )
      .max(16),
  })
  .strict();
const resultSchema = z
  .object({
    summary: z.string().max(8000),
    errors: z.array(z.string().max(1000)).max(20),
    failures: z.array(taskFailureSchema).max(128).optional(),
    artifacts: z.array(z.string().max(1000)).max(30),
    fromSeq: z.number().int().min(0),
    toSeq: z.number().int().min(0),
    code: codeResultSchema.optional(),
  })
  .strict();
export const taskSchema = z
  .object({
    id: z.string().min(1),
    requestKey: z.string().min(1).max(100),
    objective: z.string().min(1).max(12000),
    issuer: z.string(),
    issuerSession: z.string(),
    target: z.string(),
    targetSession: z.string(),
    cwd: z.string(),
    modelId: z.string(),
    contract: contractSchema.optional(),
    role: roleSchema.optional(),
    rolePermission: permissionSnapshotSchema.optional(),
    followup: z.string().max(5000).optional(),
    timing: runClockSchema.optional(),
    timeout: budgetReasonSchema.optional(),
    steps: z.number().int().nonnegative().default(0),
    repairOf: z.string().optional(),
    repairCount: z.number().int().nonnegative().default(0),
    review: z
      .object({
        accepted: z.boolean(),
        evidence: z.string().min(1).max(8000),
        at: z.string(),
        actor: z.enum(['user', 'model']).optional(),
      })
      .strict()
      .optional(),
    assessment: assessmentSchema.optional(),
    receipts: z.array(receiptSchema).max(128).default([]),
    permission: permissionSnapshotSchema.optional(),
    targetPermission: permissionSnapshotSchema.optional(),
    dependsOn: z.array(z.string()).max(30),
    status: taskStatus,
    progress: z.string().max(2000),
    createdAt: z.string(),
    updatedAt: z.string(),
    startedAt: z.string().optional(),
    endedAt: z.string().optional(),
    messageId: z.string().optional(),
    turn: z.number().int().optional(),
    fromSeq: z.number().int().min(0).default(0),
    cancelReason: z.string().optional(),
    notified: z.boolean().default(false),
    result: resultSchema.optional(),
    report: z
      .object({
        outcome: z.enum(['success', 'failed']),
        summary: z.string().max(8000),
        artifacts: z.array(z.string().max(1000)).max(30),
      })
      .strict()
      .optional(),
    notes: z
      .array(z.object({ at: z.string(), text: z.string().max(12000) }).strict())
      .max(50)
      .default([]),
    executionIssues: z
      .array(z.object({ callId: z.string(), tool: z.string(), detail: z.string().max(1000) }).strict())
      .max(20)
      .default([]),
    runId: z.string().optional(),
    fence: z.number().int().optional(),
    local: z.boolean().optional(),
    recoveryOf: z.string().optional(),
    recoveryCount: z.number().int().min(0).max(2).default(0),
    recovery: z.enum(['not-started', 'read-only', 'effects-returned', 'uncertain', 'reconciled']).optional(),
    workflow: z
      .object({ plan: z.string(), step: z.string(), stage: z.enum(['Execution', 'Review', 'Verification']) })
      .strict()
      .optional(),
    artifactVersions: z
      .array(z.object({ path: z.string(), hash: z.string() }).strict())
      .max(30)
      .default([]),
    allocation: planSchema.shape.steps.element.shape.allocation,
  })
  .strict();
export type TaskRecord = Readonly<z.infer<typeof taskSchema>>;
/** Read authority is independent of a preferred role and of concurrency path locks. */
export function isReadOnlyTask(task: Pick<TaskRecord, 'role' | 'allocation' | 'contract'>) {
  return (
    task.role?.mode === 'plan' ||
    task.allocation?.access === 'read' ||
    !!task.contract?.binding?.readProjects.length
  );
}
export const settledTaskStatuses = new Set<TaskRecord['status']>([
  'succeeded',
  'failed',
  'needs_review',
  'cancelled',
  'blocked',
  'interrupted',
]);
export const activeTaskStatuses = new Set<TaskRecord['status']>(['dispatching', 'running', 'waiting_user']);
export const taskLabels: Record<TaskRecord['status'], string> = {
  queued: '排队',
  dispatching: '准备派发',
  running: '执行中',
  waiting_user: '等待用户',
  succeeded: '已完成',
  failed: '失败',
  needs_review: '待检查',
  cancelled: '已取消',
  blocked: '依赖阻塞',
  interrupted: '已中断',
};
