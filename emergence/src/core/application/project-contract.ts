import { isAbsolute, relative, sep } from 'node:path';
import { canonicalPermissionPath } from '../adapters/permissions.ts';
import { digest } from '../storage/execution-journal.ts';
import { projectBindingSchema, type ProjectRef } from '../domain/project-contract.ts';
import type { Contract } from '../domain/orchestration.ts';
import type { TaskPlan } from '../domain/planning.ts';
import type { TaskRecord } from '../domain/task.ts';
import { toolArguments, toolContract, toolPath } from '../domain/tool-contract.ts';

export function projectRef(root: string): ProjectRef {
  if (!isAbsolute(root)) throw new Error('项目必须是绝对目录');
  const physical = canonicalPermissionPath(root, root);
  return { version: 1, id: digest(['emergence-project-v1', physical]), root: physical };
}
export function containsPath(parent: string, child: string) {
  const r = relative(parent, child);
  return !r || (!isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep));
}
export function scopedPath(root: string, path: string) {
  if (/[\x00*?]/.test(path)) throw new Error('范围必须是具体文件或目录，不能使用通配符');
  const physical = canonicalPermissionPath(path, root);
  if (!containsPath(root, physical)) throw new Error('范围超出目标项目');
  return physical;
}
export function bindProjectContract(
  step: Pick<
    TaskPlan['steps'][number],
    | 'project'
    | 'projectId'
    | 'readProjects'
    | 'scope'
    | 'acceptance'
    | 'localCriteria'
    | 'verifications'
    | 'capabilities'
  >,
) {
  const project = projectRef(step.project);
  if (step.projectId && step.projectId !== project.id) throw new Error('项目 ID 与真实目录不匹配');
  const readProjects = (step.readProjects ?? []).map(projectRef).filter((p) => p.id !== project.id);
  const scope = step.scope.map((p) => scopedPath(project.root, p));
  if (
    step.localCriteria &&
    JSON.stringify(step.acceptance) !== JSON.stringify(step.localCriteria.map((c) => c.text))
  )
    throw new Error('局部验收与执行契约不一致');
  const verifications = (step.verifications ?? []).map((spec) => {
    if (!step.capabilities.includes('tool:' + spec.tool)) throw new Error('验证命令缺少声明的 Shell 能力');
    if (spec.criteria.some((c) => c >= step.acceptance.length))
      throw new Error('验证引用了不存在的局部验收项');
    return {
      ...spec,
      projectId: project.id,
      cwd: scopedPath(project.root, spec.cwd),
      inputs: spec.inputs.map((p) => scopedPath(project.root, p)),
      configuration: spec.configuration.map((p) => scopedPath(project.root, p)),
      baseline: [],
    };
  });
  if (
    new Set(verifications.map((v) => v.id)).size !== verifications.length ||
    new Set(verifications.map((v) => v.tool + ':' + v.cwd + ':' + v.command)).size !== verifications.length
  )
    throw new Error('验证 ID 或命令重复，无法唯一归属');
  return projectBindingSchema.parse({
    version: 1,
    project,
    readProjects,
    scope,
    criterionIds: step.localCriteria?.map((c) => c.requirementId) ?? [],
    verifications,
  });
}
export function assertProjectBinding(contract: Contract, cwd: string, registered: string[]) {
  const b = contract.binding;
  if (!b) return; // Legacy persisted records remain readable, never upgraded to fabricated evidence.
  if (b.project.id !== projectRef(cwd).id || projectRef(b.project.root).id !== b.project.id)
    throw new Error('任务项目绑定已失效');
  const known = new Set(registered.map((p) => projectRef(p).id));
  for (const p of b.readProjects)
    if (!known.has(p.id) || projectRef(p.root).id !== p.id) throw new Error('集成读取项目未登记或绑定已失效');
  for (const path of b.scope) scopedPath(b.project.root, path);
  if (JSON.stringify(b.scope) !== JSON.stringify(contract.scope.map((p) => scopedPath(b.project.root, p))))
    throw new Error('声明范围与宿主绑定不一致');
  for (const spec of b.verifications) {
    if (spec.projectId !== b.project.id) throw new Error('验证不属于当前项目');
    scopedPath(b.project.root, spec.cwd);
    for (const path of [...spec.inputs, ...spec.configuration]) scopedPath(b.project.root, path);
  }
}

/** Structured tools are bounded by host project identity. Shell remains permission-controlled, not an OS sandbox. */
export function projectViolation(task: TaskRecord, name: string, args: unknown, cwd = task.cwd) {
  const b = task.contract?.binding;
  if (!b) return;
  try {
    assertProjectBinding(task.contract!, task.cwd, [b.project.root, ...b.readProjects.map((p) => p.root)]);
    if (canonicalPermissionPath(cwd, cwd) !== b.project.root) return '执行会话实际目录与任务项目绑定不一致';
    const c = toolContract(name, args),
      input = toolArguments(args);
    if (name === 'working_directory' && input.cd !== undefined) return '任务执行期间不能改变已绑定的项目目录';
    if (c.resource === 'none') return;
    if (b.readProjects.length && c.operation === 'write') return '集成任务只读取明确声明的项目，不授权写入';
    if (c.resource === 'file' || c.resource === 'query-root' || c.resource === 'project') {
      const path = canonicalPermissionPath(toolPath(args) ?? '.', task.cwd);
      const roots =
        c.operation === 'write' ? b.scope : [b.project.root, ...b.readProjects.map((p) => p.root)];
      if (!roots.some((root) => containsPath(root, path))) return '操作超出任务项目或声明范围；请修订分工';
      if (c.operation === 'write' && b.verifications.some((v) => v.configuration.includes(path)))
        return '验证脚本/配置已冻结，不能通过修改验收条件求通过';
    }
    if (['pwsh', 'bash'].includes(name)) {
      const cwd =
        typeof input.workdir === 'string'
          ? input.workdir
          : typeof input.cwd === 'string'
            ? input.cwd
            : task.cwd;
      if (!containsPath(b.project.root, canonicalPermissionPath(cwd, task.cwd)))
        return '命令工作目录超出任务项目';
      if (
        task.assessment &&
        b.verifications.length &&
        !b.verifications.some(
          (v) =>
            v.tool === name &&
            v.command === input.command &&
            v.cwd === canonicalPermissionPath(cwd, task.cwd),
        )
      )
        return '独立验证只能执行契约中的精确检查；文件属性和目录清单使用 emergence_inspect';
    }
  } catch (error) {
    return error instanceof Error ? error.message : '任务项目路径无法可靠核对';
  }
}
