import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-llm-retry';
import type {} from '@deepseek-ai/dsh-session-persistence';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types';
import type {} from '@deepseek-ai/dsh-user-questions';
import type {} from '@deepseek-ai/dsh-working-directory';
import { randomUUID } from 'node:crypto';
import { approvalIdentity } from '../core/adapters/approval-identity.ts';
import { toolKind } from '../core/adapters/harness.ts';
import { callFingerprint, evaluatePermissions, permissionFingerprint } from '../core/adapters/permissions.ts';
import type { CoreObserver } from '../core/application/observer.ts';
import {
  permissionLabels,
  permissionModeSchema,
  permissionModes,
  type PermissionMode,
  type PermissionSnapshot,
  type ToolConfirmation,
} from '../core/domain/permissions.ts';
import { stableDigest } from '../core/storage/execution-journal.ts';
import { InteractionQueue } from './interactions.ts';
import type { LaunchConfig } from './session-config.ts';
export interface SessionPermissionHost {
  readonly ctx: Context;
  readonly launch: Pick<LaunchConfig, 'cwd' | 'permissionMode' | 'prompt' | 'approvedCommands'> & {
    appConfig: Pick<LaunchConfig['appConfig'], 'permissions' | 'toolPolicy' | 'shellMode'>;
  };
  readonly closed: boolean;
  notice: string;
  current(): Agent | undefined;
  cwd(): string;
  owns(agent?: Agent): boolean;
  changed(): void;
  permissionConstraints(agent?: Agent): PermissionSnapshot[];
  approvalScope(agent: Agent): { taskId: string; runId?: string } | undefined;
  guardPlan(exec: ToolExecution): string | undefined;
  prepareTool(exec: ToolExecution): Promise<string | undefined>;
  supportsTools(agent: Agent): boolean;
  permissionCheck: CoreObserver['permissionCheck'];
  toolActivity(exec: ToolExecution, active: boolean): void;
}
/** Owns grants, denied-call identity and permission transitions. The queue owns interaction settlement. */
export class SessionPermissions {
  private readonly disposers: Array<() => void> = [];

  private readonly confirmed = new Set<string>();

  private readonly grants = new Set<string>();

  private readonly declined = new Set<string>();

  private readonly calls = new Map<string, { exec: ToolExecution; stamp: string; fingerprint: string }>();

  private permissionRevision = 0;

  private activeTools = 0;

  private transitioning = false;

  private mode: PermissionMode;

  constructor(
    private host: SessionPermissionHost,
    private interactions: InteractionQueue,
  ) {
    this.mode = host.launch.permissionMode ?? host.launch.appConfig.permissions.defaultMode;
  }

