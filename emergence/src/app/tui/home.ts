import {
  BoxRenderable,
  StyledText,
  TextRenderable,
  TextareaRenderable,
  fg,
  type CliRenderer,
  type KeyEvent,
} from '@opentui/core';
import stringWidth from 'string-width';
import { safeError } from '../../core/adapters/redaction.ts';
import { palette } from '../../core/domain/ui-preferences.ts';
import { commandHelp, homeCommands, normalizeHelp, slashSuggestions, type CommandItem } from '../commands.ts';
import type { LaunchConfig } from '../controller.ts';
import { diagnose, formatDiagnosis } from '../doctor.ts';
import { modelConfigurationIntent } from '../model-configuration.ts';
import { terminalActions } from '../terminal-actions.ts';
import { VERSION } from '../version.ts';
import { mountCommandList } from './command-list.ts';
import { sizeEditor } from './composer.ts';
import { englishWordmark, homeLogo, smallHomeLogo, tinyHomeLogo } from './home-logo-data.ts';
import { gitBranch, homeLayout } from './home-state.ts';

function fit(text: string, width: number) {
  if (stringWidth(text) <= width) return text;
  let result = '';
  for (const { segment } of new Intl.Segmenter('zh-CN', { granularity: 'grapheme' }).segment(text)) {
    if (stringWidth(result + segment) > Math.max(0, width - 1)) break;
    result += segment;
  }
  return result + '…';
}

export interface HomeSession {
  id: string;
  cwd: string;
}
export interface HomeRequest {
  kind: 'new' | 'continue' | 'resume';
  modelId: string;
  prompt?: string;
  sessionId?: string;
}
export interface HomeActions {
  open(request: HomeRequest): Promise<void>;
  sessions(): Promise<readonly HomeSession[]>;
  exit(): void;
  modelConfiguration?(): Promise<void>;
}

