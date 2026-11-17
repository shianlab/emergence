import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { safePath } from '../src/app/updates/storage.ts';
import { manifestSchema, verifyManifest } from '../src/app/updates/manifest.ts';

const windows = createRequire(import.meta.url)('../release/installation/windows.cjs');
const directory = join(process.env.USERPROFILE!, '.emergence-publisher');
const file = join(directory, 'signing.dpapi.json');
await safePath(file);
const mode = process.argv[2];
async function protect(value: string, decode = false): Promise<string> {
  return windows.powershell(
    'Add-Type -AssemblyName System.Security;$v=[Console]::In.ReadToEnd();$b=' +
      (decode ? '[Convert]::FromBase64String($v)' : '[Text.Encoding]::UTF8.GetBytes($v)') +
      ';$r=[Security.Cryptography.ProtectedData]::' +
      (decode ? 'Unprotect' : 'Protect') +
      '($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Write(' +
      (decode ? '[Text.Encoding]::UTF8.GetString($r)' : '[Convert]::ToBase64String($r)') +
      ')',
    value,
  );
}
if (mode === 'init') {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
  const jwk = publicKey.export({ format: 'jwk' });
  const id = 'emergence-2026-01';
  const key = {
    id,
    status: 'active',
    pem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    modulus: Buffer.from(jwk.n!, 'base64url').toString('base64'),
    exponent: Buffer.from(jwk.e!, 'base64url').toString('base64'),
  };
  const trust = { schema: 1, keys: [key] };
  await mkdir(directory, { recursive: true });
  await writeFile(
    file,
    JSON.stringify({
      id,
      encrypted: await protect(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()),
    }),
    { flag: 'wx', mode: 0o600 },
  );
  await writeFile('src/app/updates/trust.json', JSON.stringify(trust, null, 2) + '\n');
  const bootstrap = await readFile('../install.ps1', 'utf8');
  if (!bootstrap.includes("$encodedTrust = ''"))
    throw Error('Bootstrap trust anchor already initialized; refusing replacement');
  await writeFile(
    '../install.ps1',
    bootstrap.replace(
      "$encodedTrust = ''",
      "$encodedTrust = '" + Buffer.from(JSON.stringify(trust)).toString('base64') + "'",
    ),
  );
  console.log('已建立发布公钥；私钥仅以当前 Windows 用户的 DPAPI 密文保存在独立发布目录。');
} else if (mode === 'sign') {
  const manifest = manifestSchema.parse(JSON.parse(await readFile(process.argv[3], 'utf8')));
  const saved = JSON.parse(await readFile(file, 'utf8'));
  const bytes = Buffer.from(JSON.stringify(manifest));
  const envelope = {
    payload: bytes.toString('base64'),
    signatures: [
      {
        keyId: saved.id,
        signature: sign('RSA-SHA256', bytes, await protect(saved.encrypted, true)).toString('base64'),
      },
    ],
  };
  verifyManifest(envelope);
  await writeFile(process.argv[4], JSON.stringify(envelope, null, 2) + '\n', { flag: 'wx' });
  console.log('已签名并验证发行清单。');
} else throw Error('用法：release-signing.ts init | sign <manifest.json> <signed.json>');
