import { canonicalPermissionPath } from '../adapters/permissions.ts';
import { planSchema, type Inventory, type TaskPlan } from '../domain/planning.ts';
import { isFileCapability, toolContract } from '../domain/tool-contract.ts';

import { workPlanSchema, type WorkStep } from '../domain/work-plan.ts';
import { containsPath, projectRef } from './project-contract.ts';
export { containsPath } from './project-contract.ts';
type Rejection = { window: string; code: string; reason: string; retryable: boolean };
export class AllocationUnavailable extends Error {
  constructor(
    readonly step: string,
    readonly candidates: Rejection[],
  ) {
    super(
      JSON.stringify({
        code: 'NO_ELIGIBLE_WINDOW',
        message: `${step} 无合适执行窗口：${candidates.map((c) => `${c.window}：${c.reason}`).join('；') || '未配置执行窗口'}`,
        issues: [{ path: `steps.${step}`, code: 'allocation_unavailable' }],
        candidates,
        retryable: candidates.some((c) => c.retryable),
      }),
    );
  }
  get retryable() {
    return this.candidates.some((c) => c.retryable);
  }
}
export function scopesOverlap(a: string[], b: string[]) {
  return a.some((x) => b.some((y) => containsPath(x, y) || containsPath(y, x)));
}

function rejection(
  step: WorkStep,
  window: Inventory['windows'][number],
  target: string,
  inventory: Inventory,
  restriction: (step: WorkStep, window: Inventory['windows'][number]) => string | undefined,
): Rejection | undefined {
  const reject = (code: string, reason: string, retryable = false): Rejection => ({
    window: window.id,
    code,
    reason,
    retryable,
  });
  if (window.stale) return reject('stale_snapshot', '快照已变化，等待重新查询', true);
  if (canonicalPermissionPath(window.project, window.project) !== target)
    return reject('project_mismatch', '项目不匹配');
  const missing = step.capabilities.filter((id) => !window.capabilities.includes(id));
  if (missing.length)
    return reject(
      'missing_capability',
      '缺少必需能力：' +
        missing
          .map((id) => {
            const aliases = window.capabilities.filter(
              (available) => available.slice(available.indexOf(':') + 1) === id.slice(id.indexOf(':') + 1),
            );
            return id + (aliases.length ? `（该窗口实际登记：${aliases.join(', ')}）` : '（该窗口未登记）');
          })
          .join(', '),
    );
  if (!inventory.capabilities.some((c) => c.id === 'model:' + window.model && c.callable))
    return reject('model_unavailable', '模型尚不可调用');
  const denied = restriction(step, window);
  if (denied) return reject('permission_or_role', denied);
  if (!window.dispatchable)
    return reject(
      window.profile?.state ?? 'not_queueable',
      window.profile?.reason ?? '窗口不可排队',
      inventory.mode === 'collaborate' &&
        window.profile?.position === 'worker' &&
        ['busy', 'waiting-user', 'human-controlled', 'unavailable'].includes(window.profile.state),
    );
}

/** Hard eligibility first; preference and load only rank eligible windows. */
export function allocateWork(
  input: unknown,
  inventory: Inventory,
  project: string,
  admission: string,
  restriction: (step: WorkStep, window: Inventory['windows'][number]) => string | undefined,
): TaskPlan {
  const draft = workPlanSchema.parse(input),
    loads = new Map<string, number>();
  const steps = draft.steps.map((step, index) => {
    const target = canonicalPermissionPath(step.project ?? project, project),
      rejected: Rejection[] = [];
    if (step.projectId && step.projectId !== projectRef(target).id)
      throw new Error('项目 ID 与目标目录不匹配');
    for (const extra of step.readProjects ?? [])
      if (!inventory.windows.some((w) => projectRef(w.project).id === projectRef(extra).id))
        throw new Error('集成读取项目未登记');
    const paths = step.scope.map((p, pathIndex) => {
      if (/[\x00*?]/.test(p)) throw new Error(`${step.id}：scope 必须是具体文件或目录，不能使用通配符`);
      let path: string;
      try {
        path = canonicalPermissionPath(p, target);
      } catch (error) {
        throw new Error(
          JSON.stringify({
            code: 'INVALID_SCOPE_PATH',
            issues: [
              {
                path: `steps.${index}.scope.${pathIndex}`,
                message: `范围必须是具体文件或目录路径，不得含命令或说明；${error instanceof Error ? error.message : '路径无效'}`,
              },
            ],
          }),
        );
      }
      if (!containsPath(target, path)) throw new Error(`${step.id}：范围超出目标项目`);
      return path;
    });
    const candidates = inventory.windows
      .filter((w) => w.id !== inventory.currentWindow)
      .flatMap((w) => {
        const failure = rejection(step, w, target, inventory, restriction);
        if (failure) {
          rejected.push(failure);
          return [];
        }
        const preferred = w.profile?.preference === step.role,
          assigned = loads.get(w.id) ?? 0;
        const backlog =
          (w.profile?.queued ?? 0) + (w.profile?.running ?? (w.profile?.state === 'busy' ? 1 : 0));
        const score =
          (preferred ? 30 : w.profile?.preference === 'auto' ? 10 : 0) +
          (w.profile?.state === 'idle' ? 10 : 0) -
          (assigned + backlog) * 50 +
          Math.min(
            8,
            (w.capabilityFacts ?? []).filter((c) => c.verified && step.capabilities.includes(c.id)).length *
              2,
          );
        return [{ w, score, preferred, assigned, backlog }];
      })
      .sort((a, b) => b.score - a.score || a.w.id.localeCompare(b.w.id));
    const selected = candidates[0];
    if (!selected) throw new AllocationUnavailable(step.id, rejected);
    const { w, preferred, assigned, backlog } = selected;
    loads.set(w.id, assigned + 1);
    const bounded =
      !step.readProjects?.length && step.capabilities.length > 0 && step.capabilities.every(isFileCapability);
    return {
      ...step,
      project: w.project,
      projectId: projectRef(w.project).id,
      window: w.id,
      session: w.session,
      model: w.model,
      allocation: {
        access:
          step.capabilities.length > 0 &&
          step.capabilities.every(
            (id) => id.startsWith('tool:') && toolContract(id.slice(5)).operation === 'read',
          )
            ? 'read'
            : 'write',
        reason: `项目与必需能力匹配；${preferred ? '符合角色偏好' : '按可用能力分配'}；${w.profile?.state === 'idle' ? '窗口空闲' : '等待当前任务'}；已有队列/运行 ${backlog} 项；本图新增 ${assigned} 项任务`,
        ...(bounded
          ? {
              paths,
            }
          : {}),
      },
    };
  });
  return planSchema.parse({ ...draft, admission, steps });
}
