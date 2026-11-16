import { z } from 'zod';
import { planSchema } from './task-plan.ts';
export const stepSchema = planSchema.shape.steps.element
  .omit({ window: true, session: true, model: true, allocation: true })
  .extend({ project: planSchema.shape.steps.element.shape.project.optional() });
export const workPlanSchema = planSchema
  .omit({ steps: true, admission: true })
  .extend({ steps: z.array(stepSchema).min(1).max(12) })
  .strict();
export type WorkStep = z.infer<typeof stepSchema>;
