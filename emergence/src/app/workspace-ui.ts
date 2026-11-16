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
  type KeyEvent,
  type PasteEvent,
} from '@opentui/core';
import stringWidth from 'string-width';
import { safeError } from '../core/adapters/redaction.ts';
import { permissionLabels, permissionModes } from '../core/domain/permissions.ts';
import { keyAction, palette } from '../core/domain/ui-preferences.ts';
import { slashSuggestions, workspaceCommands, type CommandItem } from './commands.ts';
import { mountInteractionUI } from './interaction-ui.ts';
import { geometry } from './layout.ts';
import { terminalActions } from './terminal-actions.ts';
import { type AggregateState } from './tui/aggregate-art.ts';
import { createAggregateImage } from './tui/aggregate-image.ts';
import { auxiliaryInfo, type ReceiptClock } from './tui/auxiliary-info.ts';
import { sessionFooter } from './tui/workspace-chrome.ts';
import { mountCommandList } from './tui/command-list.ts';
import { activityColor, composerStatus, sizeEditor } from './tui/composer.ts';
import { headerBrandLayout } from './tui/header-brand.ts';
import { mountMessages } from './tui/message-view.ts';
import {
  navigationItems,
  navigationLabels,
  type NavigationItem,
  type NavigationKind,
} from './tui/navigation.ts';
import { mountTaskInspector } from './tui/task-inspector.ts';
import { mountTeamBar } from './tui/team-bar.ts';
import { fitCells, paneNumber, paneRole, paneState, projectName } from './tui/workspace-chrome.ts';
import type { PaneState, WorkspaceController } from './workspace.ts';

