import { z } from 'zod';
import { runManifestSchema } from './run-manifest.ts';
import { toolContract } from './tool-contract.ts';
export const receiptSchema = z
  .object({
    id: z.string(),
    tool: z.string(),
    kind: z.enum(['read', 'command', 'other']),
    ok: z.boolean(),
    hash: z.string(),
    argumentsHash: z.string(),
    failure: z.literal('invalid-arguments').optional(),
    path: z.string().optional(),
    fileHash: z.string().optional(),
    exitCode: z.number().optional(),
    fileSize: z.number().int().nonnegative().optional(),
    trailingNewline: z.enum(['LF', 'CRLF', 'none', 'empty']).optional(),
    utf8Bom: z.boolean().optional(),
    queryRoot: z.string().optional(),
    manifest: runManifestSchema.optional(),
    verification: z
      .object({
        id: z.string(),
        projectId: z.string(),
        cwd: z.string(),
        specHash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .optional(),
  })
  .strict();
export type EvidenceReceipt = z.infer<typeof receiptSchema>;
/** Actual checks may run in a process or the host's bounded file verifier, never an ordinary read. */
export function isSuccessfulExecutionCheck(receipt: EvidenceReceipt) {
  return (
    receipt.ok &&
    ((receipt.kind === 'command' && receipt.exitCode === 0) ||
      (receipt.kind === 'read' &&
        receipt.tool === 'emergence_verify_file' &&
        receipt.manifest?.contract.authority === 'host' &&
        receipt.manifest.contract.output === 'file-check' &&
        receipt.manifest.status === 'succeeded' &&
        receipt.manifest.inputs.length === 1 &&
        receipt.manifest.inputs[0].state === 'present' &&
        receipt.manifest.checks.some((c) => c.kind === 'input-version' && c.passed)))
  );
}
/** Read-only computations may yield process receipts; that never authorizes arbitrary shell evidence. */
export function isSuccessfulObservation(receipt: EvidenceReceipt, commands: boolean) {
  if (!receipt.ok) return false;
  if (receipt.kind === 'read') return true;
  if (receipt.kind !== 'command' || receipt.exitCode !== 0) return false;
  const policy = toolContract(receipt.tool);
  return commands || (policy.authority === 'host' && policy.operation === 'read' && !policy.sideEffect);
}
const checkSchema = z
  .object({
    criterion: z.number().int().nonnegative(),
    passed: z.boolean(),
    blocked: z.boolean().optional(),
    receipts: z.array(z.string()).min(1).max(20),
    note: z.string().trim().min(4).max(1000),
  })
  .strict()
  .refine((c) => !c.blocked || !c.passed, '证据受阻不能同时通过');
export const assessmentSchema = z
  .object({
    subject: z.string(),
    kind: z.enum(['review', 'verify']),
    version: z.string(),
    checks: z.array(checkSchema).max(20).optional(),
    submittedAt: z.string().optional(),
  })
  .strict();
export type Assessment = z.infer<typeof assessmentSchema>;
export const claimsSchema = z.array(checkSchema).min(1).max(20);