export function mountHome(renderer: CliRenderer, launch: LaunchConfig, saved: boolean, actions: HomeActions) {
  let helpContent: string | undefined;
  const colors = palette(launch.appConfig.ui),
    en = launch.appConfig.ui.language === 'en';
  const page = new BoxRenderable(renderer, {
    width: '100%',
    height: '100%',
    flexDirection: 'column',
    paddingLeft: 2,
    paddingRight: 2,
    backgroundColor: colors.background,
  });
  const above = new BoxRenderable(renderer, { height: 2, flexShrink: 0 });
  const hero = new BoxRenderable(renderer, {
    flexDirection: 'column',
    alignItems: 'center',
    alignSelf: 'center',
    flexShrink: 0,
  });
  const logo = new TextRenderable(renderer, {
    width: 56,
    height: 11,
    content: '',
    wrapMode: 'none',
    textAlign: 'center',
  });
  const wordmarkGap = new BoxRenderable(renderer, { height: 1, flexShrink: 0 });
  const wordmark = new TextRenderable(renderer, { width: 38, height: 3, content: '', wrapMode: 'none' });
  const infoGap = new BoxRenderable(renderer, { height: 1, flexShrink: 0 });
  const info = new TextRenderable(renderer, {
    content: '',
    fg: colors.muted,
    textAlign: 'center',
    wrapMode: 'none',
  });
  [logo, wordmarkGap, wordmark, infoGap, info].forEach((child) => hero.add(child));
  const notice = new TextRenderable(renderer, {
    height: 2,
    fg: colors.muted,
    content: '',
    alignSelf: 'center',
  });
  const composer = new BoxRenderable(renderer, {
    flexDirection: 'column',
    height: 3,
    alignSelf: 'center',
    flexShrink: 0,
    backgroundColor: colors.input,
  });
  const statusGap = new BoxRenderable(renderer, { height: 1, flexShrink: 0 });
  const hintGap = new BoxRenderable(renderer, { height: 1, flexShrink: 0 });
  const linkGap = new BoxRenderable(renderer, { height: 1, flexShrink: 0 });
  const exitGap = new BoxRenderable(renderer, { height: 1, flexShrink: 0 });
  let disposed = false,
    opening = false,
    modelId = launch.modelId,
    branch = '',
    lastLaunchModelId = launch.modelId;
  let menu: 'models' | 'sessions' | 'help' | undefined,
    selection = 0,
    history: readonly HomeSession[] = [];
  let suppressedQuery: string | undefined,
    helpPage = 0,
    submitGuard = 0;
  const availableCommands = homeCommands(en, saved);
  let menuPage = 0;
  let animationFinished =
    launch.appConfig.ui.reducedMotion ||
    process.env.NO_COLOR !== undefined ||
    process.env.TERM === 'dumb' ||
    process.env.EMERGENCE_REDUCED_MOTION === '1';
  const started = performance.now(),
    abort = new AbortController();
  let animation: ReturnType<typeof setInterval> | undefined;
  let measured = '';
  const finishAnimation = () => {
    animationFinished = true;
    clearInterval(animation);
    animation = undefined;
  };
  const modelLine = new TextRenderable(renderer, {
    height: 1,
    content: '',
    fg: colors.muted,
    alignSelf: 'center',
    wrapMode: 'none',
    truncate: true,
  });
  const input = new TextareaRenderable(renderer, {
    height: 3,
    initialValue: '',
    backgroundColor: colors.input,
    focusedBackgroundColor: colors.input,
    textColor: colors.foreground,
    focusedTextColor: colors.foreground,
    placeholderColor: colors.muted,
    placeholder: en ? 'Describe your task…' : '描述你要完成的工作…',
    keyBindings: [
      { name: 'return', action: 'submit' },
      { name: 'return', shift: true, action: 'newline' },
      { name: 'a', ctrl: true, action: 'select-all' },
    ],
    onContentChange() {
      finishAnimation();
      if (input.plainText !== suppressedQuery) suppressedQuery = undefined;
      if (input.plainText.length > 100000)
        input.setText(input.plainText.slice(0, 100000).replace(/[\uD800-\uDBFF]$/, ''));
      refresh();
    },
    onSubmit() {
      void submit(input.plainText).catch(showError);
    },
  });
  composer.add(input);
  const commands = mountCommandList(renderer, (item) => chooseCommand(item));
  function chooseCommand(item: CommandItem, complete = false) {
    if (opening || menu) return;
    const needsArgs = Boolean(item.usage && !item.usage.startsWith('['));
    const value = item.command + (item.usage && (needsArgs || complete) ? ' ' : '');
    input.setText(value);
    input.gotoBufferEnd();
    suppressedQuery = value;
    if (!complete && !needsArgs) {
      submitGuard = performance.now() + 350;
      void submit(item.command).catch(showError);
    }
    refresh();
  }
  const hints = new TextRenderable(renderer, {
    height: 1,
    fg: colors.muted,
    wrapMode: 'none',
    truncate: true,
    alignSelf: 'center',
    content: en ? 'Enter send · Shift+Enter newline · /help' : 'Enter 发送 · Shift+Enter 换行 · /help 帮助',
  });
  const links = new BoxRenderable(renderer, {
    height: 1,
    flexDirection: 'row',
    gap: 2,
    alignSelf: 'center',
    justifyContent: 'center',
  });
  const choices = [
    { command: '/continue', label: '继续工作台', en: 'Continue workspace' },
    { command: '/sessions', label: '历史', en: 'History' },
    { command: '/model', label: '模型', en: 'Model' },
    { command: '/model-config', label: '模型配置', en: 'Configure' },
    { command: '/help', label: '帮助', en: 'Help' },
  ].map((choice) => {
    const button = new TextRenderable(renderer, {
      content: '',
      height: 1,
      fg: colors.accent,
      selectable: false,
      onMouseDown(event) {
        if (event.button === 0 && !opening) {
          event.preventDefault();
          void submit(choice.command).catch(showError);
        }
      },
    });
    links.add(button);
    return { ...choice, button };
  });
  const exitHint = new TextRenderable(renderer, {
    height: 1,
    fg: colors.muted,
    alignSelf: 'center',
    textAlign: 'center',
    content: en ? 'Ctrl+C ×2 exit' : 'Ctrl+C 两次退出',
  });
  const below = new BoxRenderable(renderer, { flexGrow: 1, minHeight: 0 });
  [
    above,
    hero,
    notice,
    commands.box,
    composer,
    statusGap,
    modelLine,
    hintGap,
    hints,
    linkGap,
    links,
    exitGap,
    exitHint,
    below,
  ].forEach((child) => page.add(child));
  renderer.root.add(page);

  const showError = (reason: unknown) => {
    if (!disposed) {
      notice.content = safeError(reason);
      refresh();
    }
  };
  const choose = () => {
    if (menu === 'models') {
      modelId = launch.appConfig.models[selection]?.id ?? modelId;
      menu = undefined;
      notice.content = en ? 'Model selected for the next conversation' : '已选择下一会话的模型';
      input.focus();
      refresh();
    } else if (menu === 'sessions') {
      const session = history[selection];
      if (session) void open({ kind: 'resume', modelId, sessionId: session.id }).catch(showError);
    }
  };
  async function open(request: HomeRequest) {
    if (disposed || opening) return;
    opening = true;
    finishAnimation();
    input.blur();
    notice.content = en ? 'Opening workspace…' : '正在打开工作台…';
    refresh();
    try {
      await actions.open(request);
    } finally {
      if (!disposed) {
        opening = false;
        input.focus();
        refresh();
      }
    }
  }
  async function submit(raw: string) {
    if (disposed || opening) return;
    finishAnimation();
    const text = normalizeHelp(raw.trim());
    if (!text) return;
    if (menu) {
      choose();
      return;
    }
    if (text === '/exit') {
      actions.exit();
      return;
    }
    if (text === '/model-config' || modelConfigurationIntent(text)) {
      if (!actions.modelConfiguration)
        throw new Error('当前运行方式不支持配置窗口；请运行 emergence model-config');
      await actions.modelConfiguration();
      input.setText('');
      notice.content = '已打开模型配置窗口';
      refresh();
      return;
    }
    if (text === '/new') {
      await open({ kind: 'new', modelId });
      return;
    }
    if (text === '/help') {
      helpContent = undefined;
      menu = 'help';
      helpPage = 0;
      notice.content = '';
      input.blur();
      refresh();
      return;
    }
    if (text === '/doctor') {
      opening = true;
      notice.content = '正在检查运行环境…';
      try {
        const report = await diagnose(launch.home, launch.cwd);
        if (disposed) return;
        helpContent = safeError(formatDiagnosis(report));
        menu = 'help';
        helpPage = 0;
        input.setText('');
        input.blur();
        notice.content = '';
      } finally {
        opening = false;
        if (!disposed) refresh();
      }
      return;
    }
    if (/^\/model(?:\s|$)/.test(text)) {
      const id = text.slice(6).trim();
      if (id) {
        if (!launch.appConfig.models.some((m) => m.id === id))
          throw new Error('模型配置不存在；用 /model 查看');
        modelId = id;
        input.setText('');
        refresh();
        return;
      }
      menu = 'models';
      selection = Math.max(
        0,
        launch.appConfig.models.findIndex((m) => m.id === modelId),
      );
      input.setText('');
      input.blur();
      refresh();
      return;
    }
    if (text === '/sessions') {
      opening = true;
      input.blur();
      notice.content = '正在读取历史…';
      try {
        history = await actions.sessions();
        if (disposed) return;
        menu = 'sessions';
        selection = 0;
        input.setText('');
        notice.content = '';
      } finally {
        opening = false;
        if (!disposed) {
          if (menu) input.blur();
          else input.focus();
          refresh();
        }
      }
      return;
    }
    if (/^\/resume(?:\s|$)/.test(text)) {
      const id = text.slice(7).trim();
      if (!id) throw new Error('用法：/resume <会话ID>');
      await open({ kind: 'resume', modelId, sessionId: id });
      return;
    }
    if (text === '/continue') {
      if (!saved) throw new Error('当前项目还没有保存的工作台');
      await open({ kind: 'continue', modelId });
      return;
    }
    if (text.startsWith('/'))
      throw new Error(
        en
          ? 'Unknown home command. Type / to see available actions.'
          : '首页暂不支持这条命令。输入 / 查看可用操作；进入对话后可使用更多命令。',
      );
    await open({ kind: 'new', modelId, prompt: raw });
  }
  function refresh() {
    if (disposed) return;
    if (modelId === lastLaunchModelId) modelId = launch.modelId;
    lastLaunchModelId = launch.modelId;
    if (!launch.appConfig.models.some((m) => m.id === modelId)) modelId = launch.modelId;
    const width = renderer.width,
      height = renderer.height;
    const spec = homeLayout(width, height);
    commands.box.visible =
      !menu &&
      !opening &&
      input.plainText !== suppressedQuery &&
      slashSuggestions(input.plainText, availableCommands);
    commands.box.width = spec.contentWidth;
    commands.box.alignSelf = 'center';
    if (commands.box.visible)
      commands.update(input.plainText, availableCommands, colors, en, height < 24 ? 2 : 4);
    // Keep the accepted empty-home layout; consume spare space only while writing.
    const reserved =
      spec.topRows +
      spec.heroHeight +
      spec.noticeRows +
      spec.statusGap +
      1 +
      spec.hintGap +
      1 +
      spec.linkGap +
      1 +
      (spec.showExit ? 2 : 0);
    composer.height = sizeEditor(input, height, Math.max(3, Math.min(7, height - reserved)));
    page.paddingLeft = page.paddingRight = spec.padding;
    above.height = spec.topRows;
    hero.width = spec.contentWidth;
    for (const element of [notice, composer, modelLine, hints, links, exitHint])
      element.width = spec.contentWidth;
    notice.height = spec.noticeRows;
    statusGap.height = spec.statusGap;
    hintGap.height = spec.hintGap;
    linkGap.height = spec.linkGap;
    links.gap = width < 60 ? 1 : 2;
    exitHint.visible = exitGap.visible = spec.showExit;
    hints.content = spec.showExit
      ? en
        ? 'Enter send · Shift+Enter newline · /help'
        : 'Enter 发送 · Shift+Enter 换行 · /help 帮助'
      : en
        ? 'Enter send · Shift+Enter newline · Ctrl+C ×2 exit'
        : 'Enter 发送 · Shift+Enter 换行 · Ctrl+C 两次退出';
    const model = launch.appConfig.models.find((m) => m.id === modelId)!;
    modelLine.content = safeError(
      `${model.provider} / ${model.model}  ·  ${opening ? (en ? 'Opening' : '打开中') : en ? 'Ready' : '就绪'}`,
    );
    for (const choice of choices) {
      choice.button.visible = choice.command !== '/continue' || saved;
      const label = en
        ? width < 70 && choice.command === '/continue'
          ? 'Continue'
          : choice.en
        : choice.label;
      const text = width < 100 ? `[${label}]` : `${choice.command} ${label}`;
      choice.button.content = text;
      choice.button.width = stringWidth(text);
    }
    if (menu === 'help') {
      logo.visible = wordmarkGap.visible = wordmark.visible = infoGap.visible = false;
      const rows = Math.max(2, Math.min(18, height - 12));
      const lines = (helpContent ?? commandHelp(availableCommands, launch.appConfig.ui, true)).split('\n');
      helpPage = Math.max(0, Math.min(helpPage, Math.max(0, lines.length - rows)));
      info.textAlign = 'left';
      info.width = spec.contentWidth;
      info.height = rows + 1;
      hero.height = rows + 1;
      info.content =
        lines
          .slice(helpPage, helpPage + rows)
          .map((line) => fit(line, spec.contentWidth))
          .join('\n') + (en ? '\n↑↓ / PgUp/PgDn scroll · Esc back' : '\n↑↓ / PgUp/PgDn 翻页 · Esc 返回');
      return;
    }
    if (menu) {
      logo.visible = wordmarkGap.visible = wordmark.visible = infoGap.visible = false;
      info.textAlign = 'left';
      const rows = Math.max(2, Math.min(10, height - 12));
      menuPage = Math.floor(selection / rows) * rows;
      const entries =
        menu === 'models'
          ? launch.appConfig.models.map((m) => `${m.id} · ${m.provider}/${m.model}`)
          : history.map((s) => `${s.id} · ${s.cwd}`);
      const count = entries.length;
      info.content = safeError(
        `${menu === 'models' ? '选择模型' : '历史会话'}  ${count ? `${selection + 1}/${count}` : ''}\n` +
          (entries
            .slice(menuPage, menuPage + rows)
            .map((line, i) => `${menuPage + i === selection ? '›' : ' '} ${line}`)
            .join('\n') || '没有保存的会话') +
          '\n↑/↓ 选择 · Enter 确认 · Esc 返回',
      );
      info.width = spec.contentWidth;
      info.height = Math.min(rows, Math.max(1, count)) + 2;
      hero.height = info.height;
      return;
    }
    if (commands.box.visible) {
      logo.visible = wordmarkGap.visible = wordmark.visible = infoGap.visible = false;
      hero.height = 1;
      info.height = 1;
      info.width = spec.contentWidth;
      info.textAlign = 'center';
      info.content = en ? 'EMERGENCE · Find a command' : '涌现 · 选择你要进行的操作';
      return;
    }
    hero.height = spec.heroHeight;
    logo.visible = infoGap.visible = true;
    wordmarkGap.visible = wordmark.visible = spec.wordmark;
    const lines = (
      spec.logo === 'home'
        ? homeLogo
        : spec.logo === 'small'
          ? smallHomeLogo
          : spec.logo === 'tiny'
            ? tinyHomeLogo
            : '涌现 · Emergence'
    ).split('\n');
    logo.width =
      spec.logo === 'home' ? 56 : spec.logo === 'small' ? 48 : spec.logo === 'tiny' ? 40 : spec.contentWidth;
    logo.height = spec.logoHeight;
    info.width = spec.contentWidth;
    info.textAlign = 'center';
    const elapsed = animationFinished ? 1500 : performance.now() - started;
    if (elapsed >= 1500) finishAnimation();
    const shades = (rows: string[], offset = 0) =>
      new StyledText(
        rows.map((line, index) => {
          const progress = Math.max(0, Math.min(1, (elapsed - (index + offset) * 14) / 850));
          const backgroundShade = Math.round(
            (parseInt(colors.background.slice(1, 3), 16) +
              parseInt(colors.background.slice(3, 5), 16) +
              parseInt(colors.background.slice(5, 7), 16)) /
              3,
          );
          const base =
            backgroundShade >= 160
              ? 35 + Math.round(((index + offset) / (lines.length + 4)) * 50)
              : 238 - Math.round(((index + offset) / (lines.length + 4)) * 48);
          const shade = Math.round(backgroundShade + (base - backgroundShade) * progress);
          const color = `#${shade.toString(16).padStart(2, '0').repeat(3)}`;
          return fg(color)(line + (index < rows.length - 1 ? '\n' : ''));
        }),
      );
    logo.content = shades(lines);
    wordmark.content = shades(englishWordmark.split('\n'), lines.length + 1);
    const details = [
      en
        ? `Provider ${model.provider}  ·  Model ${model.model}`
        : `供应商 ${model.provider}  ·  模型 ${model.model}`,
      `${en ? 'Project' : '项目'} ${launch.cwd}`,
      `Git ${branch || (en ? 'No repository (optional)' : '未识别仓库，可正常使用')}  ·  ${en ? 'Independent session' : '独立会话'}`,
      `/capabilities ${en ? 'capabilities' : '能力'}  ·  v${VERSION}`,
    ];
    info.content = details
      .slice(0, spec.infoRows)
      .map((line) => fit(safeError(line), spec.contentWidth))
      .join('\n');
    info.height = spec.infoRows;
  }
  const terminal = terminalActions(
    renderer,
    (message) => {
      if (!disposed) {
        notice.content = message;
        refresh();
      }
    },
    actions.exit,
  );
  const keypress = (key: KeyEvent) => {
    if (
      key.name === 'return' &&
      (performance.now() < submitGuard || key.eventType === 'repeat' || key.repeated)
    ) {
      key.preventDefault();
      key.stopPropagation();
      return;
    }
    if (key.name.length === 1 && !key.ctrl && !key.meta) submitGuard = 0;
    if (!(key.ctrl && key.name === 'c')) terminal.reset();
    if (key.ctrl && key.name === 'c') {
      key.preventDefault();
      key.stopPropagation();
      if (key.eventType === 'repeat' || key.repeated) return;
      // Slow runtime activation must remain cancellable through the shared exit policy.
      if (opening) {
        terminal.confirmExit(key);
        return;
      }
      if (terminal.copy(input)) return;
      if (menu) {
        terminal.reset();
        menu = undefined;
        input.focus();
        refresh();
        return;
      }
      if (input.plainText) {
        terminal.reset();
        input.setText('');
        return;
      }
      terminal.confirmExit(key);
      return;
    }
    if (opening) return;
    if (!menu && commands.box.visible && !key.ctrl && !key.meta && !key.shift) {
      if (['escape', 'up', 'down', 'tab', 'return'].includes(key.name)) {
        key.preventDefault();
        key.stopPropagation();
        if (key.name === 'escape') {
          suppressedQuery = input.plainText;
          refresh();
        } else if (key.name === 'up' || key.name === 'down') commands.move(key.name === 'up' ? -1 : 1);
        else if (commands.selected) chooseCommand(commands.selected, key.name === 'tab');
        return;
      }
    }
    if (!menu) return;
    if (menu === 'help') {
      if (['escape', 'up', 'down', 'pageup', 'pagedown', 'return'].includes(key.name)) {
        key.preventDefault();
        key.stopPropagation();
      }
      if (key.name === 'escape') {
        menu = undefined;
        suppressedQuery = input.plainText;
        input.focus();
      } else if (['up', 'down', 'pageup', 'pagedown'].includes(key.name))
        helpPage += ({ up: -1, down: 1, pageup: -8, pagedown: 8 } as Record<string, number>)[key.name];
      refresh();
      return;
    }
    if (key.name === 'escape') {
      key.preventDefault();
      menu = undefined;
      input.focus();
      refresh();
    } else if (key.name === 'up' || key.name === 'down') {
      key.preventDefault();
      const count = menu === 'models' ? launch.appConfig.models.length : history.length;
      if (count) selection = (selection + (key.name === 'up' ? count - 1 : 1)) % count;
      refresh();
    } else if (key.name === 'return') {
      key.preventDefault();
      choose();
    }
  };
  const frame = () => {
    const dimensions = `${renderer.width}:${renderer.height}:${input.virtualLineCount}`;
    if (dimensions !== measured) {
      measured = dimensions;
      refresh();
    }
  };
  renderer.keyInput.on('keypress', keypress);
  renderer.on('resize', refresh);
  renderer.on('frame', frame);
  if (!animationFinished) animation = setInterval(refresh, 50);
  void gitBranch(launch.cwd, abort.signal).then((value) => {
    if (!disposed) {
      branch = value;
      refresh();
    }
  });
  refresh();
  input.focus();
  return {
    input,
    page,
    commands,
    refresh,
    get opening() {
      return opening;
    },
    submit,
    dispose() {
      if (disposed) return;
      disposed = true;
      terminal.dispose();
      clearInterval(animation);
      abort.abort();
      renderer.keyInput.off('keypress', keypress);
      renderer.off('resize', refresh);
      renderer.off('frame', frame);
      page.destroyRecursively();
    },
  };
}
