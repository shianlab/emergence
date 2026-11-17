import { z } from 'zod';
import { requirementChangesSchema } from './requirements.ts';

const text = z.string().trim().min(1).max(1000);
const texts = z.array(text).max(12);
export const intentAnalysisSchema = z
  .object({
    objective: text,
    reason: text,
    intent: z.enum(['discuss', 'execute', 'clarify']).optional(),
    constraints: texts.optional(),
    acceptance: texts.optional(),
    nonGoals: texts.optional(),
    changes: requirementChangesSchema.optional(),
    questions: z.array(text).max(4).optional(),
  })
  .strict();
export const analysisRequestSchema = intentAnalysisSchema
  .extend({
    route: z.enum(['direct', 'focused', 'planned']),
  })
  .strict();
