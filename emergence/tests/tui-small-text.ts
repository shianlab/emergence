import assert from 'node:assert/strict';
import { BoxRenderable, TextRenderable } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { setTimeout as delay } from 'node:timers/promises';
import { SmallText, SmallTextService, smallTextFitsSixel } from '../src/app/tui/small-text.ts';

const test = await createTestRenderer({ width: 80, height: 25 });
const service = new SmallTextService(test.renderer);
const box = new BoxRenderable(test.renderer, { width: '100%', height: '100%', flexDirection: 'column' });
test.renderer.root.add(box);
const body = new TextRenderable(test.renderer, { content: '正文保持原生文字', height: 1 });
let clicks = 0;
const label = new SmallText(
  test.renderer,
  {
    content: '共享项目 · 另有 1 个会话',
    fg: '#a3a3a3',
    width: '100%',
    height: 1,
    onMouseDown(event) {
      if (event.button === 0) clicks++;
    },
  },
  service,
);
box.add(body);
box.add(label);
const previous = process.env.EMERGENCE_NATIVE_TEXT;
const previousColor = process.env.NO_COLOR,
  previousTerm = process.env.TERM;
delete process.env.EMERGENCE_NATIVE_TEXT;
delete process.env.NO_COLOR;
process.env.TERM = 'xterm-256color';
const sync = async () => {
  await test.renderOnce();
  service.sync('#111111');
  await test.renderOnce();
};
async function ready() {
  // Wait past the raster worker's own 10s deadline, including on cold Windows runners.
  const deadline = performance.now() + 12_000;
  while (performance.now() < deadline) {
    await sync();
    if (label.image.visible) return;
    await delay(40);
  }
  throw new Error(
    'Small text did not load: ' +
      JSON.stringify({
        width: label.width,
        height: label.height,
        visible: label.visible,
        parent: box.visible,
        root: box.parent?.visible,
        protocol: label.image.effectiveProtocol,
        wanted: label.wanted,
        env: [process.env.NO_COLOR, process.env.TERM],
        terminal: [test.renderer.terminalWidth, test.renderer.terminalHeight],
      }),
  );
}
try {
  for (const cell of [14, 20, 24, 28, 30]) {
    assert.equal(smallTextFitsSixel(24, cell, cell, 25), false, 'bottom row is never a safe sixel target');
    assert.equal(smallTextFitsSixel(23, cell, cell, 25), true, 'one guard row contains final band/cursor');
  }
  await sync();
  assert.equal(label.text.visible, true);
  assert.equal(label.image.visible, false);
  // Only the test capability projection is mocked; rasterization and image decoding are real.
  let resolution = { width: 800, height: 500 };
  Object.defineProperty(test.renderer, 'resolution', { configurable: true, get: () => resolution });
  label.image.protocol = 'kitty';
  await ready();
  assert.equal(label.image.image!.width, 800);
  assert.equal(label.image.image!.height, 20);
  assert.equal(label.text.visible, false);
  assert.equal(body.visible, true);
  await test.mockMouse.click(label.x + 1, label.y);
  assert.equal(clicks, 1, 'small graphic keeps the shared-details click target');
  const image = label.image.image;
  await sync();
  assert.equal(label.image.image, image, 'unchanged labels reuse their image');
  label.content = '旧内容';
  await sync();
  label.content = '新内容 Tokens 3,248';
  assert.equal(label.text.visible, true, 'old image hides immediately');
  await ready();
  assert.ok(label.wanted.includes('新内容'));
  assert.equal(label.chunks.map((chunk) => chunk.text).join(''), '新内容 Tokens 3,248');
  label.width = 40;
  resolution = { width: 1200, height: 750 };
  await ready();
  assert.equal(label.image.image!.width, 600);
  assert.equal(label.image.image!.height, 30);
  label.small = false;
  label.content = '◇ 等待确认';
  await sync();
  assert.equal(label.text.visible, true);
  assert.equal(label.image.visible, false);
  label.small = true;
  label.height = 'auto';
  label.content = '共享详情\n原生文字可以复制';
  await sync();
  assert.equal(label.text.visible, true);
  label.height = 1;
  label.content = 'Tokens —';
  await ready();
  process.env.EMERGENCE_NATIVE_TEXT = '1';
  await sync();
  assert.equal(label.image.visible, false);
  assert.equal(label.text.visible, true);
  delete process.env.EMERGENCE_NATIVE_TEXT;
  // Exercise the actual service with Sixel at the bottom edge, not just its math.
  label.image.protocol = 'sixel';
  label.position = 'absolute';
  label.top = 24;
  await sync();
  assert.equal(label.y, 24);
  assert.equal(label.image.visible, false, 'last-row Sixel falls back before rasterization');
  assert.equal(label.text.visible, true);
  label.top = 23;
  await ready();
  assert.equal(label.image.visible, true, 'Sixel is retained when a guard row is available');
  test.resize(80, 24);
  resolution = { width: 1200, height: 720 };
  await sync();
  assert.equal(label.image.visible, false, 'shrinking terminal invalidates the old image');
  assert.equal(label.text.visible, true);
  label.content = '关闭前的迟到请求';
  await sync();
  label.destroyRecursively();
  service.dispose();
  service.dispose();
  await delay(100);
  assert.equal(service.labels.size, 0);
  console.log(
    'Small text: real raster, reuse, stale response, resize, urgent/expanded fallback, native opt-out and disposal passed.',
  );
} finally {
  service.dispose();
  await test.dispose();
  if (previous === undefined) delete process.env.EMERGENCE_NATIVE_TEXT;
  else process.env.EMERGENCE_NATIVE_TEXT = previous;
  if (previousColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = previousColor;
  if (previousTerm === undefined) delete process.env.TERM;
  else process.env.TERM = previousTerm;
}
