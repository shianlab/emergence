import { z } from 'zod';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const path = z.string().min(1).max(4000);
export const projectRefSchema = z.object({ version: z.literal(1), id: hash, root: path }).strict();
export type ProjectRef = z.infer<typeof projectRefSchema>;
export const localCriterionSchema = z
  .object({
    requirementId: z.string().regex(/^a[1-9][0-9]?$/),
    text: z.string().trim().min(1).max(1000),
  })
  .strict();
export const verificationSpecSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/),
    tool: z.enum(['pwsh', 'bash']),
    command: z.string().min(1).max(16000),
    cwd: path.default('.'),
    criteria: z.array(z.number().int().nonnegative()).min(1).max(20),
    inputs: z.array(path).min(1).max(24),
    configuration: z
      .array(path)
      .min(1)
      .max(8)
      .describe(
        '仅填写已存在且必须保持不变的脚本/配置文件路径；不要附加哈希、括号说明或“不得改动”等文字。哈希由宿主采集。',
      ),
  })
  .strict();
export type VerificationSpec = z.infer<typeof verificationSpecSchema>;
export const boundVerificationSchema = verificationSpecSchema
  .extend({
    projectId: hash,
    baseline: z.array(z.object({ path, hash }).strict()).max(8),
  })
  .strict();
export const projectBindingSchema = z
  .object({
    version: z.literal(1),
    project: projectRefSchema,
    readProjects: z.array(projectRefSchema).max(15),
    scope: z.array(path).min(1).max(30),
    criterionIds: z.array(z.string().regex(/^a[1-9][0-9]?$/)).max(20),
    verifications: z.array(boundVerificationSchema).max(8),
  })
  .strict();
export const goalContractSchema = z
  .object({
    version: z.literal(1),
    revision: hash,
    criteria: z
      .array(
        z
          .object({
            id: z.string().regex(/^a[1-9][0-9]?$/),
            text: z.string().min(1).max(1000),
            contributors: z
              .array(z.object({ step: z.string(), criterion: z.number().int().nonnegative() }).strict())
              .min(1)
              .max(24),
          })
          .strict(),
      )
      .min(1)
      .max(12),
  })
  .strict();
export type GoalContract = z.infer<typeof goalContractSchema>;
