import { z } from 'zod';
import { toolContract, toolPath } from './tool-contract.ts';
export const permissionModes = ['plan', 'ask', 'edit', 'auto'] as const;
export const permissionModeSchema = z.enum(permissionModes);
export type PermissionMode = z.infer<typeof permissionModeSchema>;
export const permissionLabels: Record<PermissionMode, string> = {
  plan: '计划',
  ask: '询问',
  edit: '自动编辑',
  auto: '自动执行',
};
export const permissionRuleSchema = z
  .object({
    tool: z.string().regex(/^[A-Za-z0-9_.:-]+\*?$/),
    effect: z.enum(['allow', 'ask', 'deny']),
    path: z
      .string()
      .min(1)
      .max(4000)
      .refine(
        (p) =>
          !/[?\x00]/.test(p) && (!p.includes('*') || (p.endsWith('/**') && !p.slice(0, -3).includes('*'))),
        '路径只支持字面路径或末尾 /**',
      )
      .optional(),
    command: z.string().min(1).max(16000).optional(),
    agent: z.string().min(1).max(128).optional(),
  })
  .strict();
export const permissionsSchema = z
  .object({
    defaultMode: permissionModeSchema.default('edit'),
    rules: z.array(permissionRuleSchema).max(100).default([]),
  })
  .strict();
export const permissionSnapshotSchema = z
  .object({
    mode: permissionModeSchema,
    root: z.string(),
    rules: z.array(permissionRuleSchema),
    revision: z.number().int().nonnegative().optional(),
    deny: z.array(z.string()),
    confirm: z.array(z.string()),
  })
  .strict();
export type PermissionSnapshot = z.infer<typeof permissionSnapshotSchema>;
export type PermissionCall = { name: string; arguments: unknown; cwd: string; actor: string };
export type PermissionDecision = { effect: 'allow' | 'ask' | 'deny'; reason: string; explicitAsk?: boolean };
export function toolMatches(pattern: string, name: string) {
  return pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern;
}

export interface PermissionPaths {
  canonical(path: string, cwd: string): string;
  within(root: string, target: string): boolean;
}
export function evaluatePermissionWithPaths(
  policy: PermissionSnapshot,
  call: PermissionCall,
  paths: PermissionPaths,
): PermissionDecision {
  const args =
    call.arguments && typeof call.arguments === 'object' ? (call.arguments as Record<string, unknown>) : {};
  try {
    const root = paths.canonical(policy.root, policy.root);
    const contract = toolContract(call.name, args),
      rawPath = toolPath(args);
    const matches = (pattern: string) =>
      [call.name, ...(contract.policyAliases ?? [])].some((name) => toolMatches(pattern, name));
    const path = rawPath === undefined ? undefined : paths.canonical(rawPath, call.cwd);
    const rules = policy.rules.filter(
      (rule) =>
        matches(rule.tool) &&
        (rule.agent === undefined || rule.agent === call.actor) &&
        (rule.command === undefined || rule.command === args.command) &&
        (rule.path === undefined ||
          (path !== undefined &&
            (rule.path.endsWith('/**')
              ? paths.within(paths.canonical(rule.path.slice(0, -3), policy.root), path)
              : paths.canonical(rule.path, policy.root) === path))),
    );
    if (policy.deny.some(matches) || rules.some((r) => r.effect === 'deny'))
      return { effect: 'deny', reason: '权限规则禁止此操作' };
    const read = contract.permission === 'read';
    if (policy.mode === 'plan' && !read)
      return { effect: 'deny', reason: '计划模式禁止写入、命令和执行派发；请先切换权限模式' };
    if (policy.confirm.some(matches) || rules.some((r) => r.effect === 'ask'))
      return { effect: 'ask', reason: '显式规则要求逐次确认', explicitAsk: true };
    if (read) return { effect: 'allow', reason: '结构化读取与问答' };
    if (policy.mode === 'auto' && rules.some((r) => r.effect === 'allow'))
      return { effect: 'allow', reason: '已配置的自动执行范围' };
    if (
      ['edit', 'auto'].includes(policy.mode) &&
      contract.permission === 'edit' &&
      path &&
      paths.within(root, path)
    )
      return { effect: 'allow', reason: '项目内普通编辑' };
    if (contract.permission === 'delegate') return { effect: 'allow', reason: '子任务继承权限上限' };
    return {
      effect: 'ask',
      reason: path && !paths.within(root, path) ? '项目外操作需要确认' : '此操作需要确认',
    };
  } catch {
    return { effect: 'deny', reason: '无法可靠解析权限路径，已阻止调用' };
  }
}
export function evaluatePermissionsWithPaths(
  policies: PermissionSnapshot[],
  call: PermissionCall,
  paths: PermissionPaths,
): PermissionDecision {
  const results = policies.map((p) => evaluatePermissionWithPaths(p, call, paths));
  return (
    results.find((r) => r.effect === 'deny') ??
    results.find((r) => r.explicitAsk) ??
    results.find((r) => r.effect === 'ask') ?? { effect: 'allow', reason: '所有权限约束允许' }
  );
}
