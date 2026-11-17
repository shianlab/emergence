import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-llm-retry';
import type {} from '@deepseek-ai/dsh-session-persistence';
import type {} from '@deepseek-ai/dsh-user-questions';
import type {} from '@deepseek-ai/dsh-working-directory';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createCoreObserver, mountCoreObservation } from '../core/adapters/harness.ts';
import { CoreMemory } from '../core/adapters/memory.ts';
import { registerSecretNames, safeError } from '../core/adapters/redaction.ts';
import { CorePlanning } from '../core/application/planning-service.ts';
import { RunDiagnostics } from '../core/application/run-diagnostics.ts';
import { type ModelConfig } from '../core/domain/configuration.ts';
import {
  permissionLabels,
  permissionModeSchema,
  type PermissionMode,
  type PermissionSnapshot,
} from '../core/domain/permissions.ts';
import type { BudgetReason } from '../core/domain/run-budget.ts';
import { RunDiagnosticsStore } from '../core/storage/run-diagnostics-store.ts';
import { CodeUnderstanding } from '../domains/code/harness.ts';
import { CodeWorkHarness } from '../domains/code/work-harness.ts';
import { DataFoundation } from '../domains/data/harness.ts';
import { commandHelp, sessionCommands } from './commands.ts';
import { AgentInstructions } from './instructions.ts';
import { InteractionQueue, type InteractionAnswer } from './interactions.ts';
import { commandTokens } from './layout.ts';
import { registerLocalOwner } from './local-policy.ts';
import { runtimeIdentityContext } from './runtime-identity.ts';
import type { LaunchConfig } from './session-config.ts';
import { SessionLifecycle } from './session-lifecycle.ts';
import { assertModelHistory } from './session-model.ts';
import { SessionPermissions } from './session-permissions.ts';
import { SessionPresentation } from './session-presentation.ts';
import { mountSessionQuestions } from './session-questions.ts';
export type { Interaction } from './interactions.ts';
/** Composition root and public session commands. State belongs to the mounted session services. */
export class SessionController extends EventEmitter {
  private readonly disposers: Array<() => void> = [];
  private readonly lifecycle: SessionLifecycle;
  private readonly permissions: SessionPermissions;
  private readonly presentation: SessionPresentation;
  private readonly interactions = new InteractionQueue(() => this.changed());
  permissionConstraints: (agent?: Agent) => PermissionSnapshot[] = () => [];
  approvalScope: (agent: Agent) => { taskId: string; runId?: string } | undefined = () => undefined;
  readonly instructions: AgentInstructions;
  readonly core: ReturnType<typeof createCoreObserver>;
  readonly planning: CorePlanning;
  readonly diagnostics: RunDiagnostics;
  onRunTimeout?: (reason: string, kind: BudgetReason) => Promise<void>;
  readonly memory: CoreMemory;
  readonly code: CodeUnderstanding;
  readonly codeWork: CodeWorkHarness;
  readonly data: DataFoundation;
  notice = '输入任务开始工作，/help 查看命令';
  lastError?: string;
  constructor(
    readonly ctx: Context,
    readonly launch: LaunchConfig,
  ) {
    super();
    const controller = this;
    this.lifecycle = new SessionLifecycle(ctx, launch, {
      beforeSwitch: () => {
        if (this.instructions.initializing) throw new Error('规则初始化尚未完成，请先完成或取消确认');
      },
      resetAccess: () => this.permissions.reset(),
      bind: async (agent) => {
        await this.diagnostics.bind(agent.session.id);
        this.memory.register(agent);
        this.code.register(agent);
        this.codeWork.register(agent);
        this.data.register(agent);
        await this.core.bind(
          agent.session.id,
          process.platform === 'win32' ? launch.cwd.toLowerCase() : launch.cwd,
        );
      },
      bindChild: (agent) => {
        this.permissionConstraints(agent);
      },
      resetDisplay: () => this.presentation.reset(),
      stopping: (active) => this.presentation.setStopping(active),
      cancelling: () => this.diagnostics.cancelling(),
      cancelInteractions: () => this.interactions.cancelAll(),
      notice: (text) => {
        this.notice = text;
      },
      error: (error) => {
        this.lastError = safeError(error);
      },
      changed: () => this.changed(),
    });
    this.presentation = new SessionPresentation({
      ctx,
      get diagnostics() {
        return controller.diagnostics;
      },
      current: () => this.lifecycle.current,
      changed: () => this.changed(),
      get notice() {
        return controller.notice;
      },
      set notice(text) {
        controller.notice = text;
      },
      get lastError() {
        return controller.lastError;
      },
      set lastError(text) {
        controller.lastError = text;
      },
    });
    this.permissions = new SessionPermissions(
      {
        ctx,
        launch,
        get closed() {
          return controller.closed;
        },
        get notice() {
          return controller.notice;
        },
        set notice(text) {
          controller.notice = text;
        },
        current: () => this.lifecycle.current,
        cwd: () => this.cwd,
        owns: (agent) => this.owns(agent),
        changed: () => this.changed(),
        permissionConstraints: (agent) => this.permissionConstraints(agent),
        approvalScope: (agent) => this.approvalScope(agent),
        guardPlan: (exec) => this.planning.guard(exec),
        prepareTool: (exec) => this.instructions.prepareTool(exec),
        supportsTools: (agent) => this.executionModel(agent)?.capabilities?.tools !== false,
        permissionCheck: (...args) => this.core.permissionCheck(...args),
        toolActivity: (exec, active) => this.presentation.toolActivity(exec, active),
      },
      this.interactions,
    );
    this.diagnostics = new RunDiagnostics(
      new RunDiagnosticsStore(launch.home),
      () => launch.appConfig.orchestration.budgets,
      async (reason, kind) => {
        this.lastError = reason;
        if (this.onRunTimeout) await this.onRunTimeout(reason, kind);
        else await this.cancel();
        this.notice = reason;
        this.changed();
      },
    );
    this.memory = new CoreMemory(this);
    this.disposers.push(...this.memory.mount());
    this.core = createCoreObserver(launch.home, launch.appConfig.core?.mode ?? 'observe');
    this.disposers.push(...mountCoreObservation(this));
    this.planning = new CorePlanning(this);
    this.disposers.push(...this.planning.mount());
    const access = {
      ctx,
      owns: (agent?: Agent) => this.owns(agent),
      permissionSnapshot: () => this.permissionSnapshot(),
      permissionConstraints: (agent?: Agent) => this.permissionConstraints(agent),
    };
    const workAccess = {
      ...access,
      home: launch.home,
    };

    this.data = new DataFoundation({
      ...workAccess,
      get permissionMode() {
        return controller.permissionMode;
      },
      confirmDecision: (title, valid) => this.confirmDecision(title, valid),
    });
    this.disposers.push(...this.data.mount());
    this.code = new CodeUnderstanding(access);
    this.disposers.push(...this.code.mount());
    this.codeWork = new CodeWorkHarness(workAccess);
    this.disposers.push(...this.codeWork.mount());
    this.disposers.push(
      ctx.systemPrompt.context({
        name: 'emergence-runtime-' + randomUUID(),
        order: 910,
        required: true,
        interpolate: false,
        text: ({ agent }) => (agent && this.owns(agent) ? runtimeIdentityContext(this, agent) : ''),
      }),
    );
    this.instructions = new AgentInstructions(this);
    this.disposers.push(...this.instructions.mount());
    registerSecretNames(launch.appConfig.models.map((model) => model.apiKeyEnv));
    if (launch.appConfig.shellMode === 'ask-local') this.disposers.push(registerLocalOwner(ctx, this));
    this.disposers.push(
      ...this.permissions.mount(),
      ...this.presentation.mount(),
      mountSessionQuestions(
        {
          ctx,
          owns: (agent) => this.owns(agent),
          interactive: launch.prompt === undefined,
          captureClarification: (agent) => this.planning.captureClarification(agent),
        },
        this.interactions,
      ),
    );
  }

