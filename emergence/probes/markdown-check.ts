import { BoxRenderable, TextRenderable } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { richText } from '../src/app/tui/rich-text.ts';
import { palettes } from '../src/core/domain/ui-preferences.ts';
const test = await createTestRenderer({ width: 100, height: 50 });
const content =
  '# 结构化回复\n\n正文里的 **加粗内容** 和 `inline_code`。\n\n- 第一个要点\n- 第二个要点\n\n> 提醒：保留完整历史。\n\n```ts\nconst value = "**literal**";\nconsole.log(value);\n```\n\n| 名称 | 状态 |\n| --- | --- |\n| 首页 | 完成 |';
const page = new BoxRenderable(test.renderer, {
  width: '100%',
  height: '100%',
  flexDirection: 'column',
  backgroundColor: '#111111',
});
const rich = richText(test.renderer, content, palettes.dark, 100, true),
  markdown = rich.markdown;
page.add(markdown);
page.add(new TextRenderable(test.renderer, { content: 'END_MARKER', height: 1 }));
test.renderer.root.add(page);
try {
  await test.flush();
  const dir = resolve('../artifacts/tui-phase2');
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, 'markdown-probe.txt'), test.captureCharFrame());
  console.log(
    JSON.stringify({
      height: markdown.height,
      blocks: markdown.getChildren().length,
      frame: test.captureCharFrame().trimEnd(),
    }),
  );
} finally {
  rich.dispose();
  page.destroyRecursively();
  await test.dispose();
}
