import { z } from 'zod';
import { coreConfigSchema } from './contracts.ts';
import { instructionsSchema } from './instructions.ts';
import { orchestrationSchema } from './orchestration.ts';
import { permissionsSchema } from './permissions.ts';
import { uiSchema } from './ui-preferences.ts';
const endpoint = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
    );
  }, '端点需要 http/https 地址，不能含用户名、密码或查询参数');
export const modelSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9_-]{1,32}$/),
    provider: z.string().min(1),
    model: z.string().min(1),
    api: z.enum(['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai']),
    baseURL: endpoint,
    apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    contextWindow: z.number().int().positive().default(128000),
    maxTokens: z.number().int().positive().default(8192),
    capabilities: z
      .object({ tools: z.boolean().optional(), vision: z.boolean().optional() })
      .strict()
      .optional(),
  })
  .strict();
export const mcpSchema = z
  .object({
    serverName: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
    transport: z.literal('stdio'),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    cwd: z.string().optional(),
    enabled: z.boolean().default(true),
  })
  .strict();
export const extensionSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]{0,23}$/),
    module: z.string().min(1),
    enabled: z.boolean().default(true),
  })
  .strict();
export const toolPolicySchema = z
  .object({
    deny: z
      .array(z.string().regex(/^[A-Za-z0-9_-]+\*?$/))
      .max(100)
      .default([]),
    confirm: z
      .array(z.string().regex(/^[A-Za-z0-9_-]+\*?$/))
      .max(100)
      .default([]),
  })
  .strict();
export const configSchema = z
  .object({
    version: z.literal(1),
    defaultModel: z.string(),
    models: z.array(modelSchema).min(1),
    windowModels: z
      .object({
        single: z.string().optional(),
        master: z.string().optional(),
        worker: z.string().optional(),
        slots: z.record(z.string().regex(/^(?:[2-9]|1[0-6])$/), z.string()).default({}),
      })
      .strict()
      .default({ slots: {} }),
    mcp: z.array(mcpSchema).default([]),
    skillDirs: z.array(z.string()).default([]),
    shellMode: z.enum(['ask-local', 'sandbox']).default('ask-local'),
    ui: uiSchema.default(() => uiSchema.parse({})),
    toolPolicy: toolPolicySchema.default({ deny: [], confirm: [] }),
    permissions: permissionsSchema.default(() => permissionsSchema.parse({})),
    instructions: instructionsSchema.default(() => instructionsSchema.parse({})),
    orchestration: orchestrationSchema.default(() => orchestrationSchema.parse({})),
    core: coreConfigSchema.default(() => coreConfigSchema.parse({})),
    extensions: z.array(extensionSchema).max(32).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.models.map((m) => m.id)).size !== value.models.length)
      ctx.addIssue({ code: 'custom', message: '模型配置 ID 不能重复' });
    if (!value.models.some((m) => m.id === value.defaultModel))
      ctx.addIssue({ code: 'custom', message: 'defaultModel 必须指向已有配置' });
    for (const id of [
      value.windowModels.single,
      value.windowModels.master,
      value.windowModels.worker,
      ...Object.values(value.windowModels.slots),
    ]) {
      if (id && !value.models.some((m) => m.id === id))
        ctx.addIssue({ code: 'custom', message: '窗口默认模型必须指向已有配置' });
    }
    if (new Set(value.mcp.map((m) => m.serverName)).size !== value.mcp.length)
      ctx.addIssue({ code: 'custom', message: 'MCP 名称不能重复' });
    if (new Set(value.extensions.map((m) => m.id)).size !== value.extensions.length)
      ctx.addIssue({ code: 'custom', message: '扩展 ID 不能重复' });
  });
export type AppConfig = z.infer<typeof configSchema>;
export type ModelConfig = z.infer<typeof modelSchema>;
export const defaultConfig: AppConfig = {
  version: 1,
  defaultModel: 'deepseek',
  windowModels: { slots: {} },
  models: [
    {
      id: 'deepseek',
      provider: 'deepseek',
      model: 'deepseek-flash',
      api: 'openai-completions',
      baseURL: 'https://api.deepseek.com/v1',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      contextWindow: 128000,
      maxTokens: 8192,
    },
  ],
  mcp: [],
  skillDirs: [],
  shellMode: 'ask-local',
  ui: uiSchema.parse({}),
  toolPolicy: { deny: [], confirm: [] },
  permissions: permissionsSchema.parse({}),
  instructions: instructionsSchema.parse({}),
  orchestration: orchestrationSchema.parse({}),
  core: coreConfigSchema.parse({}),
  extensions: [],
};
