import { TextAttributes } from '@opentui/core';
import stringWidth from 'string-width';
import { createRedactor } from '../../core/adapters/redaction.ts';
import { palette } from '../../core/domain/ui-preferences.ts';
import type { PaneState, WorkspaceController } from '../workspace.ts';
import { auxiliaryInfo } from './auxiliary-info.ts';
import { composerStatus } from './composer.ts';
import type { View } from './pane-view-state.ts';
import { sessionFooter } from './workspace-chrome.ts';
export function renderPaneNotice(
  workspace: Pick<WorkspaceController, 'launch' | 'panes' | 'focused' | 'notice'>,
  pane: PaneState,
  view: View,
  redact = createRedactor(),
) {
  const ui = workspace.launch.appConfig.ui,
    en = ui.language === 'en',
    colors = palette(ui);
  const controller = pane.controller;
  const shared = [...workspace.panes.values()].filter((p) => p.id !== pane.id && p.cwd === pane.cwd).length;
  if (!shared) view.sharedExpanded = false;
  const info = auxiliaryInfo(
    {
      session: controller?.id ?? pane.id,
      notice: controller?.notice,
      globalNotice: pane.id === workspace.focused ? workspace.notice : '',
      busy: Boolean(controller?.busy),
      pending: Boolean(controller?.pending),
      queued: controller?.activity.queued ?? 0,
      error: pane.error || controller?.lastError,
      shared,
      expanded: Boolean(view.sharedExpanded),
      en,
      now: Date.now(),
    },
    view.receiptClock,
  );
  view.receiptClock = info.clock;
  view.receiptExpiresAt = info.receiptExpiresAt;
  view.notice.content = redact(info.persistent);
  view.notice.visible = Boolean(info.persistent);
  view.notice.fg = colors.foreground;
  view.notice.attributes = pane.error || controller?.lastError ? TextAttributes.BOLD : 0;
  view.sharedInfo.visible = Boolean(info.shared);
  const sharedLabel = (info.mergeReady ? (en ? '○ Ready · ' : '○ 就绪 · ') : '') + info.shared;
  view.sharedInfo.content =
    !view.sharedExpanded && stringWidth(sharedLabel) > view.columns - 2
      ? en
        ? `Shared +${shared} [Details]`
        : `共享 +${shared} [详情]`
      : sharedLabel;
  view.sharedInfo.fg = colors.muted;
  view.sharedInfo.height = view.sharedExpanded ? 'auto' : 1;
  view.sharedInfo.small = !view.sharedExpanded;
  view.status.visible =
    !info.mergeReady &&
    !(
      info.persistent &&
      !controller?.busy &&
      !controller?.pending &&
      !controller?.lastError &&
      !pane.error &&
      !controller?.activity.queued
    );
  view.status.attributes =
    controller?.pending || controller?.lastError || pane.error ? TextAttributes.BOLD : 0;
  view.status.content = info.receipt || composerStatus(controller, en, pane.error, ui, redact);
  view.status.small =
    !controller?.pending &&
    !controller?.lastError &&
    !pane.error &&
    !controller?.busy &&
    !controller?.activity.queued;
  if (!view.status.small) view.status.reset();
  if (controller?.pending || controller?.lastError || pane.error) view.status.fg = colors.foreground;
  else if (info.receipt) view.status.fg = colors.muted;
}
export function paneFooter(pane: PaneState, width: number, en: boolean, redact = createRedactor()) {
  const usage = pane.controller?.tokenUsage()?.label(en) ?? 'Tokens —';
  return sessionFooter(pane.controller?.cwd ?? pane.cwd, usage, width, redact);
}
