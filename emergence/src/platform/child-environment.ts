import { join } from 'node:path';

const modelNames = new Set<string>();
export function registerModelEnvironmentNames(names: readonly string[]) {
  for (const name of names) modelNames.add(name.toUpperCase());
}

/** Launch tooling without implicit model keys. Explicit tool configuration is applied separately. */
export function childEnvironment({ harness = false } = {}): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !modelNames.has(name.toUpperCase()) && (harness || !/(KEY|TOKEN|SECRET|PASSWORD)/i.test(name)),
    ),
  );
}

export function windowsPowerShell() {
  return join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
}

/** Windows PowerShell must discover its own modules when launched by a PowerShell 7 session. */
export function windowsMaintenanceEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(childEnvironment()).filter(([name]) => name.toUpperCase() !== 'PSMODULEPATH'),
  );
}

/** Windows profile and system module discovery for bundled, local desktop helpers. */
export function windowsDesktopEnvironment(): NodeJS.ProcessEnv {
  const { TEMP, TMP, WINDIR, USERPROFILE, APPDATA, LOCALAPPDATA, ProgramFiles, PSModulePath } = process.env;
  const systemRoot = process.env.SystemRoot ?? 'C:/Windows';
  return {
    SystemRoot: systemRoot,
    Path: join(systemRoot, 'System32'),
    TEMP,
    TMP,
    WINDIR,
    USERPROFILE,
    APPDATA,
    LOCALAPPDATA,
    ProgramFiles,
    PSModulePath,
  };
}
