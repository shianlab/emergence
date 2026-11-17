import { z } from 'zod';
import { taskSchema, type TaskRecord } from './task.ts';
import { coordinationSchema } from './legacy-coordination.ts';
import { goalContractSchema } from './project-contract.ts';

/** Immutable legacy metadata is carried through checkpoints, never read as live control state. */
const historySchema = z
  .object({
    mode: z.enum(['independent', 'collaborate']),
    master: z.string().optional(),
    workers: z.array(z.string()).max(15),
    owned: z.array(z.string()).max(16),
    autoWorkers: z.boolean().optional(),
    coordinations: z.array(coordinationSchema).max(500).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = value.coordinations?.map((record) => record.id) ?? [];
    const requests =
      value.coordinations?.flatMap((record) => record.requestIds.map((id) => `${record.session}:${id}`)) ??
      [];
    if (new Set(ids).size !== ids.length || new Set(requests).size !== requests.length)
      ctx.addIssue({ code: 'custom', message: '历史主控请求重复登记' });
    if (new Set(value.workers).size !== value.workers.length || value.workers.includes(value.master ?? ''))
      ctx.addIssue({ code: 'custom', message: '历史窗口身份重复登记' });
  });
export const taskStateSchema = z
  .object({
    version: z.literal(2),
    paused: z.boolean(),
    tasks: z.array(taskSchema).max(500),
    history: historySchema.optional(),
    goalContracts: z
      .array(z.object({ plan: z.string(), goal: goalContractSchema }).strict())
      .max(500)
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = value.tasks.map((t) => t.id),
      keys = value.tasks.map((t) => `${t.issuerSession}:${t.requestKey}`);
    if (
      new Set(ids).size !== ids.length ||
      new Set(keys).size !== keys.length ||
      value.tasks.some((t) => t.dependsOn.some((id) => !ids.includes(id) || id === t.id))
    ) {
      ctx.addIssue({ code: 'custom', message: '任务身份、请求标识或依赖无效' });
    }
    const goalIds = value.goalContracts?.map((g) => g.plan) ?? [];
    if (new Set(goalIds).size !== goalIds.length)
      ctx.addIssue({ code: 'custom', message: '总目标契约重复登记' });
    const visited = new Set<string>(),
      active = new Set<string>();
    const visit = (id: string) => {
      if (active.has(id)) {
        ctx.addIssue({ code: 'custom', message: '任务依赖或尝试链成环' });
        return;
      }
      if (visited.has(id)) return;
      visited.add(id);
      active.add(id);
      const t = value.tasks.find((t) => t.id === id);
      for (const dep of t
        ? [
            ...t.dependsOn,
            ...[t.repairOf, t.recoveryOf, t.assessment?.subject].filter((v): v is string => !!v),
          ]
        : []) {
        if (!ids.includes(dep)) ctx.addIssue({ code: 'custom', message: '任务引用不存在' });
        else visit(dep);
      }
      active.delete(id);
    };
    ids.forEach(visit);
  });
export type TaskState = Omit<z.infer<typeof taskStateSchema>, 'tasks'> & { tasks: TaskRecord[] };
export function emptyTaskState(): TaskState {
  return { version: 2, paused: false, tasks: [] };
}
