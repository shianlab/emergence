import { safeError } from '../../core/adapters/redaction.ts';
import { taskLabels } from '../../core/domain/task.ts';
import type { CoordinationRecord } from '../../core/domain/team.ts';
import type { WorkspaceController } from '../workspace.ts';
import { paneNumber } from './workspace-chrome.ts';

export const coordinationLabels: Record<CoordinationRecord['phase'], string> = {
  received: '正在理解目标',
  understood: '已理解，正在组织分工',
  discussion: '仅讨论，未派发',
  'waiting-input': '等待用户确认或补充',
  planned: '分工已检查',
  dispatched: '已提交分工',
  waiting: '等待执行结果',
  reviewing: '正在核对验收',
  repairing: '正在修复并复验',
  paused: '协调已暂停',
  completed: '已通过独立验收',
  cancelled: '总任务已取消',
  blocked: '协调受阻',
};
const closed = new Set(['completed', 'cancelled', 'blocked', 'discussion']);
const roleNames: Record<string, string> = {
  developer: '开发',
  researcher: '研究',
  reviewer: '审查',
  verifier: '验证',
  planner: '规划',
};

/** Read-only projection of durable records and current bindings. Rendering never calls a model. */
export function teamFeedback(workspace: WorkspaceController) {
  const state = workspace.collaboration.state,
    master = state.master ? workspace.panes.get(state.master) : undefined;
  const records = workspace.team.records.filter(
    (r) => r.master === state.master && r.session === master?.controller?.id,
  );
  const current = records.findLast((r) => !closed.has(r.phase)) ?? records.at(-1);
  const pending = workspace.interactions
    .list()
    .map((e) => ({ pane: e.ref.pane, session: e.ref.ownerSession, request: e.ref.id }));
  const inactive = state.mode !== 'collaborate' || state.paused;
  const label =
    current && closed.has(current.phase)
      ? coordinationLabels[current.phase]
      : inactive
        ? '协调已暂停'
        : current
          ? coordinationLabels[current.phase]
          : '主控就绪，等待新目标';
  const related = current ? workspace.team.followthrough.related(current) : [];
  const windowName = (id: string) => `${paneNumber(workspace, id) || '已关闭'} (${id})`;
  const accepted = related.filter(
    (t) => !t.assessment && t.status === 'succeeded' && t.review?.accepted,
  ).length;
  const sections: Array<{ title: string; body: string }> = [];
  if (current) {
    sections.push(
      { title: '总目标 · ' + current.id.slice(0, 8), body: current.analysis?.objective ?? current.request },
      { title: '协调状态', body: label + (current.blockReason ? '\n' + current.blockReason : '') },
    );
    if (inactive && !closed.has(current.phase))
      sections.push({
        title: '暂停说明',
        body: '暂停新的派发与自动跟进；已开始的调用可能继续完成。继续不会重跑已完成任务，取消和受阻的总任务不会自动复活。',
      });
    for (const assignment of current.assignments ?? []) {
      const tasks = related.filter((t) => !t.assessment && t.workflow?.step === assignment.step);
      const latest = tasks.at(-1),
        pane = workspace.panes.get(assignment.window);
      sections.push({
        title: `分工 ${assignment.step} → 窗口 ${windowName(assignment.window)}`,
        body: `职责：${roleNames[assignment.role] ?? assignment.role}\n分配原因：${assignment.reason}\n项目：${latest?.cwd ?? pane?.cwd ?? '窗口已关闭'}\n模型配置：${latest?.modelId ?? pane?.modelId ?? '未知'}\n${latest ? taskLabels[latest.status] + ' · ' + latest.progress + '\n依赖：' + (latest.dependsOn.map((id) => id + ' · ' + (state.tasks.find((t) => t.id === id) ? taskLabels[state.tasks.find((t) => t.id === id)!.status] : '记录缺失')).join('、') || '无') : '尚无执行回执'}`,
      });
    }
    const f = current.followthrough;
    if (f)
      sections.push({
        title: '实际用量 / 上限',
        body: `已验收实施 ${accepted} 项；检查任务 ${related.filter((t) => t.assessment).length} 项\n模型步骤 ${related.reduce((n, t) => n + t.steps, 0)}/${f.maxSteps} · 协调动作 ${f.actions}/${f.maxActions}\n修复 ${related.filter((t) => t.repairOf).length}/${f.maxRepairs} · 时长上限 ${Math.round(f.maxDurationMs / 60000)} 分钟（含暂停）\nToken / 费用：未知`,
      });
    if (f?.summary) sections.push({ title: '最终回执汇总', body: f.summary });
  } else
    sections.push({
      title: '主控协调',
      body: label + '\n设置主窗口后，直接描述总目标。分工、跟进和验收会记录在这里。',
    });
  const members = workspace.team.roster();
  sections.push({
    title: '窗口当前职责与可用性',
    body: members
      .map(
        (p) =>
          `窗口 ${windowName(p.id)} · ${p.position === 'master' ? '主控 · 统筹目标与验收' : (p.position === 'worker' ? '执行' : '独立') + ' · ' + (p.assignedRole ? (roleNames[p.assignedRole] ?? p.assignedRole) : '未分配职责')}\n${p.project} · ${p.model}\n${p.state === 'waiting-user' ? '等待该窗口的审批或回答；' : ''}${p.reason}`,
      )
      .join('\n\n'),
  });
  if (records.length > 1)
    sections.push({
      title: '最近总任务',
      body: records
        .slice(-5)
        .reverse()
        .map(
          (r) =>
            `${r.id.slice(0, 8)} · ${coordinationLabels[r.phase]} · ${r.analysis?.objective ?? r.request}${r.blockReason ? '\n' + r.blockReason : ''}`,
        )
        .join('\n\n'),
    });
  return {
    current,
    label: safeError(label),
    pending,
    visible: workspace.executionScope === 'workspace' && (state.mode === 'collaborate' || !!current),
    canPause: state.mode === 'collaborate',
    paused: state.paused,
    sections: sections.map((s) => ({ title: safeError(s.title), body: safeError(s.body) })),
  };
}
