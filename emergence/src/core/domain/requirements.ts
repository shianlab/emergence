import { z } from 'zod';
import { localCriterionSchema, type GoalContract } from './project-contract.ts';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().trim().min(1).max(1000);
export const requestSourceSchema = z
  .object({
    messageIds: z.array(z.string().min(1).max(200)).min(1).max(32),
    hash,
    previousRevision: hash.optional(),
    admittedIds: z.array(z.string().min(1).max(200)).min(1).max(32).optional(),
    origin: z
      .object({
        messageIds: z.array(z.string().min(1).max(200)).min(1).max(32),
        hash,
      })
      .strict()
      .optional(),
  })
  .strict();
export const requirementsSchema = z
  .object({
    revision: hash,
    source: requestSourceSchema,
    objective: text,
    items: z
      .array(
        z
          .object({
            id: z.string().regex(/^[can][1-9][0-9]?$/),
            kind: z.enum(['constraint', 'acceptance', 'nonGoal']),
            text,
          })
          .strict(),
      )
      .min(1)
      .max(36),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = new Set<string>();
    for (const [index, item] of value.items.entries()) {
      if (
        ids.has(item.id) ||
        !item.id.startsWith({ constraint: 'c', acceptance: 'a', nonGoal: 'n' }[item.kind])
      )
        ctx.addIssue({ code: 'custom', path: ['items', index, 'id'], message: '需求 ID 重复或类型不符' });
      ids.add(item.id);
    }
    for (const kind of ['constraint', 'acceptance', 'nonGoal'] as const) {
      const count = value.items.filter((item) => item.kind === kind).length;
      if (count > 12 || (kind === 'acceptance' && count === 0))
        ctx.addIssue({ code: 'custom', path: ['items'], message: '各类需求最多 12 项，至少一项验收' });
    }
  });
export const requirementSuggestionsSchema = z
  .array(
    z
      .object({
        kind: z.enum(['constraint', 'acceptance', 'nonGoal']),
        text,
        reason: text,
        sourceIds: z.array(z.string().min(1).max(200)).min(1).max(32),
        conflictsWith: z.array(z.string().regex(/^[can][1-9][0-9]?$/)).max(36),
      })
      .strict(),
  )
  .max(4);
export const requirementChangesSchema = z
  .array(
    z
      .object({
        action: z.enum(['add', 'replace', 'remove']),
        targetId: z
          .string()
          .regex(/^[can][1-9][0-9]?$/)
          .optional(),
        kind: z.enum(['constraint', 'acceptance', 'nonGoal']),
        text: text.optional(),
        sourceId: z.string().min(1).max(200),
        reason: text,
      })
      .strict(),
  )
  .max(12);
export type Requirements = z.infer<typeof requirementsSchema>;
export type RequestSource = z.infer<typeof requestSourceSchema>;
export const requirementBindingSchema = z
  .object({
    revision: hash,
    steps: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/),
            localCriteria: z.array(localCriterionSchema).min(1).max(20).optional(),
            requirementIds: z
              .array(z.string().regex(/^[can][1-9][0-9]?$/))
              .min(1)
              .max(36),
          })
          .strict(),
      )
      .min(1)
      .max(12),
  })
  .strict();

/** IDs are assigned once by the host, never by a plan revision or a text similarity heuristic. */
export function establishRequirements(
  revision: string,
  source: RequestSource,
  analysis: {
    objective: string;
    constraints?: string[];
    acceptance?: string[];
    nonGoals?: string[];
    changes?: z.infer<typeof requirementChangesSchema>;
  },
  inherited?: Requirements,
): Requirements {
  if (inherited) {
    // A continuation preserves existing IDs and text. Only explicit, sourced changes replace them.
    const items = structuredClone(inherited.items);
    const assigned = new Set(items.map((item) => item.id));
    for (const [index, change] of (analysis.changes ?? []).entries()) {
      const fail = (message: string): never => {
        throw new RequirementError('INVALID_REQUIREMENT_CHANGE', `changes.${index}`, message, inherited);
      };
      if (!source.admittedIds?.includes(change.sourceId)) fail('修改必须引用本轮新接纳的用户消息。');
      const target = items.findIndex((item) => item.id === change.targetId);
      if (change.action === 'add') {
        if (change.targetId || !change.text) fail('新增要求需要 text，不填写 targetId。');
        const prefix = { constraint: 'c', acceptance: 'a', nonGoal: 'n' }[change.kind];
        const highest = Math.max(
          0,
          ...[...assigned].filter((id) => id.startsWith(prefix)).map((id) => Number(id.slice(1))),
        );
        const id = prefix + (highest + 1);
        assigned.add(id);
        items.push({ id, kind: change.kind, text: change.text! });
      } else {
        if (target < 0 || items[target].kind !== change.kind) fail('被修改要求不存在或类型不符。');
        if (change.action === 'remove') {
          if (change.text) fail('移除要求不填写 text。');
          items.splice(target, 1);
        } else {
          if (!change.text) fail('替换要求需要 text。');
          items[target].text = change.text!;
        }
      }
    }
    const result = requirementsSchema.parse({ revision, source, objective: analysis.objective, items });
    for (const [field, kind] of [
      ['constraints', 'constraint'],
      ['acceptance', 'acceptance'],
      ['nonGoals', 'nonGoal'],
    ] as const)
      if (
        analysis[field]?.length &&
        JSON.stringify(analysis[field]) !== JSON.stringify(requirementTexts(result, kind))
      )
        throw new RequirementError(
          'EXPLICIT_CHANGE_REQUIRED',
          field,
          '延续任务须保留既有要求；用户修改使用 changes 引用需求编号和本轮消息。未改动字段可省略。',
          inherited,
        );
    return result;
  }
  if (analysis.changes?.length)
    throw new RequirementError(
      'NO_INHERITED_REQUIREMENTS',
      'changes',
      '首次分析直接提取要求，不使用 changes。',
    );
  const groups = [
    ['constraint', 'c', analysis.constraints ?? []],
    ['acceptance', 'a', analysis.acceptance?.length ? analysis.acceptance : [analysis.objective]],
    ['nonGoal', 'n', analysis.nonGoals ?? []],
  ] as const;
  return requirementsSchema.parse({
    revision,
    source,
    objective: analysis.objective,
    items: groups.flatMap(([kind, prefix, values]) =>
      [...new Set(values)].map((text, i) => ({ id: prefix + (i + 1), kind, text })),
    ),
  });
}

