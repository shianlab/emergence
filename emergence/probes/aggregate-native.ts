import { BoxRenderable, createCliRenderer, TextRenderable } from '@opentui/core';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createAggregateImage } from '../src/app/tui/aggregate-image.ts';
const renderer = await createCliRenderer({ exitOnCtrlC: true, useMouse: false });
renderer.setBackgroundColor('#111111');
const page = new BoxRenderable(renderer, {
  width: '100%',
  height: '100%',
  flexDirection: 'column',
  backgroundColor: '#111111',
  padding: 1,
});
const heading = new BoxRenderable(renderer, { height: 3, flexShrink: 0, flexDirection: 'row' });
const brand = createAggregateImage(renderer);
heading.add(brand.image);
heading.add(
  new TextRenderable(renderer, {
    content: 'Emergence\n独立模式\n1 会话 · 0 运行 · 0 待确认',
    height: 3,
    fg: '#eeeeec',
  }),
);
page.add(heading);
page.add(
  new TextRenderable(renderer, {
    content: '\n› 1 会话 · 涌现TUI\n\n智谱 GLM · Coding/glm-5.3-flash\n',
    height: 5,
    fg: '#aaaaaa',
  }),
);
page.add(
  new TextRenderable(renderer, {
    content: ' 你\n 请检查聚合标记在终端里的形状与比例。',
    height: 3,
    bg: '#333333',
    fg: '#aaaaaa',
  }),
);
page.add(
  new TextRenderable(renderer, {
    content: '\n── 涌现 · 回答\n\n圆形轮廓使用原生终端图形显示。\n主体保持不动，右上圆点轻微浮动。',
    height: 7,
    fg: '#eeeeec',
  }),
);
const status = new TextRenderable(renderer, { content: '', height: 2, fg: '#888888' });
page.add(status);
renderer.root.add(page);
let step = 0;
const timer = setInterval(() => {
  brand.image.visible = brand.supported();
  if (brand.image.visible) brand.paint('thinking', step++ % 20, '#111111', false);
  status.content = `协议：${brand.image.effectiveProtocol}  尺寸：8 列 × 3 行\n此窗口仅用于图形验收，不连接模型。`;
  writeFileSync(
    resolve('../artifacts/brand/aggregate-native-report.json'),
    JSON.stringify(
      {
        protocol: brand.image.effectiveProtocol,
        capabilities: renderer.capabilities,
        resolution: renderer.resolution,
        width: renderer.width,
        height: renderer.height,
        image: brand.image.image?.info(),
        error: String(brand.image.loadError ?? ''),
      },
      null,
      2,
    ),
  );
}, 140);
setTimeout(() => {
  clearInterval(timer);
  renderer.destroy();
}, 90000);
