import { safeError } from '../../core/adapters/redaction.ts';
import { taskLabels } from '../../core/domain/task.ts';
import type { CommandItem } from '../commands.ts';
import type { WorkspaceController } from '../workspace.ts';

export type NavigationKind = 'history' | 'models' | 'tasks' | 'approvals';
export interface NavigationItem extends CommandItem {
  value: string;
}
export function historyEntries(workspace: WorkspaceController, pane: string) {
  const controller = workspace.panes.get(pane)?.controller;
  if (!controller) return [];
  const seen = new Set<string>(),
    result: string[] = [];
  const events = controller.agent.session.snapshotEvents();
  for (let i = events.length - 1; i >= 0 && result.length < 100; i--) {
    const event = events[i];
    if (event.type !== 'user/message' || event.data.source.kind !== 'user') continue;
    const text = safeError(event.data.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n'));
    if (!text.trim() || text.length > 100000 || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}
export function navigationItems(
  workspace: WorkspaceController,
  pane: string,
  kind: NavigationKind,
): NavigationItem[] {
  if (kind === 'approvals')
    return workspace.interactions.list().map((entry) => ({
      command: entry.ref.id,
      description: `窗口 ${entry.ref.pane} · ${entry.ready ? '待处理' : '队列中'} · ${entry.request.binding?.tool ?? entry.request.kind} · ${entry.project} · v${entry.ref.version}`,
      value: JSON.stringify(entry.ref),
    }));
  if (kind === 'history')
    return historyEntries(workspace, pane).map((text, i) => ({
      command: String(i + 1),
      description: text,
      value: text,
    }));
  if (kind === 'models')
    return workspace.launch.appConfig.models.map((m) => ({
      command: m.id,
      description: `${m.provider}/${m.model}${workspace.panes.get(pane)?.modelId === m.id ? ' · 当前 / current' : ''}`,
      value: m.id,
    }));
  return workspace.taskEngine.state.tasks
    .slice(-100)
    .reverse()
    .map((t) => ({
      command: t.id,
      description: `${taskLabels[t.status]} · ${t.target} · ${t.objective}`,
      value: t.id,
    }));
}
export const navigationLabels: Record<NavigationKind, [string, string]> = {
  approvals: [
    '待确认 · Enter 进入所属窗口，不代为批准',
    'Pending requests · Enter opens owner, never approves',
  ],
  history: ['输入历史 · Enter 回填，不发送', 'Input history · Enter restores draft'],
  models: ['选择当前窗口模型', 'Select pane model'],
  tasks: ['任务 · Enter 详情 · → 执行窗口', 'Tasks · Enter details · → worker'],
};