export function mountWorkspaceUI(renderer: CliRenderer, workspace: WorkspaceController, exit: () => void) {
  const page = new BoxRenderable(renderer, { width: '100%', height: '100%', flexDirection: 'column' });
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
  heading.add(new BoxRenderable(renderer, { height: 1, flexShrink: 0 }));
  const tabs = new Map<string, TextRenderable>();
  const overflow = new TextRenderable(renderer, { height: 1, selectable: false, content: '' });
  navigationBar.add(overflow);
  const body = new BoxRenderable(renderer, { flexGrow: 1, position: 'relative' });
  const footer = new TextRenderable(renderer, { height: 1, content: '', wrapMode: 'none', truncate: true });
  let commandMode = false,
    commandPane = workspace.focused;
  let commandSession: string | undefined;
  let navigation: { kind: NavigationKind; role?: string } | undefined;
  let permissionMenu: { pane: string; session?: string; selected: number } | undefined;
  let paneMenuTarget: { id: string; session?: string } | undefined;
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
    const target = paneMenuTarget;
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
    paneMenuTarget = undefined;
    paneMenu.box.visible = false;
    refresh();
  }
  function openPaneMenu(id: string, x: number, y: number) {
    closeCommands();
    permissionMenu = undefined;
    inspector.releaseFocus();
    paneMenuTarget = { id, session: workspace.panes.get(id)?.controller?.id };
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
  let modalSubmitUntil = 0;
  const modePicker = new TextRenderable(renderer, {
    height: 6,
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
      if (commandMode) refreshHeader();
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
  type View = {
    box: BoxRenderable;
    title: TextRenderable;
    close: TextRenderable;
    scroll: ScrollBoxRenderable;
    text: TextRenderable;
    messages: ReturnType<typeof mountMessages>;
    jump: TextRenderable;
    columns: number;
    unread: boolean;
    seenRevision: number;
    seenLive: string;
    pendingBanner?: string;
    revealPending: boolean;
    overlayText?: string;
    revealOverlay: boolean;
    notice: TextRenderable;
    sharedInfo: TextRenderable;
    sharedExpanded?: boolean;
    receiptClock?: ReceiptClock;
    meta: TextRenderable;
    status: TextRenderable;
    commands: ReturnType<typeof mountCommandList>;
    suppressedQuery?: string;
    input: TextareaRenderable;
    interaction: ReturnType<typeof mountInteractionUI>;
    submit(): void;
    binding?: string;
    initializedScroll: boolean;
    lastText: string;
    transient: boolean;
    followAfterSubmit: boolean;
    heldSelection?: { start: number; end: number; cursor: number };
  };
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
  let brandSession = '',
    brandWasBusy = false,
    brandDoneUntil = 0,
    brandPaint = '';
  function paintBrand() {
    if (disposed || !headerLogo.visible) return;
    const controller = workspace.current.controller,
      ui = workspace.launch.appConfig.ui,
      colors = palette(ui);
    const session = controller?.id ?? workspace.focused;
    if (session !== brandSession) {
      brandSession = session;
      brandWasBusy = false;
      brandDoneUntil = 0;
    }
    if (
      brandWasBusy &&
      !controller?.busy &&
      !controller?.pending &&
      !controller?.lastError &&
      controller?.notice === '本轮已完成'
    )
      brandDoneUntil = Date.now() + 1800;
    brandWasBusy = Boolean(controller?.busy);
    const state: AggregateState =
      workspace.current.error || controller?.lastError
        ? 'error'
        : controller?.pending
          ? 'tool'
          : controller?.busy
            ? controller.activity.tools.length
              ? 'tool'
              : 'thinking'
            : Date.now() < brandDoneUntil
              ? 'done'
              : 'idle';
    const monochrome = process.env.NO_COLOR !== undefined || process.env.TERM === 'dumb';
    const tick =
      ui.reducedMotion || monochrome || process.env.EMERGENCE_REDUCED_MOTION === '1'
        ? 0
        : Math.floor(Date.now() / 140) % 20;
    const signature = `${state}:${tick}:${colors.background}:${monochrome}`;
    if (signature === brandPaint) return;
    brandPaint = signature;
    aggregate.paint(state, tick, colors.background, monochrome);
  }
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
  const teamBar = mountTeamBar(
    renderer,
    workspace,
    () => inspector.openOverview(),
    () => openNavigation(workspace.focused, 'approvals'),
  );
  heading.add(teamBar.box);
  function closeCommands() {
    navigation = undefined;
    commandMode = false;
    commandInput.blur();
    commandInput.visible = false;
    commandList.box.visible = false;
  }
  function runCommand(value: string) {
    const id = commandPane,
      session = commandSession;
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
        if (!commandMode && workspace.focused === id && workspace.panes.get(id)?.controller?.id === session) {
          commandMode = true;
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
    permissionMenu = undefined;
    commandPane = id;
    commandSession = controller.id;
    navigation = { kind };
    workspace.overlay = '';
    workspace.taskPanel = false;
    commandMode = true;
    commandInput.setText(query);
    commandInput.visible = true;
    refresh();
    commandInput.focus();
  }
  function chooseNavigation(item: NavigationItem) {
    const state = navigation,
      pane = workspace.panes.get(commandPane);
    if (
      !state ||
      workspace.focused !== commandPane ||
      pane?.controller?.id !== commandSession ||
      (pane?.controller?.pending && state.kind !== 'approvals')
    ) {
      closeCommands();
      refresh();
      return;
    }
    const current = navigationItems(workspace, commandPane, state.kind).find(
      (entry) => entry.value === item.value,
    );
    if (!current) {
      refreshHeader();
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
    modalSubmitUntil = performance.now() + 350;
    const view = views.get(commandPane);
    if (state.kind === 'history') {
      const text = item.value;
      closeCommands();
      if (view) {
        view.input.replaceText(text);
        view.input.gotoBufferEnd();
        workspace.updateView(commandPane, text, savedScroll(commandPane, view.scroll));
      }
      workspace.notice = '已回填历史，检查后再发送';
      refresh();
      return;
    }
    runCommand(state.kind === 'models' ? '/model ' + item.value : '/task show ' + item.value);
  }
  function chooseCommand(item: CommandItem, view?: View) {
    if (navigation && !view) {
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
      const controller = workspace.panes.get(view ? workspace.focused : commandPane)?.controller;
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
    if (navigation) {
      refreshHeader();
      if (commandList.selected) chooseNavigation(commandList.selected as NavigationItem);
      return;
    }
    const value = commandInput.plainText.trim(),
      ui = workspace.launch.appConfig.ui;
    commandList.update(
      value,
      workspaceCommands(workspace, commandPane),
      palette(ui),
      ui.language === 'en',
      renderer.height < 28 ? 2 : 4,
    );
    const selected = commandList.selected;
    const exact = workspaceCommands(workspace, commandPane).find((item) => item.command === value);
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
  function renderComposer(pane: PaneState, view: View) {
    const ui = workspace.launch.appConfig.ui,
      en = ui.language === 'en',
      colors = palette(ui),
      controller = pane.controller;
    sizeEditor(view.input, view.box.height || renderer.height - 7);
    view.status.fg = activityColor(
      ui,
      Boolean(controller?.busy || controller?.pending || controller?.lastError),
    );
    view.status.content = composerStatus(controller, en, pane.error, ui);
    renderNotice(pane, view);
    const query = view.input.plainText;
    view.commands.box.visible =
      pane.id === workspace.focused &&
      !commandMode &&
      !permissionMenu &&
      !paneMenuTarget &&
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
  function paneFooter(pane: PaneState, width: number, en: boolean) {
    const usage = pane.controller?.tokenUsage()?.label(en) ?? 'Tokens —';
    const path = safeError(pane.controller?.cwd ?? pane.cwd);
    return sessionFooter(path, usage, width);
  }
  function renderNotice(pane: PaneState, view: View) {
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
    view.notice.content = safeError(info.persistent);
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
    view.status.content = info.receipt || composerStatus(controller, en, pane.error, ui);
    if (controller?.pending || controller?.lastError || pane.error) view.status.fg = colors.foreground;
    else if (info.receipt) view.status.fg = colors.muted;
  }
  const renderPane = (pane: PaneState, view: View) => {
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
      commandMode ||
      permissionMenu ||
      paneMenuTarget ||
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
        !commandMode &&
        !permissionMenu &&
        !paneMenuTarget &&
        !inspecting,
      colors,
      en,
    );
    view.input.visible = !controller?.pending;
    if (
      !controller?.pending &&
      !commandMode &&
      !permissionMenu &&
      !paneMenuTarget &&
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
    const role = paneRole(workspace, pane.id, en);
    const model = controller?.model ?? workspace.launch.appConfig.models.find((m) => m.id === pane.modelId);
    const actualModel = model ? `${model.provider}/${model.model}` : pane.modelId;
    const metaWidth = Math.max(10, view.columns - (en ? 5 : 4));
    const modelWidth = Math.min(stringWidth(actualModel), Math.max(12, Math.floor(metaWidth * 0.65)));
    view.title.content = safeError(
      `${active ? '›' : ' '} ${paneNumber(workspace, pane.id)} ${role} · ${paneState(pane, en)} · ${controller ? permissionLabels[controller.permissionMode] + (controller.permissionTransitioning ? '…' : '') : ''}\n` +
        fitCells(actualModel, modelWidth) +
        ' · ' +
        fitCells(controller?.cwd ?? pane.cwd, Math.max(1, metaWidth - modelWidth - 3), true),
    );
    view.box.bottomTitle =
      active && workspace.collaboration.current(pane.id)
        ? fitCells(workspace.collaboration.current(pane.id)!.id, Math.max(8, view.columns - 3))
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
          ? safeError(controller.pending.title)
          : '');
    view.text.visible = Boolean(text);
    if (view.lastText !== text) {
      view.text.content = text;
      view.lastText = text;
    }
    view.meta.visible = !single && ui.statusBar.visible;
    view.meta.fg = colors.muted;
    view.meta.content = paneFooter(pane, view.columns - 2, en);
    renderComposer(pane, view);
    // The live editor owns its contents. Only a new session binding or explicit submit/error changes it.
  };
  const createView = (pane: PaneState): View => {
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
          openPaneMenu(pane.id, event.x, event.y);
          return;
        }
        if (paneMenuTarget) closePaneMenu();
        inspector.releaseFocus();
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
        if (event.button === 0) void workspace.closePane(pane.id).catch((reason) => error(pane.id, reason));
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
        if (event.button === 0 || event.button === 2) openPaneMenu(pane.id, event.x, event.y);
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
      inspector.releaseFocus();
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
          renderNotice(pane, view);
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
      if (view) chooseCommand(item, view);
      refreshHeader();
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
      workspace.updateView(pane.id, '', savedScroll(pane.id, scroll));
      input.setText('');
      void workspace.send(pane.id, value).catch((reason) => {
        if (
          !disposed &&
          views.get(pane.id)?.input === input &&
          !input.plainText &&
          workspace.panes.get(pane.id)?.controller?.id === sessionId
        ) {
          workspace.updateView(pane.id, draft, savedScroll(pane.id, scroll));
          input.setText(workspace.panes.get(pane.id)?.draft ?? '');
          input.cursorOffset = cursor;
          if (selection) input.setSelection(selection.start, selection.end);
        }
        error(pane.id, reason);
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
        workspace.updateView(pane.id, input.plainText, savedScroll(pane.id, scroll));
        if (input.plainText.length > 100000) input.setText(workspace.panes.get(pane.id)?.draft ?? '');
        const view = views.get(pane.id);
        if (view) {
          if (view.suppressedQuery !== input.plainText) view.suppressedQuery = undefined;
          renderComposer(workspace.panes.get(pane.id)!, view);
          refreshHeader();
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
      (reason) => error(pane.id, reason),
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
  const refreshHeader = () => {
    const ui = workspace.launch.appConfig.ui,
      en = ui.language === 'en',
      colors = palette(ui);
    modePicker.visible = Boolean(permissionMenu);
    modePicker.fg = colors.foreground;
    if (permissionMenu)
      modePicker.content =
        `窗口 ${permissionMenu.pane} · 执行权限 · ↑↓ 选择 / Enter 确认 / Esc 返回\n` +
        permissionModes
          .map(
            (mode, i) =>
              `${permissionMenu!.selected === i ? '›' : ' '} ${permissionLabels[mode]} (${mode}) — ${['只读分析，禁止命令和派发', '副作用操作需确认', '项目内编辑自动，命令需确认', '按显式规则自动执行，未知操作需确认'][i]}`,
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
    commandList.box.visible = commandMode;
    if (commandMode) {
      const query = commandInput.plainText.trim(),
        commands = navigation
          ? navigationItems(workspace, commandPane, navigation.kind)
          : workspaceCommands(workspace, commandPane);
      const withArgs =
        !navigation && query.startsWith('/') && commands.some((item) => query.startsWith(item.command + ' '));
      commandList.box.visible = !withArgs;
      commandList.update(
        query,
        commands,
        colors,
        en,
        renderer.height < 28 ? 2 : 4,
        navigation ? navigationLabels[navigation.kind][en ? 1 : 0] : '',
      );
    }
    const panes = [...workspace.panes.values()];
    const cooperation = workspace.collaboration.state;
    const mode =
      cooperation.mode === 'collaborate'
        ? en
          ? `Collaborate${cooperation.paused ? ' (paused)' : ''}`
          : `协作模式${cooperation.paused ? '（派发暂停）' : ''}`
        : en
          ? 'Independent'
          : '独立模式';

    const running = panes.filter((pane) => pane.controller?.busy).length,
      pending = workspace.interactions.list().length;
    const counts = `${panes.length} ${en ? 'sessions' : '会话'} · ${running} ${en ? 'running' : '运行'} · ${pending} ${en ? 'approval' : '待确认'}`;
    const compact =
      renderer.width < 60
        ? `${panes.length} ${en ? 'sessions' : '会话'}${pending ? ` · ◇${pending}` : running ? ` · ●${running}` : ''}`
        : en
          ? counts
          : `${cooperation.mode === 'collaborate' ? (cooperation.paused ? '协作·暂停' : '协作') : '独立'}  ${counts}`;
    const brand = headerBrandLayout(renderer.width, renderer.height);
    // Keep the three-line identity on capable layouts, even when graphics are unavailable.
    const logoColumns = aggregate.supported() ? brand.columns : 0;
    const taskLabel = `[${en ? 'Tasks' : '任务'} ${cooperation.tasks.length}]`;
    const headerColumns = Math.max(
      1,
      renderer.width - stringWidth(taskLabel) - (logoColumns ? logoColumns + 2 : 0),
    );
    const shortCounts =
      stringWidth(counts) <= headerColumns
        ? counts
        : `${panes.length} ${en ? 'sessions' : '会话'} · ●${running} · ◇${pending}`;
    heading.height = brand.height + (teamBar.sync() ? 1 : 0);
    headline.height = brand.rows;
    headerLogo.visible = logoColumns > 0;
    headerLogo.width = logoColumns;
    headerLogo.height = brand.rows;
    paintBrand();
    header.height = brand.rows;
    const maximized = workspace.maximized ? (en ? ' · Maximized' : ' · 最大化') : '';
    header.content = brand.columns
      ? new StyledText([
          fg(colors.accent)(bold('\n'.repeat(Math.max(0, Math.floor((brand.rows - 3) / 2))) + 'Emergence')),
          fg(colors.muted)(`\n${fitCells(mode + maximized, headerColumns)}\n${shortCounts}`),
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
      const name = `${active ? '›' : ' '} ${paneNumber(workspace, pane.id)} ${paneRole(workspace, pane.id, en)} · ${projectName(pane.cwd)}`;
      const label = fitCells(name, Math.max(5, available - stringWidth(status + suffix))) + status + suffix;
      tab.content = label;
      tab.width = Math.max(1, Math.min(available, stringWidth(label)));
      tab.fg = active ? colors.accent : colors.muted;
      tab.bg = active ? colors.input : colors.background;
      tab.attributes = active ? TextAttributes.BOLD : 0;
    }
    const single = workspace.visible().length === 1;
    footer.visible = single && ui.statusBar.visible;
    footer.height = footer.visible ? 1 : 0;
    footer.content = paneFooter(workspace.current, renderer.width, en);
    const currentView = views.get(workspace.focused);
    if (currentView) renderNotice(workspace.current, currentView);
  };
  const refresh = () => {
    if (disposed || refreshing) return;
    if (
      navigation &&
      (workspace.focused !== commandPane ||
        workspace.panes.get(commandPane)?.controller?.id !== commandSession ||
        (workspace.panes.get(commandPane)?.controller?.pending && navigation.kind !== 'approvals'))
    )
      closeCommands();
    refreshing = true;
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
        renderPane(workspace.panes.get(id)!, view);
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
      refreshHeader();
    } finally {
      refreshing = false;
    }
  };
  const sessionChanged = (id: string) => {
    if (
      navigation &&
      navigation.kind !== 'approvals' &&
      id === commandPane &&
      workspace.panes.get(id)?.controller?.pending
    ) {
      closeCommands();
      refresh();
    }
    const pane = workspace.panes.get(id),
      view = views.get(id);
    if (pane && view) renderPane(pane, view);
    if (inspector.opened) inspector.sync(Math.max(1, body.width), Math.max(1, body.height));
    refreshHeader();
  };
  const frame = () => {
    if (disposed) return;
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
      view.jump.content = view.unread
        ? en
          ? '↓ New content · /view latest'
          : '↓ 有新内容 · /view latest'
        : en
          ? '↓ Back to latest · /view latest'
          : '↓ 回到最新 · /view latest';
      workspace.updateView(id, view.input.plainText, view.scroll.scrollTop);
    }
    // Initial layout sizes are zero before the first layout frame.
    if (body.width > 0 && (body.width !== measuredWidth || body.height !== measuredHeight)) refresh();
  };
  const keypress = (key: KeyEvent) => {
    if (paneMenuTarget) {
      key.preventDefault();
      key.stopPropagation();
      if (key.name === 'escape' || (key.ctrl && key.name === 'c')) closePaneMenu();
      else if (key.name === 'up' || key.name === 'down' || key.name === 'tab')
        paneMenu.move(key.name === 'up' || key.shift ? -1 : 1);
      else if (key.name === 'return' && !key.repeated && key.eventType !== 'repeat') {
        const target = paneMenuTarget,
          selected = paneMenu.selected;
        closePaneMenu();
        if (selected)
          void applyPaneAction(target, selected.command).catch((reason) => error(target.id, reason));
      }
      return;
    }
    const id = workspace.focused;
    const run = (promise: Promise<unknown>) => {
      void promise.catch((reason) => error(id, reason));
    };
    const view = views.get(id),
      controller = workspace.current.controller;
    if (permissionMenu) {
      key.preventDefault();
      key.stopPropagation();
      if (key.eventType === 'repeat' || key.repeated) return;
      if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        permissionMenu = undefined;
        modalSubmitUntil = performance.now() + 350;
      } else if (key.name === 'up' || key.name === 'down')
        permissionMenu.selected = (permissionMenu.selected + (key.name === 'up' ? 3 : 1)) % 4;
      else if (key.name === 'return') {
        const menu = permissionMenu;
        permissionMenu = undefined;
        modalSubmitUntil = performance.now() + 350;
        const target = workspace.panes.get(menu.pane)?.controller;
        if (target?.id === menu.session) target?.setPermissionMode(permissionModes[menu.selected]);
      }
      refresh();
      return;
    }
    if (key.name === 'return' && performance.now() < modalSubmitUntil) {
      key.preventDefault();
      key.stopPropagation();
      return;
    }
    if (!key.ctrl && !key.meta && (key.name.length === 1 || key.name === 'space')) modalSubmitUntil = 0;
    if (!(key.ctrl && key.name === 'c')) terminal.reset();
    if (commandMode) {
      if (key.ctrl && key.name === 'p' && navigation) {
        key.preventDefault();
        key.stopPropagation();
        navigation = undefined;
        commandInput.setText('');
        refreshHeader();
        commandInput.focus();
        return;
      }
      if (
        navigation &&
        (workspace.focused !== commandPane ||
          workspace.panes.get(commandPane)?.controller?.id !== commandSession ||
          (workspace.panes.get(commandPane)?.controller?.pending && navigation.kind !== 'approvals'))
      ) {
        key.preventDefault();
        key.stopPropagation();
        closeCommands();
        refresh();
        return;
      }
      if (navigation?.kind === 'tasks' && key.name === 'right') {
        key.preventDefault();
        key.stopPropagation();
        const item = commandList.selected as NavigationItem | undefined;
        if (item) runCommand('/task focus ' + item.value);
        return;
      }
      if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        key.preventDefault();
        key.stopPropagation();
        closeCommands();
        refresh();
      } else if (commandList.box.visible && ['up', 'down'].includes(key.name)) {
        key.preventDefault();
        key.stopPropagation();
        commandList.move(key.name === 'up' ? -1 : 1);
      } else if (!navigation && commandList.box.visible && key.name === 'tab' && !key.ctrl && !key.shift) {
        key.preventDefault();
        key.stopPropagation();
        const item = commandList.selected;
        if (item) {
          commandInput.replaceText(item.command + (item.usage ? ' ' : ''));
          commandInput.gotoBufferEnd();
          refreshHeader();
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
      openNavigation(id, 'history');
      return;
    }
    if (key.ctrl && key.name === 'p') {
      key.preventDefault();
      key.stopPropagation();
      navigation = undefined;
      commandMode = true;
      commandPane = id;
      commandSession = controller?.id;
      commandInput.setText('');
      commandInput.visible = true;
      refresh();
      commandInput.focus();
      return;
    }
    if (
      inspector.opened &&
      (inspector.focused || inspector.fullscreen) &&
      key.ctrl &&
      key.name === 'c' &&
      terminal.copy()
    ) {
      key.preventDefault();
      key.stopPropagation();
      return;
    }
    if (inspector.handleKey(key)) return;
    if (key.ctrl && key.name === 'c') {
      key.preventDefault();
      key.stopPropagation();
      if (key.eventType === 'repeat' || key.repeated) return;
      if (terminal.copy(view?.interaction.editing ? view.interaction.answer : view?.input)) return;
      if (workspace.overlay) {
        terminal.reset();
        workspace.overlay = '';
        workspace.taskPanel = false;
        workspace.changed();
        return;
      }
      if (controller?.pending) {
        terminal.reset();
        const request = controller.pending;
        workspace.interactions.respond(workspace.interactions.reference(id, request), { action: 'cancel' });
        return;
      }
      if (view?.input.plainText) {
        terminal.reset();
        view.input.setText('');
        workspace.updateView(id, '', savedScroll(id, view.scroll));
        return;
      }
      if (controller?.busy || workspace.collaboration.current(id)) {
        terminal.reset();
        run(workspace.cancelFocused());
        return;
      }
      terminal.confirmExit(key);
      return;
    }
    if (!workspace.overlay && view?.interaction.handleKey(key)) return;
    if (view?.commands.box.visible && !key.ctrl && !key.shift && !key.meta) {
      if (key.name === 'escape') {
        key.preventDefault();
        key.stopPropagation();
        view.suppressedQuery = view.input.plainText;
        renderComposer(workspace.current, view);
        refreshHeader();
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
          renderComposer(workspace.current, view);
        }
        return;
      }
      if (key.name === 'return') {
        key.preventDefault();
        key.stopPropagation();
        renderComposer(workspace.current, view);
        const item = view.commands.selected;
        if (key.eventType !== 'repeat' && !key.repeated && item) chooseCommand(item, view);
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
    const action = keyAction(workspace.launch.appConfig.ui, key);
    if (!action) return;
    key.preventDefault();
    if (action === 'cyclePermission') {
      key.stopPropagation();
      if (key.eventType !== 'repeat' && !key.repeated) controller?.cyclePermission();
      return;
    }
    if (action === 'next' || action === 'previous') {
      workspace.cycle(action === 'next' ? 1 : -1);
      return;
    }
    if (action === 'splitRight' || action === 'splitDown') {
      run(workspace.split(action === 'splitRight' ? 'row' : 'column'));
      return;
    }
    if (action === 'maximize') {
      workspace.maximized = !workspace.maximized;
      workspace.changed();
      return;
    }
    if (action === 'close') {
      run(workspace.closePane(id));
      return;
    }
    if (action === 'hide') {
      try {
        workspace.hide();
      } catch (reason) {
        error(id, reason);
      }
      return;
    }
    if (action.startsWith('resize')) {
      workspace.resizeFocused(
        ['resizeLeft', 'resizeRight'].includes(action) ? 'row' : 'column',
        ['resizeLeft', 'resizeUp'].includes(action) ? -0.05 : 0.05,
      );
      return;
    }
    if (action === 'tasks') {
      if (!controller?.pending) openNavigation(id, 'tasks');
      return;
    }
    if (action === 'escape') {
      if (workspace.overlay) {
        workspace.overlay = '';
        workspace.taskPanel = false;
        workspace.changed();
      } else if (workspace.current.controller) run(workspace.cancelFocused());
      return;
    }
    if (action === 'pageUp' || action === 'pageDown')
      views.get(id)?.scroll.scrollBy(action === 'pageUp' ? -8 : 8);
  };
  const paste = (event: PasteEvent) => {
    if (permissionMenu || paneMenuTarget) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (!commandMode && inspector.opened && (inspector.focused || inspector.fullscreen)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    modalSubmitUntil = 0;
    const view = views.get(workspace.focused);
    if (!workspace.current.controller?.pending) view?.interaction.releaseSubmitGuard();
    if (
      !commandMode &&
      workspace.current.controller?.pending &&
      (!view?.interaction.editing || workspace.overlay)
    ) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  const openPermissionMenu = (pane: string) => {
    const controller = workspace.panes.get(pane)?.controller;
    if (!controller) return;
    navigation = undefined;
    permissionMenu = {
      pane,
      session: controller.id,
      selected: permissionModes.indexOf(controller.permissionMode),
    };
    commandMode = false;
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
  workspace.on('session-change', sessionChanged);
  workspace.on('exit', exit);
  renderer.on('resize', refresh);
  renderer.on('frame', frame);
  renderer.keyInput.on('keypress', keypress);
  renderer.keyInput.on('paste', paste);
  const statusTimer = setInterval(() => {
    if (disposed) return;
    for (const [id, view] of views) {
      const pane = workspace.panes.get(id);
      if (pane && view.box.visible) {
        if (pane.controller?.busy || pane.controller?.pending) renderComposer(pane, view);
        else renderNotice(pane, view);
      }
    }
  }, 1000);
  const brandTimer = setInterval(() => {
    if (
      headerLogo.visible !==
      (aggregate.supported() && headerBrandLayout(renderer.width, renderer.height).columns > 0)
    )
      refresh();
    paintBrand();
  }, 140);
  refresh();
  return {
    views,
    dividers,
    commandInput,
    commandList,
    paneMenu,
    inspector,
    teamBar,
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
      clearInterval(statusTimer);
      clearInterval(brandTimer);
      for (const [id, view] of views)
        workspace.updateView(id, view.input.plainText, savedScroll(id, view.scroll));
      workspace.off('change', refresh);
      workspace.off('session-change', sessionChanged);
      workspace.off('exit', exit);
      workspace.off('navigation', openNavigation);
      workspace.off('task-inspect', inspectTask);
      workspace.off('permission-menu', openPermissionMenu);
      workspace.off('message-view-command', messageViewCommand);
      renderer.off('resize', refresh);
      renderer.off('frame', frame);
      renderer.keyInput.off('keypress', keypress);
      renderer.keyInput.off('paste', paste);
      terminal.dispose();
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
