import { BoxRenderable, TextAttributes, TextRenderable, type CliRenderer } from '@opentui/core';
import { safeError } from '../../core/adapters/redaction.ts';
import type { Palette } from '../../core/domain/ui-preferences.ts';
import { filterCommands, type CommandItem } from '../commands.ts';

export function mountCommandList(renderer: CliRenderer, accept: (item: CommandItem) => void) {
  const box = new BoxRenderable(renderer, { visible: false, flexDirection: 'column', flexShrink: 0 });
  const caption = new TextRenderable(renderer, {
    height: 1,
    wrapMode: 'none',
    truncate: true,
    selectable: false,
  });
  box.add(caption);
  const rows: TextRenderable[] = [];
  let items: CommandItem[] = [],
    selected = 0,
    query = '',
    signature = '',
    capacity = 4;
  let colors: Palette,
    english = false,
    label = '';
  function paint() {
    caption.fg = colors.muted;
    caption.content = items.length
      ? `${label || (english ? 'Commands' : '命令')}  ${selected + 1}/${items.length} · ↑↓ · Tab · Enter · Esc`
      : english
        ? 'No matches · Esc close'
        : '没有匹配项 · Esc 关闭';
    const start = Math.max(0, Math.min(selected - Math.floor(capacity / 2), items.length - capacity));
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i],
        item = items[start + i];
      row.visible = i < capacity && Boolean(item);
      if (!item) continue;
      const active = selected === start + i;
      row.content = safeError(
        `${active ? '›' : ' '} ${item.command}  ${item.description.replace(/\s+/g, ' ')}${item.shortcut ? ' · ' + item.shortcut : ''}${item.usage ? '  ' + item.usage : ''}`,
      );
      row.fg = active ? colors.accent : colors.muted;
      row.bg = active ? colors.input : colors.background;
      row.attributes = active ? TextAttributes.BOLD : 0;
      row.onMouseDown = (event) => {
        if (event.button === 0) {
          event.preventDefault();
          event.stopPropagation();
          selected = start + i;
          accept(item);
        }
      };
    }
  }
  return {
    box,
    get selected() {
      return items[selected];
    },
    update(
      value: string,
      commands: readonly CommandItem[],
      palette: Palette,
      en: boolean,
      availableRows = 4,
      title = '',
    ) {
      label = title;
      colors = palette;
      english = en;
      capacity = Math.max(1, Math.min(5, availableRows));
      const next = commands.map((item) => item.command).join('\n');
      if (query !== value || signature !== next) {
        query = value;
        signature = next;
        selected = 0;
      }
      items = filterCommands(commands, value);
      selected = Math.min(selected, Math.max(0, items.length - 1));
      while (rows.length < capacity) {
        const row = new TextRenderable(renderer, {
          height: 1,
          wrapMode: 'none',
          truncate: true,
          selectable: false,
        });
        rows.push(row);
        box.add(row);
      }
      paint();
    },
    move(delta: number) {
      if (items.length) selected = (selected + delta + items.length) % items.length;
      paint();
    },
    resetSelection() {
      selected = 0;
      paint();
    },
  };
}
