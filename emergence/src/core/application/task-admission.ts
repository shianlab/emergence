import { contractSchema, TASK_CONTEXT_CHARS, type Contract } from '../domain/orchestration.ts';
import { planDependencyIssues, type TaskPlan } from '../domain/planning.ts';
import { bindProjectContract, projectRef } from './project-contract.ts';

/** Build the final contract before declaring a plan executable. Never truncate constraints. */
export function planTaskContract(plan: TaskPlan, step: TaskPlan['steps'][number]): Contract {
  const context = JSON.stringify({
    background: { objective: plan.objective, note: '总目标仅作背景，不扩大项目与局部验收范围。' },
    constraints: plan.constraints,
    nonGoals: plan.nonGoals,
    assumptions: plan.assumptions,
    evidence: plan.evidence,
    capabilities: step.capabilities,
  });
  if (context.length > TASK_CONTEXT_CHARS) {
    throw new Error(
      `${step.id} 的完整任务上下文为 ${context.length} 字符，超过 ${TASK_CONTEXT_CHARS} 字符预算；请精简重复说明或拆成有明确依赖的批次，不能省略约束与验收项`,
    );
  }
  return contractSchema.parse({
    role: step.role,
    scope: step.scope,
    acceptance: step.acceptance,
    context,
    binding: bindProjectContract(step),
  });
}

export function assertPlanAdmission(plan: TaskPlan, contextChars: number): void {
  const issues = planDependencyIssues(plan);
  if (issues.length) throw new Error(issues.join('；'));
  const length = JSON.stringify(plan).length;
  if (length > contextChars - 3000) {
    throw new Error(
      `绑定后的计划超过当前上下文预算（${length}/${contextChars - 3000} 字符）；请减少步骤、精简重复描述或拆成有明确依赖的批次，保留必要约束与验收项`,
    );
  }
  if (plan.goalContract) {
    if (JSON.stringify(plan.goalContract.criteria.map((c) => c.text)) !== JSON.stringify(plan.acceptance))
      throw new Error('总目标契约丢失或改写了验收要求');
    for (const c of plan.goalContract.criteria) {
      const expected = plan.steps.flatMap((s) =>
        (s.localCriteria ?? []).flatMap((v, criterion) =>
          v.requirementId === c.id ? [{ step: s.id, criterion }] : [],
        ),
      );
      if (!expected.length || JSON.stringify(expected) !== JSON.stringify(c.contributors))
        throw new Error('总目标缺少完整的局部验收归属：' + c.id);
      const projects = new Set(
        expected.map((e) => projectRef(plan.steps.find((s) => s.id === e.step)!.project).id),
      );
      if (
        projects.size > 1 &&
        expected.some((e) => plan.steps.find((s) => s.id === e.step)!.acceptance[e.criterion] === c.text)
      )
        throw new Error('跨项目共同验收必须说明各项目局部贡献，不能复制全局要求');
    }
    if (
      plan.steps.some((s) =>
        s.localCriteria?.some((c) => !plan.goalContract!.criteria.some((g) => g.id === c.requirementId)),
      )
    )
      throw new Error('局部验收引用了不存在的总目标要求');
  }
  for (const step of plan.steps) planTaskContract(plan, step);
}
