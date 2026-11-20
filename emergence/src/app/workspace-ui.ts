import {
  BoxRenderable,
  ScrollBoxRenderable,
  StyledText,
  TextAttributes,
  TextRenderable,
  TextareaRenderable,
  bold,
  createCliRenderer,
  fg,
  type CliRenderer,
} from '@opentui/core';
import stringWidth from 'string-width';
import { createRedactor, safeError } from '../core/adapters/redaction.ts';
import { permissionDescriptions, permissionLabels, permissionModes } from '../core/domain/permissions.ts';
import { palette } from '../core/domain/ui-preferences.ts';
import { slashSuggestions, workspaceCommands, type CommandItem } from './commands.ts';
import { geometry } from './layout.ts';
import { terminalActions } from './terminal-actions.ts';
import { createAggregateImage } from './tui/aggregate-image.ts';
import { mountCommandList } from './tui/command-list.ts';
import { activityColor, sizeEditor } from './tui/composer.ts';
import { headerBrandLayout } from './tui/header-brand.ts';
import {
  navigationItems,
  navigationLabels,
  type NavigationItem,
  type NavigationKind,
} from './tui/navigation.ts';
import { paneFooter, renderPaneNotice } from './tui/pane-notice.ts';
import type { View } from './tui/pane-view-state.ts';
import { paneViewFactory } from './tui/pane-view.ts';
import { mountTaskInspector } from './tui/task-inspector.ts';
import { workspaceBrand } from './tui/workspace-brand.ts';
import { SmallText, SmallTextService } from './tui/small-text.ts';
import { fitCells, paneNumber, paneState } from './tui/workspace-chrome.ts';
import { workspaceInput, type WorkspaceModalState } from './tui/workspace-input.ts';
import { workspaceStatusRefresh } from './tui/workspace-refresh.ts';
import type { PaneState, WorkspaceController } from './workspace.ts';
import { updateAction, updateHint } from './updates/presentation.ts';

