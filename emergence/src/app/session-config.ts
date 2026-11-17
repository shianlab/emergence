import type { PermissionMode } from '../core/domain/permissions.ts';
import type { AppConfig } from '../core/domain/configuration.ts';
export interface LaunchConfig {
  home: string;
  cwd: string;
  modelId: string;
  explicitModel?: boolean;
  permissionMode?: PermissionMode;
  resume?: string;
  fresh?: boolean;
  template?: string;
  prompt?: string;
  approvedCommands?: string[];
  hydratedCredentials?: string[];
  appConfig: AppConfig;
}
