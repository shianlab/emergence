/** Stage-one isolated fixture: no model calls, no production UI changes. */
import {
  BoxRenderable,
  TextRenderable,
  TextareaRenderable,
  ImageRenderable,
  TextAttributes,
  createCliRenderer,
} from '@opentui/core';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { createAggregateImage } from '../src/app/tui/aggregate-image.ts';

const directory = resolve('../artifacts/tui-typography-phase1');
await mkdir(directory, { recursive: true });
const renderer = await createCliRenderer({ exitOnCtrlC: true, useMouse: true });
renderer.setBackgroundColor('#111111');
const page = new BoxRenderable(renderer, {
  width: '100%',
  height: '100%',
  flexDirection: 'column',
  backgroundColor: '#111111',
  paddingLeft: 2,
  paddingRight: 2,
});
const line = (parent: BoxRenderable, text: string, height = 1, color = '#dddddd', strong = false) => {
  const item = new TextRenderable(renderer, {
    content: text,
    height,
    flexShrink: 0,
    fg: color,
    attributes: strong ? TextAttributes.BOLD : 0,
    wrapMode: 'none',
    truncate: true,
  });
  parent.add(item);
  return item;
};
const heading = new BoxRenderable(renderer, { height: 3, flexShrink: 0, flexDirection: 'row' });
const brand = createAggregateImage(renderer);
heading.add(brand.image);
line(heading, 'Emergence\n文字层级 · 第一阶段样张\n示例内容，不连接模型', 3);
page.add(heading);
line(page, '', 1);
const tabs = line(page, '', 1, '#eeeeee', true);
line(page, '› 1 会话 · 涌现TUI', 1, '#eeeeee', true);
const labels: { text: string; textNode: TextRenderable; image: ImageRenderable }[] = [];
function auxiliary(text: string) {
  const row = new BoxRenderable(renderer, { height: 1, width: '100%', flexShrink: 0 });
  const textNode = line(row, text, 1, '#a3a3a3');
  const image = new ImageRenderable(renderer, {
    width: '100%',
    height: 1,
    fit: 'fill',
    protocol: 'auto',
    visible: false,
  });
  row.add(image);
  page.add(row);
  labels.push({ text, textNode, image });
}
auxiliary('智谱 GLM · Coding/glm-5.3-flash');
line(page, '', 1);
const user = new BoxRenderable(renderer, {
  height: 3,
  flexShrink: 0,
  backgroundColor: '#333333',
  paddingLeft: 1,
});
line(user, '你', 1, '#aaaaaa', true);
line(user, '帮我梳理项目，并整理下一步要做的事情。', 1, '#cccccc');
page.add(user);
line(page, '', 1);
line(page, '── 涌现 · 回答', 1, '#eeeeee', true);
line(page, '', 1);
line(page, '我会先检查项目结构，再整理优先级。');
line(page, '', 1);
line(page, '接下来要做的事情', 1, '#eeeeee', true);
line(page, '  1. 核对已完成的功能\n  2. 整理需要验证的问题', 2);
const spacer = new BoxRenderable(renderer, { flexGrow: 1, minHeight: 1 });
page.add(spacer);
auxiliary('已提交 · 示例回执');
auxiliary('共享项目 · 另有 1 个会话');
const urgent = line(page, '', 1, '#eeeeee', true);
const input = new TextareaRenderable(renderer, {
  width: '100%',
  height: 3,
  flexShrink: 0,
  backgroundColor: '#1c1c1c',
  textColor: '#dddddd',
  placeholder: '输入区可试打字；不会发送给模型',
});
page.add(input);
auxiliary('M:\\涌现TUI   ·   Tokens 3,248（示例）');
const explanation = line(page, '', 1, '#aaaaaa');
line(page, 'F1 标准文字  F2 小字试验  F3 紧急提示  F4 原生文本回退  Esc 退出', 1, '#aaaaaa');
renderer.root.add(page);
input.focus();

let variant = process.argv.includes('--small') ? 'B' : 'A',
  alert = false,
  fallback = false,
  key = '',
  busy = false,
  ready = false,
  stopped = false,
  generation = 0;