  get closed() {
    return this.lifecycle.closed;
  }
  get id() {
    return this.lifecycle.current?.session.id;
  }
  get agent() {
    const agent = this.lifecycle.current;
    if (!agent) throw new Error('会话尚未打开');
    return agent;
  }
  get busy() {
    return this.lifecycle.busy;
  }
  get cwd() {
    return this.lifecycle.cwd;
  }
  get live() {
    return this.presentation.live;
  }
  get activity() {
    return this.presentation.activity;
  }
  get permissionMode() {
    return this.permissions.permissionMode;
  }
  get permissionEpoch() {
    return this.permissions.permissionEpoch;
  }
  get permissionTransitioning() {
    return this.permissions.permissionTransitioning;
  }
  owns(agent?: Agent) {
    return this.lifecycle.owns(agent);
  }
  permissionSnapshot() {
    return this.permissions.permissionSnapshot();
  }
  invalidatePermissions() {
    this.permissions.invalidatePermissions();
  }
  setPermissionMode(mode: PermissionMode) {
    this.permissions.setPermissionMode(mode);
  }
  cyclePermission() {
    this.permissions.cyclePermission();
  }
  confirmDecision(title: string, valid?: () => boolean) {
    return this.permissions.confirmDecision(title, valid);
  }
  writeWithPermission(path: string, content: string, action: () => Promise<void>) {
    return this.permissions.writeWithPermission(path, content, action);
  }
  transcript() {
    return this.presentation.transcript();
  }
  displayMessages() {
    return this.presentation.displayMessages();
  }
  tokenUsage() {
    return this.presentation.tokenUsage();
  }
  displayTranscript() {
    return this.presentation.displayTranscript();
  }
  async open(resume?: string) {
    await this.lifecycle.open(resume);
    this.lastError = undefined;
    this.changed();
  }
  cancel() {
    return this.lifecycle.cancel();
  }
  close() {
    return this.lifecycle.close(
      {
        beforeDispose: [() => this.instructions.settle()],
        afterDispose: [
          () => this.planning.close(),
          () => this.core.close(),
          () => this.diagnostics.close(),
          () => this.permissions.close(),
          () => this.removeAllListeners(),
        ],
      },
      this.disposers,
    );
  }

