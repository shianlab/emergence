import { z } from 'zod';
import { coordinationSchema } from '../domain/legacy-coordination.ts';
import { goalContractSchema } from '../domain/project-contract.ts';
import { taskStateSchema, type TaskState } from '../domain/task-state.ts';
import { taskSchema, type TaskRecord } from '../domain/task.ts';
const legacyTaskStateSchema = z
  .object({
    version: z.literal(1),
    mode: z.enum(['independent', 'collaborate']),
    paused: z.boolean(),
    master: z.string().optional(),
    workers: z.array(z.string()).max(15),
    owned: z.array(z.string()).max(16),
    tasks: z.array(taskSchema).max(500),
    autoWorkers: z.boolean().optional(),
    coordinations: z.array(coordinationSchema).max(500).optional(),
    goalContracts: z
      .array(z.object({ plan: z.string(), goal: goalContractSchema }).strict())
      .max(500)
      .optional(),
  })
  .strict();

export const storedTaskStateSchema = z
  .union([taskStateSchema, legacyTaskStateSchema])
  .transform((value): z.input<typeof taskStateSchema> => {
    if (value.version === 2) return value;
    const { tasks, paused, goalContracts, version: _version, ...history } = value;
    return { version: 2 as const, paused, tasks, goalContracts, history };
  })
  .pipe(taskStateSchema);

/** Historical objective lookup is read-only; it never reconstructs a scheduler. */
export function historicalObjective(state: TaskState, task: TaskRecord): string | undefined {
  const related = new Set<string>();
  const visit = (item: TaskRecord) => {
    if (related.has(item.id)) return;
    related.add(item.id);
    for (const id of [item.repairOf, item.recoveryOf, item.assessment?.subject]) {
      const parent = state.tasks.find((t) => t.id === id);
      if (parent) visit(parent);
    }
  };
  visit(task);
  const record = state.history?.coordinations?.find((r) => r.executions.some((id) => related.has(id)));
  return record?.analysis?.objective ?? record?.request;
}
