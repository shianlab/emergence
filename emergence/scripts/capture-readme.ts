import { createTestRenderer } from '@opentui/core/testing';
import type { CapturedFrame, RGBA } from '@opentui/core';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import stringWidth from 'string-width';
import { mountHome } from '../src/app/tui/home.ts';
import { defaultConfig } from '../src/core/domain/configuration.ts';

// Export real renderer cells, without a model request or the developer's local configuration.
const output = resolve('../docs/media');
await mkdir(output, { recursive: true });
const config = structuredClone(defaultConfig);
config.ui.reducedMotion = true;
config.models[0].model = 'demo-model';
const test = await createTestRenderer({ width: 112, height: 38 });
const home = mountHome(
  test.renderer,
  {
    home: resolve('../artifacts/readme-demo'),
    cwd: 'D:\\Projects\\demo',
    modelId: config.models[0].id,
    appConfig: config,
  },
  false,
  {
    async open() {
      throw new Error('Static capture must not open a session');
    },
    async sessions() {
      return [];
    },
    exit() {},
  },
);
const escape = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const color = (value: RGBA) => `rgb(${value.toInts().slice(0, 3).join(',')})`;
function svg(frame: CapturedFrame) {
  const cells: string[] = [];
  const quadrants: Record<string, number> = {
    '▘': 1,
    '▝': 2,
    '▀': 3,
    '▖': 4,
    '▌': 5,
    '▞': 6,
    '▛': 7,
    '▗': 8,
    '▚': 9,
    '▐': 10,
    '▜': 11,
    '▄': 12,
    '▙': 13,
    '▟': 14,
    '█': 15,
  };
  frame.lines.forEach((line, row) => {
    let column = 0;
    for (const span of line.spans) {
      cells.push(
        `<rect x="${column * 10}" y="${row * 20}" width="${span.width * 10}" height="20" fill="${color(span.bg)}"/>`,
      );
      const start = column;
      for (const char of span.text) {
        const width = stringWidth(char);
        const mask = quadrants[char];
        if (mask) {
          for (let bit = 0; bit < 4; bit++)
            if (mask & (1 << bit))
              cells.push(
                `<rect x="${column * 10 + (bit % 2) * 5}" y="${row * 20 + Math.floor(bit / 2) * 10}" width="5" height="10" fill="${color(span.fg)}"/>`,
              );
        } else if (char.trim() && width) {
          cells.push(
            `<text x="${column * 10}" y="${row * 20 + 16}" textLength="${width * 10}" lengthAdjust="spacingAndGlyphs" fill="${color(span.fg)}" font-weight="${span.attributes & 1 ? 700 : 400}">${escape(char)}</text>`,
          );
        }
        column += width;
      }
      column = start + span.width;
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1120" height="760" viewBox="0 0 1120 760" role="img" aria-label="Emergence TUI, real renderer frame with demo configuration"><rect width="1120" height="760" fill="#111111"/><g font-family="Consolas,Microsoft YaHei,monospace" font-size="16">${cells.join('')}</g></svg>\n`;
}
try {
  await test.flush();
  await test.renderOnce();
  await test.flush();
  const frame = test.captureSpans();
  await writeFile(resolve(output, 'home.svg'), svg(frame));
  home.input.setText('/');
  await test.flush();
  await test.renderOnce();
  await test.flush();
  const commands = test.captureSpans();
  await writeFile(resolve(output, 'commands.svg'), svg(commands));
  console.log('Captured home and slash-command frames from the native renderer.');
} finally {
  home.dispose();
  await test.dispose();
}
