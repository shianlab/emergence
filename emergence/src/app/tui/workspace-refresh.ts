import { createRedactor } from '../../core/adapters/redaction.ts';
import type { PaneState } from '../workspace.ts';
import type { View } from './pane-view-state.ts';

function runStartedAt(pane: PaneState) {
  const controller = pane.controller;
  if (!controller?.busy || controller.pending) return;
  const activity = controller.activity;
  if (!activity.stopping) return activity.startedAt;
}

/** Only visible, changing status text needs a deadline. Session updates handle other changes. */
export function workspaceStatusRefresh(
  panes: ReadonlyMap<string, PaneState>,
  views: ReadonlyMap<string, View>,
  render: (pane: PaneState, view: View, redact: ReturnType<typeof createRedactor>) => void,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline = Infinity;

  function schedule(at: number, now: number) {
    if (deadline === at) return;
    deadline = at;
    clearTimeout(timer);
    timer = Number.isFinite(at) ? setTimeout(tick, Math.max(1, at - now)) : undefined;
  }

  function sync() {
    const now = Date.now();
    let next = Infinity;
    for (const [id, view] of views) {
      const pane = panes.get(id);
      if (!pane || !view.box.visible) continue;
      const start = runStartedAt(pane);
      if (start !== undefined)
        next = Math.min(next, start + (Math.floor(Math.max(0, now - start) / 1000) + 1) * 1000);
      next = Math.min(next, view.receiptExpiresAt ?? Infinity);
    }
    schedule(next, now);
  }

  function tick() {
    deadline = Infinity;
    const now = Date.now();
    let redact: ReturnType<typeof createRedactor> | undefined;
    for (const [id, view] of views) {
      const pane = panes.get(id);
      if (!pane || !view.box.visible) continue;
      if (runStartedAt(pane) !== undefined || (view.receiptExpiresAt ?? Infinity) <= now)
        render(pane, view, (redact ??= createRedactor()));
    }
    sync();
  }

  return { sync, dispose: () => schedule(Infinity, Date.now()) };
}
