import {
  BoxRenderable,
  StyledText,
  TextAttributes,
  TextRenderable,
  bold,
  fg,
  type CliRenderer,
  type ScrollBoxRenderable,
} from '@opentui/core';
import { safeError } from '../../core/adapters/redaction.ts';
import type { Palette } from '../../core/domain/ui-preferences.ts';
import {
  intentSummary,
  toolSummary,
  type DisplayMessage,
  type MessageProjection,
  type TextMessage,
} from './message-model.ts';
import { richText } from './rich-text.ts';

interface Row {
  item: DisplayMessage;
  box: BoxRenderable;
  heading: TextRenderable;
  action: TextRenderable;
  body: BoxRenderable;
  more: TextRenderable;
  signature: string;
  raw: boolean;
  expanded?: boolean;
  budget: number;
  rich?: ReturnType<typeof richText>;
}
const pageSize = 16000;
/** Keep the message surface in the active theme, with a clearer step from the canvas. */
function userSurface(colors: Palette) {
  const channels = [1, 3, 5].map((offset) =>
    Math.round(
      parseInt(colors.input.slice(offset, offset + 2), 16) * 0.88 +
        parseInt(colors.foreground.slice(offset, offset + 2), 16) * 0.12,
    )
      .toString(16)
      .padStart(2, '0'),
  );
  return '#' + channels.join('');
}
export function mountMessages(renderer: CliRenderer, scroll: ScrollBoxRenderable, focus: () => void) {
  const box = new BoxRenderable(renderer, {
    width: '100%',
    flexDirection: 'column',
    flexShrink: 0,
    paddingLeft: 1,
    paddingRight: 1,
  });
  const history = new TextRenderable(renderer, { width: '100%', visible: false, content: '', fg: '#a3a3a3' });
  box.add(history);
  const rows = new Map<string, Row>();
  let showBackground = false,
    backgroundCount = 0;
  const backgroundToggle = new TextRenderable(renderer, {
    height: 1,
    visible: false,
    selectable: false,
    wrapMode: 'none',
    truncate: true,
    content: '',
    onMouseDown(event) {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      focus();
      showBackground = !showBackground;
      paintBackground();
    },
  });
  box.add(backgroundToggle);
  let session = '',
    colors: Palette,
    columns = 70,
    en = false,
    disposed = false;
  function paintBackground() {
    backgroundToggle.visible = backgroundCount > 0;
    backgroundToggle.fg = colors.muted;
    backgroundToggle.content = en
      ? `Background · ${backgroundCount} records · [${showBackground ? 'Hide' : 'Show'}]`
      : `背景资料 · ${backgroundCount} 条 · [${showBackground ? '收起' : '查看'}]`;
    for (const row of rows.values())
      row.box.visible = !(row.item.kind === 'context' && row.item.background) || showBackground;
  }
  const clearBody = (row: Row) => {
    row.rich?.dispose();
    row.rich = undefined;
    for (const child of row.body.getChildren()) child.destroyRecursively();
  };
  const render = (row: Row, streaming = false) => {
    const item = row.item,
      tool = item.kind === 'tool',
      collapsible = tool || item.kind === 'context';
    const intent = tool ? intentSummary(item) : undefined;
    const expanded = row.expanded ?? (tool && item.status === 'error');
    const signature = JSON.stringify([
      item.revision,
      row.raw,
      expanded,
      row.budget,
      colors,
      columns,
      en,
      streaming,
      item.kind === 'assistant' ? item.text : '',
    ]);
    if (row.signature === signature) return;
    const user = item.kind === 'user',
      assistant = item.kind === 'assistant';
    row.signature = signature;
    row.box.backgroundColor = user ? userSurface(colors) : colors.background;
    if (user) row.box.borderColor = colors.muted;
    row.box.border = user ? ['left'] : false;
    row.box.paddingLeft = user || collapsible ? 1 : 0;
    row.box.paddingRight = user ? 1 : 0;
    row.box.marginBottom = collapsible && !expanded ? 0 : 1;
    row.box.paddingTop = row.box.paddingBottom = user ? 1 : 0;
    row.heading.marginBottom = assistant ? 1 : 0;
    row.heading.attributes = 0;
    row.heading.fg = assistant
      ? colors.accent
      : tool && item.status === 'error'
        ? colors.warning
        : colors.muted;
    row.action.fg = colors.muted;
    row.more.fg = colors.muted;
    row.heading.content = tool
      ? `${item.status === 'running' ? '…' : item.status === 'error' ? '!' : '✓'} ${item.name} · ${item.status === 'running' ? (en ? 'Awaiting result' : '等待结果') : item.status === 'error' ? (en ? 'Failed' : '失败') : en ? 'Done' : '完成'}${item.exitCode === undefined ? '' : ` · exit ${item.exitCode}`} · #${item.seq}`
      : `${item.kind === 'user' ? (en ? 'You' : '你') : item.kind === 'context' ? (item.label ?? (en ? 'Context' : '上下文')) : en ? 'Emergence' : '涌现'} · ${streaming ? (en ? 'Writing' : '正在输出') : '#' + item.seq}${!tool && item.kind === 'assistant' && item.interrupted ? (en ? ' · Interrupted' : ' · 已中止') : ''}`;
    if (intent) row.heading.content = `✓ ${en ? 'Requirement understanding' : '需求理解'} · #${item.seq}`;
    if (user)
      row.heading.content = new StyledText([
        fg(colors.foreground)(bold(en ? 'You' : '你')),
        fg(colors.muted)(`  #${item.seq}`),
      ]);
    if (tool && item.status === 'error')
      row.heading.content = new StyledText([
        fg(colors.foreground)(bold(`! ${item.name} · ${en ? 'Failed' : '失败'}`)),
        fg(colors.muted)(`${item.exitCode === undefined ? '' : ` · exit ${item.exitCode}`}  #${item.seq}`),
      ]);
    if (assistant)
      row.heading.content = new StyledText([
        fg(colors.accent)(bold(en ? '── Emergence' : '── 涌现 · 回答')),
        fg(colors.muted)(
          `  ${streaming ? (en ? 'Writing' : '正在输出') : '#' + item.seq}${item.interrupted ? (en ? ' · Interrupted' : ' · 已中止') : ''}`,
        ),
      ]);
    row.action.content = collapsible
      ? expanded
        ? en
          ? '[Collapse]'
          : '[收起]'
        : en
          ? '[Details]'
          : '[展开]'
      : row.raw
        ? en
          ? '[Rendered]'
          : '[排版]'
        : en
          ? '[Source]'
          : '[原文]';
    row.action.visible = collapsible || item.kind === 'assistant';
    const raw = tool
      ? `${en ? 'Arguments' : '参数'}\n${item.arguments}${item.result ? `\n\n${en ? 'Output' : '输出'}\n${item.result}` : ''}${item.error ? `\n\n${item.error}` : ''}`
      : item.text;
    const text = raw.slice(0, row.budget).replace(/[\uD800-\uDBFF]$/, '');
    const canUseRich = item.kind === 'assistant' && !row.raw;
    if (canUseRich && row.rich) row.rich.update(text, colors, columns - 2, streaming);
    else {
      clearBody(row);
      if (canUseRich) {
        row.rich = richText(renderer, text, colors, columns - 2, streaming);
        row.body.add(row.rich.markdown);
      } else {
        const visible =
          intent && !expanded
            ? intent
            : tool && !expanded
              ? [
                  toolSummary(item),
                  item.status === 'running'
                    ? ''
                    : (item.result.split('\n').find((line) => line.trim()) ?? ''),
                ]
                  .filter(Boolean)
                  .join(' · ')
              : item.kind === 'context' && !expanded
                ? (item.summary ?? item.text.split('\n').find((line) => line.trim()) ?? '')
                : text;
        const bodyColor =
          tool && item.status === 'error'
            ? colors.foreground
            : assistant || expanded || intent
              ? colors.foreground
              : colors.muted;
        row.body.add(
          new TextRenderable(renderer, {
            width: '100%',
            content: visible || (tool ? '…' : ''),
            fg: bodyColor,
            wrapMode: 'word',
            flexShrink: 0,
          }),
        );
      }
    }
    row.more.visible = raw.length > row.budget && (!collapsible || expanded);
    row.more.content = en
      ? `[Show more · ${row.budget}/${raw.length} chars · full history retained]`
      : `[显示更多 · ${row.budget}/${raw.length} 字符 · 完整内容保留在历史中]`;
    if (collapsible && !expanded && !intent) {
      const preview = row.body.getChildren()[0];
      if (preview) preview.maxHeight = tool && item.status !== 'error' ? 1 : 2;
    }
  };
  const create = (item: DisplayMessage) => {
    const container = new BoxRenderable(renderer, {
      width: '100%',
      maxWidth: 112,
      flexDirection: 'column',
      flexShrink: 0,
      marginBottom: 1,
    });
    const bar = new BoxRenderable(renderer, {
      width: '100%',
      height: item.kind === 'assistant' ? 2 : 1,
      flexDirection: 'row',
      gap: 1,
    });
    const heading = new TextRenderable(renderer, {
      height: 1,
      flexGrow: 1,
      wrapMode: 'none',
      truncate: true,
      attributes: TextAttributes.BOLD,
    });
    let row: Row;
    const action = new TextRenderable(renderer, {
      content: '',
      height: 1,
      selectable: false,
      onMouseDown(event) {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        focus();
        if (row.item.kind === 'tool' || row.item.kind === 'context')
          row.expanded = !(row.expanded ?? (row.item.kind === 'tool' && row.item.status === 'error'));
        else row.raw = !row.raw;
        render(row, row.item.id.endsWith(':live'));
      },
    });
    bar.add(heading);
    bar.add(action);
    const body = new BoxRenderable(renderer, { width: '100%', flexDirection: 'column', flexShrink: 0 });
    const more = new TextRenderable(renderer, {
      visible: false,
      width: '100%',
      selectable: false,
      onMouseDown(event) {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        focus();
        row.budget += pageSize;
        render(row, row.item.id.endsWith(':live'));
      },
    });
    container.add(bar);
    container.add(body);
    container.add(more);
    box.add(container);
    row = { item, box: container, heading, action, body, more, signature: '', raw: false, budget: pageSize };
    rows.set(item.id, row);
    return row;
  };
  const clear = () => {
    for (const row of rows.values()) {
      clearBody(row);
      row.box.destroyRecursively();
    }
    rows.clear();
  };
  return {
    box,
    rows,
    backgroundToggle,
    update(
      projection: MessageProjection | undefined,
      live: string,
      nextColors: Palette,
      width: number,
      english: boolean,
    ) {
      if (disposed) return;
      const nextSession = projection?.sessionId ?? '';
      if (session !== nextSession) {
        clear();
        session = nextSession;
        showBackground = false;
      }
      colors = nextColors;
      columns = Math.max(12, Math.min(112, width));
      en = english;
      history.visible = Boolean(projection?.omitted);
      history.fg = colors.muted;
      history.content = en
        ? `${projection?.omitted} earlier entries · /context export <file> for full history`
        : `更早 ${projection?.omitted} 条记录 · /context export <文件> 导出完整历史`;
      const items: DisplayMessage[] = [...(projection?.items ?? [])];
      if (live)
        items.push({
          kind: 'assistant',
          id: `${session}:live`,
          seq: -1,
          time: 0,
          revision: 0,
          text: safeError(live),
        } satisfies TextMessage);
      const ids = new Set(items.map((item) => item.id));
      for (const [id, row] of rows)
        if (!ids.has(id)) {
          clearBody(row);
          row.box.destroyRecursively();
          rows.delete(id);
        }
      // A settled assistant can arrive before the live row disappears; keep durable event order.
      items.forEach((item) => {
        const row = rows.get(item.id) ?? create(item);
        row.item = item;
        render(row, item.id.endsWith(':live'));
      });
      backgroundCount = items.filter((item) => item.kind === 'context' && item.background).length;
      paintBackground();
    },
    command(action: string, sequence?: number) {
      if (action === 'context') {
        showBackground = !showBackground;
        paintBackground();
        return;
      }
      if (action === 'raw' || action === 'render') {
        const row = [...rows.values()].findLast(
          (value) =>
            value.item.kind === 'assistant' && (sequence === undefined || value.item.seq === sequence),
        );
        if (!row) throw new Error('没有对应的助手消息');
        row.raw = action === 'raw';
        render(row, row.item.id.endsWith(':live'));
        scroll.scrollChildIntoView(row.box.id);
      } else if (action === 'tools') {
        const tools = [...rows.values()].filter(
          (row) => row.item.kind === 'tool' && (sequence === undefined || row.item.seq === sequence),
        );
        const expand = tools.some(
          (row) => !(row.expanded ?? (row.item.kind === 'tool' && row.item.status === 'error')),
        );
        for (const row of tools) {
          row.expanded = expand;
          render(row);
        }
      } else if (action === 'more') {
        const row = [...rows.values()].findLast(
          (value) => sequence === undefined || value.item.seq === sequence,
        );
        if (!row) throw new Error('没有对应的消息');
        row.budget += pageSize;
        render(row, row.item.id.endsWith(':live'));
      } else throw new Error('用法：/view raw|render|tools|more [消息序号] 或 /view latest|context');
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clear();
      box.destroyRecursively();
    },
  };
}
