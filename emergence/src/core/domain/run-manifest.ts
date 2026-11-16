import { z } from 'zod';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const resourceVersionSchema = z
  .object({
    path: z.string().max(4000),
    hash: z.string().max(100),
    state: z.enum(['present', 'missing', 'unknown']),
    bytes: z.number().int().nonnegative().optional(),
    kind: z.enum(['file', 'directory']).optional(),
  })
  .strict();

/** Optional on legacy receipts: absence means untracked, never inferred success. */
export const runManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: z.string(),
    runId: z.string().optional(),
    sessionId: z.string(),
    callId: z.string(),
    tool: z.string(),
    contract: z
      .object({
        version: z.literal(1),
        authority: z.enum(['host', 'unknown']),
        input: z.string(),
        output: z.string(),
      })
      .strict(),
    argumentsHash: hash,
    codeHash: hash.optional(),
    resultHash: hash,
    inputs: z.array(resourceVersionSchema).max(32),
    outputs: z.array(resourceVersionSchema).max(32),
    resourceCoverage: z.enum(['file', 'query-snapshot', 'untracked']),
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime(),
    status: z.enum(['succeeded', 'failed', 'cancelled', 'pending']),
    environment: z
      .object({ runtime: z.string(), platform: z.string(), modelId: z.string().optional() })
      .strict(),
    budget: z
      .object({ timeoutMs: z.number().positive().nullable(), outputBytes: z.number().positive().nullable() })
      .strict(),
    checks: z
      .array(
        z
          .object({
            kind: z.enum(['tool-result', 'input-version', 'output-version', 'process-exit']),
            passed: z.boolean(),
          })
          .strict(),
      )
      .max(8),
  })
  .strict();
export type RunManifest = z.infer<typeof runManifestSchema>;
export type ResourceVersion = z.infer<typeof resourceVersionSchema>;
