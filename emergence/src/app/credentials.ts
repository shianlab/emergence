import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { replaceJsonFile } from '../core/storage/safe-json-file.ts';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { registerSecretNames, registerSecretSource } from '../core/adapters/redaction.ts';
import { canonicalDirectory, withLease } from '../core/storage/lease.ts';
import {
  registerModelEnvironmentNames,
  windowsDesktopEnvironment,
  windowsPowerShell,
} from '../platform/child-environment.ts';
import { pathIdentity } from '../platform/path-policy.ts';

const envelopeSchema = z.object({ version: z.literal(1), encrypted: z.string().min(1) }).strict();
const secretsSchema = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().min(1));
const filename = 'credentials.dpapi.json';
const stores = new Map<string, Record<string, string>>();
const loading = new Map<string, Promise<void>>();
const shellOverrides = new Map<string, string>();
let isolated = false;
const homeKey = (home: string) => pathIdentity(resolve(home));
const environmentKey = (name: string) => (process.platform === 'win32' ? name.toUpperCase() : name);
const shellValue = (name: string) =>
  shellOverrides.get(environmentKey(name)) || process.env[name] || undefined;
const storedValue = (home: string, name: string) => {
  const saved = stores.get(homeKey(home));
  return saved && Object.hasOwn(saved, name) ? saved[name] : undefined;
};
registerSecretSource(function* () {
  yield* shellOverrides.values();
  for (const stored of stores.values()) yield* Object.values(stored);
});

export function registerModelCredentials(names: readonly string[]) {
  registerSecretNames(names);
  registerModelEnvironmentNames(names);
  if (isolated)
    for (const name of names) {
      const value = process.env[name];
      if (!value) continue;
      shellOverrides.set(environmentKey(name), value);
      delete process.env[name];
    }
}
export function credentialSource(home: string, name: string): 'encrypted' | 'environment' | 'missing' {
  return shellValue(name) ? 'environment' : storedValue(home, name) ? 'encrypted' : 'missing';
}

/** The launcher uses its existing private Node IPC channel for explicit shell overrides. */
export function receiveShellCredentials(names: readonly string[]): Promise<void> {
  const send = process.send?.bind(process);
  if (!send || !process.connected) return Promise.reject(new Error('模型凭据通道未连接'));
  const allowed = new Set(names);
  return new Promise((done, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      process.off('message', receive);
      process.off('disconnect', disconnected);
    };
    const fail = () => {
      cleanup();
      reject(new Error('无法从启动进程接收模型凭据'));
    };
    const disconnected = () => fail();
    const receive = (message: unknown) => {
      if (
        !message ||
        typeof message !== 'object' ||
        !('type' in message) ||
        message.type !== 'emergence-model-credentials'
      )
        return;
      const parsed = secretsSchema.safeParse('values' in message ? message.values : undefined);
      if (!parsed.success || Object.keys(parsed.data).some((name) => !allowed.has(name))) {
        fail();
        return;
      }
      cleanup();
      isolated = true;
      for (const [name, value] of Object.entries(parsed.data))
        shellOverrides.set(environmentKey(name), value);
      registerModelCredentials(names);
      done();
    };
    const timer = setTimeout(fail, 10000);
    process.on('message', receive);
    process.once('disconnect', disconnected);
    send({ type: 'emergence-model-credentials-request' }, (error) => {
      if (error) fail();
    });
  });
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
    const executable = windowsPowerShell();
    const child = spawn(
      executable,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      {
        cwd: dirname(executable),
        env: windowsDesktopEnvironment(),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
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
    stores.set(homeKey(home), validated);
  });
}

export async function prepareModelCredentials(home: string, names: readonly string[]): Promise<void> {
  registerModelCredentials(names);
  const key = homeKey(home);
  if (stores.has(key) || names.every((name) => shellValue(name))) return;
  let pending = loading.get(key);
  if (!pending) {
    pending = readCredentials(home)
      .then((stored) => {
        if (!stores.has(key)) stores.set(key, stored);
      })
      .finally(() => loading.delete(key));
    loading.set(key, pending);
  }
  await pending;
}

/** Explicit shell values win. DPAPI values stay in the process-local store. */
export async function resolveCredential(home: string, name: string): Promise<string | undefined> {
  await prepareModelCredentials(home, [name]);
  return shellValue(name) ?? storedValue(home, name);
}
