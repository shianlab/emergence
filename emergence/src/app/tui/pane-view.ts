import {
  BoxRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  TextareaRenderable,
  type CliRenderer,
} from '@opentui/core';
import { palette } from '../../core/domain/ui-preferences.ts';
import { type CommandItem } from '../commands.ts';
import { mountInteractionUI } from '../interaction-ui.ts';
import type { PaneState, WorkspaceController } from '../workspace.ts';
import { mountCommandList } from './command-list.ts';
import { mountMessages } from './message-view.ts';
import type { View } from './pane-view-state.ts';
interface ViewHost {
  menuOpen(): boolean;
  disposed(): boolean;
  releaseFocus(): void;
  openPaneMenu(id: string, x: number, y: number): void;
  closePaneMenu(): void;
  chooseCommand(item: CommandItem, view: View): void;
  refreshHeader(): void;
  renderNotice(pane: PaneState, view: View): void;
  renderComposer(pane: PaneState, view: View): void;
  savedScroll(id: string, scroll: ScrollBoxRenderable): number;
  error(id: string, error: unknown): void;
}
export function paneViewFactory(
  renderer: CliRenderer,
  body: BoxRenderable,
  workspace: Pick<
    WorkspaceController,
    'launch' | 'focused' | 'panes' | 'focus' | 'closePane' | 'notice' | 'updateView' | 'send' | 'interactions'
  >,
  views: ReadonlyMap<string, View>,
  host: ViewHost,
) {
  return (pane: PaneState): View => {
    const colors = palette(workspace.launch.appConfig.ui);
    const box = new BoxRenderable(renderer, {
      id: `view-${pane.id}`,
      position: 'absolute',
      border: true,
      flexDirection: 'column',
      overflow: 'hidden',
      onMouseDown(event) {
        if (event.button === 2) {
          event.preventDefault();
          event.stopPropagation();
          host.openPaneMenu(pane.id, event.x, event.y);
          return;
        }
        if (host.menuOpen()) host.closePaneMenu();
        host.releaseFocus();
        if (workspace.focused !== pane.id) workspace.focus(pane.id);
      },
    });
    const titlebar = new BoxRenderable(renderer, { height: 2, width: '100%', position: 'relative' });
    const title = new TextRenderable(renderer, {
      position: 'absolute',
      left: 0,
      top: 0,
      height: 2,
      minWidth: 0,
      content: '',
      fg: colors.accent,
      wrapMode: 'none',
      truncate: true,
    });
    const close = new TextRenderable(renderer, {
      position: 'absolute',
      right: 0,
      top: 0,
      width: 6,
      height: 1,
      content: '[关闭]',
      fg: colors.warning,
      selectable: false,
      onMouseDown(event) {
        event.stopPropagation();
        event.preventDefault();
        if (event.button === 0)
          void workspace.closePane(pane.id).catch((reason) => host.error(pane.id, reason));
      },
    });
    titlebar.add(title);
    titlebar.add(close);
    const menuButton = new TextRenderable(renderer, {
      position: 'absolute',
      right: 8,
      top: 0,
      width: 6,
      height: 1,
      content: '[窗口]',
      selectable: false,
      onMouseDown(event) {
        event.preventDefault();
        event.stopPropagation();
        if (event.button === 0 || event.button === 2) host.openPaneMenu(pane.id, event.x, event.y);
      },
    });
    titlebar.add(menuButton);
    const scroll = new ScrollBoxRenderable(renderer, {
      flexGrow: 1,
      minHeight: 0,
      scrollY: true,
      stickyScroll: true,
      stickyStart: 'bottom',
    });
    const focusPane = () => {
      host.releaseFocus();
      if (workspace.focused !== pane.id) workspace.focus(pane.id);
    };
    const messages = mountMessages(renderer, scroll, focusPane);
    scroll.add(messages.box);
    const text = new TextRenderable(renderer, { content: '' });
    scroll.add(text);
    const jump = new TextRenderable(renderer, {
      height: 1,
      visible: false,
      content: '',
      selectable: false,
      onMouseDown(event) {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        const view = views.get(pane.id);
        if (view) {
          view.followAfterSubmit = true;
          view.unread = false;
        }
      },
    });
    const meta = new TextRenderable(renderer, {
      height: 1,
      flexShrink: 0,
      content: '',
      wrapMode: 'none',
      truncate: true,
      fg: colors.muted,
    });
    const notice = new TextRenderable(renderer, {
      content: '',
      visible: false,
      maxHeight: 3,
      flexShrink: 0,
      fg: colors.warning,
    });
    const sharedInfo = new TextRenderable(renderer, {
      height: 1,
      visible: false,
      flexShrink: 0,
      content: '',
      fg: colors.muted,
      wrapMode: 'word',
      selectable: false,
      onMouseDown(event) {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        const view = views.get(pane.id);
        if (view) {
          view.sharedExpanded = !view.sharedExpanded;
          host.renderNotice(pane, view);
        }
      },
    });
    const status = new TextRenderable(renderer, {
      height: 1,
      flexShrink: 0,
      content: '',
      fg: colors.muted,
      wrapMode: 'none',
      truncate: true,
    });
    const commands = mountCommandList(renderer, (item) => {
      const view = views.get(pane.id);
      if (view) host.chooseCommand(item, view);
      host.refreshHeader();
    });
    let input: TextareaRenderable;
    const submit = () => {
      if (workspace.panes.get(pane.id)?.controller?.pending) return;
      if (views.get(pane.id)?.interaction.blocksSubmit) return;
      const draft = input.plainText,
        trimmed = draft.trim();
      if (!trimmed) return;
      const value = trimmed.startsWith('/') ? trimmed : draft;
      const cursor = input.cursorOffset,
        selection = input.getSelection();
      const sessionId = workspace.panes.get(pane.id)?.controller?.id;
      const view = views.get(pane.id);
      if (view && !value.startsWith('/')) view.followAfterSubmit = true;
      if (!value.startsWith('/')) workspace.notice = '';
      workspace.updateView(pane.id, '', host.savedScroll(pane.id, scroll));
      input.setText('');
      void workspace.send(pane.id, value).catch((reason) => {
        if (
          !host.disposed() &&
          views.get(pane.id)?.input === input &&
          !input.plainText &&
          workspace.panes.get(pane.id)?.controller?.id === sessionId
        ) {
          workspace.updateView(pane.id, draft, host.savedScroll(pane.id, scroll));
          input.setText(workspace.panes.get(pane.id)?.draft ?? '');
          input.cursorOffset = cursor;
          if (selection) input.setSelection(selection.start, selection.end);
        }
        host.error(pane.id, reason);
      });
    };
    input = new TextareaRenderable(renderer, {
      height: 3,
      minHeight: 2,
      flexShrink: 0,
      initialValue: pane.draft,
      backgroundColor: colors.input,
      placeholder: '输入任务或 /help',
      onMouseDown: focusPane,
      keyBindings: [
        { name: 'return', action: 'submit' },
        { name: 'return', shift: true, action: 'newline' },
        { name: 'a', ctrl: true, action: 'select-all' },
      ],
      onContentChange() {
        if (!input) return;
        workspace.updateView(pane.id, input.plainText, host.savedScroll(pane.id, scroll));
        if (input.plainText.length > 100000) input.setText(workspace.panes.get(pane.id)?.draft ?? '');
        const view = views.get(pane.id);
        if (view) {
          if (view.suppressedQuery !== input.plainText) view.suppressedQuery = undefined;
          host.renderComposer(workspace.panes.get(pane.id)!, view);
          host.refreshHeader();
        }
      },
      onSubmit: submit,
    });
    const interaction = mountInteractionUI(
      renderer,
      (request, answer) => {
        const controller = workspace.panes.get(pane.id)?.controller;
        if (!controller) throw new Error('窗口已关闭');
        const view = views.get(pane.id);
        if (view) view.followAfterSubmit = true;
        workspace.interactions.respond(workspace.interactions.reference(pane.id, request), answer);
      },
      (reason) => host.error(pane.id, reason),
    );
    interaction.answer.onMouseDown = focusPane;
    [titlebar, scroll, jump, notice, sharedInfo, commands.box, status, interaction.box, input, meta].forEach(
      (child) => box.add(child),
    );
    body.add(box);
    return {
      box,
      title,
      close,
      scroll,
      text,
      messages,
      jump,
      columns: 70,
      unread: false,
      seenRevision: -1,
      seenLive: '',
      revealPending: false,
      revealOverlay: false,
      notice,
      sharedInfo,
      meta,
      status,
      commands,
      input,
      interaction,
      submit,
      initializedScroll: false,
      lastText: '',
      transient: false,
      followAfterSubmit: false,
    };
  };
}