  mount() {
    const ctx = this.host.ctx;
    const approved = [...(this.host.launch.approvedCommands ?? [])];
    this.disposers.push(
      ctx.tools.guard((exec) => (this.host.owns(exec.agent) ? this.permissionGuard(exec) : undefined)),
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
        if (!this.host.owns(exec.agent)) return next();
        const planningError = this.host.guardPlan(exec);
        if (planningError) return { kind: 'deny', reason: planningError };
        const instructionError = await this.host.prepareTool(exec);
        if (instructionError) return { kind: 'deny', reason: instructionError };
        if (!this.host.supportsTools(exec.agent!)) throw new Error('此模型配置声明不支持工具');
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
        if (!this.host.owns(exec.agent)) return next();
        const instructionError = await this.host.prepareTool(exec);
        if (instructionError) throw new Error(instructionError);
        const reason = this.permissionGuard(exec);
        if (reason) throw new Error(reason);
        this.activeTools++;

        this.host.toolActivity(exec, true);
        this.host.changed();
        try {
          return await next();
        } finally {
          this.host.toolActivity(exec, false);
          this.activeTools--;
          if (!this.activeTools && this.transitioning) {
            this.transitioning = false;
            this.host.notice = `权限已切换：${permissionLabels[this.permissionMode]}`;
          }
          this.host.changed();
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
          this.host.owns(agent)
            ? `Emergence permission mode: ${this.permissionMode}. Project boundary: ${this.host.launch.cwd}. Plan: read and reason only; no writes, shell or executing delegation. Ask: request approval for side effects. Edit: project edits allowed, commands and unknown tools need approval. Auto: only configured allow rules and project edits run automatically. Rage: the user has enabled automatic tool approvals in this window, overriding its configured tool rules. Runtime constraints and inherited task limits still apply. Do not bypass a denied operation using another tool.`
            : '',
      }),
    );
    this.disposers.push(
      ctx.on('approval/request', async (req, next): Promise<ApprovalOutcome> => {
        if (!this.host.owns(req.agent)) return next();
        const key = `${req.agent.id}:${req.callId}:${req.toolName}`,
          record = this.calls.get(key);
        const identity = approvalIdentity(req.agent.session.snapshotEvents(), req.toolName, req.callId);
        if (record && !identity.nativeId) return 'unavailable';
        const scope = this.host.approvalScope(req.agent),
          ownerSession = this.host.current()?.session.id;
        const policies = () =>
          permissionFingerprint([this.permissionSnapshot(), ...this.host.permissionConstraints(req.agent)]);
        const policy = policies();
        const valid = () => {
          const live = approvalIdentity(req.agent.session.snapshotEvents(), req.toolName, req.callId);
          return (
            !this.host.closed &&
            !req.signal?.aborted &&
            this.host.owns(req.agent) &&
            this.host.current()?.session.id === ownerSession &&
            live.nativeId === identity.nativeId &&
            live.turn === identity.turn &&
            policy === policies() &&
            stableDigest(scope ?? null) === stableDigest(this.host.approvalScope(req.agent) ?? null) &&
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
          this.mode === 'rage' &&
          identity.nativeId &&
          (record
            ? this.permissionState(record.exec).decision.effect === 'allow'
            : this.host.permissionConstraints(req.agent).every((constraint) => constraint.mode === 'rage'))
        )
          return this.transitioning ? 'cancelled' : approveOnce();
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
        if (this.host.launch.prompt !== undefined) return 'rejected';
        try {
          return await this.interactions.request(
            {
              kind: 'permission',
              sessionId: req.agent.session.id,
              agentId: req.agent.id,
              title: `会话 ${req.agent.session.id}\n需要确认：${req.toolName}\n${this.host.launch.appConfig.shellMode === 'ask-local' && ['pwsh', 'bash'].includes(req.toolName) ? '此命令将在本机直接执行。\n' : ''}${record ? '会话许可仅覆盖同代理、同目录及完整参数；切换模式、撤销或关闭后失效。\n' : ''}${req.reason ?? ''}`,
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
                cwd: this.host.ctx.workingDirectory.get(req.agent.session),
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
          if (req.signal?.aborted || this.host.closed) return 'cancelled';
          throw error;
        }
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
      }),
    );
    this.disposers.push(
      ctx.on('agent/disposed', ({ agent }) => {
        this.interactions.cancelWhere((r) => r.agentId === agent.id);
        for (const key of this.declined)
          if (key.startsWith(agent.session.id + ':')) this.declined.delete(key);
      }),
    );
    return this.disposers;
  }

  get permissionMode() {
    return this.mode;
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
      root: this.host.launch.cwd,
      revision: this.permissionRevision,
      rules: this.host.launch.appConfig.permissions.rules,
      deny: this.host.launch.appConfig.toolPolicy.deny,
      confirm: this.host.launch.appConfig.toolPolicy.confirm,
    });
  }

  invalidatePermissions() {
    this.permissionRevision++;
    this.confirmed.clear();
    this.grants.clear();
    if (this.activeTools) {
      this.transitioning = true;
      this.host.notice = '权限约束已更新，等待已开始的工具结束';
    }
    this.interactions.cancelPermissions();
    this.host.changed();
  }

  setPermissionMode(mode: PermissionMode) {
    permissionModeSchema.parse(mode);
    if (this.host.closed) throw new Error('会话正在关闭');
    if (mode === this.permissionMode) return;
    this.mode = mode;
    this.transitioning = this.activeTools > 0;
    this.invalidatePermissions();
    this.host.notice = this.transitioning
      ? `正在切换到${permissionLabels[mode]}，等待已开始的工具结束；不会撤销已发生的操作`
      : `权限已切换：${permissionLabels[mode]}`;
    this.host.changed();
  }

