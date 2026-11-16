import {
  BoxRenderable,
  MarkdownRenderable,
  RGBA,
  StyledText,
  SyntaxStyle,
  TextAttributes,
  TextRenderable,
  TextTableRenderable,
  type CliRenderer,
  type Renderable,
  type TextChunk,
} from '@opentui/core';
import { Lexer, type Token, type Tokens } from 'marked';
import stringWidth from 'string-width';
import type { Palette } from '../../core/domain/ui-preferences.ts';
import { headingStyle } from './typography.ts';

function entities(text: string) {
  return text.replace(/&(?:amp|lt|gt|quot|apos|#39|#x[\da-f]+|#\d+);/gi, (entity) => {
    const named: Record<string, string> = {
      '&amp;': '&',
      '&lt;': '<',
      '&gt;': '>',
      '&quot;': '"',
      '&apos;': "'",
      '&#39;': "'",
    };
    if (named[entity]) return named[entity];
    const point =
      entity[2]?.toLowerCase() === 'x'
        ? parseInt(entity.slice(3, -1), 16)
        : parseInt(entity.slice(2, -1), 10);
    // Character references must not reintroduce terminal controls after sanitization.
    return point >= 32 &&
      !(point >= 127 && point <= 159) &&
      point <= 0x10ffff &&
      !(point >= 0xd800 && point <= 0xdfff)
      ? String.fromCodePoint(point)
      : entity;
  });
}
function chunk(text: string, colors: Palette, attributes = 0, extra: Partial<TextChunk> = {}): TextChunk {
  return { __isChunk: true, text, fg: RGBA.fromHex(colors.foreground), attributes, ...extra };
}
export function inlineText(tokens: readonly Token[], colors: Palette, attributes = 0): TextChunk[] {
  return tokens.flatMap((token) => {
    switch (token.type) {
      case 'strong':
        return inlineText((token as Tokens.Strong).tokens, colors, attributes | TextAttributes.BOLD);
      case 'em':
        return inlineText((token as Tokens.Em).tokens, colors, attributes | TextAttributes.ITALIC);
      case 'del':
        return inlineText((token as Tokens.Del).tokens, colors, attributes | TextAttributes.STRIKETHROUGH);
      case 'codespan':
        return [
          chunk((token as Tokens.Codespan).text, colors, attributes, { bg: RGBA.fromHex(colors.input) }),
        ];
      case 'link': {
        const link = token as Tokens.Link;
        const contents = inlineText(link.tokens, colors, attributes | TextAttributes.UNDERLINE);
        if (/^https?:\/\//i.test(link.href) && !/[\x00-\x20\x7f]/.test(link.href))
          for (const value of contents) value.link = { url: link.href };
        return contents;
      }
      case 'image':
        return [chunk(`[图片 ${'text' in token ? token.text : ''}]`, colors, attributes)];
      case 'br':
        return [chunk('\n', colors, attributes)];
      case 'text': {
        const value = token as Tokens.Text;
        return value.tokens
          ? inlineText(value.tokens, colors, attributes)
          : [chunk(entities(value.text), colors, attributes)];
      }
      default:
        return [chunk(entities('text' in token ? String(token.text) : token.raw), colors, attributes)];
    }
  });
}

/** Conservative, synchronous highlighting: every original code character stays intact. */
function codeText(text: string, language: string, colors: Palette) {
  if (['diff', 'patch'].includes(language))
    return new StyledText(
      text
        .split('\n')
        .flatMap((line, index, rows) => [
          chunk(
            line + (index < rows.length - 1 ? '\n' : ''),
            colors,
            /^[+-]/.test(line) ? TextAttributes.BOLD : 0,
            /^[+-]/.test(line) ? { fg: RGBA.fromHex(colors.accent) } : {},
          ),
        ]),
    );
  if (
    !/^(?:js|jsx|ts|tsx|javascript|typescript|json|py|python|sh|bash|powershell|ps1|sql|yaml|yml)$/.test(
      language,
    )
  )
    return text;
  const pattern =
    /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/[^\n]*|#[^\n]*|\b(?:const|let|var|function|return|class|import|from|export|async|await|if|else|for|while|def|print|True|False|None|true|false|null|select|SELECT|where|WHERE)\b|\b\d+(?:\.\d+)?\b)/g;
  const chunks: TextChunk[] = [];
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index! > cursor) chunks.push(chunk(text.slice(cursor, match.index), colors));
    const value = match[0],
      comment = /^(?:\/\/|#)/.test(value),
      quoted = /^["'`]/.test(value);
    chunks.push(
      chunk(
        value,
        colors,
        comment || quoted || /^\d/.test(value) ? 0 : TextAttributes.BOLD,
        comment ? { fg: RGBA.fromHex(colors.muted) } : {},
      ),
    );
    cursor = match.index! + value.length;
  }
  if (cursor < text.length) chunks.push(chunk(text.slice(cursor), colors));
  return new StyledText(chunks);
}

function nodeRenderer(renderer: CliRenderer, colors: Palette, columns: number) {
  const text = (content: string | StyledText) =>
    new TextRenderable(renderer, {
      content,
      width: '100%',
      fg: colors.foreground,
      wrapMode: 'word',
      flexShrink: 0,
    });
  const container = () =>
    new BoxRenderable(renderer, { width: '100%', flexDirection: 'column', flexShrink: 0 });
  const render = (token: Token, depth = 0): Renderable => {
    if (depth > 12) return text(token.raw); // Bound maliciously deep nesting in display only.
    if (token.type === 'space') return new BoxRenderable(renderer, { height: 1, flexShrink: 0 });
    if (token.type === 'heading') {
      const heading = token as Tokens.Heading,
        style = headingStyle(heading.depth, columns);
      const box = container();
      box.paddingLeft = style.indent;
      const titleColors = { ...colors, foreground: heading.depth <= 2 ? colors.accent : colors.foreground };
      box.add(
        text(new StyledText(inlineText(heading.tokens, titleColors, style.bold ? TextAttributes.BOLD : 0))),
      );
      if (style.underlineRule)
        box.add(
          new TextRenderable(renderer, {
            height: 1,
            flexShrink: 0,
            selectable: false,
            content: '─'.repeat(Math.max(1, Math.min(24, columns - 2, stringWidth(heading.text)))),
            fg: colors.border,
          }),
        );
      return box;
    }
    if (token.type === 'paragraph' || token.type === 'text') {
      const value = token as Tokens.Paragraph;
      return text(new StyledText(inlineText(value.tokens ?? Lexer.lexInline(value.text), colors)));
    }
    if (token.type === 'code') {
      const code = token as Tokens.Code,
        box = container();
      box.backgroundColor = colors.input;
      box.paddingLeft = box.paddingRight = 1;
      const language = (code.lang ?? 'text').split(/\s/)[0].slice(0, 40).toLowerCase() || 'text';
      box.add(new TextRenderable(renderer, { height: 1, content: language, fg: colors.muted }));
      box.add(
        new TextRenderable(renderer, {
          width: '100%',
          content: codeText(code.text, language, colors),
          fg: colors.foreground,
          wrapMode: 'char',
          flexShrink: 0,
        }),
      );
      return box;
    }
    if (token.type === 'blockquote') {
      const box = container();
      box.border = ['left'];
      box.borderColor = colors.muted;
      box.backgroundColor = colors.input;
      box.paddingLeft = 1;
      box.paddingRight = 1;
      for (const child of (token as Tokens.Blockquote).tokens) box.add(render(child, depth + 1));
      return box;
    }
    if (token.type === 'list') {
      const list = token as Tokens.List,
        box = container();
      list.items.forEach((item, index) => {
        const row = new BoxRenderable(renderer, { width: '100%', flexDirection: 'row', flexShrink: 0 });
        const marker = item.task
          ? item.checked
            ? '[x]'
            : '[ ]'
          : list.ordered
            ? `${Number(list.start) + index}.`
            : '•';
        row.add(
          new TextRenderable(renderer, { content: marker, width: stringWidth(marker) + 1, fg: colors.muted }),
        );
        const body = new BoxRenderable(renderer, {
          flexDirection: 'column',
          flexGrow: 1,
          flexShrink: 1,
          minWidth: 0,
        });
        for (const child of item.tokens) body.add(render(child, depth + 1));
        row.add(body);
        box.add(row);
      });
      return box;
    }
    if (token.type === 'table') {
      const table = token as Tokens.Table;
      if (columns < Math.max(48, table.header.length * 14)) {
        const box = container();
        for (const row of table.rows) {
          const record = container();
          record.marginBottom = 1;
          row.forEach((cell, index) =>
            record.add(
              text(
                new StyledText([
                  ...inlineText(table.header[index]?.tokens ?? [], colors, TextAttributes.BOLD),
                  chunk('  ', colors),
                  ...inlineText(cell.tokens, colors),
                ]),
              ),
            ),
          );
          box.add(record);
        }
        return box;
      }
      return new TextTableRenderable(renderer, {
        width: '100%',
        columnWidthMode: 'full',
        columnFitter: 'balanced',
        wrapMode: 'word',
        showBorders: false,
        cellPaddingX: 1,
        cellPaddingY: 0,
        fg: colors.foreground,
        selectable: true,
        content: [
          table.header.map((cell) => inlineText(cell.tokens, colors, TextAttributes.BOLD)),
          ...table.rows.map((row) => row.map((cell) => inlineText(cell.tokens, colors))),
        ],
      });
    }
    if (token.type === 'hr')
      return new TextRenderable(renderer, {
        width: '100%',
        height: 1,
        content: '─'.repeat(Math.max(1, Math.min(72, columns))),
        fg: colors.border,
      });
    // HTML is literal terminal text. No HTML execution or parser download is involved.
    return text('text' in token ? String(token.text) : token.raw);
  };
  return (token: Token) => {
    const block = container();
    if (token.type === 'space') {
      block.height = 0;
      return block;
    }
    block.add(render(token));
    const after = token.type === 'heading' ? headingStyle((token as Tokens.Heading).depth, columns).after : 1;
    if (after) block.add(new BoxRenderable(renderer, { height: after, flexShrink: 0 }));
    return block;
  };
}

export function richText(
  renderer: CliRenderer,
  content: string,
  colors: Palette,
  columns: number,
  streaming = false,
) {
  const style = SyntaxStyle.fromStyles({ default: { fg: colors.foreground } }, renderer.nativeScene);
  const markdown = new MarkdownRenderable(renderer, {
    width: '100%',
    flexShrink: 0,
    content,
    syntaxStyle: style,
    conceal: true,
    concealCode: false,
    streaming,
    internalBlockMode: 'top-level',
    renderNode: nodeRenderer(renderer, colors, columns),
  });
  let appearance = JSON.stringify([colors, columns]);
  return {
    markdown,
    update(value: string, nextColors: Palette, width: number, live: boolean) {
      const next = JSON.stringify([nextColors, width]);
      if (appearance !== next) {
        appearance = next;
        markdown.renderNode = nodeRenderer(renderer, nextColors, width);
      }
      if (markdown.streaming !== live) markdown.streaming = live;
      if (markdown.content !== value) markdown.content = value;
    },
    dispose() {
      markdown.destroyRecursively();
      style.destroy();
    },
  };
}