let fontScale = 0.875;
let renderingError = '';
let verified = false;
async function verifySample() {
  if (verified || !process.argv.includes('--verify') || !ready) return;
  verified = true;
  const snapshots: Record<string, string> = {};
  input.setText('未发送草稿🙂');
  for (const mode of ['A', 'B', 'urgent', 'fallback', 'B']) {
    variant = mode === 'A' ? 'A' : 'B';
    alert = mode === 'urgent';
    fallback = mode === 'fallback';
    update();
    await new Promise((done) => setTimeout(done, 250));
    snapshots[mode] = new TextDecoder().decode(renderer.currentRenderBuffer.getRealCharBytes(true));
  }
  await writeFile(
    resolve(directory, 'checks.json'),
    JSON.stringify(
      {
        nativeLabelsInA: snapshots.A.includes('共享项目'),
        graphicsReplaceLabelsInB: !snapshots.B.includes('共享项目'),
        bodyRemainsNative: snapshots.B.includes('我会先检查项目结构'),
        urgentRemainsNative: snapshots.urgent.includes('等待你的确认'),
        fallbackRestoresLabels: snapshots.fallback.includes('共享项目'),
        inputDraftPreserved: input.plainText === '未发送草稿🙂',
        controlsVisible: snapshots.B.includes('Esc 退出'),
        imageLoadsSucceeded: labels.every((label) => label.image.image !== null && !label.image.loadError),
      },
      null,
      2,
    ),
  );
  await writeFile(resolve(directory, 'native-frames.json'), JSON.stringify(snapshots, null, 2));
  input.setText('');
}
function update() {
  const graphical = ready && !fallback && labels[0].image.effectiveProtocol !== 'blocks';
  for (const label of labels) {
    label.image.visible = variant === 'B' && graphical;
    label.textNode.visible = !label.image.visible;
  }
  tabs.content = variant === 'A' ? 'A / 标准原生文字 · 字重与留白分层' : 'B / 辅助小字试验 · 目标字号 87.5%';
  explanation.content =
    variant === 'A'
      ? 'A：全部为原生文字，可选择复制。'
      : graphical
        ? 'B：灰色辅助行为图形文字；不能按普通文字选择复制，行高仍占一行。'
        : `B：${renderingError || '图形未就绪或不可用'}，当前显示原生文字回退。`;
  urgent.content = alert ? '◇ 等待你的确认 · 重要信息保持正文大小' : '';
  brand.image.visible = brand.supported();
  if (brand.image.visible) brand.paint('idle', 0, '#111111', false);
}
async function refreshImages() {
  if (stopped || busy) return;
  const resolution = renderer.resolution;
  if (!resolution || labels[0].image.effectiveProtocol === 'blocks') {
    update();
    return;
  }
  const cellHeight = resolution.height / renderer.terminalHeight,
    cellWidth = resolution.width / renderer.terminalWidth;
  const width = Math.max(1, Math.round((renderer.width - 4) * cellWidth)),
    height = Math.max(1, Math.round(cellHeight));
  const next = `${width}:${height}`;
  if (next === key) {
    update();
    return;
  }
  busy = true;
  ready = false;
  update();
  try {
    const serial = ++generation;
    const request = {
      width,
      height,
      fontPixels: cellHeight * 0.8 * fontScale,
      labels: labels.map((label, i) => ({
        text: label.text,
        path: resolve(directory, `label-${serial}-${i}.png`),
      })),
    };
    const requestPath = resolve(directory, 'labels-request.json');
    await writeFile(requestPath, JSON.stringify(request));
    await promisify(execFile)(
      'powershell.exe',
      ['-NoProfile', '-File', resolve('probes/typography-labels.ps1'), '-Request', requestPath],
      { windowsHide: true, timeout: 15000 },
    );
    if (stopped) return;
    for (let i = 0; i < labels.length; i++) {
      labels[i].image.source = request.labels[i].path;
      await labels[i].image.loadPromise;
      if (labels[i].image.loadError) throw labels[i].image.loadError;
    }
    key = next;
    ready = true;
    renderingError = '';
  } catch (error) {
    renderingError = String(error).slice(0, 100);
  } finally {
    busy = false;
    if (!stopped) {
      update();
      void verifySample();
    }
  }
}
function close() {
  if (stopped) return;
  stopped = true;
  clearInterval(timer);
  renderer.destroy();
}
renderer.keyInput.on('keypress', (event) => {
  if (event.name === 'escape') {
    event.preventDefault();
    close();
  }
  if (['f1', 'f2', 'f3', 'f4'].includes(event.name)) {
    event.preventDefault();
    if (event.name === 'f1') variant = 'A';
    if (event.name === 'f2') variant = 'B';
    if (event.name === 'f3') alert = !alert;
    if (event.name === 'f4') fallback = !fallback;
    update();
  }
});
renderer.on('resize', () => {
  ready = false;
  update();
  void refreshImages();
});
const timer = setInterval(() => {
  void refreshImages();
  void writeFile(
    resolve(directory, 'native-report.json'),
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        variant,
        capabilities: renderer.capabilities,
        resolution: renderer.resolution,
        width: renderer.width,
        height: renderer.height,
        protocol: labels[0].image.effectiveProtocol,
        imagesReady: ready,
        error: renderingError,
        fallback,
        targetFontScale: fontScale,
        fontPixelBasis: 'cell height × 0.8; visual estimate, not terminal glyph metrics',
        textCopy: 'A native text; B auxiliary images have no native text selection',
        sampleOnly: true,
      },
      null,
      2,
    ),
  );
}, 1000);
update();
