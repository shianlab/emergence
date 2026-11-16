import { z } from 'zod';

/** Host-owned observations. A resolution links evidence; it never deletes the failure. */
export const taskFailureSchema = z
  .object({
    callId: z.string().optional(),
    tool: z.string().optional(),
    detail: z.string().max(1000),
    resolution: z
      .object({
        kind: z.enum(['read-retry', 'submission', 'code-repair']),
        by: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type TaskFailure = z.infer<typeof taskFailureSchema>;

/** Older results have no structured observations; retain their conservative semantics. */
export function unresolvedTaskErrors(task: {
  result?: { errors: readonly string[]; failures?: readonly TaskFailure[] };
}): string[] {
  return task.result?.failures
    ? task.result.failures.filter((f) => !f.resolution).map((f) => f.detail)
    : [...(task.result?.errors ?? [])];
}
