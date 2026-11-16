import { z } from 'zod';
import { planSchema } from './task-plan.ts';
import { workPlanSchema } from './work-plan.ts';
import {
  RequirementError,
  requirementTexts,
  requirementSuggestionsSchema,
  type Requirements,
} from './requirements.ts';

const references = z
  .array(z.string().regex(/^[can][1-9][0-9]?$/))
  .min(1)
  .max(36);
const extensions = {
  requirementRevision: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .describe(
      '必填：逐字复制本轮 emergence_analyze 返回的 requirements.revision。放在 work/plan 对象内部，不放 steps 或兼容 JSON 字段；不能自行生成。',
    ),
  suggestions: requirementSuggestionsSchema.default([]),
};
const owned = {
  objective: true,
  constraints: true,
  acceptance: true,
  nonGoals: true,
  goalContract: true,
} as const;
// Proposal-only classification. Executable plans keep their existing delivery contract;
// host assurance never becomes a second model-authored execution graph.
const purpose = z.enum(['delivery', 'user-check', 'assurance']);
const subject = z.string().trim().min(1).max(80).optional();
export const workProposalSchema = workPlanSchema
  .omit(owned)
  .extend({
    ...extensions,
    steps: z
      .array(
        workPlanSchema.shape.steps.element
          .omit({ acceptance: true })
          .extend({
            requirementIds: references,
            purpose,
            subject,
          })
          .strict(),
      )
      .min(1)
      .max(12),
  })
  .strict();
export const planProposalSchema = planSchema
  .omit({ ...owned, admission: true })
  .extend({
    ...extensions,
    steps: z
      .array(
        planSchema.shape.steps.element
          .omit({ acceptance: true })
          .extend({
            requirementIds: references,
            purpose,
            subject,
          })
          .strict(),
      )
      .min(1)
      .max(12),
  })
  .strict();
type Proposal = z.infer<typeof workProposalSchema> | z.infer<typeof planProposalSchema>;

