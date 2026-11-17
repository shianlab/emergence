import { canonicalPermissionPath } from '../adapters/permissions.ts';
import { isReadOnlyTask, type TaskRecord } from '../domain/task.ts';
import { toolContract, toolPath } from '../domain/tool-contract.ts';
import { containsPath } from './project-contract.ts';
import { projectViolation } from './project-contract.ts';
export function scopesOverlap(a: string[], b: string[]) {
  return a.some((x) => b.some((y) => containsPath(x, y) || containsPath(y, x)));
}

export function tasksConflict(a: TaskRecord, b: TaskRecord) {
  try {
    if (
      a.allocation?.paths &&
      b.allocation?.paths &&
      a.allocation.access === 'read' &&
      b.allocation.access === 'read'
    )
      return false;
    const paths = (t: TaskRecord) =>
      (t.allocation?.paths ?? [t.cwd, ...(t.contract?.binding?.readProjects.map((p) => p.root) ?? [])]).map(
        (p) => canonicalPermissionPath(p, t.cwd),
      );
    return scopesOverlap(paths(a), paths(b));
  } catch {
    return true;
  }
}
/** Only host-allocated file tasks get concurrency; their declared paths are enforced. */
export function allocationViolation(task: TaskRecord, name: string, args: unknown, cwd = task.cwd) {
  const contract = toolContract(name, args);
  if (
    isReadOnlyTask(task) &&
    (contract.sideEffect || (contract.operation !== 'read' && contract.resource !== 'none'))
  )
    return '只读任务契约禁止写入、Shell 和额外副作用；角色偏好不能扩大已声明的执行能力';
  const violation = projectViolation(task, name, args, cwd);
  if (violation) return violation;
  if (!task.allocation?.paths) return;
  if (contract.resource === 'file' && contract.parallelFileTask) {
    const path = toolPath(args);
    if (typeof path !== 'string') return '并行文件任务必须提供明确路径';
    try {
      const root = canonicalPermissionPath(task.cwd, task.cwd),
        target = canonicalPermissionPath(path, task.cwd);
      const paths = task.allocation.paths.map((p) => canonicalPermissionPath(p, task.cwd));
      if (
        !containsPath(root, target) ||
        paths.some((p) => !containsPath(root, p)) ||
        !paths.some((p) => containsPath(p, target))
      )
        return '操作超出任务已声明范围，请说明范围缺口并修订计划';
    } catch {
      return '任务路径无法可靠解析';
    }
    return;
  }
  if (contract.resource === 'none' && contract.parallelFileTask) return;
  return '并行文件任务不允许额外命令、检索或外部副作用；请修订计划，改用独占任务';
}
