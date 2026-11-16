import type { TaskPlan } from '../domain/planning.ts';
import { digest } from '../storage/execution-journal.ts';
import { allocationRestriction } from './allocation-policy.ts';
import { allocationRevision } from './allocation-snapshot.ts';
import type { WorkspacePort } from './runtime-ports.ts';
import { assertProjectBinding } from './project-contract.ts';
import { planTaskContract } from './task-admission.ts';
export class AllocationChanged extends Error {
  constructor(message: string) {
    super('STALE_ALLOCATION：' + message);
  }
}

/** Exclude presentation/lookup metadata; retries of the same execution graph share one key. */
export function executionGraphKey(session: string | undefined, request: string | undefined, plan: TaskPlan) {
  return digest([
    session,
    request,
    {
      objective: plan.objective,
      constraints: plan.constraints,
      acceptance: plan.acceptance,
      goalContract: plan.goalContract,
      nonGoals: plan.nonGoals,
      assumptions: plan.assumptions,
      steps: plan.steps
        .map(({ allocation, ...step }) => ({
          ...step,
          capabilities: [...step.capabilities].sort(),
          dependsOn: [...step.dependsOn].sort(),
          scope: [...step.scope].sort(),
          allocation: allocation && {
            access: allocation.access,
            paths: allocation.paths && [...allocation.paths].sort(),
          },
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    },
  ]);
}

/** Reobserve after approval; the synchronous guard closes the last async lookup/commit gap. */
export async function observeDispatch(
  workspace: WorkspacePort,
  issuer: string,
  plan: TaskPlan,
  signal?: AbortSignal,
) {
  const source = workspace.panes.get(issuer)?.controller;
  if (!source) throw new Error('派发来源会话不存在');
  const inventory = await source.planning.inventory(source.agent, signal);
  for (const step of plan.steps) {
    assertProjectBinding(
      planTaskContract(plan, step),
      step.project,
      inventory.windows.map((w) => w.project),
    );
    const window = inventory.windows.find((w) => w.id === step.window);
    if (
      !window ||
      window.stale ||
      window.session !== step.session ||
      window.project !== step.project ||
      window.model !== step.model
    )
      throw new AllocationChanged('计划窗口绑定已变化或快照失效，请重新分配');
    if (step.window !== issuer && !window.dispatchable)
      throw new AllocationChanged('目标可用性已变化：' + (window.profile?.reason ?? '目标窗口当前不可派发'));
    if (step.capabilities.some((id) => !window.capabilities.includes(id)))
      throw new Error('CAPABILITY_UNAVAILABLE：目标窗口缺少计划要求的实际能力');
    if (!inventory.capabilities.some((item) => item.id === 'model:' + window.model && item.callable))
      throw new Error('MODEL_UNAVAILABLE：目标模型当前不可调用');
    const reason = allocationRestriction(source, workspace.panes.get(window.id)?.controller, step, window);
    if (reason) throw new Error('PERMISSION_OR_ROLE_UNAVAILABLE：' + reason);
  }
  const revision = inventory.snapshot?.revision;
  return {
    revision: digest([revision, inventory.windows.map((w) => [w.id, w.capabilities])]),
    assertCurrent() {
      if (
        workspace.panes.get(issuer)?.controller !== source ||
        (source.planning.environment && revision !== allocationRevision(source.planning.environment()))
      )
        throw new AllocationChanged('窗口、权限、团队或负载在提交前变化，请重新分配');
    },
  };
}
