import { stripVTControlCharacters } from 'node:util';
const credentialNames = new Set<string>();
export function registerSecretNames(names: readonly string[]) {
  names.forEach((name) => credentialNames.add(name));
}

/** Diagnostics must not include environment values or credential-bearing URLs. */
export function safeError(error: unknown): string {
  return createRedactor()(error);
}

/** One synchronous presentation pass only; never retain across events or awaits. */
export function createRedactor(): typeof safeError {
  const secrets: string[] = [];
  // On Windows every environment value lookup crosses the native boundary.
  // Enumerate once per pass, reading only possible credentials. Independent
  // safeError calls and subsequent passes always observe current credentials.
  for (const key of Object.keys(process.env)) {
    if (!/(KEY|TOKEN|SECRET|PASSWORD)/i.test(key) && !credentialNames.has(key)) continue;
    const value = process.env[key];
    if (value && value.length >= 4) secrets.push(value);
  }
  return (error) => redact(error, secrets);
}

function redact(error: unknown, secrets: readonly string[]): string {
  let text = error instanceof Error ? error.message : String(error);
  for (const value of secrets) text = text.replaceAll(value, '[已隐藏]');
  // Provider/MCP errors may contain credentials not present in this process environment.
  text = text.replace(/https?:\/\/[^\s"'<>]+/gi, (value) => {
    try {
      const url = new URL(value);
      let changed = false;
      if (url.username || url.password) {
        url.username = '';
        url.password = '';
        changed = true;
      }
      for (const name of [...url.searchParams.keys()]) {
        if (
          /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|signature|sig|x-amz-signature)$/i.test(
            name,
          )
        ) {
          url.searchParams.set(name, '[已隐藏]');
          changed = true;
        }
      }
      return changed ? url.toString() : value;
    } catch {
      return value;
    }
  });
  return stripVTControlCharacters(text.replace(/(Bearer|Basic)\s+[^\s"']+/gi, '$1 [已隐藏]')).replace(
    /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,
    '',
  );
}
