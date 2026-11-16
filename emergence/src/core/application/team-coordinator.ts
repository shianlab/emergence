import { defineTool } from '@deepseek-ai/dsh-tools';
import { safeError } from '../adapters/redaction.ts';
import { roles } from '../domain/orchestration.ts';
import type { Capability, PlanningState } from '../domain/planning.ts';
import { inventoryPage } from '../domain/inventory-view.ts';
import { orchestrationLimits } from '../domain/run-budget.ts';
import { coordinationSchema, rolePreferenceSchema, type TeamMember } from '../domain/team.ts';
import { digest } from '../storage/execution-journal.ts';
import type { WorkspacePort as WorkspaceController } from './runtime-ports.ts';
import { TeamFollowthrough } from './team-followthrough.ts';

/** Team facts and durable intake only; Collaboration remains the sole scheduler. */
export class TeamCoordinator {
  readonly followthrough: TeamFollowthrough;
  constructor(private w: WorkspaceController) {
    this.followthrough = new TeamFollowthrough(w);
  }
  get active() {
    const s = this.w.collaboration.state;
    return this.w.executionScope === 'workspace' && s.mode === 'collaborate' && !s.paused;
  }
  get records() {
    return this.w.collaboration.state.coordinations ?? [];
  }
  roster(): TeamMember[] {
    const s = this.w.collaboration.state;
    return [...this.w.panes.values()].map((p) => {
      const c = p.controller,
        task = this.w.collaboration.current(p.id);
      const position = s.master === p.id ? 'master' : s.workers.includes(p.id) ? 'worker' : 'independent';
      const state =
        !c || p.error || !this.w.available(p.id)
          ? 'unavailable'
          : s.owned.includes(p.id)
            ? 'human-controlled'
            : c.pending
              ? 'waiting-user'
              : c.busy
                ? 'busy'
                : 'idle';
      const queueable =
        this.active &&
        position === 'worker' &&
        !['unavailable', 'human-controlled'].includes(state) &&
        (state === 'idle' || Boolean(task));
      const reason = !this.active
        ? '协作未启用或已暂停'
        : position !== 'worker'
          ? '主控或独立窗口'
          : state === 'unavailable'
            ? '会话不可用或正在切换'
            : state === 'human-controlled'
              ? '用户已接管'
              : !queueable
                ? '窗口正在处理独立工作，暂不参与派工'
                : state === 'idle'
                  ? '可接收任务'
                  : '正在执行既有任务，可排队';
      return {
        id: p.id,
        session: c?.id ?? p.sessionId,
        project: c?.cwd ?? p.cwd,
        model: c?.launch.modelId ?? p.modelId,
        queued: s.tasks.filter((t) => t.target === p.id && t.status === 'queued').length,
        running: task ? 1 : 0,
        position,
        preference: p.rolePreference ?? 'auto',
        state,
        queueable,
        dispatchable: queueable && state === 'idle',
        reason,
        ...(task ? { task: task.id, assignedRole: task.contract?.role } : {}),
        ...(c ? { permission: c.permissionSnapshot() } : {}),
      };
    });
  }
  async setPreference(id: string, value: string) {
    const p = this.w.panes.get(id);
    if (!p) throw new Error('窗口不存在');
    const role = rolePreferenceSchema.parse(value);
    if (role !== 'auto' && !roles(this.w.launch.appConfig.orchestration).some((r) => r.id === role))
      throw new Error('角色不存在');
    p.rolePreference = role;
    this.w.notice = '角色偏好已保存；仅影响后续任务，不改变当前任务与权限';
    this.w.changed();
    await this.w.save();
  }
  sync(master: string, state: PlanningState) {
    const c = this.w.panes.get(master)?.controller,
      s = this.w.collaboration.state;
    if (
      !c ||
      !this.active ||
      s.master !== master ||
      !state.requestIds.length ||
      this.w.collaboration.current(master)
    )
      return;
    const last = state.requestIds.at(-1)!;
    const existing = this.records.find(
      (r) => r.session === c.id && (r.requestIds.includes(last) || r.id === state.coordination),
    );
    if (!existing && state.route === 'direct' && !state.analysis) return;
    // A directory switch does not silently rebind an admitted objective.
    if (existing && existing.project !== c.cwd) return;
    if (!existing && this.records.length >= 500) throw new Error('主控请求记录已达上限；请归档工作台后继续');
    const requestIds = [...new Set([...(existing?.requestIds ?? []), last])];
    const record = coordinationSchema.parse({
      id: existing?.id ?? digest([this.w.path, c.id, last]),
      master,
      session: c.id,
      project: c.cwd,
      requestIds,
      request: safeError(state.request),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      phase: existing?.followthrough
        ? existing.phase
        : state.executions?.length
          ? 'dispatched'
          : state.autonomy?.decision === 'blocked'
            ? 'blocked'
            : state.analysis?.intent === 'discuss'
              ? 'discussion'
              : state.analysis?.intent === 'clarify' ||
                  state.analysis?.questions?.length ||
                  state.status === 'needs-input'
                ? 'waiting-input'
                : state.plan && state.status === 'ready'
                  ? 'planned'
                  : state.analysis
                    ? 'understood'
                    : 'received',
      teamAtIntake: existing?.teamAtIntake ?? this.roster(),
      analysis: state.analysis,
      planId: state.plan ? digest(state.plan) : undefined,
      executions: state.executions ?? [],
      blockReason: existing?.followthrough
        ? existing.blockReason
        : state.autonomy?.decision === 'blocked'
          ? state.autonomy.reason
          : undefined,
      waitReason: existing?.waitReason,
      followthrough:
        existing?.followthrough ??
        (state.autonomy && state.executions?.length
          ? {
              startedAt: Date.now(),
              maxDurationMs: orchestrationLimits.teamExecutionMs,
              maxSteps: orchestrationLimits.teamSteps,
              maxActions: orchestrationLimits.teamActions,
              maxRepairs: orchestrationLimits.teamRepairs,
              actions: 0,
            }
          : undefined),
      assignments: state.plan?.steps.map((step) => ({
        step: step.id,
        window: step.window,
        role: step.role,
        reason: step.allocation?.reason ?? '模型指定，经计划校验',
      })),
    });
    const records = this.records.filter((r) => r.id !== record.id).concat(record);
    if (JSON.stringify(records).length > 4_000_000)
      throw new Error('主控请求记录超过容量限制，请归档工作台后继续');
    const previous = s.coordinations;
    s.coordinations = records;
    try {
      this.w.collaboration.checkpoint();
    } catch (error) {
      s.coordinations = previous;
      throw error;
    }
    state.coordination = record.id;
    this.w.changed();
    this.w.collaboration.kick();
  }
  async snapshot() {
    const before = this.roster();
    const master = this.w.collaboration.state.master,
      c = master && this.w.panes.get(master)?.controller;
    const inventory = c ? await c.planning.inventory() : undefined;
    const diagnostics = [...(inventory?.diagnostics ?? ['主控会话不可用，未查询工具'])];
    const binding = (p: TeamMember | undefined) => p && digest([p.session, p.project, p.model, p.permission]);
    return {
      active: this.active,
      master,
      members: this.roster().map((p) => ({
        ...p,
        capabilities: (() => {
          const window = inventory?.windows.find((w) => w.id === p.id);
          if (
            window &&
            (binding(before.find((b) => b.id === p.id)) !== binding(p) ||
              window.session !== p.session ||
              window.project !== p.project ||
              window.model !== p.model)
          ) {
            diagnostics.push(`窗口 ${p.id} 的绑定或权限在查询中变化，已丢弃旧能力，请重新查询`);
            return [];
          }
          return window?.capabilityFacts ?? [];
        })(),
      })),
      roles: roles(this.w.launch.appConfig.orchestration).map((r) => ({
        id: r.id,
        description: r.description,
        model: r.modelId,
        skills: r.skills,
      })),
      diagnostics,
      services: this.w.capabilities.snapshot(),
      recent: this.records
        .filter((r) => r.master === master)
        .slice(-5)
        .map((r) => ({
          id: r.id,
          phase: r.phase,
          objective: r.analysis?.objective ?? r.request,
          executions: r.executions,
          blockReason: r.blockReason,
          assignments: r.assignments,
          followthrough: r.followthrough,
        })),
      meaning:
        '角色是偏好，能力可调用不等于擅长；verified 仅表示本请求有成功工具回执。团队清单不授予执行权限。',
    };
  }
  async describe() {
    const data = await this.snapshot();
    const states = {
      idle: '空闲',
      busy: '忙碌',
      'waiting-user': '等待用户',
      'human-controlled': '用户接管',
      unavailable: '不可用',
    };
    const phases = {
      received: '请求已登记',
      understood: '需求已理解',
      discussion: '仅讨论',
      'waiting-input': '等待用户',
      planned: '方案已检查',
      dispatched: '已提交执行',
      waiting: '等待执行结果',
      reviewing: '独立审查与验证',
      repairing: '正在有限修复',
      paused: '协调已暂停',
      completed: '已通过验收',
      cancelled: '已取消',
      blocked: '协调受阻',
    };
    return (
      `主控团队 · ${data.active ? '协作中' : '独立或暂停'}\n` +
      data.members
        .map(
          (p) =>
            `${p.position === 'master' ? '主控' : p.position === 'worker' ? '执行窗口' : '独立窗口'} ${p.id} · ${states[p.state]} · 偏好 ${p.preference === 'auto' ? '自动' : p.preference}\n${p.project} · ${p.model}\n${p.reason} · 当前职责 ${p.assignedRole ?? '未分配'}\n已注册 ${p.capabilities.length} · 候选可用 ${p.capabilities.filter((c) => c.callable).length} · 本请求成功 ${p.capabilities.filter((c) => c.verified).length}`,
        )
        .join('\n\n') +
      '\n\n最近主控请求：\n' +
      (data.recent
        .map(
          (r) =>
            `${r.id.slice(0, 8)} · ${phases[r.phase]} · ${r.objective}${r.blockReason ? '\n' + r.blockReason : ''}\n${r.assignments?.map((a) => `${a.step} → ${a.window} (${a.role})：${a.reason}`).join('\n') ?? ''}`,
        )
        .join('\n') || '尚无新任务') +
      '\n\n' +
      data.meaning
    );
  }
  async modelSnapshot(offset = 0, windowOffset = 0) {
    const full = await this.snapshot();
    const capabilities = new Map<string, Capability>();
    for (const member of full.members)
      for (const fact of member.capabilities)
        if (!capabilities.has(fact.id) || fact.callable) capabilities.set(fact.id, fact);
    const { windows, ...page } = inventoryPage(
      {
        capabilities: [...capabilities.values()],
        windows: full.members.map(({ capabilities: facts, ...profile }) => ({
          id: profile.id,
          session: profile.session ?? '',
          project: profile.project,
          model: profile.model,
          dispatchable: profile.dispatchable,
          profile,
          capabilities: facts.filter((c) => c.callable).map((c) => c.id),
        })),
        currentWindow: full.master ?? '',
        mode: full.active ? 'collaborate' : 'independent',
        diagnostics: full.diagnostics,
      },
      offset,
      windowOffset,
    );
    return {
      ...page,
      active: full.active,
      master: full.master,
      members: windows.map(({ profile, capabilities, capabilitiesPageOnly }) => ({
        ...profile,
        capabilities,
        capabilitiesPageOnly,
      })),
      roles: full.roles,
      recent: full.recent.map(({ id, phase, objective, executions, blockReason }) => ({
        id,
        phase,
        objective: objective.slice(0, 800),
        executions,
        blockReason,
      })),
      meaning: full.meaning + ' 能力与窗口均分页；最近任务为摘要，详细状态用 emergence_tasks。',
    };
  }
  mount() {
    if (this.w.executionScope === 'session') return [];
    return [
      this.w.ctx.tools.register(
        defineTool({
          name: 'emergence_team',
          description:
            '读取主控团队实时窗口、角色偏好、权限和请求摘要。offset 为能力分页，windowOffset 为成员分页，默认 0；members.capabilities 仅列本页可用能力 ID，用 nextOffset/nextWindowOffset 续读。仅查询，不创建或派发任务。',
          parameters: { offset: { type: 'integer' }, windowOffset: { type: 'integer' } },
          output: {
            schema: { type: 'json' },
            render: (_a, value) => [{ type: 'text', text: JSON.stringify(value) }],
          },
          execute: async (args) =>
            JSON.parse(JSON.stringify(await this.modelSnapshot(args.offset, args.windowOffset))),
        }),
        {
          when: ({ agent }) =>
            this.active &&
            this.w.panes.get(this.w.collaboration.state.master ?? '')?.controller?.agent === agent,
        },
      ),
    ];
  }
}