export function mountWorkspaceUI(renderer: CliRenderer, workspace: WorkspaceController, exit: () => void) {
  const smallText = new SmallTextService(renderer);
  const modal: WorkspaceModalState = {
    commandMode: false,
    commandPane: workspace.focused,
    modalSubmitUntil: 0,
  };
  // Sixel's six-pixel bands can extend past a character row and scroll the terminal
  // if painted at the bottom edge. Keep one blank guard row below the footer.
  const page = new BoxRenderable(renderer, {
    width: '100%',
    height: '100%',
    flexDirection: 'column',
    paddingBottom: 1,
  });
  const heading = new BoxRenderable(renderer, { height: 3, flexShrink: 0, flexDirection: 'column' });
  const headline = new BoxRenderable(renderer, { height: 1, flexShrink: 0, flexDirection: 'row' });
  const aggregate = createAggregateImage(renderer),
    headerLogo = aggregate.image;
  const header = new TextRenderable(renderer, {
    height: 1,
    flexShrink: 0,
    minWidth: 0,
    wrapMode: 'none',
    truncate: true,
    fg: palette(workspace.launch.appConfig.ui).accent,
    content: '涌现 · Emergence',
  });
  const taskButton = new TextRenderable(renderer, {
    height: 1,
    flexShrink: 0,
    selectable: false,
    content: '',
    onMouseDown(event) {
      if (event.button === 0) {
        event.preventDefault();
        event.stopPropagation();
        inspector.open();
      }
    },
  });
  headline.add(headerLogo);
  headline.add(header);
  headline.add(taskButton);
  heading.add(headline);
  const navigationBar = new BoxRenderable(renderer, {
    height: 1,
    flexShrink: 0,
    flexDirection: 'row',
    gap: 1,
    overflow: 'hidden',
  });
  heading.add(navigationBar);
  const updateNotice = new TextRenderable(renderer, {
    height: 1,
    flexShrink: 0,
    content: '',
    wrapMode: 'none',
    truncate: true,
    onMouseDown(event) {
      if (event.button === 0) {
        event.preventDefault();
        event.stopPropagation();
        openNavigation(workspace.focused, 'updates');
      }
    },
  });
  heading.add(updateNotice);
  const tabs = new Map<string, TextRenderable>();
  const overflow = new TextRenderable(renderer, { height: 1, selectable: false, content: '' });
  navigationBar.add(overflow);
  const body = new BoxRenderable(renderer, { flexGrow: 1, position: 'relative' });
  const footer = new SmallText(
    renderer,
    { height: 1, marginTop: 1, flexShrink: 0, content: '', wrapMode: 'none', truncate: true },
    smallText,
  );

  async function applyPaneAction(target: { id: string; session?: string }, command: string) {
    if (workspace.panes.get(target.id)?.controller?.id !== target.session) return;
    const actions: Record<string, string> = {
      向右分屏: '/split right',
      向下分屏: '/split down',
      切换模型: '/model',
      '最大化 / 恢复': '/maximize',
      关闭窗口: '/close',
    };
    if (actions[command]) await workspace.send(target.id, actions[command]);
  }
  const paneMenu = mountCommandList(renderer, (item) => {
    const target = modal.paneMenuTarget;
    closePaneMenu();
    if (!target || workspace.panes.get(target.id)?.controller?.id !== target.session) return;
    void applyPaneAction(target, item.command).catch((reason) => error(target.id, reason));
  });
  paneMenu.box.position = 'absolute';
  paneMenu.box.zIndex = 100;
  paneMenu.box.width = 48;
  paneMenu.box.onMouseScroll = (event) => {
    if (!paneMenu.box.visible || !event.scroll || !['up', 'down'].includes(event.scroll.direction)) return;
    event.preventDefault();
    event.stopPropagation();
    paneMenu.move(event.scroll.direction === 'up' ? -1 : 1);
  };
  function closePaneMenu() {
    modal.paneMenuTarget = undefined;
    paneMenu.box.visible = false;
    refresh();
  }
  function openPaneMenu(id: string, x: number, y: number) {
    closeCommands();
    modal.permissionMenu = undefined;
    inspector.releaseFocus();
    modal.paneMenuTarget = { id, session: workspace.panes.get(id)?.controller?.id };
    paneMenu.box.left = Math.max(0, Math.min(x, renderer.width - 48));
    paneMenu.box.top = Math.max(0, Math.min(y, renderer.height - 7));
    paneMenu.box.width = Math.min(48, renderer.width);
    paneMenu.box.backgroundColor = palette(workspace.launch.appConfig.ui).input;
    paneMenu.update(
      '',
      [
        { command: '向右分屏', description: '新增独立会话' },
        { command: '向下分屏', description: '新增独立会话' },
        { command: '切换模型', description: '只更改当前窗口' },
        { command: '最大化 / 恢复', description: '调整当前窗口显示' },
        { command: '关闭窗口', description: '关闭当前窗口，保留会话历史' },
      ],
      palette(workspace.launch.appConfig.ui),
      false,
      Math.max(1, Math.min(5, renderer.height - 2)),
      '窗口操作',
    );
    paneMenu.box.visible = true;
    refresh();
  }

  const modePicker = new TextRenderable(renderer, {
    height: permissionModes.length + 1,
    visible: false,
    content: '',
    selectable: false,
  });
  const commandList = mountCommandList(renderer, (item) => chooseCommand(item));
  const commandInput = new TextareaRenderable(renderer, {
    height: 3,
    visible: false,
    placeholder: '命令 · /help · /focus 2 · /exit · Esc 返回',
    keyBindings: [
      { name: 'return', action: 'submit' },
      { name: 'a', ctrl: true, action: 'select-all' },
    ],
    onContentChange() {
      if (modal.commandMode) refreshHeader();
    },
    onSubmit() {
      submitCommand();
    },
  });
  page.add(heading);
  page.add(body);
  page.add(modePicker);
  page.add(commandList.box);
  page.add(commandInput);
  page.add(footer);
  renderer.root.add(page);
  page.add(paneMenu.box);

  const views = new Map<string, View>();
  const dividers = new Map<string, BoxRenderable>();
  const savedScroll = (id: string, scroll: ScrollBoxRenderable) => {
    const view = views.get(id);
    return view && (!view.box.visible || view.transient || !view.initializedScroll)
      ? (workspace.panes.get(id)?.scrollTop ?? 0)
      : scroll.scrollTop;
  };
  let layout = geometry(workspace.layout, { x: 0, y: 0, width: 80, height: 24 });
  let refreshing = false,
    disposed = false;
  let measuredWidth = 0,
    measuredHeight = 0;

  const brand = workspaceBrand(workspace, aggregate);
  const statusRefresh = workspaceStatusRefresh(workspace.panes, views, (pane, view, redact) =>
    renderPaneNotice(workspace, pane, view, redact),
  );
  const terminal = terminalActions(
    renderer,
    (message) => {
      if (!disposed) {
        workspace.notice = message;
        refreshHeader();
      }
    },
    exit,
  );
  const error = (id: string, value: unknown) => {
    const pane = workspace.panes.get(id);
    workspace.notice = safeError(value);
    if (pane?.controller) {
      pane.controller.notice = safeError(value);
      pane.controller.changed();
    }
    workspace.changed();
  };
  const inspector = mountTaskInspector(
    renderer,
    workspace,
    () => refresh(),
    (reason) => error(workspace.focused, reason),
  );
  body.add(inspector.box);
  function closeCommands() {
    if (modal.navigation?.kind === 'updates')
      void workspace.updates?.preference(undefined, true).catch(() => {});
    modal.navigation = undefined;
    modal.commandMode = false;
    commandInput.blur();
    commandInput.visible = false;
    commandList.box.visible = false;
  }
  function runCommand(value: string) {
    const id = modal.commandPane,
      session = modal.commandSession;
    closeCommands();
    if (inspector.opened) inspector.close();
    refresh();
    if (!workspace.panes.has(id) || workspace.panes.get(id)?.controller?.id !== session) {
      error(id, '命令所属会话已变化，请重新打开命令列表');
      return;
    }
    if (
      workspace.panes.get(id)?.controller?.pending &&
      !workspaceCommands(workspace, id).some((item) => item.command === value.split(/\s/)[0])
    ) {
      error(id, '请先完成或取消当前确认');
      return;
    }
    void workspace.send(id, value).catch((reason) => {
      if (!disposed) {
        error(id, reason);
        // Keep failed command text separate from the conversation draft.
        if (
          !modal.commandMode &&
          workspace.focused === id &&
          workspace.panes.get(id)?.controller?.id === session
        ) {
          modal.commandMode = true;
          commandInput.setText(value);
          commandInput.visible = true;
          refresh();
          commandInput.focus();
        }
      }
    });
  }
  function openNavigation(id: string, kind: NavigationKind, query = '') {
    const controller = workspace.panes.get(id)?.controller;
    if (!controller || (controller.pending && kind !== 'approvals') || id !== workspace.focused) {
      error(id, '请先完成当前确认或切换到目标窗口');
      return;
    }
    if (inspector.opened) inspector.close();
    closePaneMenu();
    modal.permissionMenu = undefined;
    modal.commandPane = id;
    modal.commandSession = controller.id;
    modal.navigation = { kind };
    workspace.overlay = '';
    workspace.taskPanel = false;
    modal.commandMode = true;
    commandInput.setText(query);
    commandInput.visible = true;
    refresh();
    if (kind === 'updates') commandList.resetSelection();
    commandInput.focus();
  }
  function chooseNavigation(item: NavigationItem) {
    const state = modal.navigation,
      pane = workspace.panes.get(modal.commandPane);
    if (
      !state ||
      workspace.focused !== modal.commandPane ||
      pane?.controller?.id !== modal.commandSession ||
      (pane?.controller?.pending && state.kind !== 'approvals')
    ) {
      closeCommands();
      refresh();
      return;
    }
    const current = navigationItems(workspace, modal.commandPane, state.kind).find(
      (entry) => entry.value === item.value,
    );
    if (!current) {
      refreshHeader();
      return;
    }
    if (state.kind === 'updates') {
      modal.modalSubmitUntil = performance.now() + 350;
      closeCommands();
      refresh();
      void updateAction(workspace.updates, item.value)
        .then((message) => {
          if (disposed) return;
          if (item.value === 'notes') workspace.overlay = message;
          else workspace.notice = message;
          workspace.changed();
        })
        .catch((reason) => error(workspace.focused, reason));
      return;
    }
    if (state.kind === 'approvals') {
      const entry = workspace.interactions.list().find((e) => JSON.stringify(e.ref) === item.value);
      if (!entry) return;
      closeCommands();
      workspace.overlay = '';
      workspace.taskPanel = false;
      workspace.show(entry.ref.pane);
      return;
    }
    modal.modalSubmitUntil = performance.now() + 350;
    const view = views.get(modal.commandPane);
    if (state.kind === 'history') {
      const text = item.value;
      closeCommands();
      if (view) {
        view.input.replaceText(text);
        view.input.gotoBufferEnd();
        workspace.updateView(modal.commandPane, text, savedScroll(modal.commandPane, view.scroll));
      }
      workspace.notice = '已回填历史，检查后再发送';
      refresh();
      return;
    }
    runCommand(state.kind === 'models' ? '/model ' + item.value : '/task show ' + item.value);
  }
  function chooseCommand(item: CommandItem, view?: View) {
    if (modal.navigation && !view) {
      chooseNavigation(item as NavigationItem);
      return;
    }
    const needsArgs = item.usage && !item.usage.startsWith('[');
    if (needsArgs) {
      const hint =
        workspace.launch.appConfig.ui.language === 'en'
          ? `Fill in: ${item.command} ${item.usage}`
          : `请补充参数：${item.command} ${item.usage}；填好后再按 Enter`;
      workspace.notice = hint;
      const controller = workspace.panes.get(view ? workspace.focused : modal.commandPane)?.controller;
      if (controller) controller.notice = hint;
    }
    if (view) {
      view.suppressedQuery = item.command + (needsArgs ? ' ' : '');
      view.input.replaceText(item.command + (needsArgs ? ' ' : ''));
      view.input.gotoBufferEnd();
      if (!needsArgs) view.submit();
    } else if (needsArgs) {
      commandInput.replaceText(item.command + ' ');
      commandInput.gotoBufferEnd();
      refreshHeader();
    } else runCommand(item.command);
  }
  function submitCommand() {
    if (modal.navigation) {
      refreshHeader();
      if (commandList.selected) chooseNavigation(commandList.selected as NavigationItem);
      return;
    }
    const value = commandInput.plainText.trim(),
      ui = workspace.launch.appConfig.ui;
    commandList.update(
      value,
      workspaceCommands(workspace, modal.commandPane),
      palette(ui),
      ui.language === 'en',
      renderer.height < 28 ? 2 : 4,
    );
    const selected = commandList.selected;
    const exact = workspaceCommands(workspace, modal.commandPane).find((item) => item.command === value);
    if (exact) {
      chooseCommand(selected ?? exact);
      return;
    }
    if (!selected && !value.startsWith('/')) return;
    if (selected && (!value.startsWith('/') || (!value.includes(' ') && value !== selected.command))) {
      chooseCommand(selected);
      return;
    }
    if (selected && value === selected.command && selected.usage && !selected.usage.startsWith('[')) {
      chooseCommand(selected);
      return;
    }
    if (value) runCommand(value.startsWith('/') ? value : '/' + value);
  }
  function renderComposer(pane: PaneState, view: View, redact = createRedactor()) {
    const ui = workspace.launch.appConfig.ui,
      en = ui.language === 'en',
      colors = palette(ui),
      controller = pane.controller;
    sizeEditor(view.input, view.box.height || renderer.height - 7);
    view.status.fg = activityColor(
      ui,
      Boolean(controller?.busy || controller?.pending || controller?.lastError),
    );
    renderNotice(pane, view, redact);
    const query = view.input.plainText;
    view.commands.box.visible =
      pane.id === workspace.focused &&
      !modal.commandMode &&
      !modal.permissionMenu &&
      !modal.paneMenuTarget &&
      !(inspector.opened && (inspector.focused || inspector.fullscreen)) &&
      !controller?.pending &&
      !workspace.overlay &&
      slashSuggestions(query, workspaceCommands(workspace, pane.id)) &&
      query !== view.suppressedQuery;
    if (view.commands.box.visible)
      view.commands.update(
        query,
        workspaceCommands(workspace, pane.id),
        colors,
        en,
        view.box.height < 22 ? 2 : 4,
      );
  }

  const renderNotice = (pane: PaneState, view: View, redact = createRedactor()) =>
    renderPaneNotice(workspace, pane, view, redact);
  const renderPane = (pane: PaneState, view: View, redact = createRedactor()) => {
    const controller = pane.controller;
    if (view.binding !== controller?.id) {
      view.binding = controller?.id;
      view.initializedScroll = false;
      view.transient = false;
      view.heldSelection = undefined;
      view.followAfterSubmit = false;
      view.unread = false;
      view.seenRevision = -1;
      view.seenLive = '';
      view.sharedExpanded = false;
      view.receiptClock = undefined;
      if (view.input.plainText !== pane.draft) view.input.setText(pane.draft);
    }
    const ui = workspace.launch.appConfig.ui,
      colors = palette(ui),
      en = ui.language === 'en';
    const inspecting = inspector.opened && (inspector.focused || inspector.fullscreen);
    if (
      controller?.pending ||
      modal.commandMode ||
      modal.permissionMenu ||
      modal.paneMenuTarget ||
      inspecting ||
      pane.id !== workspace.focused ||
      !view.box.visible
    )
      view.input.blur();
    view.interaction.sync(
      controller?.pending,
      view.box.visible &&
        pane.id === workspace.focused &&
        !workspace.overlay &&
        !modal.commandMode &&
        !modal.permissionMenu &&
        !modal.paneMenuTarget &&
        !inspecting,
      colors,
      en,
    );
    view.input.visible = !controller?.pending;
    view.composer.visible = view.input.visible;
    if (
      !controller?.pending &&
      !modal.commandMode &&
      !modal.permissionMenu &&
      !modal.paneMenuTarget &&
      !inspecting &&
      view.box.visible &&
      pane.id === workspace.focused
    )
      view.input.focus();
    view.box.backgroundColor = colors.background;
    view.title.fg = colors.accent;
    view.text.fg = colors.foreground;
    view.close.fg = colors.warning;
    view.input.backgroundColor = colors.input;
    view.composer.backgroundColor = colors.input;
    view.composer.borderColor =
      ui.theme === 'dark' && process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb'
        ? '#606060'
        : colors.border;
    view.input.focusedBackgroundColor = colors.input;
    view.input.textColor = colors.foreground;
    view.input.focusedTextColor = colors.foreground;
    view.input.placeholder = en ? 'Task or /help' : '输入任务或 /help';
    view.input.placeholderColor = colors.muted;
    view.close.content = en ? '[Close]' : '[关闭]';
    view.close.width = en ? 7 : 6;
    view.title.width = Math.max(1, view.columns - 16);
    const transient = Boolean((pane.id === workspace.focused && workspace.overlay) || controller?.pending);
    if (transient !== view.transient) {
      if (transient) workspace.updateView(pane.id, view.input.plainText, savedScroll(pane.id, view.scroll));
      else view.initializedScroll = false;
      view.transient = transient;
    }
    if (view.transient) view.jump.visible = false;
    const active = pane.id === workspace.focused,
      single = workspace.visible().length === 1;
    view.box.paddingLeft = view.box.paddingRight = single ? (renderer.width >= 80 ? 2 : 1) : 0;
    view.box.borderColor = active && !inspecting ? colors.accent : colors.border;
    // OpenTUI's color setter enables a missing border; apply the chosen sides last.
    view.box.border = !single;
    view.title.fg = active ? colors.accent : colors.muted;
    view.title.attributes = active ? TextAttributes.BOLD : 0;
    const role = en ? 'Session' : '会话';
    const model = controller?.model ?? workspace.launch.appConfig.models.find((m) => m.id === pane.modelId);
    const actualModel = model ? `${model.provider}/${model.model}` : pane.modelId;
    const metaWidth = Math.max(10, view.columns - (en ? 5 : 4));
    view.title.content = redact(
      `${active ? '›' : ' '} ${paneNumber(workspace, pane.id)} ${role} · ${paneState(pane, en)} · ${controller ? permissionLabels[controller.permissionMode] + (controller.permissionTransitioning ? '…' : '') : ''}`,
    );
    view.modelLabel.fg = colors.muted;
    view.modelLabel.content = fitCells(actualModel, metaWidth, false, redact);
    view.box.bottomTitle =
      active && workspace.taskEngine.current(pane.id)
        ? fitCells(workspace.taskEngine.current(pane.id)!.id, Math.max(8, view.columns - 3), false, redact)
        : undefined;
    const overlay = pane.id === workspace.focused && workspace.overlay;
    view.scroll.stickyScroll = !overlay;
    if (view.overlayText !== overlay) {
      view.overlayText = overlay || undefined;
      view.revealOverlay = Boolean(overlay);
    }
    const pendingBanner = !overlay ? controller?.pending?.id : undefined;
    if (view.pendingBanner !== pendingBanner) {
      view.pendingBanner = pendingBanner;
      view.revealPending = Boolean(pendingBanner);
    }
    const projection = controller?.displayMessages();
    const reading =
      view.initializedScroll &&
      !view.transient &&
      view.scroll.scrollTop < Math.max(0, view.scroll.scrollHeight - view.scroll.viewport.height) - 1;
    if (
      reading &&
      ((projection?.revision ?? 0) !== view.seenRevision || (controller?.live ?? '') !== view.seenLive)
    )
      view.unread = true;
    view.seenRevision = projection?.revision ?? 0;
    view.seenLive = controller?.live ?? '';
    view.messages.box.visible = !overlay && !pane.error;
    view.messages.update(projection, controller?.live ?? '', colors, view.columns, en);
    view.jump.fg = colors.muted;
    const text =
      overlay ||
      (pane.error
        ? `恢复失败：${pane.error}\n/retry 重试 · /project "目录" 新建 · /panes 查看其他会话`
        : controller?.pending
          ? redact(controller.pending.title)
          : '');
    view.text.visible = Boolean(text);
    if (view.lastText !== text) {
      view.text.content = text;
      view.lastText = text;
    }
    view.meta.visible = !single && ui.statusBar.visible;
    view.meta.marginTop = view.box.height >= 16 ? 1 : 0;
    view.meta.fg = colors.muted;
    view.meta.content = paneFooter(pane, view.columns - 2, en, redact);
    renderComposer(pane, view, redact);
    // The live editor owns its contents. Only a new session binding or explicit submit/error changes it.
  };
  const createView = paneViewFactory(
    renderer,
    body,
    workspace,
    views,
    {
      menuOpen: () => !!modal.paneMenuTarget,
      disposed: () => disposed,
      releaseFocus: () => inspector.releaseFocus(),
      openPaneMenu,
      closePaneMenu,
      chooseCommand,
      refreshHeader: () => refreshHeader(),
      renderNotice,
      renderComposer,
      savedScroll,
      error,
    },
    smallText,
  );
  const refreshHeader = (redact = createRedactor()) => {
    const updateIdle = ![...workspace.panes.values()].some(
      (pane) => pane.controller?.busy || pane.controller?.pending,
    );
    const updateState = workspace.updates?.snapshot;
    updateNotice.content =
      updateState?.status === 'installing' || (updateIdle && !modal.commandMode)
        ? updateHint(updateState)
        : '';
    updateNotice.fg = palette(workspace.launch.appConfig.ui).muted;
    updateNotice.visible = Boolean(updateNotice.chunks.map((chunk) => chunk.text).join(''));
    const ui = workspace.launch.appConfig.ui,
      en = ui.language === 'en',
      colors = palette(ui);
    modePicker.visible = Boolean(modal.permissionMenu);
    modePicker.fg = colors.foreground;
    if (modal.permissionMenu)
      modePicker.content =
        `窗口 ${modal.permissionMenu.pane} · 执行权限 · ↑↓ 选择 / Enter 确认 / Esc 返回\n` +
        permissionModes
          .map(
            (mode, i) =>
              `${modal.permissionMenu!.selected === i ? '›' : ' '} ${permissionLabels[mode]} (${mode}) — ${permissionDescriptions[mode]}`,
          )
          .join('\n');
    page.backgroundColor = colors.background;
    header.fg = colors.accent;
    footer.fg = colors.muted;
    commandInput.backgroundColor = colors.input;
    commandInput.focusedBackgroundColor = colors.input;
    commandInput.textColor = colors.foreground;
    commandInput.focusedTextColor = colors.foreground;
    commandInput.placeholder = en
      ? 'Search commands or enter /command · Esc back'
      : '搜索命令或输入 /命令 · Esc 返回';
    commandList.box.visible = modal.commandMode;
    if (modal.commandMode) {
      const query = commandInput.plainText.trim(),
        commands = modal.navigation
          ? navigationItems(workspace, modal.commandPane, modal.navigation.kind)
          : workspaceCommands(workspace, modal.commandPane);
      const withArgs =
        !modal.navigation &&
        query.startsWith('/') &&
        commands.some((item) => query.startsWith(item.command + ' '));
      commandList.box.visible = !withArgs;
      commandList.update(
        query,
        commands,
        colors,
        en,
        renderer.height < 28 ? 2 : 4,
        modal.navigation ? navigationLabels[modal.navigation.kind][en ? 1 : 0] : '',
      );
    }
    const panes = [...workspace.panes.values()];
    const cooperation = workspace.taskEngine.state;
    const mode = en ? 'Independent' : '独立模式';
    const running = panes.filter((pane) => pane.controller?.busy).length,
      pending = workspace.interactions.list().length;
    const counts = `${panes.length} ${en ? 'sessions' : '会话'} · ${running} ${en ? 'running' : '运行'} · ${pending} ${en ? 'approval' : '待确认'}`;
    const compact =
      renderer.width < 60
        ? `${panes.length} ${en ? 'sessions' : '会话'}${pending ? ` · ◇${pending}` : running ? ` · ●${running}` : ''}`
        : en
          ? counts
          : `独立  ${counts}`;
    const brandLayout = headerBrandLayout(renderer.width, renderer.height);
    // Keep the three-line identity on capable layouts, even when graphics are unavailable.
    const logoColumns = aggregate.supported() ? brandLayout.columns : 0;
    const taskLabel = `[${en ? 'Tasks' : '任务'} ${cooperation.tasks.length}]`;
    const headerColumns = Math.max(
      1,
      renderer.width - stringWidth(taskLabel) - (logoColumns ? logoColumns + 2 : 0),
    );
    const shortCounts =
      stringWidth(counts) <= headerColumns
        ? counts
        : `${panes.length} ${en ? 'sessions' : '会话'} · ●${running} · ◇${pending}`;
    navigationBar.visible = panes.length > 1;
    heading.height = brandLayout.rows + (navigationBar.visible ? 1 : 0) + (updateNotice.visible ? 1 : 0);
    headline.height = brandLayout.rows;
    headerLogo.visible = logoColumns > 0;
    headerLogo.width = logoColumns;
    headerLogo.height = brandLayout.rows;
    brand.sync();
    header.height = brandLayout.rows;
    const maximized = workspace.maximized ? (en ? ' · Maximized' : ' · 最大化') : '';
    header.content = brandLayout.columns
      ? new StyledText([
          fg(colors.accent)(
            bold('\n'.repeat(Math.max(0, Math.floor((brandLayout.rows - 3) / 2))) + 'Emergence'),
          ),
          fg(colors.muted)(`\n${fitCells(mode + maximized, headerColumns, false, redact)}\n${shortCounts}`),
        ])
      : new StyledText([
          fg(colors.accent)(bold('涌现 · Emergence')),
          fg(colors.muted)(`  ${compact}${maximized}`),
        ]);
    taskButton.content = taskLabel;
    taskButton.width = stringWidth(taskLabel);
    taskButton.fg = colors.muted;
    header.width = headerColumns;
    const capacity = Math.max(1, Math.floor((renderer.width - 7) / 18)),
      index = panes.findIndex((pane) => pane.id === workspace.focused);
    const start = Math.max(0, Math.min(index - Math.floor(capacity / 2), panes.length - capacity));
    const displayed = panes.slice(start, start + capacity),
      available =
        Math.floor(
          (renderer.width - (panes.length > displayed.length ? 7 : 0)) / Math.max(1, displayed.length),
        ) - 1;
    overflow.visible = panes.length > displayed.length;
    overflow.content = `… +${panes.length - displayed.length}`;
    overflow.width = 6;
    overflow.fg = colors.muted;
    for (const [id, tab] of tabs)
      if (!workspace.panes.has(id)) {
        tab.destroy();
        tabs.delete(id);
      }
    for (const pane of panes) {
      let tab = tabs.get(pane.id);
      if (!tab) {
        tab = new TextRenderable(renderer, {
          height: 1,
          selectable: false,
          wrapMode: 'none',
          truncate: true,
          onMouseDown(event) {
            if (event.button === 2) {
              event.preventDefault();
              event.stopPropagation();
              openPaneMenu(pane.id, event.x, event.y);
              return;
            }
            if (event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            inspector.releaseFocus();
            if (workspace.visible().includes(pane.id)) workspace.focus(pane.id);
            else workspace.show(pane.id);
          },
        });
        tabs.set(pane.id, tab);
        navigationBar.add(tab);
      }
      tab.visible = displayed.includes(pane);
      const active = pane.id === workspace.focused;
      const hidden = !workspace.visible().includes(pane.id),
        folded = !hidden && !views.get(pane.id)?.box.visible;
      const status = pane.controller?.pending ? ' ◇' : pane.controller?.busy ? ' ●' : '';
      const suffix = hidden ? (en ? ' hidden' : ' 后台') : folded ? (en ? ' folded' : ' 折叠') : '';
      const name = `${active ? '›' : ' '} ${paneNumber(workspace, pane.id)} ${en ? 'Session' : '会话'}`;
      const label =
        fitCells(name, Math.max(5, available - stringWidth(status + suffix)), false, redact) +
        status +
        suffix;
      tab.content = label;
      tab.width = Math.max(1, Math.min(available, stringWidth(label)));
      tab.fg = active ? colors.accent : colors.muted;
      tab.bg = active ? colors.input : colors.background;
      tab.attributes = active ? TextAttributes.BOLD : 0;
    }
    const single = workspace.visible().length === 1;
    footer.visible = single && ui.statusBar.visible;
    footer.height = footer.visible ? 1 : 0;
    footer.content = paneFooter(workspace.current, renderer.width, en, redact);
    const currentView = views.get(workspace.focused);
    if (currentView) renderNotice(workspace.current, currentView, redact);
  };
  const refresh = () => {
    if (disposed || refreshing) return;
    if (
      modal.navigation &&
      (workspace.focused !== modal.commandPane ||
        workspace.panes.get(modal.commandPane)?.controller?.id !== modal.commandSession ||
        (workspace.panes.get(modal.commandPane)?.controller?.pending &&
          modal.navigation.kind !== 'approvals'))
    )
      closeCommands();
    refreshing = true;
    const redact = createRedactor();
    try {
      for (const [id, view] of views)
        if (!workspace.panes.has(id)) {
          view.messages.dispose();
          view.box.destroyRecursively();
          views.delete(id);
        }
      for (const pane of workspace.panes.values())
        if (!views.has(pane.id)) views.set(pane.id, createView(pane));
      const panel = inspector.sync(Math.max(1, body.width), Math.max(1, body.height));
      const bounds = {
        x: 0,
        y: 0,
        width: Math.max(1, body.width - (panel.fullscreen ? 0 : panel.width)),
        height: Math.max(1, body.height),
      };
      measuredWidth = body.width;
      measuredHeight = body.height;
      layout = geometry(workspace.layout, bounds);
      const folded =
        workspace.maximized || [...layout.panes.values()].some((rect) => rect.width < 26 || rect.height < 10);
      for (const [id, view] of views) {
        const rect =
          inspector.opened && panel.fullscreen
            ? undefined
            : folded
              ? id === workspace.focused
                ? bounds
                : undefined
              : layout.panes.get(id);
        if (view.box.visible && !rect) {
          workspace.updateView(id, view.input.plainText, savedScroll(id, view.scroll));
          view.initializedScroll = false;
          const selection = view.input.getSelection();
          if (selection) view.heldSelection = { ...selection, cursor: view.input.cursorOffset };
        }
        view.box.visible = Boolean(rect);
        if (rect) {
          view.box.left = rect.x;
          view.box.top = rect.y;
          view.box.width = rect.width;
          view.box.height = rect.height;
          view.columns = Math.max(12, rect.width - 5);
          view.title.width = Math.max(
            1,
            rect.width - (workspace.launch.appConfig.ui.language === 'en' ? 10 : 9),
          );
        }
        if (id !== workspace.focused) view.input.blur();
        renderPane(workspace.panes.get(id)!, view, redact);
      }
      for (const [id, divider] of dividers)
        if (!layout.splits.has(id)) {
          divider.destroy();
          dividers.delete(id);
        }
      for (const [id, split] of layout.splits) {
        let divider = dividers.get(id);
        if (!divider) {
          const drag = (event: { x: number; y: number }) => {
            const split = layout.splits.get(id);
            if (!split) return;
            const ratio =
              split.axis === 'row'
                ? (event.x - body.x - split.bounds.x) / split.bounds.width
                : (event.y - body.y - split.bounds.y) / split.bounds.height;
            workspace.resize(id, ratio);
          };
          divider = new BoxRenderable(renderer, {
            id: `divider-${id}`,
            position: 'absolute',
            backgroundColor: palette(workspace.launch.appConfig.ui).border,
            onMouseDrag: drag,
            onMouseDragEnd: drag,
          });
          body.add(divider);
          dividers.set(id, divider);
        }
        divider.backgroundColor = palette(workspace.launch.appConfig.ui).border;
        divider.visible = !folded && !(inspector.opened && panel.fullscreen);
        divider.left = split.divider.x;
        divider.top = split.divider.y;
        divider.width = split.divider.width;
        divider.height = split.divider.height;
      }
      refreshHeader(redact);
      statusRefresh.sync();
    } finally {
      refreshing = false;
    }
  };
  const sessionChanged = (id: string) => {
    const redact = createRedactor();
    if (
      modal.navigation &&
      modal.navigation.kind !== 'approvals' &&
      id === modal.commandPane &&
      workspace.panes.get(id)?.controller?.pending
    ) {
      closeCommands();
      refresh();
    }
    const pane = workspace.panes.get(id),
      view = views.get(id);
    if (pane && view) renderPane(pane, view, redact);
    if (inspector.opened) inspector.sync(Math.max(1, body.width), Math.max(1, body.height));
    refreshHeader(redact);
    statusRefresh.sync();
  };
  const frame = () => {
    if (disposed) return;
    smallText.sync(palette(workspace.launch.appConfig.ui).background);
    for (const [id, view] of views) {
      const pane = workspace.panes.get(id);
      if (!pane || !view.box.visible || view.scroll.viewport.height <= 0) continue;
      sizeEditor(view.input, view.box.height);
      if (view.heldSelection) {
        const { start, end, cursor } = view.heldSelection;
        view.input.cursorOffset = cursor;
        view.input.setSelection(start, end);
        view.heldSelection = undefined;
      }
      if (view.transient) {
        if (view.revealOverlay) {
          view.scroll.scrollTo(0);
          view.revealOverlay = false;
        } else if (view.revealPending) {
          view.scroll.scrollTo(view.scroll.scrollHeight);
          view.revealPending = false;
        }
        continue;
      }
      if (!view.initializedScroll) {
        view.scroll.scrollTop = pane.scrollTop;
        view.initializedScroll = true;
      }
      if (view.followAfterSubmit) {
        view.scroll.scrollTo(view.scroll.scrollHeight);
        view.followAfterSubmit = false;
      }
      const reading =
        view.scroll.scrollTop < Math.max(0, view.scroll.scrollHeight - view.scroll.viewport.height) - 1;
      if (!reading) view.unread = false;
      view.jump.visible = reading;
      const en = workspace.launch.appConfig.ui.language === 'en';
      const jumpLabel = view.unread
        ? en
          ? '↓ New content · /view latest'
          : '↓ 有新内容 · /view latest'
        : en
          ? '↓ Back to latest · /view latest'
          : '↓ 回到最新 · /view latest';
      if (reading && view.jump.chunks[0]?.text !== jumpLabel) view.jump.content = jumpLabel;
      workspace.updateView(id, view.input.plainText, view.scroll.scrollTop);
    }
    // Image decode and pixel-size discovery can complete after a capability event.
    const logoVisible =
      aggregate.supported() && headerBrandLayout(renderer.width, renderer.height).columns > 0;
    if (
      logoVisible !== headerLogo.visible ||
      (body.width > 0 && (body.width !== measuredWidth || body.height !== measuredHeight))
    )
      refresh();
  };

  const { keypress, paste } = workspaceInput({
    modal,
    workspace,
    views,
    paneMenu,
    closePaneMenu,
    applyPaneAction,
    error,
    refresh: () => refresh(),
    terminal,
    commandInput,
    commandList,
    refreshHeader: () => refreshHeader(),
    closeCommands,
    runCommand,
    openNavigation,
    inspector,
    savedScroll,
    renderComposer,
    chooseCommand,
  });
  const openPermissionMenu = (pane: string) => {
    const controller = workspace.panes.get(pane)?.controller;
    if (!controller) return;
    modal.navigation = undefined;
    modal.permissionMenu = {
      pane,
      session: controller.id,
      selected: permissionModes.indexOf(controller.permissionMode),
    };
    modal.commandMode = false;
    commandInput.blur();
    commandInput.visible = false;
    refresh();
  };
  const messageViewCommand = (id: string, action: string, sequence?: number) => {
    const view = views.get(id);
    if (!view) throw new Error('窗口不可用');
    if (workspace.panes.get(id)?.controller?.pending) throw new Error('请先完成或取消当前确认');
    if (action === 'latest') {
      view.followAfterSubmit = true;
      view.unread = false;
    } else view.messages.command(action, sequence);
  };
  const inspectTask = (_pane: string, task?: string) => {
    inspector.open(task);
  };
  workspace.on('task-inspect', inspectTask);
  workspace.on('navigation', openNavigation);
  workspace.on('message-view-command', messageViewCommand);
  workspace.on('permission-menu', openPermissionMenu);
  workspace.on('change', refresh);
  workspace.updates?.on('change', refresh);
  workspace.on('session-change', sessionChanged);
  workspace.on('exit', exit);
  renderer.on('resize', refresh);
  renderer.on('capabilities', refresh);
  renderer.on('frame', frame);
  renderer.keyInput.on('keypress', keypress);
  renderer.keyInput.on('paste', paste);
  refresh();
  return {
    views,
    dividers,
    commandInput,
    commandList,
    paneMenu,
    inspector,
    tabs,
    taskButton,
    heading,
    headerLogo,
    refresh,
    submitInitial() {
      views.get(workspace.focused)?.submit();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      statusRefresh.dispose();
      brand.dispose();
      for (const [id, view] of views)
        workspace.updateView(id, view.input.plainText, savedScroll(id, view.scroll));
      workspace.off('change', refresh);
      workspace.updates?.off('change', refresh);
      workspace.off('session-change', sessionChanged);
      workspace.off('exit', exit);
      workspace.off('navigation', openNavigation);
      workspace.off('task-inspect', inspectTask);
      workspace.off('permission-menu', openPermissionMenu);
      workspace.off('message-view-command', messageViewCommand);
      renderer.off('resize', refresh);
      renderer.off('capabilities', refresh);
      renderer.off('frame', frame);
      renderer.keyInput.off('keypress', keypress);
      renderer.keyInput.off('paste', paste);
      terminal.dispose();
      smallText.dispose();
      for (const view of views.values()) view.messages.dispose();
      page.destroyRecursively();
    },
  };
}

export async function startWorkspaceUI(workspace: WorkspaceController, exit: () => void) {
  const renderer = await createCliRenderer({ exitOnCtrlC: false, useMouse: true });
  const view = mountWorkspaceUI(renderer, workspace, exit);
  return {
    dispose() {
      view.dispose();
      renderer.destroy();
    },
  };
}
