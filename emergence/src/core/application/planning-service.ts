import type { Agent } from '@deepseek-ai/dsh-agent';
import type { UserMessage } from '@deepseek-ai/dsh-llm';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { mountPlanningHarness, registerPlanningTools } from '../adapters/planning.ts';
import { analysisRequestSchema } from '../domain/intent.ts';
import { planningConfigSchema, type TaskPlan } from '../domain/planning.ts';
import { PlanStore } from '../storage/plan-store.ts';
import { reviewPlan, validateReadyPlan } from './planning-admission.ts';
import { collectPlanningInventory, planningBindingsValid } from './planning-inventory.ts';
import { planningGuard } from './planning-policy.ts';
import type { PlanningEnvironment, PlanningHost } from './planning-ports.ts';
import {
  describeInventory,
  describePlanning,
  planningContext,
  planningIntake,
  planningLabel,
} from './planning-presentation.ts';
import { PlanningRequests } from './planning-requests.ts';
/** Wires intake, inventory and admission into the existing Harness; owns no duplicate request state. */
export class CorePlanning {
  private readonly requests: PlanningRequests;
  environment?: () => PlanningEnvironment;
  onExecute?: (plan: TaskPlan, model: boolean, signal?: AbortSignal) => Promise<Array<{ id: string }>>;
  constructor(
    readonly c: PlanningHost,
    store = new PlanStore(c.launch.home),
  ) {
    const service = this;
    this.requests = new PlanningRequests(
      {
        get enabled() {
          return service.enabled;
        },
        get config() {
          return service.config;
        },
        cwd: (agent) => c.ctx.workingDirectory.get(agent.session),
        inherited: (agent) => !!c.permissionConstraints(agent).length,
        register: (agent) => {
          registerPlanningTools(service, agent);
        },
        changed: () => c.changed(),
      },
      store,
    );
  }
  get enabled() {
    return this.c.core.enabled && this.config.enabled;
  }
  get config() {
    return planningConfigSchema.parse(this.c.launch.appConfig.core.planning ?? {});
  }
  snapshot(agent = this.c.agent) {
    return this.requests.view(agent)?.value;
  }
  intake(agent = this.c.agent) {
    return planningIntake(this.snapshot(agent));
  }
  get label() {
    return planningLabel(this.enabled, this.intake());
  }
  settle() {
    return this.requests.settle();
  }
  close() {
    return this.requests.close();
  }
  captureClarification(agent: Agent) {
    return this.requests.captureClarification(agent);
  }
  admit(agent: Agent, messages: UserMessage[]) {
    return this.requests.admit(agent, messages);
  }
  claim(agent: Agent, message: UserMessage) {
    this.requests.claim(agent, message);
  }
  clearClaim(agent: Agent) {
    this.requests.clearClaim(agent);
  }
  isContracted(agent: Agent) {
    return this.requests.preview(agent)?.at(-1)?.source.kind === 'emergence-task';
  }
  active(agent: Agent) {
    return this.requests.active(agent);
  }
  async analyze(agent: Agent, input: z.infer<typeof analysisRequestSchema>) {
    await this.requests.analyze(agent, input);
    return this.intake(agent);
  }
  beginRead(agent: Agent, id: string) {
    return this.requests.beginRead(agent, id);
  }
  observeCall(agent: Agent, id: string) {
    this.requests.observeCall(agent, id);
  }
  finishCall(agent: Agent, id: string) {
    this.requests.finishCall(agent, id);
  }
  recordReceipt(agent: Agent, id: string, tool: string, read: boolean) {
    this.requests.recordReceipt(agent, id, tool, read);
  }
  inventory(agent = this.c.agent, signal = AbortSignal.timeout(5000)) {
    return collectPlanningInventory(this.c, this.environment, agent, signal);
  }
  submit(agent: Agent, input: unknown, signal: AbortSignal) {
    return this.requests.revise(agent, (draft, establish) =>
      reviewPlan(draft, input, signal, this.config, (s) => this.inventory(agent, s), establish),
    );
  }
  async readyPlan() {
    const agent = this.c.agent,
      lease = await this.requests.lease(agent);
    const plan = await validateReadyPlan(lease.value, this.enabled, this.config, () => this.inventory(agent));
    lease.assertCurrent();
    if (this.c.agent !== agent) throw new Error('会话已变化，旧计划不可执行');
    return plan;
  }
  async run(model = false, expected?: string, signal?: AbortSignal) {
    if (!this.onExecute) throw new Error('当前入口没有持久任务调度器，请在终端工作台运行');
    const agent = this.c.agent,
      lease = await this.requests.lease(agent);
    const plan = await validateReadyPlan(lease.value, this.enabled, this.config, () => this.inventory(agent));
    lease.assertCurrent();
    if (this.c.agent !== agent) throw new Error('会话已变化，旧计划不可执行');
    const id = createHash('sha256').update(JSON.stringify(plan)).digest('hex');
    signal?.throwIfAborted();
    if (expected && expected !== id) throw new Error('计划已变化，旧执行请求失效');
    const tasks = await this.onExecute(plan, model, signal);
    lease.commitExecutions(tasks.map((t) => t.id));
    return tasks;
  }
  guard(exec: ToolExecution) {
    if (!this.enabled || !exec.agent) return;
    const view = exec.agent ? this.requests.view(exec.agent) : undefined;
    return planningGuard(exec, {
      enabled: this.enabled,
      state: view?.value,
      contracted: !!view?.contracted,
      reading: !!exec.agent && this.requests.isReading(exec.agent, exec.callId),
      isRoot: exec.agent === this.c.agent,
      mode: this.c.permissionMode,
      config: this.config,
      bindingsValid: () =>
        !!exec.agent && planningBindingsValid(view?.value.plan, exec.agent, this.c, this.environment?.()),
    });
  }
  context(agent: Agent) {
    return planningContext({
      enabled: this.enabled,
      view: this.requests.view(agent),
      preview: this.requests.preview(agent),
      config: this.config,
      mode: this.c.permissionMode,
      inheritedModes: this.c.permissionConstraints(agent).map((p) => p.mode),
      methods: this.c.core.catalog?.roles,
      canExecute: !!this.onExecute,
    });
  }
  async describe(agent = this.c.agent) {
    return describePlanning(
      await this.requests.read(agent),
      this.enabled,
      this.config,
      this.c.diagnostics.snapshot,
    );
  }
  async describeCapabilities(agent = this.c.agent) {
    return describeInventory(await this.inventory(agent));
  }
  mount() {
    return mountPlanningHarness(this);
  }
}