export function requirementTexts(requirements: Requirements, kind: Requirements['items'][number]['kind']) {
  return requirements.items.filter((item) => item.kind === kind).map((item) => item.text);
}

/** Recheck materialized data at execution/recovery, not just the model-input boundary. */
export function assertRequirementIntegrity(
  requirements: Requirements,
  plan: {
    objective: string;
    constraints: string[];
    acceptance: string[];
    nonGoals: string[];
    goalContract?: GoalContract;
    steps: Array<{
      id: string;
      acceptance: string[];
      localCriteria?: z.infer<typeof localCriterionSchema>[];
    }>;
  },
  binding: z.infer<typeof requirementBindingSchema> | undefined,
) {
  const fail = (path: string) => {
    throw new RequirementError(
      'REQUIREMENT_INTEGRITY',
      path,
      '计划与已接纳需求不一致，请重新提交计划。',
      requirements,
    );
  };
  if (plan.objective !== requirements.objective) fail('objective');
  if (!binding || binding.revision !== requirements.revision || binding.steps.length !== plan.steps.length)
    fail('requirementBinding');
  for (const step of plan.steps) {
    const references = binding!.steps.filter((item) => item.id === step.id);
    if (references.length !== 1) fail('requirementBinding.steps');
    const items = references[0].requirementIds.map((id) => requirements.items.find((item) => item.id === id));
    if (items.some((item) => !item)) fail('requirementBinding.steps.requirementIds');
    const acceptance = [
      ...new Set(items.filter((item) => item?.kind === 'acceptance').map((item) => item!.text)),
    ];
    if (step.localCriteria) {
      if (
        JSON.stringify(step.localCriteria) !== JSON.stringify(references[0].localCriteria) ||
        JSON.stringify(step.acceptance) !== JSON.stringify(step.localCriteria.map((c) => c.text)) ||
        step.localCriteria.some(
          (c) => !items.some((r) => r?.id === c.requirementId && r.kind === 'acceptance'),
        )
      )
        fail('steps.localCriteria');
    } else if (JSON.stringify(acceptance) !== JSON.stringify(step.acceptance)) fail('steps.acceptance');
  }
  for (const [field, kind] of [
    ['constraints', 'constraint'],
    ['acceptance', 'acceptance'],
    ['nonGoals', 'nonGoal'],
  ] as const)
    if (JSON.stringify(plan[field]) !== JSON.stringify(requirementTexts(requirements, kind))) fail(field);
  if (plan.goalContract) {
    const expected = {
      version: 1,
      revision: requirements.revision,
      criteria: requirements.items
        .filter((r) => r.kind === 'acceptance')
        .map((r) => ({
          id: r.id,
          text: r.text,
          contributors: plan.steps.flatMap((s) =>
            (s.localCriteria ?? []).flatMap((c, criterion) =>
              c.requirementId === r.id ? [{ step: s.id, criterion }] : [],
            ),
          ),
        })),
    };
    if (
      JSON.stringify(plan.goalContract) !== JSON.stringify(expected) ||
      expected.criteria.some((c) => !c.contributors.length)
    )
      fail('goalContract');
    return;
  }
  const covered = new Set(plan.steps.flatMap((step) => step.acceptance));
  if (
    plan.acceptance.some((text) => !covered.has(text)) ||
    [...covered].some((text) => !plan.acceptance.includes(text))
  )
    fail('steps.acceptance');
}

export class RequirementError extends Error {
  constructor(
    readonly code: string,
    readonly path: string,
    message: string,
    readonly requirements?: Requirements,
  ) {
    super(
      JSON.stringify({
        code,
        issues: [{ path, message }],
        retained: requirements && { revision: requirements.revision, items: requirements.items },
        suggestion: '引用保留的需求编号修订步骤；新增目标或授权须来自用户后续输入。',
      }),
    );
  }
}
