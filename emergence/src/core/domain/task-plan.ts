import { z } from 'zod';
import { goalContractSchema, localCriterionSchema, verificationSpecSchema } from './project-contract.ts';
const text = z.string().trim().min(1).max(1000);
const texts = z.array(text).max(12);
export const planSchema = z
  .object({
    objective: text,
    constraints: texts,
    goalContract: goalContractSchema.optional(),
    acceptance: texts.min(1),
    nonGoals: texts,
    unknowns: z
      .array(
        z
          .object({
            question: text,
            impact: z.enum(['outcome', 'permission', 'route']),
            blocking: z.boolean(),
          })
          .strict(),
      )
      .max(8),
    assumptions: texts,
    options: z.array(z.object({ name: text, tradeoff: text }).strict()).max(4),
    conflicts: texts.default([]),
    reason: text,
    evidence: z
      .array(z.string().max(200))
      .max(24)
      .describe(
        '仅填写成功读取工具的原始 callId，例如 call_abc；不得填写说明文字、文件内容或用户声明。没有读取证据时填 []。',
      ),
    admission: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    steps: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/),
            objective: text,
            window: z.string().min(1).max(128),
            session: z.string().min(1).max(128),
            project: z
              .string()
              .min(1)
              .max(4000)
              .describe('项目的绝对目录路径，必须与实时窗口项目匹配；不是项目名称或说明。'),
            model: z.string().min(1).max(128),
            projectId: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .optional(),
            readProjects: z
              .array(z.string().min(1).max(4000))
              .max(15)
              .optional()
              .describe('仅集成检查声明的其他已登记项目绝对目录；不授权写入或绕过权限。'),
            localCriteria: z
              .array(localCriterionSchema)
              .min(1)
              .max(20)
              .optional()
              .describe('本项目的具体验收项；requirementId 关联总目标，text 只描述本步骤负责的结果。'),
            verifications: z
              .array(verificationSpecSchema)
              .max(8)
              .optional()
              .describe(
                '检查命令及输入、不可修改的配置/脚本，criteria 对应本步骤验收下标；仍通过普通 Shell 权限执行。',
              ),
            role: z.string().min(1).max(64),
            capabilities: z
              .array(z.string().min(1).max(300))
              .max(16)
              .describe(
                '完整能力 ID，逐字复制清单，例如 tool:read、tool:edit、tool:pwsh；不得省略 tool: 前缀。',
              ),
            dependsOn: z.array(z.string().max(32)).max(12),
            scope: texts
              .min(1)
              .describe(
                '仅含具体文件/目录路径的数组，推荐项目相对路径如 ["notes.txt", "verify.cjs"]。不得放命令、解释、括号注释或权限文字；约束由宿主继承。',
              ),
            acceptance: texts.min(1),
            allocation: z
              .object({
                access: z.enum(['read', 'write']).optional(),
                reason: text,
                paths: z.array(z.string().min(1).max(4000)).min(1).max(12).optional(),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(12),
  })
  .strict();
export type TaskPlan = z.infer<typeof planSchema>;
