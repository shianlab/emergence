import type { Agent } from '@deepseek-ai/dsh-agent';
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm';
import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { safeError } from '../adapters/redaction.ts';
import { analysisRequestSchema } from '../domain/intent.ts';
import { planningConfigSchema, routeRequest, type PlanningState } from '../domain/planning.ts';
import { RequirementError, establishRequirements, requirementTexts } from '../domain/requirements.ts';
import { PlanStore, planScope } from '../storage/plan-store.ts';
type PlanningConfig = ReturnType<typeof planningConfigSchema.parse>;
interface RequestHost {
  readonly enabled: boolean;
  readonly config: PlanningConfig;
  cwd(agent: Agent): string;
  inherited(agent: Agent): boolean;
  register(agent: Agent): void;
  changed(): void;
}
type Runtime = {
  value: PlanningState;
  loaded: Promise<void>;
  write: Promise<void>;
  reading: Set<string>;
  contracted?: boolean;
  storageError?: string;
};
export interface PlanningView {
  value: PlanningState;
  contracted: boolean;
  storageError?: string;
}
export interface PlanningLease {
  value: PlanningState;
  assertCurrent(): void;
  commitExecutions(ids: string[]): void;
}
/** Only owner of request/analysis/plan mutations. Consumers receive detached snapshots. */
export class PlanningRequests {
  private readonly states = new WeakMap<Agent, Runtime>();
  private readonly registered = new WeakSet<Agent>();
  private readonly proposed = new WeakMap<Agent, UserMessage[]>();
  private readonly pending = new Set<Promise<void>>();
  private readonly reviewing = new WeakSet<Runtime>();
  private readonly calls = new WeakMap<Agent, Map<string, { runtime: Runtime; request: string }>>();
  private closed = false;
  constructor(
    private host: RequestHost,
    private store: PlanStore,
  ) {}
  view(agent: Agent): PlanningView | undefined {
    const r = this.states.get(agent);
    return r
      ? { value: structuredClone(r.value), contracted: !!r.contracted, storageError: r.storageError }
      : undefined;
  }
  preview(agent: Agent) {
    return structuredClone(this.proposed.get(agent));
  }
  claim(agent: Agent, message: UserMessage) {
    this.state(agent);
    this.proposed.set(agent, [...(this.proposed.get(agent) ?? []), message]);
  }
  clearClaim(agent: Agent) {
    this.proposed.delete(agent);
  }
  async read(agent: Agent) {
    const r = this.state(agent);
    await r.loaded;
    this.assertCurrent(agent, r, r.value);
    return this.view(agent)!;
  }
  private assertCurrent(agent: Agent, r: Runtime, value: PlanningState) {
    if (
      this.closed ||
      this.states.get(agent) !== r ||
      r.value !== value ||
      r.value.scope !== planScope(agent.session.id, this.host.cwd(agent))
    )
      throw new Error('请求或工作目录已变化，旧规划结果已失效；请基于当前请求重新规划');
  }
  async lease(agent: Agent): Promise<PlanningLease> {
    const r = this.state(agent);
    await r.loaded;
    const value = r.value;
    this.assertCurrent(agent, r, value);
    return {
      value: structuredClone(value),
      assertCurrent: () => this.assertCurrent(agent, r, value),
      commitExecutions: (ids) => {
        this.assertCurrent(agent, r, value);
        value.executions = [...ids];
        this.save(r);
      },
    };
  }
  private track(job: Promise<void>) {
    this.pending.add(job);
    void job.then(
      () => this.pending.delete(job),
      () => this.pending.delete(job),
    );
    return job;
  }
  async settle() {
    while (this.pending.size) await Promise.all([...this.pending]);
  }
  async close() {
    this.closed = true;
    await this.settle();
  }
  async active(agent: Agent) {
    const r = this.state(agent);
    await r.loaded;
    const claimed = this.proposed.get(agent);
    if (claimed?.at(-1)?.source.kind === 'emergence-task') return false;
    const proposed = claimed?.filter((m) => m.source.kind === 'user');
    if (!proposed?.length) return r.value.route === 'planned';
    const text = proposed
      .flatMap((m) => m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])))
      .join('\n');
    return (
      routeRequest(text).route === 'planned' ||
      (r.value.route === 'planned' &&
        (r.value.status === 'needs-input' ||
          /^(继续|可以|确认|没问题|按这个|是的|好的|continue|yes|go ahead)/i.test(text.trim())))
    );
  }
  private state(agent: Agent): Runtime {
    if (this.closed) throw new Error('规划服务已关闭');
    const scope = planScope(agent.session.id, this.host.cwd(agent));
    let runtime = this.states.get(agent);
    if (runtime?.value.scope === scope) return runtime;
    const previous = runtime?.value;
    const value: PlanningState = previous
      ? {
          ...structuredClone(previous),
          scope,
          attempts: 0,
          research: 0,
          receipts: [],
          status: 'blocked',
          draft: undefined,
          issues: ['当前工作目录已变化，请重新查询能力和读取来源，修订项目绑定'],
        }
      : {
          version: 2,
          scope,
          requestIds: [],
          request: '',
          route: 'direct',
          routeReason: '',
          attempts: 0,
          research: 0,
          receipts: [],
          status: 'draft',
          issues: [],
        };
    runtime = { value, loaded: Promise.resolve(), write: Promise.resolve(), reading: new Set() };
    this.states.set(agent, runtime);
    if (!this.registered.has(agent)) {
      this.host.register(agent);
      this.registered.add(agent);
    }
    const target = runtime;
    if (previous) {
      if (previous.route !== 'direct') this.save(target);
      return target;
    }
    target.loaded = this.track(
      this.store.read(scope).then(
        (saved) => {
          if (saved) target.value = saved;
        },
        () => {
          target.storageError = '计划记录无法读取，已保留原文件；本次仅在内存中规划';
        },
      ),
    );
    return target;
  }
  private save(runtime: Runtime) {
    if (!this.host.enabled) return;
    if (runtime.storageError) return;
    const snapshot = structuredClone(runtime.value);
    const job = (runtime.write = runtime.write
      .then(() => this.store.write(snapshot))
      .catch(() => {
        runtime.storageError = '计划保存失败，本次仅在内存中规划';
      }));
    this.pending.add(job);
    void job.finally(() => this.pending.delete(job));
  }
  private establish(value: PlanningState, analysis: Parameters<typeof establishRequirements>[2]) {
    if (value.requirements) return value.requirements;
    const source = value.source ?? {
      messageIds: value.requestIds.slice(-32),
      hash: createHash('sha256').update(value.request).digest('hex'),
    };
    if (!source.messageIds.length)
      throw new RequirementError('NO_USER_REQUEST', 'source', '尚无用户请求，不能建立需求。');
    const revision = createHash('sha256')
      .update(JSON.stringify([value.scope, source]))
      .digest('hex');
    const requirements = establishRequirements(revision, source, analysis, value.inheritedRequirements);
    if (JSON.stringify(requirements).length > this.host.config.contextChars - 3000)
      throw new RequirementError(
        'REQUIREMENTS_BUDGET',
        'requirements',
        '需求超出请求上下文预算；请精简表述，不能删除必需要求。',
      );
    value.source = source;
    value.requirements = requirements;
    return requirements;
  }
  captureClarification(agent: Agent) {
    const r = this.states.get(agent);
    if (
      !this.host.enabled ||
      !r?.value.analysis ||
      r.contracted ||
      this.host.inherited(agent) ||
      r.value.executions?.length ||
      (r.value.status !== 'needs-input' &&
        r.value.analysis.intent !== 'clarify' &&
        !r.value.analysis.questions?.length)
    )
      return;
    const expected = r.value;
    return async (text: string) => {
      await this.admit(
        agent,
        [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })],
        { expected },
      );
      await this.state(agent).write;
      if (r.storageError) throw new Error(r.storageError);
    };
  }
  async admit(agent: Agent, messages: UserMessage[], clarification?: { expected: PlanningState }) {
    const r = this.state(agent);
    await r.loaded;
    this.assertCurrent(agent, r, r.value);
    if (clarification) {
      if (r.value !== clarification.expected || r.value.executions?.length)
        throw new Error('需求已变化或本轮已停止，旧澄清答复不能更新当前计划');
    }
    const incoming = messages.filter(
      (m) => ['user', 'emergence-task'].includes(m.source.kind) && !r.value.requestIds.includes(m.id),
    );
    if (!incoming.length) return;
    const input = incoming
      .flatMap((m) => m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])))
      .join('\n');
    const ids = [...r.value.requestIds, ...incoming.map((m) => m.id)].slice(-32);
    const contracted = incoming.at(-1)?.source.kind === 'emergence-task';
    r.contracted = contracted;
    const taskSource = incoming.at(-1)?.source;
    const ownExecution =
      taskSource?.kind === 'emergence-task' && r.value.executions?.includes(taskSource.taskId);
    const continuation =
      !contracted &&
      (clarification ||
        (r.value.route === 'planned' &&
          (r.value.status === 'needs-input' ||
            /^(继续|可以|确认|没问题|按这个|是的|好的|continue|yes|go ahead)/i.test(input.trim()))));
    const previousRoute = r.value.route;
    const inheritedRequirements = continuation
      ? (r.value.requirements ?? r.value.inheritedRequirements)
      : undefined;
    const previousSource = inheritedRequirements?.source ?? (continuation ? r.value.source : undefined);
    const request = safeError(
      continuation ? r.value.request.slice(0, 4000) + '\n用户补充：' + input : input,
    ).slice(0, 6000);
    const route = contracted
      ? { route: 'focused' as const, routeReason: '已接到计划任务，遵循现有任务契约与继承权限' }
      : clarification
        ? { route: previousRoute, routeReason: '用户澄清已接纳，保留原目标并更新需求理解' }
        : continuation
          ? { route: 'planned' as const, routeReason: '保留原目标与用户补充，重新检查方案' }
          : routeRequest(input);
    r.value = {
      version: 2,
      scope: r.value.scope,
      requestIds: ids,
      request,
      source: {
        messageIds: continuation ? ids : incoming.map((m) => m.id).slice(-32),
        admittedIds: incoming.map((m) => m.id).slice(-32),
        hash: createHash('sha256').update(input).digest('hex'),
        ...(inheritedRequirements ? { previousRevision: inheritedRequirements.revision } : {}),
        ...(previousSource
          ? {
              origin: previousSource.origin ?? {
                messageIds: previousSource.messageIds,
                hash: previousSource.hash,
              },
            }
          : {}),
      },
      ...(inheritedRequirements ? { inheritedRequirements } : {}),
      ...route,
      attempts: clarification ? r.value.attempts : 0,
      research: clarification ? r.value.research : 0,
      receipts: continuation ? r.value.receipts : [],
      status: 'draft',
      issues: [],
      ...(!clarification && (continuation || ownExecution) && r.value.plan ? { plan: r.value.plan } : {}),
      ...(ownExecution
        ? {
            executions: r.value.executions,
            status: 'ready' as const,
            analysis: r.value.analysis,
            requirements: r.value.requirements,
            requirementBinding: r.value.requirementBinding,
          }
        : {}),
    };
    // Direct chat incurs no inventory lookup, planning file write or extra model request.
    if (route.route !== 'direct' || previousRoute !== 'direct') this.save(r);
    this.host.changed();
  }
  async analyze(agent: Agent, parsed: z.infer<typeof analysisRequestSchema>) {
    const r = this.state(agent);
    await r.loaded;
    this.assertCurrent(agent, r, r.value);
    if (r.value.executions?.length) throw new Error('执行图已提交；请等待任务结果，不重置正在执行的目标');
    if (r.value.analysis) throw new Error('本次请求已有目标分析；请使用计划修订承接后续发现');
    const { route: requestedRoute, ...parsedAnalysis } = structuredClone(parsed);
    const ranks = { direct: 0, focused: 1, planned: 2 };
    const route = requestedRoute;
    const draft = structuredClone(r.value);
    if (ranks[route] > ranks[draft.route]) draft.route = route;
    const requirements = this.establish(draft, parsedAnalysis);
    draft.analysis = {
      ...parsedAnalysis,
      constraints: requirementTexts(requirements, 'constraint'),
      acceptance: requirementTexts(requirements, 'acceptance'),
      nonGoals: requirementTexts(requirements, 'nonGoal'),
    };
    if (draft.analysis.intent === 'clarify' || draft.analysis.questions?.length) draft.status = 'needs-input';
    draft.routeReason = safeError(parsedAnalysis.reason).slice(0, 200);
    r.value = draft;
    this.save(r);
    this.host.changed();
  }
  isReading(agent: Agent, callId: string) {
    return this.states.get(agent)?.reading.has(callId) ?? false;
  }
  beginRead(agent: Agent, callId: string) {
    if (this.closed) throw new Error('规划服务已关闭');
    const r = this.states.get(agent);
    if (!r || r.value.route !== 'planned' || r.value.status === 'ready') return;
    if (r.reading.has(callId)) return;
    if (r.value.research >= this.host.config.researchCalls)
      throw new Error('规划读取预算已用完，请提交已有证据或说明缺口，不要换工具绕过');
    r.value.research++;
    r.reading.add(callId);
    this.save(r);
    return () => r.reading.delete(callId);
  }
  observeCall(agent: Agent, id: string) {
    const r = this.states.get(agent);
    if (this.closed || !r) return;
    let calls = this.calls.get(agent);
    if (!calls) this.calls.set(agent, (calls = new Map()));
    calls.set(id, { runtime: r, request: JSON.stringify(r.value.source ?? r.value.requestIds) });
  }
  finishCall(agent: Agent, id: string) {
    this.calls.get(agent)?.delete(id);
  }
  recordReceipt(agent: Agent, id: string, tool: string, read: boolean) {
    if (this.closed) return;
    const r = this.states.get(agent);
    const call = this.calls.get(agent)?.get(id);
    if (
      !r ||
      r.value.route === 'direct' ||
      !call ||
      call.runtime !== r ||
      call.request !== JSON.stringify(r.value.source ?? r.value.requestIds) ||
      r.value.scope !== planScope(agent.session.id, this.host.cwd(agent))
    )
      return;
    if (!r.value.receipts.some((receipt) => receipt.id === id))
      r.value.receipts.push({
        id,
        tool,
        read,
      });
    r.value.receipts = r.value.receipts.slice(-64);
    this.save(r);
  }
  async revise<T>(
    agent: Agent,
    review: (
      draft: PlanningState,
      establish: (
        analysis: Parameters<typeof establishRequirements>[2],
      ) => NonNullable<PlanningState['requirements']>,
    ) => Promise<T>,
  ): Promise<T> {
    const r = this.state(agent);
    await r.loaded;
    const expected = r.value;
    this.assertCurrent(agent, r, expected);
    if (this.reviewing.has(r)) throw new Error('计划正在检查，请等待当前修订完成');
    if (expected.attempts >= this.host.config.revisions)
      throw new Error('计划修订预算已用完，请说明阻塞点并等待用户补充');
    expected.attempts++;
    this.save(r);
    this.reviewing.add(r);
    const draft = structuredClone(expected);
    try {
      const result = await review(draft, (analysis) => this.establish(draft, analysis));
      this.assertCurrent(agent, r, expected);
      // Reads may finish during capability resolution; admission cannot roll back their budget or receipts.
      draft.research = expected.research;
      draft.receipts = structuredClone(expected.receipts);
      r.value = structuredClone(draft);
      this.save(r);
      this.host.changed();
      return result;
    } catch (error) {
      this.assertCurrent(agent, r, expected);
      draft.status =
        error instanceof RequirementError && error.code === 'REQUIREMENTS_NEED_INPUT'
          ? 'needs-input'
          : 'blocked';
      draft.issues = [safeError(error).slice(0, 1000)];
      draft.research = expected.research;
      draft.receipts = structuredClone(expected.receipts);
      r.value = structuredClone(draft);
      this.save(r);
      this.host.changed();
      if (error instanceof RequirementError) throw error;
      let detail: unknown = safeError(error);
      try {
        detail = JSON.parse(safeError(error));
      } catch {
        /* Plain diagnostics stay text. */
      }
      throw new Error(
        JSON.stringify({
          code: 'PLAN_ADMISSION_FAILED',
          detail,
          retained: draft.requirements,
          attempts: draft.attempts,
          remaining: this.host.config.revisions - draft.attempts,
          correctable: ['steps', 'evidence', 'unknowns', 'assumptions', 'reason', 'suggestions'],
        }),
      );
    } finally {
      this.reviewing.delete(r);
    }
  }
}
