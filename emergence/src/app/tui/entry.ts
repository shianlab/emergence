import { createCliRenderer, type CliRenderer } from '@opentui/core';
import type { LaunchConfig } from '../session-config.ts';
import { mountWorkspaceUI } from '../workspace-ui.ts';
import type { WorkspaceController } from '../workspace.ts';
import { archiveSnapshot, hasSnapshot } from './home-state.ts';
import { mountHome, type HomeActions, type HomeRequest } from './home.ts';
import { createUpdateService } from '../updates/runtime.ts';
import type { UpdateService } from '../updates/service.ts';

export interface EntryActions {
  updates?: UpdateService;
  open(config: LaunchConfig): Promise<WorkspaceController>;
  sessions: HomeActions['sessions'];
  modelConfiguration?: HomeActions['modelConfiguration'];
  exit(): void;
}

export async function mountEntryUI(renderer: CliRenderer, config: LaunchConfig, actions: EntryActions) {
  const updates = actions.updates ?? (await createUpdateService());
  let disposed = false,
    opening: Promise<void> | undefined;
  let home: ReturnType<typeof mountHome> | undefined,
    workspaceView: ReturnType<typeof mountWorkspaceUI> | undefined;
  const activate = (launch: LaunchConfig, prompt?: string, archive = false) => {
    if (disposed || opening) return opening ?? Promise.resolve();
    opening = (async () => {
      if (archive) await archiveSnapshot(config);
      if (disposed) return;
      const workspace = await actions.open(launch);
      if (disposed) return;
      workspace.updates = updates;
      if (prompt !== undefined) workspace.updateView(workspace.focused, prompt, 0);
      home?.dispose();
      home = undefined;
      workspaceView = mountWorkspaceUI(renderer, workspace, actions.exit);
      if (prompt !== undefined) workspaceView.submitInitial();
    })().finally(() => {
      opening = undefined;
    });
    return opening;
  };
  const open = (request: HomeRequest) => {
    const explicitModel = config.explicitModel === true || request.modelId !== config.modelId;
    return activate(
      {
        ...config,
        modelId: request.modelId,
        explicitModel,
        template: undefined,
        fresh: request.kind === 'new',
        resume: request.kind === 'resume' ? request.sessionId : undefined,
      },
      request.prompt,
      request.kind !== 'continue',
    );
  };
  try {
    if (config.resume || config.template) await activate(config);
    else
      home = mountHome(renderer, config, await hasSnapshot(config), {
        open,
        sessions: actions.sessions,
        exit: actions.exit,
        modelConfiguration: actions.modelConfiguration,
        updates,
      });
  } catch (error) {
    home?.dispose();
    workspaceView?.dispose();
    updates.dispose();
    throw error;
  }
  updates.start();
  return {
    get home() {
      return home;
    },
    get workspaceView() {
      return workspaceView;
    },
    get opening() {
      return opening;
    },
    refreshHome() {
      home?.refresh();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      home?.dispose();
      workspaceView?.dispose();
      updates.dispose();
    },
  };
}

export async function startEntryUI(config: LaunchConfig, actions: EntryActions) {
  const renderer = await createCliRenderer({ exitOnCtrlC: false, useMouse: true });
  try {
    const view = await mountEntryUI(renderer, config, actions);
    return {
      refreshHome() {
        view.refreshHome();
      },
      dispose() {
        view.dispose();
        renderer.destroy();
      },
    };
  } catch (error) {
    renderer.destroy();
    throw error;
  }
}
