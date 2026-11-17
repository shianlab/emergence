import { z } from 'zod';
import { permissionSnapshotSchema } from './permissions.ts';
import { intentAnalysisSchema } from './intent.ts';
import { runClockSchema } from './run-budget.ts';

export const rolePreferenceSchema = z.string().regex(/^(auto|[a-z][a-z0-9_-]{0,31})$/);
export const teamMemberSchema = z
  .object({
    id: z.string(),
    session: z.string().optional(),
    project: z.string(),
    model: z.string(),
    position: z.enum(['master', 'worker', 'independent']),
    preference: rolePreferenceSchema,
    state: z.enum(['idle', 'busy', 'waiting-user', 'human-controlled', 'unavailable']),
    queued: z.number().int().nonnegative().optional(),
    running: z.number().int().nonnegative().optional(),
    queueable: z.boolean(),
    dispatchable: z.boolean(),
    reason: z.string(),
    task: z.string().optional(),
    assignedRole: z.string().optional(),
    permission: permissionSnapshotSchema.optional(),
  })
  .strict();
export type TeamMember = z.infer<typeof teamMemberSchema>;

/** Intake records, not another execution queue. Original messages remain in Session. */
export const coordinationSchema = z
  .object({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    master: z.string(),
    session: z.string(),
    project: z.string(),
    requestIds: z.array(z.string()).min(1).max(256),
    request: z.string().max(6000),
    createdAt: z.string(),
    updatedAt: z.string(),
    phase: z.enum([
      'received',
      'understood',
      'discussion',
      'waiting-input',
      'planned',
      'dispatched',
      'waiting',
      'reviewing',
      'repairing',
      'paused',
      'completed',
      'cancelled',
      'blocked',
    ]),
    followthrough: z
      .object({
        timing: runClockSchema.optional(),
        startedAt: z.number(),
        maxDurationMs: z.number().positive(),
        maxSteps: z.number().int().positive(),
        maxActions: z.number().int().positive(),
        maxRepairs: z.number().int().nonnegative(),
        actions: z.number().int().nonnegative(),
        summary: z.string().max(24000).optional(),
        notified: z.boolean().optional(),
      })
      .strict()
      .optional(),
    blockReason: z.string().max(1000).optional(),
    waitReason: z.enum(['audit-resource']).optional(),
    assignments: z
      .array(
        z.object({ step: z.string(), window: z.string(), role: z.string(), reason: z.string() }).strict(),
      )
      .max(12)
      .optional(),
    teamAtIntake: z.array(teamMemberSchema).max(16),
    analysis: intentAnalysisSchema.optional(),
    planId: z.string().optional(),
    executions: z.array(z.string()).max(12),
  })
  .strict();
export type CoordinationRecord = z.infer<typeof coordinationSchema>;