  get model(): ModelConfig {
    return this.launch.appConfig.models.find((m) => m.id === this.launch.modelId)!;
  }
  executionModel(agent: Agent) {
    const selection = agent.model.current();
    return this.launch.appConfig.models.find(
      (m) => m.id === selection?.provider && m.model === selection.model,
    );
  }
  get pending() {
    return this.interactions.pending;
  }
  get pendingInteractions() {
    return this.interactions.all;
  }
  cancelInteractions() {
    this.interactions.cancelAll();
  }
  respondInteraction(id: string, version: number, answer: InteractionAnswer) {
    if (this.closed) throw new Error('会话正在关闭');
    const request = this.pending;
    const owner =
      request &&
      this.ctx.agents
        .list()
        .find((agent) => agent.id === request.agentId && agent.session.id === request.sessionId);
    if (!owner || !this.owns(owner)) throw new Error('确认请求的会话已失效');
    this.interactions.answer(id, version, answer);
  }
  changed() {
    this.diagnostics.pending(!!this.pending);
    if (!this.closed) this.emit('change');
  }
  async send(text: string) {
    if (this.closed) return;
    this.lifecycle.assertReady();
    if (text === '/exit') {
      this.emit('exit');
      return;
    }
    if (/^\/(permission|instructions|init)(?:\s|$)/.test(text)) {
      await this.command(text);
      return;
    }
    if (this.pending) {
      this.pending.respond(text);
      return;
    }
    if (text.startsWith('/')) {
      await this.command(text);
      return;
    }
    if (!process.env[this.model.apiKeyEnv])
      throw new Error(`请先设置环境变量 ${this.model.apiKeyEnv}，密钥不要填入聊天框`);
    this.lastError = undefined;
    const wasBusy = this.busy;
    this.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
    this.notice = wasBusy ? '已加入队列，当前任务结束后处理' : '已提交';
    this.changed();
  }
  async command(text: string) {
    this.lifecycle.assertReady();
    const [command, ...args] = commandTokens(text);
    switch (command) {
      case '/core':
        this.notice = this.core.describe(args[0]);
        break;
      case '/plan':
        this.notice = await this.planning.describe();
        break;
      case '/capabilities':
        this.notice = await this.planning.describeCapabilities();
        break;
      case '/instructions':
      case '/init':
        this.notice = safeError(await this.instructions.command(command, args));
        break;
      case '/permission':
        if (args[0] === 'next') this.cyclePermission();
        else if (args[0] === 'revoke') {
          this.invalidatePermissions();
          this.notice = '已撤销会话授权和待处理确认';
        } else if (args[0]) this.setPermissionMode(permissionModeSchema.parse(args[0]));
        else
          this.notice = `当前权限：${permissionLabels[this.permissionMode]}\n/permission plan|ask|edit|auto · /permission revoke`;
        break;
      case '/help':
        this.notice = commandHelp(
          sessionCommands(this.launch.appConfig.ui.language === 'en'),
          this.launch.appConfig.ui,
        );
        break;
      case '/new':
        await this.open();
        this.notice = '已创建新会话';
        break;
      case '/sessions': {
        const sessions = await this.ctx.sessionPersistence.list();
        this.notice =
          sessions.map((s) => `${s.header.id}  ${s.header.cwd ?? ''}`).join('\n') || '没有保存的会话';
        break;
      }
      case '/resume':
        if (!args[0]) throw new Error('用法：/resume <会话ID>');
        await this.open(args[0]);
        this.notice = '已恢复会话';
        break;
      case '/model': {
        if (!args[0]) {
          this.notice = this.launch.appConfig.models
            .map((m) => `${m.id}  ${m.provider}/${m.model}`)
            .join('\n');
          break;
        }
        const model = this.launch.appConfig.models.find((m) => m.id === args[0]);
        if (!model) throw new Error('模型配置不存在；用 /model 查看');
        if (this.busy) throw new Error('请先停止当前任务后切换模型');
        assertModelHistory(model, this.agent.session.snapshotEvents(), [
          ...this.agent.inbox.nextStep,
          ...this.agent.inbox.nextTurn,
        ]);
        const owner = this.agent;
        await this.ctx.llm.resolveModelInfo(model.id, model.model);
        this.lifecycle.assertReady();
        if (this.agent !== owner || this.busy) throw new Error('会话状态已变化，请重新选择模型');
        this.agent.model.select({ provider: model.id, model: model.model });
        this.launch.modelId = model.id;
        // Per-window model selection is persisted with its session/layout; do not overwrite shared config snapshots.
        this.notice = `下一轮使用 ${model.provider}/${model.model}`;
        break;
      }
      case '/tools':
        this.notice = this.ctx.tools
          .definitions(this.agent)
          .map((t) => t.name)
          .join(' · ');
        break;
      case '/exit':
        this.emit('exit');
        return;
      default:
        throw new Error('未知命令，输入 /help 查看');
    }
    this.changed();
  }
}
