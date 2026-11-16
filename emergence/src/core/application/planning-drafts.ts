import type { Agent } from '@deepseek-ai/dsh-agent';
import type { z } from 'zod';
import type { CorePlanning } from './planning-service.ts';
import { bindProjectContract, projectRef } from './project-contract.ts';
import { parseProtocol } from '../adapters/tool-protocol.ts';
import { orchestrationLimits } from '../domain/run-budget.ts';
import { contractSchema } from '../domain/orchestration.ts';
import { evaluatePermissions } from '../adapters/permissions.ts';
import { freezeVerification } from './verification.ts';
import {
  newWorkDraft,
  editWorkDraft,
  composeWorkDraft,
  draftProgress,
  draftStepInputSchema,
  draftRemoveInputSchema,
  draftCommitInputSchema,
} from '../domain/work-draft.ts';

type Host = Pick<
  CorePlanning,
  | 'c'
  | 'state'
  | 'states'
  | 'enabled'
  | 'config'
  | 'environment'
  | 'coordinatorRole'
  | 'save'
  | 'submit'
  | 'planningBudget'
>;

/** Edits the existing session plan record; only CorePlanning.submit can admit a graph. */
export class PlanningDrafts {
  private operations = new WeakMap<Agent, Promise<unknown>>();
  constructor(private host: Host) {}
  prepare(agent: Agent) {
    const s = this.host.state(agent).value;
    if (
      this.host.config.submission === 'steps' &&
      this.host.coordinatorRole(agent) &&
      s.requirements &&
      !s.draft
    )
      s.draft = newWorkDraft(s.requirements);
  }
  summary(agent: Agent) {
    const s = this.host.states.get(agent)?.value;
    return s?.draft && s.requirements ? draftProgress(s.draft, s.requirements) : null;
  }
  budget(agent: Agent) {
    const model = this.host.c.executionModel(agent);
    const outputTokens =
      model?.maxTokens ??
      this.host.c.launch.appConfig.models.find((m) => m.id === this.host.c.launch.modelId)?.maxTokens ??
      8192;
    const active = this.host.planningBudget()?.a.timing?.active ?? 0;
    const planningMs = this.host.c.launch.appConfig.orchestration.budgets.planningMs;
    return {
      model: model?.model ?? null,
      outputTokens,
      reasoning:
        /^(glm-5\.3|glm-5\.3-flash)$/i.test(model?.model ?? '') &&
        /(^|\.)(bigmodel\.cn|z\.ai)$/.test(new URL(model!.baseURL).hostname)
          ? 'required-by-provider'
          : 'provider-default-or-unknown',
      reasoningEffort: agent.model.current()?.reasoningEffort ?? null,
      stepChars: Math.min(
        4000,
        this.host.config.contextChars - 3000,
        Math.max(512, Math.floor(outputTokens * 0.75)),
      ),
      planningMs,
      remainingMs: Math.max(0, Math.floor(planningMs - active)),
      remainingModelSteps: Math.max(
        0,
        orchestrationLimits.planningSteps - (this.host.states.get(agent)?.value.autonomy?.steps ?? 0),
      ),
      policy:
        '思考与工具输出共用模型输出额度；每次仅提交一个子任务。保留原规划期限，不自动增加额度或切换模型。',
    };
  }
  private serial<T>(agent: Agent, signal: AbortSignal, action: () => Promise<T>) {
    const previous = this.operations.get(agent) ?? Promise.resolve();
    const job = previous
      .catch(() => {})
      .then(async () => {
        const r = this.host.state(agent);
        await r.loaded;
        signal.throwIfAborted();
        if (
          !this.host.enabled ||
          !this.host.coordinatorRole(agent) ||
          this.host.config.submission !== 'steps'
        )
          throw new Error('当前不是分步规划主控');
        if (r.storageError) throw new Error(r.storageError);
        if (r.value.executions?.length) throw new Error('任务图已经派发，不能编辑或再次提交');
        if (r.value.autonomy?.decision || this.host.planningBudget()?.exceeded)
          throw new Error('本轮规划已停止；草稿保留，等待用户新指令');
        if (!r.value.analysis || !r.value.requirements || !r.value.draft)
          throw new Error('先完成需求分析，再编辑草稿');
        if (r.value.analysis.intent === 'clarify' || r.value.analysis.questions?.length)
          throw new Error('关键问题待答，不能编辑工作图');
        return action();
      });
    this.operations.set(agent, job);
    return job;
  }
  private async validateProject(agent: Agent, step: z.infer<typeof draftStepInputSchema>['step']) {
    const projects = this.host.environment?.().windows.map((w) => projectRef(w.controller.cwd)) ?? [];
    const project = projectRef(step.project);
    if (!projects.some((p) => p.id === project.id))
      throw new Error('PROJECT_CHANGED：草稿项目不在当前工作台，需修改步骤或恢复项目绑定');
    if (step.projectId && step.projectId !== project.id)
      throw new Error('PROJECT_CHANGED：项目物理目录已变化，旧草稿不可重绑');
    for (const path of step.readProjects ?? [])
      if (!projects.some((p) => p.id === projectRef(path).id))
        throw new Error('PROJECT_CHANGED：读取项目未登记');
    const binding = bindProjectContract({
      ...step,
      projectId: project.id,
      acceptance: step.localCriteria.map((c) => c.text),
    });
    // Immutable verification configuration must already be observable. Check it
    // while the model can still repair a draft; dispatch recaptures the baseline.
    const policies = [this.host.c.permissionSnapshot(), ...this.host.c.permissionConstraints(agent)];
    await freezeVerification(
      contractSchema.parse({ scope: step.scope, acceptance: step.localCriteria.map((c) => c.text), binding }),
      (file_path) =>
        evaluatePermissions(policies, {
          name: 'read',
          arguments: { file_path },
          cwd: step.project,
          actor: agent.id,
        }).effect === 'allow',
    );
    return { ...step, projectId: project.id };
  }
  edit(agent: Agent, input: unknown, signal: AbortSignal, remove = false) {
    return this.serial(agent, signal, async () => {
      const r = this.host.state(agent);
      const args = remove
        ? parseProtocol(draftRemoveInputSchema, input)
        : parseProtocol(draftStepInputSchema, input);
      if ('step' in args) {
        if (JSON.stringify(args.step).length > this.budget(agent).stepChars)
          throw new Error(
            `STEP_OUTPUT_BUDGET：单项草稿限 ${this.budget(agent).stepChars} 字符；精简描述或拆成有依赖的子任务`,
          );
        args.step = await this.validateProject(agent, args.step);
      }
      signal.throwIfAborted();
      if (this.host.state(agent) !== r) throw new Error('PROJECT_CHANGED：保存期间会话项目已变化');
      const next = editWorkDraft(r.value.draft!, r.value.requirements!, args);
      if (JSON.stringify(next).length > this.host.config.contextChars - 3000)
        throw new Error('DRAFT_CONTEXT_BUDGET：完整草稿超出上下文准入预算，请缩减后再提交');
      r.value.draft = next;
      r.value.status = 'draft';
      r.value.plan = undefined;
      r.value.requirementBinding = undefined;
      r.value.issues = [];
      this.host.save(r);
      await r.write;
      if (r.storageError) throw new Error(r.storageError);
      signal.throwIfAborted();
      this.host.c.changed();
      return {
        ...this.summary(agent),
        budget: this.budget(agent),
        note: '已持久化草稿；尚未派发。逐项继续提交，全部准备好后用 emergence_plan_commit。',
      };
    });
  }
  commit(agent: Agent, input: unknown, signal: AbortSignal) {
    return this.serial(agent, signal, async () => {
      const r = this.host.state(agent);
      const args = parseProtocol(draftCommitInputSchema, input);
      for (const step of r.value.draft!.steps) await this.validateProject(agent, step);
      signal.throwIfAborted();
      if (this.host.state(agent) !== r) throw new Error('PROJECT_CHANGED：封存期间会话项目已变化');
      const proposal = composeWorkDraft(r.value.draft!, r.value.requirements!, args);
      const result = await this.host.submit(agent, proposal, signal, true);
      signal.throwIfAborted();
      if (r.value.status === 'ready') {
        r.value.draft!.status = 'sealed';
        this.host.save(r);
        await r.write;
        if (r.storageError) throw new Error(r.storageError);
      }
      return {
        status: result.status,
        issues: result.issues,
        planId: result.planId,
        draft: this.summary(agent),
        note: result.note,
      };
    });
  }
}
