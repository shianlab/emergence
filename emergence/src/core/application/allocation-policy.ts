import { evaluatePermissions } from '../adapters/permissions.ts';
import { roles } from '../domain/orchestration.ts';
import type { PlanWindow } from '../domain/planning.ts';
import type { TaskPlan } from '../domain/task-plan.ts';
import type { SessionPort } from './runtime-ports.ts';

/** Eligibility never changes the actual permission snapshots used at execution. */
export function allocationRestriction(
  source: SessionPort,
  owner: SessionPort | undefined,
  step: TaskPlan['steps'][number],
  window: PlanWindow,
): string | undefined {
  const role = roles(source.launch.appConfig.orchestration).find((role) => role.id === step.role);
  if (!role || !owner) return '角色或窗口不存在';
  if (role.modelId && role.modelId !== window.model) return '角色要求的模型不匹配';
  if (role.skills.some((skill) => !window.capabilities.includes('skill:' + skill))) return '缺少角色所需技能';
  const policy = source.permissionSnapshot();
  const policies = [
    policy,
    ...source.permissionConstraints(source.agent),
    owner.permissionSnapshot(),
    ...owner.permissionConstraints(owner.agent),
    { mode: role.mode, root: owner.cwd, rules: role.rules, deny: role.deny, confirm: [] },
  ];
  for (const capability of step.capabilities) {
    const name = capability.startsWith('tool:')
      ? capability.slice(5)
      : capability.startsWith('mcp-tool:')
        ? capability.slice(9)
        : undefined;
    // Scope includes read-only references too. Actual calls still pass their exact argument guard.
    if (
      name &&
      step.scope.every(
        (file_path) =>
          evaluatePermissions(policies, {
            name,
            arguments: { file_path },
            cwd: owner.cwd,
            actor: owner.agent.id,
          }).effect === 'deny',
      )
    )
      return `角色或窗口权限在全部任务路径上禁止必需工具 ${name}`;
  }
}
