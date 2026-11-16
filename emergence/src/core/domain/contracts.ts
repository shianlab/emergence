import { z } from 'zod';
import { planningConfigSchema } from './planning.ts';

export const coreConfigSchema = z
  .object({
    mode: z.enum(['observe', 'off']).default('observe'),
    planning: planningConfigSchema.default(() => planningConfigSchema.parse({})),
  })
  .strict();
export type CoreMode = z.infer<typeof coreConfigSchema>['mode'];
export const stageIds = [
  'Critical',
  'Fetch',
  'Thinking',
  'Execution',
  'Review',
  'Meta-Review',
  'Verification',
  'Evolution',
] as const;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const sourcePath = z
  .string()
  .min(1)
  .max(300)
  .refine((p) => !p.startsWith('/') && !p.includes('\\') && !p.includes(':') && !p.split('/').includes('..'));
const strings = z.array(z.string().min(1).max(4000)).max(100);
export const catalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    policyVersion: z.literal('emergence-core-0.2.0'),
    source: z
      .object({
        name: z.literal('Meta_Kim'),
        version: z.literal('3.7.3'),
        archiveSha256: hash,
        license: z.literal('Apache-2.0'),
      })
      .strict(),
    roles: z
      .array(
        z
          .object({
            id: z.string().regex(/^meta-[a-z]+$/),
            name: z.string().min(1).max(50),
            responsibility: z.string().min(1).max(4000),
            boundary: z.string().min(1).max(2000),
            notResponsibleFor: z.string().min(1).max(2000),
            source: sourcePath,
            sha256: hash,
            executionAuthority: z.literal(false),
          })
          .strict(),
      )
      .length(9),
    stages: z
      .array(
        z
          .object({
            id: z.enum(stageIds),
            name: z.string().min(1).max(50),
            owner: z.string().min(1).max(100),
            inputs: strings,
            outputs: strings,
            skipConditions: strings,
          })
          .strict(),
      )
      .length(8),
    businessPhases: z
      .array(
        z
          .object({
            id: z.string().min(1).max(50),
            name: z.string().min(1).max(50),
            relatedStages: z.array(z.enum(stageIds)).min(1).max(8),
          })
          .strict(),
      )
      .length(11),
    dependencies: z
      .array(
        z
          .object({
            id: z.string().min(1).max(100),
            upstreamEligibility: z.string().max(100),
            emergenceStatus: z.literal('not-connected'),
            phase: z.number().int().min(2).max(6),
          })
          .strict(),
      )
      .max(100),
    methodology: strings.min(4),
    sourceAssets: z
      .array(z.object({ path: sourcePath, sha256: hash }).strict())
      .min(16)
      .max(100),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const items of [
      value.roles.map((r) => r.id),
      value.stages.map((s) => s.id),
      value.businessPhases.map((p) => p.id),
      value.sourceAssets.map((s) => s.path),
      value.dependencies.map((d) => d.id),
    ]) {
      if (new Set(items).size !== items.length) ctx.addIssue({ code: 'custom', message: '核心资产 ID 重复' });
    }
    if (value.stages.some((s, i) => s.id !== stageIds[i]))
      ctx.addIssue({ code: 'custom', message: '核心阶段顺序错误' });
    const expectedRoles = [
      'conductor',
      'scout',
      'artisan',
      'genesis',
      'prism',
      'warden',
      'sentinel',
      'librarian',
      'chrysalis',
    ].map((id) => 'meta-' + id);
    if (expectedRoles.some((id) => !value.roles.some((role) => role.id === id)))
      ctx.addIssue({ code: 'custom', message: '内置治理职责缺失' });
    const expectedPhases = [
      'direction',
      'planning',
      'execution',
      'review',
      'meta_review',
      'revision',
      'verify',
      'summary',
      'feedback',
      'evolve',
      'mirror',
    ];
    if (value.businessPhases.some((phase, index) => phase.id !== expectedPhases[index]))
      ctx.addIssue({ code: 'custom', message: '业务阶段顺序错误' });
    for (const role of value.roles)
      if (!value.sourceAssets.some((s) => s.path === role.source && s.sha256 === role.sha256))
        ctx.addIssue({ code: 'custom', message: '角色来源未绑定资产摘要' });
    for (const stage of value.stages)
      if (stage.owner.startsWith('meta-') && !value.roles.some((r) => r.id === stage.owner))
        ctx.addIssue({ code: 'custom', message: '阶段负责人不存在' });
  });
