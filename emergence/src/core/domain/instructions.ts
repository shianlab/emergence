import { z } from 'zod';
export const instructionsSchema = z
  .object({
    rootMode: z.enum(['git', 'launch']).default('git'),
    agents: z.boolean().default(true),
    claude: z.boolean().default(false),
    maxFileBytes: z.number().int().min(1024).max(262144).default(65536),
    maxTotalBytes: z.number().int().min(4096).max(131072).default(32768),
  })
  .strict();
export type InstructionOptions = z.infer<typeof instructionsSchema>;
