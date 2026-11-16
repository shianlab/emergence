import { z } from 'zod';

export const memoryScope = z.enum(['session', 'project', 'personal']);
export const memoryKind = z.enum(['fact', 'preference', 'policy']);
export const memorySource = z
  .object({
    kind: z.enum(['user', 'task']),
    session: z.string(),
    task: z.string().optional(),
    proof: z.string().optional(),
    note: z.string().max(1000),
  })
  .strict();
const version = z
  .object({
    revision: z.number().int().positive(),
    content: z.string().max(2000),
    source: memorySource,
    at: z.string(),
    action: z.string(),
    actor: z.string(),
  })
  .strict();
export const memoryEntry = z
  .object({
    id: z.string(),
    scope: memoryScope,
    owner: z.string(),
    kind: memoryKind,
    state: z.enum(['candidate', 'approved', 'forgotten']),
    revision: z.number().int().positive(),
    content: z.string().max(2000),
    source: memorySource,
    at: z.string(),
    history: z.array(version).max(10),
    approvedBy: z.string().optional(),
  })
  .strict();
export const memoryFile = z
  .object({ version: z.literal(1), entries: z.array(memoryEntry).max(500) })
  .strict();
export type MemoryEntry = z.infer<typeof memoryEntry>;
export type MemorySource = z.infer<typeof memorySource>;
export type MemoryIdentity = { project: string; session: string };
export function checkedMemoryText(input: string) {
  const text = z.string().trim().min(2).max(2000).parse(input);
  if (
    /-----BEGIN .*PRIVATE KEY|\b(?:sk|ghp|github_pat)-?[A-Za-z0-9_]{20,}|(?:api[_ -]?key|access[_ -]?token|password|密码|密钥)\s*[:=：]\s*\S+/i.test(
      text,
    )
  )
    throw new Error('记忆含疑似密钥或敏感凭据，未写入；请先去除');
  return text;
}
