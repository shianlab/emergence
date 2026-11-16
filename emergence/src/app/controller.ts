import type { Context } from '@deepseek-ai/cordis';
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent';
import { createUserMessage, type ContentBlock, type UserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-session-persistence';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types';
import type {} from '@deepseek-ai/dsh-user-questions';
import type {} from '@deepseek-ai/dsh-working-directory';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { createCoreObserver, mountCoreObservation, toolKind } from '../core/adapters/harness.ts';
import { CoreMemory } from '../core/adapters/memory.ts';
import { callFingerprint, evaluatePermissions, permissionFingerprint } from '../core/adapters/permissions.ts';
import { registerSecretNames, safeError } from '../core/adapters/redaction.ts';
import { CorePlanning } from '../core/application/planning-service.ts';
import { RunDiagnostics } from '../core/application/run-diagnostics.ts';
import { RunDiagnosticsStore } from '../core/storage/run-diagnostics-store.ts';
import { replaceJsonFile } from '../core/storage/safe-json-file.ts';
import { approvalIdentity } from '../core/adapters/approval-identity.ts';
import { stableDigest } from '../core/storage/execution-journal.ts';
import type { BudgetReason } from '../core/domain/run-budget.ts';
import { type AppConfig, type ModelConfig } from '../core/domain/configuration.ts';
import {
  permissionLabels,
  permissionModeSchema,
  permissionModes,
  type PermissionMode,
  type PermissionSnapshot,
} from '../core/domain/permissions.ts';
import { acquireLease, canonicalDirectory } from '../core/storage/lease.ts';
import { CodeUnderstanding } from '../domains/code/harness.ts';
import { CodeWorkHarness } from '../domains/code/work-harness.ts';
import { DataFoundation } from '../domains/data/harness.ts';
import { commandHelp, sessionCommands } from './commands.ts';
import { AgentInstructions } from './instructions.ts';
import { InteractionQueue, type InteractionAnswer } from './interactions.ts';
import { commandTokens } from './layout.ts';
import { registerLocalOwner } from './local-policy.ts';
import { runtimeIdentityContext } from './runtime-identity.ts';
import { MessageProjection } from './tui/message-model.ts';
import { SessionUsage } from './tui/session-usage.ts';
export type { Interaction } from './interactions.ts';

export interface LaunchConfig {
  home: string;
  cwd: string;
  modelId: string;
  explicitModel?: boolean;
  permissionMode?: PermissionMode;
  resume?: string;
  fresh?: boolean;
  template?: string;
  prompt?: string;
  approvedCommands?: string[];
  hydratedCredentials?: string[];
  appConfig: AppConfig;
}

/** Validate declared limitations without discarding or rewriting session history. */
export function assertModelHistory(
  model: ModelConfig,
  events: readonly SessionEvent[],
  pending: readonly UserMessage[] = [],
) {
  if (
    model.capabilities?.tools === false &&
    events.some((e) => e.type === 'tool/call' || e.type === 'tool/result')
  )
    throw new Error('此模型声明不支持工具，当前历史含工具记录；请先 /new，再 /model 切换。原历史会保留');
  const images = (content: readonly ContentBlock[]) =>
    content.some((b) => b.type === 'image' && !b.offloaded);
  if (
    model.capabilities?.vision === false &&
    (events.some((e) =>
      images(
        e.type === 'user/message'
          ? e.data.content
          : e.type === 'assistant/message' || e.type === 'tool/result'
            ? e.data.message.content
            : [],
      ),
    ) ||
      pending.some((m) => images(m.content)))
  )
    throw new Error('此模型声明不支持图像，当前历史或待处理上下文含图像；请先 /new，再 /model 切换');
}

function textOf(content: readonly ContentBlock[]) {
  return content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
}
export function eventLine(event: SessionEvent): string | undefined {
  switch (event.type) {
    case 'user/message':
      return event.data.source.kind === 'user'
        ? `你 › ${textOf(event.data.content)}`
        : event.data.source.kind === 'emergence-instructions'
          ? `规则 › ${event.data.source.root} · ${event.data.source.fingerprint.slice(0, 12)} · /instructions 查看来源`
          : event.data.source.kind === 'emergence-context'
            ? `上下文 ${event.data.source.label} › ${textOf(event.data.content)}`
            : event.data.source.kind === 'skill-invocation'
              ? `技能 ${event.data.source.name} › ${textOf(event.data.content)}`
              : event.data.source.kind === 'emergence-task' ||
                  event.data.source.kind === 'emergence-note' ||
                  event.data.source.kind === 'emergence-receipt'
                ? `协作 ${event.data.source.taskId} › ${textOf(event.data.content)}`
                : `上下文 · ${event.data.source.kind}`;
    case 'assistant/message': {
      const text = textOf(event.data.message.content);
      return text || event.data.interrupted
        ? `涌现 › ${text}${event.data.interrupted ? '\n[已中止]' : ''}`
        : undefined;
    }
    case 'tool/call':
      return `┌ 工具 ${event.data.name}\n${event.data.arguments}`;
    case 'tool/result':
      return `└ ${event.data.message.isError ? '失败' : '完成'}\n${textOf(event.data.message.content)}`;
    default:
      return undefined;
  }
}

export class SessionController extends EventEmitter {
  private handle?: AgentHandle;
  private readonly disposers: Array<() => void> = [];
  private closed = false;
  private closing?: Promise<void>;
  private releaseSession?: () => Promise<void>;
  private readonly childLeases = new Map<Agent, () => Promise<void>>();
  private readonly childReleases = new Set<Promise<void>>();
  private readonly interactions = new InteractionQueue(() => this.changed());
  private readonly confirmed = new Set<string>();
  private readonly grants = new Set<string>();
  private readonly declined = new Set<string>();
  private readonly calls = new Map<string, { exec: ToolExecution; stamp: string; fingerprint: string }>();
  private permissionRevision = 0;
  private activeTools = 0;
  private readonly runningTools = new Map<string, { name: string; arguments: string }>();
  private stopping = false;
  private activityStartedAt?: number;
  private streamPhase: 'waiting' | 'reasoning' | 'writing' = 'waiting';
  private usageProjection?: { session: string; value: SessionUsage };
  private transitioning = false;
  permissionConstraints: (agent?: Agent) => PermissionSnapshot[] = () => [];
  permissionIssuers: () => readonly string[] = () => [];
  approvalScope: (agent: Agent) => { taskId: string; runId?: string } | undefined = () => undefined;
  permissionMode: PermissionMode;
  readonly instructions: AgentInstructions;
  readonly core: ReturnType<typeof createCoreObserver>;
  readonly planning: CorePlanning;
  readonly diagnostics: RunDiagnostics;
  onRunTimeout?: (reason: string, kind: BudgetReason) => Promise<void>;
  readonly memory: CoreMemory;
  readonly code: CodeUnderstanding;
  readonly codeWork: CodeWorkHarness;
  readonly data: DataFoundation;
  private display?: { sessionId: string; lines: string[] };
  private messages?: MessageProjection;
  live = '';
  notice = '输入任务开始工作，/help 查看命令';
  lastError?: string;
  constructor(
    readonly ctx: Context,
    readonly launch: LaunchConfig,
  ) {
    super();
    this.diagnostics = new RunDiagnostics(
      new RunDiagnosticsStore(launch.home),
      () => launch.appConfig.orchestration.budgets,
      async (reason, kind) => {
        if (this.planning.expire('主控规划：' + reason)) reason = '主控规划：' + reason;
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
    this.data = new DataFoundation(this);
    this.disposers.push(...this.data.mount());
    this.code = new CodeUnderstanding(this);
    this.disposers.push(...this.code.mount());
    this.codeWork = new CodeWorkHarness(this);
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
    this.permissionMode = launch.permissionMode ?? launch.appConfig.permissions.defaultMode;
    this.instructions = new AgentInstructions(this);
    this.disposers.push(...this.instructions.mount());
    registerSecretNames(launch.appConfig.models.map((model) => model.apiKeyEnv));
    if (launch.appConfig.shellMode === 'ask-local') this.disposers.push(registerLocalOwner(ctx, this));
    this.disposers.push(
      ctx.on('agent/created', async ({ agent }) => {
        if (this.handle && agent !== this.handle.agent && this.owns(agent)) {
          this.childLeases.set(
            agent,
            await acquireLease(
              `session:${await canonicalDirectory(launch.home)}:${agent.id}`,
              '该子代理会话',
            ),
          );
          this.permissionConstraints(agent);
        }
      }),
    );
    this.disposers.push(
      ctx.on('agent/disposed', ({ agent }) => {
        this.interactions.cancelWhere((r) => r.agentId === agent.id);
        for (const key of this.declined)
          if (key.startsWith(agent.session.id + ':')) this.declined.delete(key);
        const release = this.childLeases.get(agent);
        if (!release) return;
        this.childLeases.delete(agent);
        const job = release();
        this.childReleases.add(job);
        void job.then(
          () => this.childReleases.delete(job),
          (error) => {
            this.childReleases.delete(job);
            this.lastError = safeError(error);
          },
        );
      }),
    );
    const approved = [...(launch.approvedCommands ?? [])];
    this.disposers.push(
      ctx.tools.guard((exec) => (this.owns(exec.agent) ? this.permissionGuard(exec) : undefined)),
    );
    this.disposers.push(
      ctx.on('tools/result', (exec) => {
        const key = this.callKey(exec);
        this.confirmed.delete(key);
        this.calls.delete(key);
      }),
    );
    this.disposers.push(
      ctx.on('tools/pre-execute', async (exec, next) => {
        if (!this.owns(exec.agent)) return next();
        const planningError = this.planning.guard(exec);
        if (planningError) return { kind: 'deny', reason: planningError };
        const instructionError = await this.instructions.prepareTool(exec);
        if (instructionError) return { kind: 'deny', reason: instructionError };
        if (this.executionModel(exec.agent!)?.capabilities?.tools === false)
          throw new Error('此模型配置声明不支持工具');
        const state = this.permissionState(exec);
        if (this.declined.has(this.declineKey(exec.agent!, state.fingerprint)))
          return { kind: 'deny', reason: '用户已拒绝或取消本轮相同操作；请停止重试或提出合规替代' };
        if (state.decision.effect === 'deny' || this.transitioning)
          return {
            kind: 'deny',
            reason: this.transitioning ? '权限正在切换，等待已开始的工具结束' : state.decision.reason,
          };
        this.calls.set(this.callKey(exec), { exec, stamp: state.stamp, fingerprint: state.fingerprint });
        if (state.decision.effect === 'ask' && !this.hasGrant(state))
          return {
            kind: 'ask',
            reason: `${state.decision.reason}：${exec.name}\n目录：${state.call.cwd}\n${JSON.stringify(exec.arguments)}`,
          };
        return next();
      }),
    );
    this.disposers.push(
      ctx.on('tools/execute', async (exec, next) => {
        if (!this.owns(exec.agent)) return next();
        const instructionError = await this.instructions.prepareTool(exec);
        if (instructionError) throw new Error(instructionError);
        const reason = this.permissionGuard(exec);
        if (reason) throw new Error(reason);
        this.activeTools++;
        const key = this.callKey(exec);
        this.diagnostics.tool(key, true);
        this.runningTools.set(key, {
          name: safeError(exec.name),
          arguments: safeError(JSON.stringify(exec.arguments) ?? ''),
        });
        this.changed();
        try {
          return await next();
        } finally {
          this.diagnostics.tool(key, false);
          this.runningTools.delete(key);
          this.activeTools--;
          if (!this.activeTools && this.transitioning) {
            this.transitioning = false;
            this.notice = `权限已切换：${permissionLabels[this.permissionMode]}`;
          }
          this.changed();
        }
      }),
    );
    this.disposers.push(
      ctx.systemPrompt.context({
        name: 'emergence-permissions-' + randomUUID(),
        order: 950,
        required: true,
        interpolate: false,
        text: ({ agent }) =>
          this.owns(agent)
            ? `Emergence permission mode: ${this.permissionMode}. Project boundary: ${this.launch.cwd}. Plan: read and reason only; no writes, shell or executing delegation. Ask: request approval for side effects. Edit: project edits allowed, commands and unknown tools need approval. Auto: only configured allow rules and project edits run automatically. Runtime constraints, explicit deny/ask rules and inherited task limits remain authoritative. Do not bypass a denied operation using another tool.`
            : '',
      }),
    );
    this.disposers.push(
      ctx.on('session/event', (session, event) => {
        if (event.type === 'approval/decided')
          this.interactions.cancelWhere(
            (r) => r.sessionId === session.id && r.binding?.nativeId === event.data.id,
          );
        if (event.type === 'turn/end')
          this.interactions.cancelWhere((r) => r.sessionId === session.id && r.binding?.turn !== undefined);
        if (event.type === 'turn/start') {
          for (const key of this.declined) if (key.startsWith(session.id + ':')) this.declined.delete(key);
        }
        if (session.id !== this.id) return;
        if (event.type === 'llm/retry') {
          this.diagnostics.model('retry');
          this.notice = '模型请求暂时中断，正在原预算内重试；已执行的工具不会重放';
        }
        if (this.usageProjection?.session === session.id) this.usageProjection.value.append(event);
        if (this.messages?.sessionId === session.id) this.messages.append(event);
        if (event.type === 'assistant/message') this.live = '';
        if (event.type === 'turn/end' && event.data.reason.kind === 'max-tokens') {
          const decision = this.planning.coordinatorRole(this.agent)
            ? this.planning.intake()?.autonomy
            : undefined;
          this.lastError =
            decision?.decision === 'blocked' && decision.reason
              ? decision.reason
              : '模型输出达到 Token 上限，本轮未完成；已保留执行记录，继续前请核对任务状态和输出预算。';
          this.notice = this.lastError;
        }
        if (this.display?.sessionId === session.id) {
          const line = eventLine(event);
          if (line) {
            this.display.lines.push(this.displayLine(line));
            if (this.display.lines.length > 200) this.display.lines.shift();
          }
        }
        this.changed();
      }),
    );
    this.disposers.push(
      ctx.on('agent/assistant-stream', ({ agent, frame }) => {
        if (agent.session.id !== this.id) return;
        if (frame.type === 'start') {
          this.diagnostics.model('start');
          this.live = '';
          this.streamPhase = 'waiting';
        }
        if (frame.type === 'chunk' && frame.chunk.type === 'reasoning-delta') this.streamPhase = 'reasoning';
        if (
          frame.type === 'chunk' &&
          ['reasoning-delta', 'text-delta', 'tool-call-delta'].includes(frame.chunk.type)
        )
          this.diagnostics.model('output');
        if (frame.type === 'chunk' && frame.chunk.type === 'text-delta') {
          this.streamPhase = 'writing';
          this.live = (this.live + frame.chunk.text).slice(-16000);
        }
        if (frame.type === 'end') {
          this.diagnostics.model('end');
          this.live = '';
          this.streamPhase = 'waiting';
        }
        this.changed();
      }),
    );
    this.disposers.push(
      ctx.on('agent/status', ({ agent, status }) => {
        if (agent.session.id === this.id) {
          if (status === 'running') {
            this.activityStartedAt ??= Date.now();
            this.diagnostics.start();
          } else {
            this.diagnostics.end(this.lastError ? 'error' : 'ended', this.lastError);
            this.activityStartedAt = undefined;
            this.streamPhase = 'waiting';
          }
          if (status === 'idle' && !this.lastError) this.notice = '本轮已完成';
          this.changed();
        }
      }),
    );
    this.disposers.push(
      ctx.on('agent/error', ({ agent, error }) => {
        if (agent.session.id === this.id) {
          this.lastError = safeError(error);
          this.diagnostics.end('error', this.lastError);
          this.notice = '执行失败：' + this.lastError;
          this.changed();
        }
      }),
    );
    for (const event of ['agent/inbox/inserted', 'agent/inbox/claimed', 'agent/inbox/discarded'] as const) {
      this.disposers.push(
        ctx.on(event, ({ agent }: { agent: Agent }) => {
          if (agent.session.id === this.id) this.changed();
        }),
      );
    }
    this.disposers.push(
      ctx.on('agent/inbox/claimed', ({ agent, message }) => {
        if (agent.session.id !== this.id) return;
        this.diagnostics.start();
        if (message.source.kind === 'emergence-task') this.diagnostics.assign(message.source.taskId);
      }),
    );
    this.disposers.push(
      ctx.on('approval/request', async (req, next): Promise<ApprovalOutcome> => {
        if (!this.owns(req.agent)) return next();
        const key = `${req.agent.id}:${req.callId}:${req.toolName}`,
          record = this.calls.get(key);
        const identity = approvalIdentity(req.agent.session.snapshotEvents(), req.toolName, req.callId);
        if (record && !identity.nativeId) return 'unavailable';
        const scope = this.approvalScope(req.agent),
          ownerSession = this.id;
        const policies = () =>
          permissionFingerprint([this.permissionSnapshot(), ...this.permissionConstraints(req.agent)]);
        const policy = policies();
        const valid = () => {
          const live = approvalIdentity(req.agent.session.snapshotEvents(), req.toolName, req.callId);
          return (
            !this.closed &&
            !req.signal?.aborted &&
            this.owns(req.agent) &&
            this.id === ownerSession &&
            live.nativeId === identity.nativeId &&
            live.turn === identity.turn &&
            policy === policies() &&
            stableDigest(scope ?? null) === stableDigest(this.approvalScope(req.agent) ?? null) &&
            (!record ||
              (this.calls.get(key) === record &&
                record.stamp === this.permissionState(record.exec).stamp &&
                record.fingerprint === this.permissionState(record.exec).fingerprint &&
                this.permissionState(record.exec).decision.effect !== 'deny'))
          );
        };
        const decline = (outcome: 'rejected' | 'cancelled') => {
          if (record) this.declined.add(this.declineKey(req.agent, record.fingerprint));
          return outcome;
        };
        const approveOnce = (session = false) => {
          if (!valid()) throw new Error('权限已经变化，请重新发起调用');
          if (session && record) {
            const state = this.permissionState(record.exec);
            if (state.decision.explicitAsk) throw new Error('显式 ask 规则只能逐次确认');
            if (this.grants.size >= 4096) throw new Error('会话许可已达上限，请先 /permission revoke');
            this.grants.add(state.stamp + ':' + state.fingerprint);
          }
          this.confirmed.add(key);
          return 'allowed-once' as const;
        };
        if (
          record &&
          ['pwsh', 'bash'].includes(req.toolName) &&
          !this.permissionState(record.exec).decision.explicitAsk
        ) {
          const args: unknown = record.exec.arguments;
          if (
            typeof args === 'object' &&
            args !== null &&
            'command' in args &&
            typeof args.command === 'string'
          ) {
            const index = approved.indexOf(args.command);
            if (index >= 0) {
              approved.splice(index, 1);
              return approveOnce();
            }
          }
        }
        if (this.launch.prompt !== undefined) return 'rejected';
        try {
          return await this.interactions.request(
            {
              kind: 'permission',
              sessionId: req.agent.session.id,
              agentId: req.agent.id,
              title: `会话 ${req.agent.session.id}\n需要确认：${req.toolName}\n${this.launch.appConfig.shellMode === 'ask-local' && ['pwsh', 'bash'].includes(req.toolName) ? '此命令将在本机直接执行。\n' : ''}${record ? '会话许可仅覆盖同代理、同目录及完整参数；切换模式、撤销或关闭后失效。\n' : ''}${req.reason ?? ''}`,
              options: [
                { id: 'allow', label: '允许本次', value: 'y' },
                { id: 'deny', label: '拒绝本次', value: 'n' },
                ...(record && !this.permissionState(record.exec).decision.explicitAsk
                  ? [{ id: 'session', label: '本会话允许相同操作', value: 's' }]
                  : []),
              ],
              allowCustom: false,
              binding: {
                ...identity,
                ...scope,
                callId: req.callId,
                tool: req.toolName,
                cwd: this.ctx.workingDirectory.get(req.agent.session),
                fingerprint: record?.fingerprint ?? stableDigest([req.toolName, req.callId, req.reason]),
                permissionVersion: policy,
              },
            },
            (text) => {
              if (text.trim().toLowerCase() === 'y') return approveOnce();
              if (text.trim().toLowerCase() === 'n') return decline('rejected');
              if (text.trim().toLowerCase() === 's' && record) return approveOnce(true);
              throw new Error('请输入 y 或 n');
            },
            req.signal,
            () => decline('cancelled'),
            undefined,
            valid,
          );
        } catch (error) {
          if (req.signal?.aborted || this.closed) return 'cancelled';
          throw error;
        }
      }),
    );
    this.disposers.push(
      ctx.on('user-questions/request', async (req, next) => {
        if (!req.agent || !this.owns(req.agent)) return next();
        if (this.launch.prompt !== undefined) throw new Error('此任务需要人工回答，请在交互终端中运行');
        const clarify = req.questions.some((q) => q.intent?.kind === 'approval')
          ? undefined
          : this.planning.captureClarification(req.agent);
        const answers = [];
        for (const q of req.questions) {
          const options = q.options ?? [];
          const title = [`会话 ${req.agent.session.id}`, q.question, q.detail ?? ''].join('\n');
          answers.push(
            await this.interactions.request(
              {
                title,
                sessionId: req.agent.session.id,
                agentId: req.agent.id,
                kind: options.length ? (q.multiSelect ? 'multiChoice' : 'singleChoice') : 'text',
                options: options.map((option, index) => ({
                  id: String(index + 1),
                  label: option.label,
                  value: String(index + 1),
                })),
                allowCustom: q.intent?.kind !== 'approval',
              },
              (text) => {
                const indices = text.split(',').map((s) => Number(s.trim()));
                if (indices.every((n) => Number.isInteger(n) && n > 0 && n <= options.length)) {
                  if (!q.multiSelect && indices.length > 1) throw new Error('该问题只接受一个选项');
                  return { id: q.id, selected: [...new Set(indices.map((n) => options[n - 1].label))] };
                }
                if (q.intent?.kind === 'approval') throw new Error('请回答一个选项编号');
                return { id: q.id, selected: [], custom: text };
              },
              req.signal,
              undefined,
              (answer) =>
                answer.text !== undefined
                  ? { id: q.id, selected: [] as string[], custom: answer.text }
                  : { id: q.id, selected: answer.selected!.map((id) => options[Number(id) - 1].label) },
            ),
          );
        }
        req.signal?.throwIfAborted();
        await clarify?.(
          JSON.stringify({
            questions: req.questions.map(({ id, question }) => ({ id, question })),
            answers,
          }),
        );
        return { answers };
      }),
    );
  }
  get id() {
    return this.handle?.agent.session.id;
  }
  get agent() {
    if (!this.handle) throw new Error('会话尚未就绪');
    return this.handle.agent;
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
  get busy() {
    return this.handle?.agent.status === 'running';
  }
  get activity() {
    return {
      stopping: this.stopping,
      startedAt: this.activityStartedAt,
      phase: this.streamPhase,
      tools: [...this.runningTools.values()],
      queued:
        this.handle?.agent.inbox.nextTurn.filter((message) => message.source.kind === 'user').length ?? 0,
    };
  }
  get pending() {
    return this.interactions.pending;
  }
  get pendingInteractions() {
    return this.interactions.all;
  }
  private declineKey(agent: Agent, fingerprint: string) {
    return agent.session.id + ':' + fingerprint;
  }
  get permissionTransitioning() {
    return this.transitioning;
  }
  get permissionEpoch() {
    return this.permissionRevision;
  }
  permissionSnapshot(): PermissionSnapshot {
    return structuredClone({
      mode: this.permissionMode,
      root: this.launch.cwd,
      revision: this.permissionRevision,
      rules: this.launch.appConfig.permissions.rules,
      deny: this.launch.appConfig.toolPolicy.deny,
      confirm: this.launch.appConfig.toolPolicy.confirm,
    });
  }
  invalidatePermissions() {
    this.permissionRevision++;
    this.confirmed.clear();
    this.grants.clear();
    if (this.activeTools) {
      this.transitioning = true;
      this.notice = '权限约束已更新，等待已开始的工具结束';
    }
    this.interactions.cancelPermissions();
    this.changed();
  }
  setPermissionMode(mode: PermissionMode) {
    permissionModeSchema.parse(mode);
    if (this.closed) throw new Error('会话正在关闭');
    if (mode === this.permissionMode) return;
    this.permissionMode = mode;
    this.transitioning = this.activeTools > 0;
    this.invalidatePermissions();
    this.notice = this.transitioning
      ? `正在切换到${permissionLabels[mode]}，等待已开始的工具结束；不会撤销已发生的操作`
      : `权限已切换：${permissionLabels[mode]}`;
    this.changed();
  }
  cyclePermission() {
    this.setPermissionMode(
      permissionModes[(permissionModes.indexOf(this.permissionMode) + 1) % permissionModes.length],
    );
  }
  async confirmDecision(title: string, valid: () => boolean = () => true): Promise<boolean> {
    if (this.closed || this.launch.prompt !== undefined) return false;
    const session = this.id,
      epoch = this.permissionEpoch;
    return this.interactions.request(
      {
        kind: 'permission',
        sessionId: this.agent.session.id,
        agentId: this.agent.id,
        title,
        options: [
          { id: 'cancel', label: '暂不执行', value: 'n' },
          { id: 'confirm', label: '已核对，确认本次操作', value: 'y' },
        ],
        allowCustom: false,
      },
      (answer) => {
        if (answer === 'n') return false;
        if (answer !== 'y') throw new Error('请选择确认或取消');
        if (this.closed || this.id !== session || this.permissionEpoch !== epoch || !valid())
          throw new Error('决策依据或权限已变化，请取消后重新核对');
        return true;
      },
      undefined,
      () => false,
      undefined,
      () => !this.closed && this.id === session && this.permissionEpoch === epoch && valid(),
    );
  }
  cancelInteractions() {
    this.interactions.cancelAll();
  }
  private callKey(exec: Pick<ToolExecution, 'agent' | 'callId' | 'name'>) {
    return `${exec.agent?.id}:${exec.callId}:${exec.name}`;
  }
  private permissionState(exec: ToolExecution) {
    const call = {
      name: exec.name,
      arguments: exec.arguments,
      actor: exec.agent!.id,
      cwd: this.ctx.workingDirectory.get(exec.agent!.session),
    };
    const policies = [this.permissionSnapshot(), ...this.permissionConstraints(exec.agent)];
    const decision = evaluatePermissions(policies, call);
    let fingerprint = '';
    try {
      fingerprint = callFingerprint(call);
    } catch {
      decision.effect = 'deny';
      decision.reason = '无法可靠解析调用路径';
    }
    this.core.permissionCheck(exec.agent!.id, this.callKey(exec), {
      modes: policies.map((p) => p.mode),
      toolKind: toolKind(exec.name, exec.arguments),
      legacyDecision: decision.effect,
    });
    return {
      call,
      decision,
      fingerprint,
      stamp: permissionFingerprint({ policies, revision: this.permissionRevision }),
    };
  }
  private hasGrant(state: ReturnType<SessionController['permissionState']>) {
    return !state.decision.explicitAsk && this.grants.has(state.stamp + ':' + state.fingerprint);
  }
  private permissionGuard(exec: ToolExecution) {
    const planningError = this.planning.guard(exec);
    if (planningError) return planningError;
    if (this.executionModel(exec.agent!)?.capabilities?.tools === false) return '此模型配置声明不支持工具';
    if (this.transitioning) return '权限正在切换，等待已开始的工具结束';
    const state = this.permissionState(exec),
      key = this.callKey(exec),
      record = this.calls.get(key);
    if (state.decision.effect === 'deny') return state.decision.reason;
    if (record && (record.stamp !== state.stamp || record.fingerprint !== state.fingerprint))
      return '权限或实际路径已变化，旧调用已失效';
    if (state.decision.effect === 'ask' && !this.hasGrant(state) && !(record && this.confirmed.has(key)))
      return '所属窗口尚未确认此工具调用';
  }
  async writeWithPermission(path: string, content: string, action: () => Promise<void>) {
    const agent = this.agent,
      call = { name: 'write', arguments: { file_path: path, content }, actor: agent.id, cwd: this.cwd };
    const state = () => {
      const policies = [this.permissionSnapshot(), ...this.permissionConstraints(agent)];
      return {
        decision: evaluatePermissions(policies, call),
        stamp: permissionFingerprint({
          policies,
          revision: this.permissionRevision,
          fingerprint: callFingerprint(call),
        }),
      };
    };
    const initial = state();
    if (this.closed || this.transitioning || initial.decision.effect === 'deny')
      throw new Error(initial.decision.reason || '权限正在切换');
    if (initial.decision.effect === 'ask') {
      if (this.launch.prompt !== undefined) throw new Error('初始化写入需要人工确认，请在交互终端操作');
      const allow = await this.interactions.request(
        {
          kind: 'permission',
          title: `初始化规则文件\n${path}\n${initial.decision.reason}\n只写入已预览草案，不修改运行时权限。`,
          sessionId: agent.session.id,
          agentId: agent.id,
          options: [
            { id: 'allow', label: '写入已预览草案', value: 'y' },
            { id: 'deny', label: '取消写入', value: 'n' },
          ],
          allowCustom: false,
        },
        (text) => {
          if (text.trim().toLowerCase() === 'y') return true;
          if (text.trim().toLowerCase() === 'n') return false;
          throw new Error('请选择允许或取消');
        },
        undefined,
        () => false,
      );
      if (!allow) throw new Error('初始化写入已取消');
    }
    const final = state();
    if (
      this.closed ||
      this.handle?.agent !== agent ||
      final.stamp !== initial.stamp ||
      final.decision.effect === 'deny' ||
      this.transitioning
    )
      throw new Error('会话、权限或文件路径已变化，未写入；请重新 /init');
    this.activeTools++;
    try {
      await action();
    } finally {
      this.activeTools--;
      if (!this.activeTools) this.transitioning = false;
      this.changed();
    }
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
  owns(agent?: Agent): boolean {
    if (!agent || !this.handle || this.closed) return false;
    const roots = [this.handle.agent],
      seen = new Set<Agent>();
    const candidates = this.ctx.agents.list();
    for (const owner of roots) {
      if (owner === agent) return true;
      if (seen.has(owner)) continue;
      seen.add(owner);
      for (const child of candidates)
        if (!seen.has(child) && this.ctx.agents.isOwnedBy(child.id, owner)) roots.push(child);
    }
    return false;
  }
  get cwd() {
    return this.handle ? this.ctx.workingDirectory.get(this.agent.session) : this.launch.cwd;
  }
  changed() {
    this.diagnostics.pending(!!this.pending);
    if (!this.closed) this.emit('change');
  }
  transcript() {
    return this.handle
      ? this.agent.session.snapshotEvents().flatMap((e) => {
          const line = eventLine(e);
          return line ? [safeError(line)] : [];
        })
      : [];
  }
  displayMessages() {
    if (!this.handle) return undefined;
    if (this.messages?.sessionId !== this.id)
      this.messages = new MessageProjection(this.id!).load(this.agent.session.snapshotEvents());
    return this.messages;
  }
  tokenUsage() {
    if (!this.handle) return undefined;
    if (!this.usageProjection || this.usageProjection.session !== this.id) {
      const value = new SessionUsage();
      for (const event of this.agent.session.snapshotEvents()) value.append(event);
      this.usageProjection = { session: this.id!, value };
    }
    return this.usageProjection!.value;
  }
  private displayLine(line: string) {
    return safeError(
      line.length > 16000 ? line.slice(0, 16000) + '\n[界面截断，完整内容在会话日志中]' : line,
    );
  }
  /** The UI tail is incremental; exports and persisted history remain complete. */
  displayTranscript(): readonly string[] {
    if (!this.handle) return [];
    if (!this.display || this.display.sessionId !== this.id)
      this.display = {
        sessionId: this.id!,
        lines: this.transcript()
          .slice(-200)
          .map((line) => this.displayLine(line)),
      };
    return this.display.lines;
  }
  async open(resume?: string) {
    if (this.closed) throw new Error('会话正在关闭');
    if (this.instructions.initializing) throw new Error('规则初始化尚未完成，请先完成或取消确认');
    if (this.busy) throw new Error('请先等当前任务完成或按 Esc 停止');
    if (resume !== undefined && resume === this.id) return;
    const options = { agentOptions: { provider: this.model.id, model: this.model.model } };
    const id = resume ?? randomUUID();
    const release = await acquireLease(
      `session:${await canonicalDirectory(this.launch.home)}:${id}`,
      '该历史会话',
    );
    let handle: AgentHandle;
    try {
      handle = resume
        ? await this.ctx.agents.resume({
            resumeSessionId: SessionId(resume),
            ...options,
            setup: (_ctx, agent) => {
              // Old assigned inbox entries are historical intents, not authority to replay work.
              for (const message of [...agent.inbox.nextTurn, ...agent.inbox.nextStep])
                if (['emergence-task', 'emergence-note', 'emergence-receipt'].includes(message.source.kind))
                  agent.inbox.remove(message.id);
            },
          })
        : await this.ctx.agents.create({ sessionId: SessionId(id), meta: { cwd: this.cwd }, ...options });
      try {
        await this.ctx.sessionPersistence.flush();
      } catch (error) {
        await handle.dispose();
        throw error;
      }
      if (this.closed) {
        await handle.dispose();
        throw new Error('会话正在关闭');
      }
    } catch (error) {
      await release();
      throw error;
    }
    if (resume) {
      if (this.launch.explicitModel) {
        try {
          assertModelHistory(this.model, handle.agent.session.snapshotEvents(), [
            ...handle.agent.inbox.nextStep,
            ...handle.agent.inbox.nextTurn,
          ]);
          handle.agent.model.select({ provider: this.model.id, model: this.model.model });
        } catch (error) {
          await handle.dispose();
          await release();
          throw error;
        }
      } else {
        const selection = handle.agent.model.current();
        const model = this.launch.appConfig.models.find(
          (m) => m.id === selection?.provider && m.model === selection.model,
        );
        if (!model) {
          await handle.dispose();
          await release();
          throw new Error('原会话的模型配置已不存在，请用 --model 指定配置后恢复');
        }
        try {
          assertModelHistory(model, handle.agent.session.snapshotEvents(), [
            ...handle.agent.inbox.nextStep,
            ...handle.agent.inbox.nextTurn,
          ]);
        } catch (error) {
          await handle.dispose();
          await release();
          throw error;
        }
        this.launch.modelId = model.id;
      }
    }
    const previous = this.handle;
    this.invalidatePermissions();
    this.calls.clear();
    this.declined.clear();
    this.interactions.cancelAll();
    const previousLease = this.releaseSession;
    this.handle = handle;
    await this.diagnostics.bind(handle.agent.session.id);
    this.memory.register(handle.agent);
    // Idle workers must advertise real domain capabilities before their first
    // assignment. Waiting for inbox/claimed makes capability-based dispatch fail.
    this.code.register(handle.agent);
    this.codeWork.register(handle.agent);
    this.data.register(handle.agent);
    this.launch.cwd = handle.agent.session.header.cwd ?? this.launch.cwd;
    await this.core.bind(
      handle.agent.session.id,
      process.platform === 'win32' ? this.launch.cwd.toLowerCase() : this.launch.cwd,
    );
    this.releaseSession = release;
    try {
      await previous?.dispose();
    } catch (error) {
      this.notice = '先前会话释放失败：' + safeError(error);
    } finally {
      await previousLease?.();
    }
    this.live = '';
    this.activityStartedAt = undefined;
    this.streamPhase = 'waiting';
    this.lastError = undefined;
    this.changed();
    await replaceJsonFile(
      join(this.launch.home, 'last-session.json'),
      { id: this.id, cwd: this.cwd },
      {
        invalidMessage: '最近会话路径不是普通文件，未覆盖',
      },
    );
  }
  async send(text: string) {
    if (this.closed) return;
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
  async cancel() {
    this.diagnostics.cancelling();
    this.interactions.cancelAll();
    if (this.handle) {
      this.stopping = true;
      this.changed();
      try {
        this.agent.cancel({ kind: 'user' });
        await this.agent.whenIdle();
        this.live = '';
        this.notice = '已停止当前任务';
      } finally {
        this.stopping = false;
        this.changed();
      }
    }
  }
  async command(text: string) {
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
        await this.ctx.llm.resolveModelInfo(model.id, model.model);
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
  close() {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      const errors: unknown[] = [];
      try {
        try {
          await this.cancel();
          await this.instructions.settle();
        } catch (error) {
          errors.push(error);
        }
        try {
          await this.ctx.sessionPersistence.flush();
        } catch (error) {
          errors.push(error);
        }
        try {
          await this.handle?.dispose();
        } catch (error) {
          errors.push(error);
        }
        await this.planning.settle();
        await this.core.close();
        await this.diagnostics.close();
      } finally {
        await Promise.allSettled([
          ...this.childReleases,
          ...[...this.childLeases.values()].map((release) => release()),
        ]);
        this.childLeases.clear();
        await this.releaseSession?.();
        this.disposers.forEach((dispose) => dispose());
        this.confirmed.clear();
        this.grants.clear();
        this.calls.clear();
        this.display = undefined;
        this.messages = undefined;
        this.live = '';
        this.handle = undefined;
        this.interactions.cancelAll();
        this.removeAllListeners();
      }
      if (errors.length) throw new AggregateError(errors, '会话释放失败');
    })();
    return this.closing;
  }
}
import type {} from '@deepseek-ai/dsh-llm-retry';
