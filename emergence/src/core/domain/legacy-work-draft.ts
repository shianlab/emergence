import { z } from 'zod';
import { workProposalSchema } from './plan-proposal.ts';

const revision = z.string().regex(/^[a-f0-9]{64}$/);
/** A draft contains proposals only. It is never an executable task graph. */
export const draftStepSchema = workProposalSchema.shape.steps.element
  .omit({ subject: true })
  .extend({
    purpose: z.enum(['delivery', 'user-check']),
    project: z.string().min(1).max(4000),
    localCriteria: workProposalSchema.shape.steps.element.shape.localCriteria.unwrap(),
    dependsOn: z
      .array(z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/))
      .max(12)
      .default([]),
  })
  .strict();
export const workDraftSchema = z
  .object({
    version: z.literal(1),
    requirementRevision: revision,
    revision: z.number().int().nonnegative(),
    edits: z.number().int().min(0).max(48),
    status: z.enum(['editing', 'sealed']),
    steps: z.array(draftStepSchema).max(12),
  })
  .strict();