/** The only conversion from model proposals into executable, immutable requirement text. */
export function materializeProposal(proposal: Proposal, requirements: Requirements) {
  const fail = (code: string, path: string, message: string): never => {
    throw new RequirementError(code, path, message, requirements);
  };
  if (proposal.requirementRevision !== requirements.revision)
    fail('STALE_REQUIREMENTS', 'requirementRevision', '需求版本已失效；使用当前分析回执中的版本。');
  const known = new Map(requirements.items.map((item) => [item.id, item]));
  const covered = new Set<string>();
  for (const [index, step] of proposal.steps.entries()) {
    if (step.purpose === 'assurance')
      fail(
        'HOST_OWNS_ASSURANCE',
        `steps.${index}.purpose`,
        `步骤 ${step.id} 的宿主核验${step.subject ? `（对象 ${step.subject}）` : ''}由执行后的统一核验负责。移除此核验节点及其依赖引用，重新提交交付图；用户明确要求的研究、测试报告或检查交付使用 user-check 并引用其验收编号。`,
      );
    if (
      step.subject &&
      !proposal.steps.some((candidate) => candidate.id === step.subject && candidate.id !== step.id)
    )
      fail('UNKNOWN_SUBJECT', `steps.${index}.subject`, '关联对象必须是本计划中另一个交付步骤。');
    for (const id of step.requirementIds) {
      if (!known.has(id)) fail('UNKNOWN_REQUIREMENT', `steps.${index}.requirementIds`, `不存在的需求：${id}`);
      covered.add(id);
    }
    if (!step.requirementIds.some((id) => known.get(id)?.kind === 'acceptance'))
      fail('MISSING_ACCEPTANCE', `steps.${index}.requirementIds`, '每个交付步骤必须引用至少一项验收要求。');
    if (step.localCriteria) {
      for (const criterion of step.localCriteria)
        if (
          !step.requirementIds.includes(criterion.requirementId) ||
          known.get(criterion.requirementId)?.kind !== 'acceptance'
        )
          fail(
            'INVALID_LOCAL_CRITERION',
            `steps.${index}.localCriteria`,
            '局部验收必须引用本步骤负责的总目标验收编号。',
          );
      for (const id of step.requirementIds.filter((id) => known.get(id)?.kind === 'acceptance'))
        if (!step.localCriteria.some((c) => c.requirementId === id))
          fail('MISSING_LOCAL_CRITERION', `steps.${index}.localCriteria`, `缺少局部验收：${id}`);
    }
    if (step.readProjects?.length && step.purpose !== 'user-check')
      fail(
        'INTEGRATION_REQUIRED',
        `steps.${index}.readProjects`,
        '多项目读取须单列 user-check 集成任务；普通交付不扩大项目范围。',
      );
  }
  const crossProject = new Set(proposal.steps.map((s) => s.project).filter(Boolean)).size > 1;
  if (crossProject)
    for (const [index, step] of proposal.steps.entries()) {
      if (!step.localCriteria)
        fail(
          'LOCAL_CRITERIA_REQUIRED',
          `steps.${index}.localCriteria`,
          '跨项目计划必须逐项声明本项目 localCriteria，不能把总体验收直接复制给每个窗口。',
        );
      for (const c of step.localCriteria ?? []) {
        if (
          c.text === known.get(c.requirementId)?.text &&
          proposal.steps.some(
            (other) =>
              other.id !== step.id &&
              other.project !== step.project &&
              other.requirementIds.includes(c.requirementId),
          )
        )
          fail(
            'GLOBAL_CRITERION_COPIED',
            `steps.${index}.localCriteria`,
            '多个项目共同承担的验收需写出各自局部贡献，原文保留在总目标。',
          );
      }
    }
  for (const item of requirements.items)
    if (item.kind === 'acceptance' && !covered.has(item.id))
      fail('MISSING_ACCEPTANCE', 'steps', `未覆盖验收要求：${item.id}`);
  for (const [index, suggestion] of proposal.suggestions.entries()) {
    if (suggestion.sourceIds.some((id) => !requirements.source.messageIds.includes(id)))
      fail('UNKNOWN_SOURCE', `suggestions.${index}.sourceIds`, '建议引用了不属于当前需求的来源。');
    if (suggestion.conflictsWith.some((id) => !known.has(id)))
      fail('UNKNOWN_REQUIREMENT', `suggestions.${index}.conflictsWith`, '冲突引用不存在。');
  }
  if (proposal.suggestions.length)
    fail(
      'REQUIREMENTS_NEED_INPUT',
      'suggestions',
      '新增需求建议尚未被用户接纳；说明建议及其冲突，等待用户补充。',
    );
  const { requirementRevision: _revision, suggestions: _suggestions, steps, ...rest } = proposal;
  const materialized = steps.map(({ requirementIds, purpose: _purpose, subject: _subject, ...step }) => ({
    ...step,
    localCriteria:
      step.localCriteria ??
      [...new Set(requirementIds)].flatMap((id) => {
        const item = known.get(id)!;
        return item.kind === 'acceptance' ? [{ requirementId: id, text: item.text }] : [];
      }),
  }));
  return {
    ...rest,
    objective: requirements.objective,
    constraints: requirementTexts(requirements, 'constraint'),
    acceptance: requirementTexts(requirements, 'acceptance'),
    nonGoals: requirementTexts(requirements, 'nonGoal'),
    goalContract: {
      version: 1 as const,
      revision: requirements.revision,
      criteria: requirements.items
        .filter((r) => r.kind === 'acceptance')
        .map((r) => ({
          id: r.id,
          text: r.text,
          contributors: materialized.flatMap((s) =>
            s.localCriteria.flatMap((c, criterion) =>
              c.requirementId === r.id ? [{ step: s.id, criterion }] : [],
            ),
          ),
        })),
    },
    steps: materialized.map((step) => ({
      ...step,
      acceptance: step.localCriteria.map((c) => c.text),
    })),
  };
}