  cyclePermission() {
    const index = permissionModes.indexOf(this.mode);
    this.setPermissionMode(permissionModes[(index + 1) % permissionModes.length]);
  }

  async confirmToolDecision(
    tool: ToolExecution,
    title: string,
    valid: () => boolean,
  ): Promise<ToolConfirmation> {
    if (this.host.closed || tool.signal.aborted || !this.host.owns(tool.agent)) return false;
    if (this.mode === 'rage') {
      const decision = this.permissionState(tool).decision;
      if (decision.effect === 'deny') return false;
      if (decision.effect === 'allow') return !this.transitioning && valid() && 'auto-approved';
    }
    return (await this.confirmDecision(title, valid)) && 'user-confirmed';
  }

  async confirmDecision(title: string, valid: () => boolean = () => true): Promise<boolean> {
    if (this.host.closed || this.host.launch.prompt !== undefined) return false;
    const owner = this.host.current();
    if (!owner) return false;
    const session = owner.session.id,
      epoch = this.permissionEpoch;
    return this.interactions.request(
      {
        kind: 'permission',
        sessionId: session,
        agentId: owner.id,
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
        if (
          this.host.closed ||
          this.host.current()?.session.id !== session ||
          this.permissionEpoch !== epoch ||
          !valid()
        )
          throw new Error('决策依据或权限已变化，请取消后重新核对');
        return true;
      },
      undefined,
      () => false,
      undefined,
      () =>
        !this.host.closed &&
        this.host.current()?.session.id === session &&
        this.permissionEpoch === epoch &&
        valid(),
    );
  }

  private callKey(exec: Pick<ToolExecution, 'agent' | 'callId' | 'name'>) {
    return `${exec.agent?.id}:${exec.callId}:${exec.name}`;
  }

  private permissionState(exec: ToolExecution) {
    const call = {
      name: exec.name,
      arguments: exec.arguments,
      actor: exec.agent!.id,
      cwd: this.host.ctx.workingDirectory.get(exec.agent!.session),
    };
    const policies = [this.permissionSnapshot(), ...this.host.permissionConstraints(exec.agent)];
    const decision = evaluatePermissions(policies, call);
    let fingerprint = '';
    try {
      fingerprint = callFingerprint(call);
    } catch {
      decision.effect = 'deny';
      decision.reason = '无法可靠解析调用路径';
    }
    this.host.permissionCheck(exec.agent!.id, this.callKey(exec), {
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

  private hasGrant(state: ReturnType<SessionPermissions['permissionState']>) {
    return !state.decision.explicitAsk && this.grants.has(state.stamp + ':' + state.fingerprint);
  }

  private permissionGuard(exec: ToolExecution) {
    const planningError = this.host.guardPlan(exec);
    if (planningError) return planningError;
    if (!this.host.supportsTools(exec.agent!)) return '此模型配置声明不支持工具';
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
    const agent = this.host.current()!,
      call = {
        name: 'write',
        arguments: { file_path: path, content },
        actor: agent.id,
        cwd: this.host.cwd(),
      };
    const state = () => {
      const policies = [this.permissionSnapshot(), ...this.host.permissionConstraints(agent)];
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
    if (this.host.closed || this.transitioning || initial.decision.effect === 'deny')
      throw new Error(initial.decision.reason || '权限正在切换');
    if (initial.decision.effect === 'ask') {
      if (this.host.launch.prompt !== undefined) throw new Error('初始化写入需要人工确认，请在交互终端操作');
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
      this.host.closed ||
      this.host.current() !== agent ||
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
      this.host.changed();
    }
  }

  reset() {
    this.invalidatePermissions();
    this.calls.clear();
    this.declined.clear();
    this.interactions.cancelAll();
  }

  close() {
    this.confirmed.clear();
    this.grants.clear();
    this.declined.clear();
    this.calls.clear();
    this.interactions.cancelAll();
  }
}
