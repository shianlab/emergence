import { ScrollBoxRenderable, TextareaRenderable, type KeyEvent, type PasteEvent } from '@opentui/core';
import { permissionModes } from '../../core/domain/permissions.ts';
import { keyAction } from '../../core/domain/ui-preferences.ts';
import { type CommandItem } from '../commands.ts';
import { terminalActions } from '../terminal-actions.ts';
import type { PaneState, WorkspaceController } from '../workspace.ts';
import { mountCommandList } from './command-list.ts';
import { type NavigationItem, type NavigationKind } from './navigation.ts';
import type { View } from './pane-view-state.ts';
import { mountTaskInspector } from './task-inspector.ts';
export interface WorkspaceModalState {
  commandMode: boolean;
  commandPane: string;
  commandSession?: string;
  navigation?: { kind: NavigationKind; role?: string };
  permissionMenu?: { pane: string; session?: string; selected: number };
  paneMenuTarget?: { id: string; session?: string };
  modalSubmitUntil: number;
}
interface InputHost {
  modal: WorkspaceModalState;
  workspace: Pick<
    WorkspaceController,
    | 'cancelFocused'
    | 'changed'
    | 'closePane'
    | 'current'
    | 'cycle'
    | 'focused'
    | 'hide'
    | 'interactions'
    | 'launch'
    | 'maximized'
    | 'overlay'
    | 'panes'
    | 'resizeFocused'
    | 'split'
    | 'taskEngine'
    | 'taskPanel'
    | 'updateView'
  >;
  views: ReadonlyMap<string, View>;
  paneMenu: ReturnType<typeof mountCommandList>;
  closePaneMenu: () => void;
  applyPaneAction: (target: { id: string; session?: string }, command: string) => Promise<void>;
  error: (id: string, value: unknown) => void;
  refresh: () => void;
  terminal: ReturnType<typeof terminalActions>;
  commandInput: TextareaRenderable;
  commandList: ReturnType<typeof mountCommandList>;
  refreshHeader: () => void;
  closeCommands: () => void;
  runCommand: (value: string) => void;
  openNavigation: (id: string, kind: NavigationKind, query?: string) => void;
  inspector: ReturnType<typeof mountTaskInspector>;
  savedScroll: (id: string, scroll: ScrollBoxRenderable) => number;
  renderComposer: (pane: PaneState, view: View) => void;
  chooseCommand: (item: CommandItem, view?: View) => void;
}
export function workspaceInput(host: InputHost) {
  const keypress = (key: KeyEvent) => {
    if (host.modal.paneMenuTarget) {
      key.preventDefault();
      key.stopPropagation();
      if (key.name === 'escape' || (key.ctrl && key.name === 'c')) host.closePaneMenu();
      else if (key.name === 'up' || key.name === 'down' || key.name === 'tab')
        host.paneMenu.move(key.name === 'up' || key.shift ? -1 : 1);
      else if (key.name === 'return' && !key.repeated && key.eventType !== 'repeat') {
        const target = host.modal.paneMenuTarget,
          selected = host.paneMenu.selected;
        host.closePaneMenu();
        if (selected)
          void host
            .applyPaneAction(target, selected.command)
            .catch((reason) => host.error(target.id, reason));
      }
      return;
    }
    const id = host.workspace.focused;
    const run = (promise: Promise<unknown>) => {
      void promise.catch((reason) => host.error(id, reason));
    };
    const view = host.views.get(id),
      controller = host.workspace.current.controller;
    if (host.modal.permissionMenu) {
      key.preventDefault();
      key.stopPropagation();
      if (key.eventType === 'repeat' || key.repeated) return;
      if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        host.modal.permissionMenu = undefined;
        host.modal.modalSubmitUntil = performance.now() + 350;
      } else if (key.name === 'up' || key.name === 'down')
        host.modal.permissionMenu.selected =
          (host.modal.permissionMenu.selected + (key.name === 'up' ? 3 : 1)) % 4;
      else if (key.name === 'return') {
        const menu = host.modal.permissionMenu;
        host.modal.permissionMenu = undefined;
        host.modal.modalSubmitUntil = performance.now() + 350;
        const target = host.workspace.panes.get(menu.pane)?.controller;
        if (target?.id === menu.session) target?.setPermissionMode(permissionModes[menu.selected]);
      }
      host.refresh();
      return;
    }
    if (key.name === 'return' && performance.now() < host.modal.modalSubmitUntil) {
      key.preventDefault();
      key.stopPropagation();
      return;
    }
    if (!key.ctrl && !key.meta && (key.name.length === 1 || key.name === 'space'))
      host.modal.modalSubmitUntil = 0;
    if (!(key.ctrl && key.name === 'c')) host.terminal.reset();
    if (host.modal.commandMode) {
      if (key.ctrl && key.name === 'p' && host.modal.navigation) {
        key.preventDefault();
        key.stopPropagation();
        host.modal.navigation = undefined;
        host.commandInput.setText('');
        host.refreshHeader();
        host.commandInput.focus();
        return;
      }
      if (
        host.modal.navigation &&
        (host.workspace.focused !== host.modal.commandPane ||
          host.workspace.panes.get(host.modal.commandPane)?.controller?.id !== host.modal.commandSession ||
          (host.workspace.panes.get(host.modal.commandPane)?.controller?.pending &&
            host.modal.navigation.kind !== 'approvals'))
      ) {
        key.preventDefault();
        key.stopPropagation();
        host.closeCommands();
        host.refresh();
        return;
      }
      if (host.modal.navigation?.kind === 'tasks' && key.name === 'right') {
        key.preventDefault();
        key.stopPropagation();
        const item = host.commandList.selected as NavigationItem | undefined;
        if (item) host.runCommand('/task focus ' + item.value);
        return;
      }
      if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        key.preventDefault();
        key.stopPropagation();
        host.closeCommands();
        host.refresh();
      } else if (host.commandList.box.visible && ['up', 'down'].includes(key.name)) {
        key.preventDefault();
        key.stopPropagation();
        host.commandList.move(key.name === 'up' ? -1 : 1);
      } else if (
        !host.modal.navigation &&
        host.commandList.box.visible &&
        key.name === 'tab' &&
        !key.ctrl &&
        !key.shift
      ) {
        key.preventDefault();
        key.stopPropagation();
        const item = host.commandList.selected;
        if (item) {
          host.commandInput.replaceText(item.command + (item.usage ? ' ' : ''));
          host.commandInput.gotoBufferEnd();
          host.refreshHeader();
        }
      } else if (key.name === 'return' && (key.eventType === 'repeat' || key.repeated)) {
        key.preventDefault();
        key.stopPropagation();
      }
      return;
    }
    if (key.ctrl && key.name === 'r' && !controller?.pending) {
      key.preventDefault();
      key.stopPropagation();
      host.openNavigation(id, 'history');
      return;
    }
    if (key.ctrl && key.name === 'p') {
      key.preventDefault();
      key.stopPropagation();
      host.modal.navigation = undefined;
      host.modal.commandMode = true;
      host.modal.commandPane = id;
      host.modal.commandSession = controller?.id;
      host.commandInput.setText('');
      host.commandInput.visible = true;
      host.refresh();
      host.commandInput.focus();
      return;
    }
    if (
      host.inspector.opened &&
      (host.inspector.focused || host.inspector.fullscreen) &&
      key.ctrl &&
      key.name === 'c' &&
      host.terminal.copy()
    ) {
      key.preventDefault();
      key.stopPropagation();
      return;
    }
    if (host.inspector.handleKey(key)) return;
    if (key.ctrl && key.name === 'c') {
      key.preventDefault();
      key.stopPropagation();
      if (key.eventType === 'repeat' || key.repeated) return;
      if (host.terminal.copy(view?.interaction.editing ? view.interaction.answer : view?.input)) return;
      if (host.workspace.overlay) {
        host.terminal.reset();
        host.workspace.overlay = '';
        host.workspace.taskPanel = false;
        host.workspace.changed();
        return;
      }
      if (controller?.pending) {
        host.terminal.reset();
        const request = controller.pending;
        host.workspace.interactions.respond(host.workspace.interactions.reference(id, request), {
          action: 'cancel',
        });
        return;
      }
      if (view?.input.plainText) {
        host.terminal.reset();
        view.input.setText('');
        host.workspace.updateView(id, '', host.savedScroll(id, view.scroll));
        return;
      }
      if (controller?.busy || host.workspace.taskEngine.current(id)) {
        host.terminal.reset();
        run(host.workspace.cancelFocused());
        return;
      }
      host.terminal.confirmExit(key);
      return;
    }
    if (!host.workspace.overlay && view?.interaction.handleKey(key)) return;
    if (view?.commands.box.visible && !key.ctrl && !key.shift && !key.meta) {
      if (key.name === 'escape') {
        key.preventDefault();
        key.stopPropagation();
        view.suppressedQuery = view.input.plainText;
        host.renderComposer(host.workspace.current, view);
        host.refreshHeader();
        return;
      }
      if (key.name === 'up' || key.name === 'down') {
        key.preventDefault();
        key.stopPropagation();
        view.commands.move(key.name === 'up' ? -1 : 1);
        return;
      }
      if (key.name === 'tab') {
        key.preventDefault();
        key.stopPropagation();
        const item = view.commands.selected;
        if (item) {
          view.suppressedQuery = item.command + (item.usage ? ' ' : '');
          view.input.replaceText(view.suppressedQuery);
          view.input.gotoBufferEnd();
          host.renderComposer(host.workspace.current, view);
        }
        return;
      }
      if (key.name === 'return') {
        key.preventDefault();
        key.stopPropagation();
        host.renderComposer(host.workspace.current, view);
        const item = view.commands.selected;
        if (key.eventType !== 'repeat' && !key.repeated && item) host.chooseCommand(item, view);
        return;
      }
    }
    if (key.name === 'return' && (key.eventType === 'repeat' || key.repeated)) {
      key.preventDefault();
      key.stopPropagation();
      return;
    }
    if (!controller?.pending && !key.ctrl && !key.meta && (key.name.length === 1 || key.name === 'space'))
      view?.interaction.releaseSubmitGuard();
    if (key.name === 'return' && view?.interaction.blocksSubmit) {
      key.preventDefault();
      key.stopPropagation();
      return;
    }
    // Answer editors retain text editing keys; pane navigation and Escape still work.
    if (
      controller?.pending &&
      view?.interaction.editing &&
      ['up', 'down', 'left', 'right'].includes(key.name)
    )
      return;
    const action = keyAction(host.workspace.launch.appConfig.ui, key);
    if (!action) return;
    key.preventDefault();
    if (action === 'cyclePermission') {
      key.stopPropagation();
      if (key.eventType !== 'repeat' && !key.repeated) controller?.cyclePermission();
      return;
    }
    if (action === 'next' || action === 'previous') {
      host.workspace.cycle(action === 'next' ? 1 : -1);
      return;
    }
    if (action === 'splitRight' || action === 'splitDown') {
      run(host.workspace.split(action === 'splitRight' ? 'row' : 'column'));
      return;
    }
    if (action === 'maximize') {
      host.workspace.maximized = !host.workspace.maximized;
      host.workspace.changed();
      return;
    }
    if (action === 'close') {
      run(host.workspace.closePane(id));
      return;
    }
    if (action === 'hide') {
      try {
        host.workspace.hide();
      } catch (reason) {
        host.error(id, reason);
      }
      return;
    }
    if (action.startsWith('resize')) {
      host.workspace.resizeFocused(
        ['resizeLeft', 'resizeRight'].includes(action) ? 'row' : 'column',
        ['resizeLeft', 'resizeUp'].includes(action) ? -0.05 : 0.05,
      );
      return;
    }
    if (action === 'tasks') {
      if (!controller?.pending) host.openNavigation(id, 'tasks');
      return;
    }
    if (action === 'escape') {
      if (host.workspace.overlay) {
        host.workspace.overlay = '';
        host.workspace.taskPanel = false;
        host.workspace.changed();
      } else if (host.workspace.current.controller) run(host.workspace.cancelFocused());
      return;
    }
    if (action === 'pageUp' || action === 'pageDown')
      host.views.get(id)?.scroll.scrollBy(action === 'pageUp' ? -8 : 8);
  };
  const paste = (event: PasteEvent) => {
    if (host.modal.permissionMenu || host.modal.paneMenuTarget) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (
      !host.modal.commandMode &&
      host.inspector.opened &&
      (host.inspector.focused || host.inspector.fullscreen)
    ) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    host.modal.modalSubmitUntil = 0;
    const view = host.views.get(host.workspace.focused);
    if (!host.workspace.current.controller?.pending) view?.interaction.releaseSubmitGuard();
    if (
      !host.modal.commandMode &&
      host.workspace.current.controller?.pending &&
      (!view?.interaction.editing || host.workspace.overlay)
    ) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  return { keypress, paste };
}
