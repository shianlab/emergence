import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { BoxRenderable, ScrollBoxRenderable, TextAttributes, TextRenderable, rgbToHex } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MessageProjection } from '../src/app/tui/message-model.ts';
import { mountMessages } from '../src/app/tui/message-view.ts';
import { palettes } from '../src/core/domain/ui-preferences.ts';

const columns = 104,
  rows = 34,
  colors = palettes.dark;
const test = await createTestRenderer({ width: columns, height: rows });
const page = new BoxRenderable(test.renderer, {
  width: '100%',
  height: '100%',
  flexDirection: 'column',
  backgroundColor: colors.background,
  paddingLeft: 1,
  paddingRight: 1,
});
page.add(
  new TextRenderable(test.renderer, {
    height: 1,
    content: '涌现 · Emergence',
    attributes: TextAttributes.BOLD,
    fg: colors.accent,
  }),
);
page.add(
  new TextRenderable(test.renderer, {
    height: 2,
    content: 'deepseek / deepseek-flash  ·  独立会话',
    fg: colors.muted,
  }),
);
const scroll = new ScrollBoxRenderable(test.renderer, { flexGrow: 1, minHeight: 0, scrollY: true });
page.add(scroll);
const feed = mountMessages(test.renderer, scroll, () => {});
scroll.add(feed.box);
const event = (type: string, seq: number, data: unknown) => ({ type, seq, time: 1, data }) as SessionEvent;
const projection = new MessageProjection('roles').load([
  event('user/message', 0, {
    source: { kind: 'user' },
    content: [{ type: 'text', text: '帮我梳理一下当前项目，重点看看界面哪里还需要优化。' }],
  }),
  event('assistant/message', 1, {
    message: {
      content: [
        {
          type: 'text',
          text: '## 项目已梳理\n\n入口、会话和工具模块已经分开，界面可以继续逐步打磨。\n\n- **阅读体验**：让不同发言更容易区分\n- **操作反馈**：保留当前状态和快捷提示',
        },
      ],
    },
  }),
  event('user/message', 2, {
    source: { kind: 'user' },
    content: [
      { type: 'text', text: '我的消息和你的回复，希望扫一眼就能分出来。\n继续保持现在的黑白灰风格。' },
    ],
  }),
  event('assistant/message', 3, {
    message: {
      content: [
        {
          type: 'text',
          text: '## 现在这样区分\n\n你的消息放在**独立的深灰块**中，用浅灰文字显示。\n我的回复使用更亮的灰白正文，保持原有的标题、列表与代码排版。',
        },
      ],
    },
  }),
]);
page.add(
  new TextRenderable(test.renderer, {
    height: 3,
    content: '继续输入任务…',
    fg: colors.muted,
    bg: colors.input,
  }),
);
page.add(
  new TextRenderable(test.renderer, {
    height: 1,
    content: 'Enter 发送 · Shift+Enter 换行 · Ctrl+P 命令',
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
              `<span style="width:${span.width}ch;color:${rgbToHex(span.fg)};background:${rgbToHex(span.bg)};${span.attributes & TextAttributes.BOLD ? 'font-weight:700;' : ''}">${escape(span.text)}</span>`,
          )
          .join('') +
        '</div>',
    )
    .join('\n');
  const directory = resolve('../artifacts/brand');
  await mkdir(directory, { recursive: true });
  await writeFile(
    resolve(directory, 'message-roles-preview.html'),
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>涌现 · 对话角色区分</title><style>
*{box-sizing:border-box}body{margin:0;background:#111;color:#dedede;font-family:"Cascadia Mono",Consolas,"Microsoft YaHei UI",monospace}main{padding:24px;width:max-content;min-width:100%}header{width:calc(100vw - 48px);max-width:1000px;margin-bottom:24px;font:12px/1.7 system-ui,sans-serif;color:#999;display:flex;flex-wrap:wrap;justify-content:space-between;gap:12px}.terminal{width:${columns}ch;font-size:15px;line-height:19px;margin:0 auto}.line{height:19px;white-space:pre}span{display:inline-block;height:19px;vertical-align:top}
</style><main><header><div>涌现 / 对话角色区分<br>实际消息组件 · 示例对话 · 静态预览</div><div>你：深灰消息块 / 浅灰文字<br>涌现：近黑背景 / 灰白正文</div></header><div class="terminal">${html}</div></main></html>`,
  );
  const user = feed.rows.get('roles:0')!,
    assistant = feed.rows.get('roles:1')!;
  console.log(
    JSON.stringify({
      userSurface: rgbToHex(user.box.backgroundColor),
      userText: rgbToHex((user.body.getChildren()[0] as TextRenderable).fg),
      assistantHeading: rgbToHex(assistant.heading.fg),
      assistantText: colors.foreground,
    }),
  );
} finally {
  feed.dispose();
  page.destroyRecursively();
  await test.dispose();
}
