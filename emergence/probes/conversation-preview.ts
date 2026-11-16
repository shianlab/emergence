import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { BoxRenderable, rgbToHex, ScrollBoxRenderable, TextAttributes, TextRenderable } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MessageProjection } from '../src/app/tui/message-model.ts';
import { mountMessages } from '../src/app/tui/message-view.ts';
import { palettes } from '../src/core/domain/ui-preferences.ts';

const columns = 108,
  rows = 48,
  test = await createTestRenderer({ width: columns, height: rows });
const colors = palettes.dark;
const page = new BoxRenderable(test.renderer, {
  width: '100%',
  height: '100%',
  flexDirection: 'column',
  backgroundColor: colors.background,
});
page.add(
  new TextRenderable(test.renderer, {
    height: 1,
    content: '涌现 · Emergence   独立会话',
    fg: colors.accent,
    attributes: TextAttributes.BOLD,
  }),
);
page.add(
  new TextRenderable(test.renderer, {
    height: 2,
    content: 'M:\\涌现TUI  ·  deepseek/deepseek-flash',
    fg: colors.muted,
  }),
);
const scroll = new ScrollBoxRenderable(test.renderer, { flexGrow: 1, minHeight: 0, scrollY: true });
page.add(scroll);
const feed = mountMessages(test.renderer, scroll, () => {});
scroll.add(feed.box);
const message = `# 项目结构已梳理

**结果**：入口与会话模块已经分开，可以逐步优化界面。

## 建议调整

1. 保留现有会话和工具权限
2. 将展示职责分离
   - 用户消息保留原文
   - 助手回复按结构排版

\`\`\`ts
const view = createMessageView(session);
view.render({ content: "**字面量保持原样**" });
\`\`\`

| 模块 | 作用 |
| --- | --- |
| message-model | 读取结构化事件 |
| message-view | 显示消息与工具 |

> 原始 Markdown 和工具输出都保留，可随时查看。

下一步可以继续检查 \`src/app.ts\` 的调用关系。`;
const event = (type: string, seq: number, data: unknown) => ({ type, seq, time: 1, data }) as SessionEvent;
const projection = new MessageProjection('preview').load([
  event('user/message', 0, {
    source: { kind: 'user' },
    content: [{ type: 'text', text: '检查项目结构，并给出界面调整建议。' }],
  }),
  event('tool/call', 1, { callId: 'preview-read', name: 'read', arguments: '{"file_path":"src/app.ts"}' }),
  event('tool/result', 2, {
    message: { source: { callId: 'preview-read' }, content: [{ type: 'text', text: '已读取 src/app.ts' }] },
  }),
  event('assistant/message', 3, { message: { content: [{ type: 'text', text: message }] } }),
]);
page.add(
  new TextRenderable(test.renderer, {
    height: 2,
    content: '输入任务或 /help',
    fg: colors.muted,
    bg: colors.input,
  }),
);
page.add(
  new TextRenderable(test.renderer, {
    height: 1,
    content: 'Enter 发送 · Shift+Enter 换行 · /view raw 查看原文 · /view tools 展开工具',
    fg: colors.muted,
  }),
);
test.renderer.root.add(page);
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );
try {
  feed.update(projection, '', colors, columns - 4, false);
  await test.flush();
  const snapshot = test.captureSpans();
  const html = snapshot.lines
    .map(
      (line) =>
        '<div class="line">' +
        line.spans
          .map(
            (span) =>
              `<span style="width:${span.width}ch;color:${rgbToHex(span.fg)};background:${rgbToHex(span.bg)};${span.attributes & TextAttributes.BOLD ? 'font-weight:700;' : ''}${span.attributes & TextAttributes.ITALIC ? 'font-style:italic;' : ''}${span.attributes & TextAttributes.UNDERLINE ? 'text-decoration:underline;' : ''}">${escape(span.text)}</span>`,
          )
          .join('') +
        '</div>',
    )
    .join('\n');
  const dir = resolve('../artifacts/brand');
  await mkdir(dir, { recursive: true });
  await writeFile(
    resolve(dir, 'conversation-preview.html'),
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>涌现 · 第二阶段消息排版</title><style>
body{margin:0;background:#111;color:#dedede;font-family:"Cascadia Mono",Consolas,"Microsoft YaHei UI",monospace}main{width:max-content;min-width:100%;padding:24px;box-sizing:border-box}header{font:12px/1.6 system-ui,sans-serif;color:#888;max-width:1000px;margin:0 auto 24px;display:flex;justify-content:space-between}.terminal{width:${columns}ch;font-size:15px;line-height:18px;margin:auto}.line{height:18px;white-space:pre}span{display:inline-block;height:18px;vertical-align:top}
</style><main><header><div>涌现 / 第二阶段</div><div>实际消息组件 · 示例内容 · 静态终端帧</div></header><div class="terminal">${html}</div></main></html>`,
  );
  await writeFile(resolve('../artifacts/tui-phase2/preview.txt'), test.captureCharFrame());
} finally {
  feed.dispose();
  page.destroyRecursively();
  await test.dispose();
}
