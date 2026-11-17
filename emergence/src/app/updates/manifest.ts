import { createPublicKey, verify } from 'node:crypto';
import { z } from 'zod';
import trust from './trust.json' with { type: 'json' };

export const stableURL = 'https://raw.githubusercontent.com/shianlab/emergence/main/releases/stable.json';
const version = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
export const manifestSchema = z
  .object({
    schema: z.literal(1),
    product: z.literal('emergence'),
    platform: z.literal('win32-x64'),
    version,
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    minimumInstaller: z.literal(2),
    publishedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    asset: z
      .object({
        url: z.string().url(),
        bytes: z
          .number()
          .int()
          .positive()
          .max(1024 ** 3),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    notes: z
      .string()
      .max(12000)
      .refine((value) => !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(value)),
    notesURL: z.string().url(),
  })
  .strict();
export type ReleaseManifest = z.infer<typeof manifestSchema>;
export interface TrustedKey {
  id: string;
  pem: string;
  status: string;
}
export const trustedKeys: readonly TrustedKey[] = trust.keys;
export function compareVersions(a: string, b: string) {
  const parse = (value: string) => value.split('-')[0].split('.').map(BigInt);
  const aa = parse(a),
    bb = parse(b);
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] > bb[i] ? 1 : -1;
  return a.includes('-') === b.includes('-') ? 0 : a.includes('-') ? -1 : 1;
}
export function verifyManifest(value: unknown, keys = trustedKeys, now = Date.now()): ReleaseManifest {
  const envelope = z
    .object({
      payload: z.string().max(50000),
      signatures: z
        .array(z.object({ keyId: z.string(), signature: z.string().max(2048) }).strict())
        .min(1)
        .max(8),
    })
    .strict()
    .parse(value);
  const bytes = Buffer.from(envelope.payload, 'base64');
  if (
    bytes.toString('base64') !== envelope.payload ||
    !envelope.signatures.some((signature) => {
      const key = keys.find((key) => key.id === signature.keyId && key.status === 'active');
      if (!key) return false;
      try {
        return verify(
          'RSA-SHA256',
          bytes,
          createPublicKey(key.pem),
          Buffer.from(signature.signature, 'base64'),
        );
      } catch {
        return false;
      }
    })
  )
    throw Error('版本清单签名无效，未下载或运行任何更新');
  const manifest = manifestSchema.parse(JSON.parse(bytes.toString('utf8')));
  const base = `https://github.com/shianlab/emergence/releases/download/v${manifest.version}/Emergence-${manifest.version}-win32-x64.zip`;
  if (
    manifest.asset.url !== base ||
    manifest.notesURL !== `https://github.com/shianlab/emergence/releases/tag/v${manifest.version}` ||
    Date.parse(manifest.expiresAt) <= now ||
    Date.parse(manifest.publishedAt) > now + 300000 ||
    Date.parse(manifest.expiresAt) <= Date.parse(manifest.publishedAt)
  )
    throw Error('版本清单的来源、平台或有效期不符合要求');
  return manifest;
}
