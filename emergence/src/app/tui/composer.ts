import type { TextareaRenderable } from '@opentui/core';
import { safeError } from '../../core/adapters/redaction.ts';
import { effectiveKeys, palette, type UIPreferences } from '../../core/domain/ui-preferences.ts';
import type { SessionController } from '../controller.ts';
import { toolSummary } from './message-model.ts';

/** Size from the native editor's wrapped lines, including Chinese and emoji. */
export function sizeEditor(input: TextareaRenderable, availableHeight: number, maximum = 7) {
  const minimum = availableHeight < 16 ? 2 : 3;
  const limit = Math.max(minimum, Math.min(maximum, Math.floor(availableHeight / 3)));
  const rows = Math.max(minimum, Math.min(limit, input.virtualLineCount + 1));
  if (input.height !== rows) input.height = rows;
  return rows;
}

export function activityColor(ui: UIPreferences, active: boolean) {
  if (
    !active ||
    ui.activityColor === 'gray' ||
    process.env.NO_COLOR !== undefined ||
    process.env.TERM === 'dumb'
  )
    return palette(ui).muted;
  return ui.theme === 'light' ? '#805b1c' : '#d2b477';
}

export function composerStatus(
  controller: SessionController | undefined,
  en: boolean,
  restoreError?: string,
  ui = controller?.launch.appConfig.ui,
) {
  if (restoreError) return en ? '× Session unavailable · /retry' : '× 会话不可用 · /retry 重试';
  if (!controller) return en ? '○ Opening session' : '○ 正在打开会话';
  const activity = controller.activity;
  const queued = activity.queued ? (en ? ` · ${activity.queued} queued` : ` · 排队 ${activity.queued}`) : '';
  if (activity.stopping) return (en ? '■ Stopping…' : '■ 正在停止…') + queued;
  if (controller.pending)
    return (en ? '◇ Awaiting your answer' : '◇ 轮到你啦 · 等待你的回答 / 操作确认') + queued;
  if (controller.busy) {
    const tool = activity.tools.at(-1);
    const detail = tool
      ? `${en ? 'Tool' : '工具'} ${tool.name}${toolSummary(tool) ? ' · ' + toolSummary(tool) : ''}`
      : controller.live || activity.phase === 'writing'
        ? en
          ? 'Writing response'
          : '涌现正在输出'
        : activity.phase === 'reasoning'
          ? en
            ? 'Reasoning'
            : '涌现正在思考'
          : en
            ? 'Waiting for model response'
            : '正在涌现… · 等待模型响应';
    const seconds = activity.startedAt
      ? Math.max(0, Math.floor((Date.now() - activity.startedAt) / 1000))
      : 0;
    const time = en ? ` · ${seconds}s elapsed` : ` · 已运行 ${seconds} 秒`;
    const stopKey = ui ? effectiveKeys(ui).escape.replace('Escape', 'Esc') : 'Esc';
    const quiet =
      seconds >= 30 && !tool && activity.phase === 'waiting'
        ? en
          ? ` · Still waiting; ${stopKey} to stop`
          : ` · 仍在等待，可按 ${stopKey} 停止`
        : '';
    const motion =
      ui?.reducedMotion ||
      process.env.EMERGENCE_REDUCED_MOTION === '1' ||
      process.env.NO_COLOR !== undefined ||
      process.env.TERM === 'dumb';
    const icon = motion ? '●' : ['◐', '◓', '◑', '◒'][seconds % 4];
    return safeError(
      `${icon} ${tool && !en ? '涌现正在调用 · ' : ''}${detail}${activity.tools.length > 1 ? ` (+${activity.tools.length - 1})` : ''}${time}${quiet}${queued}`,
    );
  }
  return (
    (controller.lastError
      ? en
        ? '× Failed · You can retry'
        : '× 执行失败 · 可重新提交'
      : en
        ? '○ Ready'
        : '○ 就绪') + queued
  );
}

/** Hints follow real bindings and the operation that currently owns Enter/Escape. */
export function composerHint(
  ui: UIPreferences,
  state: {
    busy?: boolean;
    pending?: boolean;
    editingAnswer?: boolean;
    multiChoice?: boolean;
    ownedTask?: boolean;
    overlay?: boolean;
    picker?: boolean;
    command?: boolean;
  },
  narrow = false,
) {
  const en = ui.language === 'en',
    keys = effectiveKeys(ui);
  const escapeKey = keys.escape === 'Escape' ? 'Esc' : keys.escape;
  if (state.picker) return en ? '↑↓ select · Enter choose · Esc close' : '↑↓ 选择 · Enter 确认 · Esc 关闭';
  if (state.command)
    return en ? 'Enter run command · Esc back to conversation' : 'Enter 执行命令 · Esc 返回对话';
  if (state.pending && state.overlay)
    return en ? `${escapeKey} back to confirmation · Ctrl+P commands` : `${escapeKey} 返回确认 · Ctrl+P 命令`;
  if (state.pending)
    return state.editingAnswer
      ? en
        ? 'Enter submit · Shift+Enter newline · Esc back/cancel'
        : 'Enter 提交 · Shift+Enter 换行 · Esc 返回/取消'
      : en
        ? `↑↓ select · Enter confirm${state.multiChoice ? ' · Space toggle' : ''} · Esc cancel`
        : `↑↓ 选择 · Enter 确认${state.multiChoice ? ' · Space 多选' : ''} · Esc 取消`;
  if (state.ownedTask)
    return en ? `${escapeKey} stop task · /task note` : `${escapeKey} 停止任务 · /task note 补充`;
  const submit = state.busy ? (en ? 'Enter queue' : 'Enter 排队') : en ? 'Enter send' : 'Enter 发送';
  const escape = state.overlay
    ? en
      ? `${escapeKey} close panel`
      : `${escapeKey} 关闭面板`
    : state.busy
      ? en
        ? `${escapeKey} stop`
        : `${escapeKey} 停止`
      : en
        ? '/ commands'
        : '/ 命令';
  if (narrow && (state.busy || state.overlay))
    return `${submit} · ${escape} · Shift+Enter ${en ? 'newline' : '换行'}`;
  return `${submit} · Shift+Enter ${en ? 'newline' : '换行'} · ${escape}${narrow ? '' : en ? ' · Ctrl+R history · Ctrl+P commands' : ' · Ctrl+R 历史 · Ctrl+P 命令'}`;
}
