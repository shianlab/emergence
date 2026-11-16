import { z } from 'zod';
import { workProposalSchema, materializeProposal } from './plan-proposal.ts';
import type { Requirements } from './requirements.ts';

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
export type WorkDraft = z.infer<typeof workDraftSchema>;
export const draftReferenceSchema = z
  .object({
    requirementRevision: revision,
    draftRevision: z.number().int().nonnegative(),
  })
  .strict();
export const draftStepInputSchema = draftReferenceSchema.extend({ step: draftStepSchema }).strict();
export const draftRemoveInputSchema = draftReferenceSchema.extend({ id: z.string().min(1).max(32) }).strict();
export const draftCommitInputSchema = draftReferenceSchema
  .extend({
    reason: z.string().trim().min(1).max(1000),
    evidence: workProposalSchema.shape.evidence,
    assumptions: workProposalSchema.shape.assumptions.default([]),
  })
  .strict();
export function newWorkDraft(requirements: Requirements): WorkDraft {
  return {
    version: 1,
    requirementRevision: requirements.revision,
    revision: 0,
    edits: 0,
    status: 'editing',
    steps: [],
  };
}
export function assertDraftReference(
  draft: WorkDraft,
  input: z.infer<typeof draftReferenceSchema>,
  requirements: Requirements,
) {
  if (
    draft.requirementRevision !== requirements.revision ||
    input.requirementRevision !== requirements.revision
  )
    throw new Error('STALE_REQUIREMENTS：需求已变化，不能使用旧草稿；读取当前分析回执');
  if (input.draftRevision !== draft.revision)
    throw new Error(`STALE_DRAFT：当前草稿版本为 ${draft.revision}；先读取草稿摘要再修改`);
  if (draft.status !== 'editing') throw new Error('DRAFT_SEALED：完整图已提交，不重复编辑或派发');
}
export function draftProgress(draft: WorkDraft, requirements: Requirements) {
  const covered = new Set(draft.steps.flatMap((s) => s.requirementIds));
  const ids = new Set(draft.steps.map((s) => s.id));
  return {
    requirementRevision: draft.requirementRevision,
    draftRevision: draft.revision,
    status: draft.status,
    steps: draft.steps.map(({ id, objective, project, requirementIds, dependsOn }) => ({
      id,
      objective,
      project,
      requirementIds,
      dependsOn,
    })),
    uncovered: requirements.items
      .filter((r) => r.kind === 'acceptance' && !covered.has(r.id))
      .map((r) => r.id),
    missingDependencies: [...new Set(draft.steps.flatMap((s) => s.dependsOn).filter((id) => !ids.has(id)))],
    remainingEdits: 48 - draft.edits,
  };
}
export function editWorkDraft(
  draft: WorkDraft,
  requirements: Requirements,
  input: z.infer<typeof draftStepInputSchema> | z.infer<typeof draftRemoveInputSchema>,
): WorkDraft {
  assertDraftReference(draft, input, requirements);
  if (draft.edits >= 48) throw new Error('DRAFT_EDIT_BUDGET：草稿修订次数已用完');
  let steps = draft.steps.filter((s) => s.id !== ('step' in input ? input.step.id : input.id));
  if ('step' in input) {
    const s = input.step;
    // The partial boundary validates local references; graph-wide coverage,
    // cycles, resource matching and permission admission remain at commit.
    const known = new Map(requirements.items.map((r) => [r.id, r]));
    if (s.requirementIds.some((id) => !known.has(id)))
      throw new Error('UNKNOWN_REQUIREMENT：子任务引用了未知需求');
    if (!s.requirementIds.some((id) => known.get(id)?.kind === 'acceptance'))
      throw new Error('MISSING_ACCEPTANCE：子任务必须承担验收要求');
    if (
      s.localCriteria.some(
        (c) =>
          !s.requirementIds.includes(c.requirementId) || known.get(c.requirementId)?.kind !== 'acceptance',
      )
    )
      throw new Error('INVALID_LOCAL_CRITERION：局部验收必须引用本步骤承担的验收编号');
    if (
      s.requirementIds.some(
        (id) => known.get(id)?.kind === 'acceptance' && !s.localCriteria.some((c) => c.requirementId === id),
      )
    )
      throw new Error('MISSING_LOCAL_CRITERION：每项验收须有局部贡献');
    if (s.dependsOn.includes(s.id)) throw new Error('SELF_DEPENDENCY：子任务不能依赖自身');
    if (s.readProjects?.length && s.purpose !== 'user-check')
      throw new Error('INTEGRATION_REQUIRED：跨项目读取需独立 user-check 子任务');
    const index = draft.steps.findIndex((item) => item.id === s.id);
    steps.splice(index < 0 ? steps.length : index, 0, structuredClone(s));
  } else if (steps.length === draft.steps.length) throw new Error('UNKNOWN_STEP：草稿中不存在该步骤');
  return workDraftSchema.parse({ ...draft, steps, revision: draft.revision + 1, edits: draft.edits + 1 });
}
export function composeWorkDraft(
  draft: WorkDraft,
  requirements: Requirements,
  input: z.infer<typeof draftCommitInputSchema>,
) {
  assertDraftReference(draft, input, requirements);
  const proposal = workProposalSchema.parse({
    requirementRevision: requirements.revision,
    steps: draft.steps,
    reason: input.reason,
    evidence: input.evidence,
    assumptions: input.assumptions,
    unknowns: [],
    options: [],
    suggestions: [],
    conflicts: [],
  });
  // Preserve the original global requirements; no defaults may erase coverage.
  materializeProposal(proposal, requirements);
  return proposal;
}
