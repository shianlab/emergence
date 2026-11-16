import { BoxRenderable, TextRenderable, type CliRenderer } from '@opentui/core';
import { palette } from '../../core/domain/ui-preferences.ts';
import type { WorkspaceController } from '../workspace.ts';
import { teamFeedback } from './team-feedback.ts';

export function mountTeamBar(
  renderer: CliRenderer,
  workspace: WorkspaceController,
  overview: () => void,
  approvals: () => void,
) {
  const box = new BoxRenderable(renderer, {
    height: 1,
    flexShrink: 0,
    flexDirection: 'row',
    gap: 1,
    overflow: 'hidden',
  });
  const status = new TextRenderable(renderer, {
    height: 1,
    minWidth: 0,
    flexGrow: 1,
    wrapMode: 'none',
    truncate: true,
    selectable: false,
    onMouseDown(e) {
      if (e.button === 0) {
        e.preventDefault();
        e.stopPropagation();
        overview();
      }
    },
  });
  const pause = new TextRenderable(renderer, {
    height: 1,
    flexShrink: 0,
    selectable: false,
    onMouseDown(e) {
      if (e.button === 0) {
        e.preventDefault();
        e.stopPropagation();
        if (workspace.collaboration.state.mode === 'collaborate')
          workspace.collaboration.pause(!workspace.collaboration.state.paused);
      }
    },
  });
  const approval = new TextRenderable(renderer, {
    height: 1,
    flexShrink: 0,
    selectable: false,
    onMouseDown(e) {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      approvals();
    },
  });
  box.add(status);
  box.add(pause);
  box.add(approval);
  return {
    box,
    status,
    pause,
    approval,
    sync() {
      const data = teamFeedback(workspace),
        colors = palette(workspace.launch.appConfig.ui);
      box.visible = data.visible;
      status.fg = colors.accent;
      pause.fg = colors.muted;
      approval.fg = colors.accent;
      status.content = `[主控 · ${data.label}${data.current?.executions.length ? ' · 已分配 ' + data.current.executions.length + ' 项' : ''}]`;
      pause.visible = data.canPause;
      pause.content = data.paused ? '[继续]' : '[暂停]';
      pause.width = 6;
      approval.visible = data.pending.length > 0;
      approval.content = `[待确认 ${data.pending.length}]`;
      approval.width = 10 + String(data.pending.length).length;
      return data.visible;
    },
  };
}
