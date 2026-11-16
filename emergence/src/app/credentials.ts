import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { replaceJsonFile } from '../core/storage/safe-json-file.ts';
import { join } from 'node:path';
import { z } from 'zod';
import { registerSecretNames } from '../core/adapters/redaction.ts';
import { canonicalDirectory, withLease } from '../core/storage/lease.ts';

const envelopeSchema = z.object({ version: z.literal(1), encrypted: z.string().min(1) }).strict();
const secretsSchema = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().min(1));
const filename = 'credentials.dpapi.json';
const hydrated = new Map<string, string>();
export function hydratedCredentialNames() {
  return [...hydrated.keys()].filter((name) => process.env[name] === hydrated.get(name));
}
/** The launcher passes names only, so the child can distinguish injected DPAPI keys from shell overrides. */
export function adoptHydratedCredentials(names: readonly string[]) {
  for (const name of names) if (process.env[name]) hydrated.set(name, process.env[name]!);
}
export function credentialSource(name: string): 'encrypted' | 'environment' | 'missing' {
  const value = process.env[name];
  return !value ? 'missing' : hydrated.get(name) === value ? 'encrypted' : 'environment';
}

/** DPAPI binds the ciphertext to the current Windows user; secrets travel only through pipes. */
async function dpapi(value: string, mode: 'Protect' | 'Unprotect'): Promise<string> {
  if (process.platform !== 'win32') throw new Error('加密凭据存储当前仅支持 Windows；其他系统请使用环境变量');
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$payload = [Console]::In.ReadToEnd()
$bytes = ${mode === 'Protect' ? '[Text.Encoding]::UTF8.GetBytes($payload)' : '[Convert]::FromBase64String($payload)'}
$result = [Security.Cryptography.ProtectedData]::${mode}($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write(${mode === 'Protect' ? '[Convert]::ToBase64String($result)' : '[Text.Encoding]::UTF8.GetString($result)'})
`;
  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.resume();
    const timeout = setTimeout(() => child.kill(), 15000);
    child.on('error', () => {
      clearTimeout(timeout);
      reject(new Error('无法启动 Windows 凭据加密服务'));
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0)
        reject(new Error('无法处理加密凭据；请确认仍使用原 Windows 用户，或重新执行 emergence auth'));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    child.stdin.on('error', () => {
      /* Process failure is reported through close/error above. */
    });
    child.stdin.end(value);
  });
}

export async function readCredentials(home: string): Promise<Record<string, string>> {
  let raw: string;
  try {
    raw = await readFile(join(home, filename), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  const envelope = envelopeSchema.parse(JSON.parse(raw));
  return secretsSchema.parse(JSON.parse(await dpapi(envelope.encrypted, 'Unprotect')));
}

export async function saveCredential(home: string, name: string, value: string): Promise<void> {
  await withLease(`credentials:${await canonicalDirectory(home)}`, '加密凭据', async () => {
    const secrets = await readCredentials(home);
    const validated = secretsSchema.parse({ ...secrets, [name]: value });
    const encrypted = await dpapi(JSON.stringify(validated), 'Protect');
    await mkdir(home, { recursive: true });
    await replaceJsonFile(
      join(home, filename),
      { version: 1, encrypted },
      {
        invalidMessage: '加密凭据路径不是普通文件，未覆盖',
        newline: true,
      },
    );
    if ((hydrated.has(name) && process.env[name] === hydrated.get(name)) || !process.env[name]) {
      process.env[name] = value;
      hydrated.set(name, value);
    }
  });
}

export async function hydrateCredentials(home: string, names: readonly string[]): Promise<void> {
  registerSecretNames(names);
  if (names.every((name) => process.env[name])) return;
  const secrets = await readCredentials(home);
  for (const name of names)
    if (!process.env[name] && secrets[name]) {
      process.env[name] = secrets[name];
      hydrated.set(name, secrets[name]);
    }
}

/** Explicit shell values win; values injected from DPAPI can be refreshed after an edit. */
export async function resolveCredential(home: string, name: string): Promise<string | undefined> {
  const value = process.env[name];
  if (value && value !== hydrated.get(name)) return value;
  const stored = (await readCredentials(home))[name];
  if (stored) {
    process.env[name] = stored;
    hydrated.set(name, stored);
  }
  return stored;
}
