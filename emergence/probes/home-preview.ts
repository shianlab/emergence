import { rgbToHex } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { mountHome } from '../src/app/tui/home.ts';
import { defaultConfig } from '../src/core/domain/configuration.ts';

// Export actual OpenTUI spans, including cell backgrounds, without opening an Agent.
const previousMotion = process.env.EMERGENCE_REDUCED_MOTION;
process.env.EMERGENCE_REDUCED_MOTION = '1';
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  );
const width = Number(process.argv[2] ?? 120),
  height = Number(process.argv[3] ?? 38);
if (
  !Number.isInteger(width) ||
  width < 40 ||
  width > 240 ||
  !Number.isInteger(height) ||
  height < 18 ||
  height > 100
)
  throw new Error('Preview size must be 40–240 columns and 18–100 rows');
const test = await createTestRenderer({ width, height });
const config = structuredClone(defaultConfig);
const home = mountHome(
  test.renderer,
  { home: resolve('../.emergence'), cwd: resolve('..'), modelId: config.defaultModel, appConfig: config },
  false,
  { open: async () => {}, sessions: async () => [], exit() {} },
);
try {
  await test.flush();
  const snapshot = test.captureSpans();
  const rows = snapshot.lines
    .map(
      (line) =>
        '<div class="row">' +
        line.spans
          .map(
            (span) =>
              `<span style="width:${span.width}ch;color:${rgbToHex(span.fg)};background:${rgbToHex(span.bg)}">${escape(span.text)}</span>`,
          )
          .join('') +
        '</div>',
    )
    .join('\n');
  await writeFile(
    resolve('../artifacts/brand/home-centered-preview.html'),
    `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>涌现 · 居中首页终端快照</title><style>
*{box-sizing:border-box}body{margin:0;background:#111;color:#a3a3a3;font-family:"Cascadia Mono",Consolas,"Microsoft YaHei UI",monospace}
main{width:max-content;min-width:100%;padding:20px 24px 0}header{max-width:1080px;margin:0 auto 20px;font:12px/1.6 system-ui,sans-serif;display:flex;justify-content:space-between;color:#888}
.terminal{width:${width}ch;margin:0 auto;background:#111;font-size:15px;line-height:18px;font-family:"Cascadia Mono",Consolas,"Microsoft YaHei UI",monospace}
.row{height:18px;white-space:pre;letter-spacing:0}span{display:inline-block;height:18px;vertical-align:top}p{margin:0}
</style><main><header><p>涌现 / 首页调整</p><p>${width} × ${height} · 原生 OpenTUI 帧 · 静态快照</p></header><div class="terminal">${rows}</div></main></html>`,
  );
} finally {
  home.dispose();
  await test.dispose();
  if (previousMotion === undefined) delete process.env.EMERGENCE_REDUCED_MOTION;
  else process.env.EMERGENCE_REDUCED_MOTION = previousMotion;
}