export type CoreCatalog = z.infer<typeof catalogSchema>;

export const permissionFactSchema = z
  .object({
    modes: z
      .array(z.enum(['plan', 'ask', 'edit', 'auto']))
      .min(1)
      .max(32),
    toolKind: z.enum(['read', 'write', 'shell', 'delegate', 'other']),
    legacyDecision: z.enum(['allow', 'ask', 'deny']),
  })
  .strict();
export type PermissionFact = z.infer<typeof permissionFactSchema>;
/** Only an invariant comparison. No execution, permission grants, or route selection. */
export function comparePermission(fact: PermissionFact) {
  const input = permissionFactSchema.parse(fact);
  const shadowDecision =
    input.modes.includes('plan') && ['write', 'shell', 'delegate'].includes(input.toolKind)
      ? ('deny' as const)
      : ('not-assessed' as const);
  return {
    shadowDecision,
    comparison:
      shadowDecision === 'not-assessed'
        ? ('not-assessed' as const)
        : input.legacyDecision === shadowDecision
          ? ('consistent' as const)
          : ('disagreement' as const),
  };
}

export const instructionLayers = [
  { id: 'core', name: '内置身份与边界', authority: 'immutable-runtime-policy' },
  { id: 'configuration', name: '用户配置', authority: 'validated-explicit-settings' },
  { id: 'project', name: 'EMERGENCE.md 与兼容项目指引', authority: 'scoped-guidance-no-permission-grant' },
  { id: 'task', name: '本次用户目标', authority: 'task-scope-within-runtime-permissions' },
  { id: 'evidence', name: '检索、工具结果与外部资料', authority: 'data-not-execution-authority' },
] as const;

export const observationSchema = z
  .object({
    sequence: z.number().int().positive(),
    at: z.string().datetime(),
    kind: z.enum([
      'observer-bound',
      'model-step',
      'permission-check',
      'tool-finished',
      'run-idle',
      'run-error',
    ]),
    actorKey: hash,
    toolKind: permissionFactSchema.shape.toolKind.optional(),
    legacyDecision: permissionFactSchema.shape.legacyDecision.optional(),
    shadowDecision: z.enum(['deny', 'not-assessed']).optional(),
    comparison: z.enum(['consistent', 'disagreement', 'not-assessed']).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      v.kind === 'permission-check' &&
      (!v.toolKind || !v.legacyDecision || !v.shadowDecision || !v.comparison)
    )
      ctx.addIssue({ code: 'custom', message: '权限观察字段缺失' });
  });
export type Observation = z.infer<typeof observationSchema>;
export const observationSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    policyVersion: z.literal('emergence-core-0.2.0'),
    purpose: z.literal('observation-only-not-execution-checkpoint'),
    scopeKey: hash,
    lastSequence: z.number().int().nonnegative(),
    events: z.array(observationSchema).max(128),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      (!v.events.length && v.lastSequence !== 0) ||
      (v.events.length && v.events.at(-1)!.sequence !== v.lastSequence) ||
      v.events.some((e, i) => i > 0 && e.sequence !== v.events[i - 1].sequence + 1)
    )
      ctx.addIssue({ code: 'custom', message: '观察记录序列不连续' });
  });
export type ObservationSnapshot = z.infer<typeof observationSnapshotSchema>;
