import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createTestRenderer } from '@opentui/core/testing';
import { TextAttributes, rgbToHex } from '@opentui/core';
import { richText } from '../src/app/tui/rich-text.ts';
import { palettes } from '../src/core/domain/ui-preferences.ts';

const content =
  '# 项目总结\n\n主要结论保持普通正文大小。\n\n## 主要章节\n\n章节正文，保留 **关键结论**。\n\n### 操作步骤\n\n步骤正文直接跟随。\n\n#### 补充说明\n\n补充正文。\n\n> 引用中的中文与 emoji 🙂 保持可读。\n\n```ts\nconst original = "# **literal** 🙂";\n```\n\n| 项目 | 状态 |\n| --- | --- |\n| 排版 | 已完成 |';
const test = await createTestRenderer({ width: 90, height: 50 });
const rich = richText(test.renderer, content, palettes.dark, 86);
test.renderer.root.add(rich.markdown);
const directory = resolve('../artifacts/tui-typography-phase3');
await mkdir(directory, { recursive: true });
const checks: Record<string, boolean> = {};
try {
  await test.flush();
  await test.renderOnce();
  const frame = test.captureCharFrame(),
    rows = frame.split('\n'),
    spans = test.captureSpans();
  const row = (label: string) => rows.findIndex((line) => line.includes(label));
  assert.match(rows[row('项目总结') + 1], /─/);
  assert.equal(rows[row('主要章节') + 1].trim(), '');
  assert.equal(row('步骤正文直接跟随'), row('操作步骤') + 1);
  assert.ok(rows[row('操作步骤')].indexOf('操作步骤') > rows[row('主要章节')].indexOf('主要章节'));
  const bold = (label: string) =>
    spans.lines.some((line) =>
      line.spans.some((span) => span.text.includes(label) && Boolean(span.attributes & TextAttributes.BOLD)),
    );
  assert.ok(bold('项目总结') && bold('主要章节') && bold('操作步骤'));
  assert.equal(bold('补充说明'), false);
  assert.ok(bold('关键结论'));
  checks.headingHierarchyAndCompactSubsections = true;
  assert.ok(frame.includes('const original = "# **literal** 🙂";'));
  const quoted = spans.lines
    .flatMap((line) => line.spans)
    .find((span) => span.text.includes('引用中的中文'))!;
  assert.equal(rgbToHex(quoted.fg), palettes.dark.foreground);
  assert.equal(rgbToHex(quoted.bg), palettes.dark.input);
  checks.codeStaysLiteralAndQuoteUsesReadableSurface = true;
  await writeFile(resolve(directory, 'dark-frame.txt'), frame);
  await writeFile(resolve(directory, 'dark-spans.json'), JSON.stringify(spans, null, 2));
  test.resize(32, 60);
  rich.update(content, palettes.light, 28, false);
  await test.flush();
  await test.renderOnce();
  const narrow = test.captureCharFrame();
  await writeFile(resolve(directory, 'narrow-frame.txt'), narrow);
  assert.ok(narrow.includes('操作步骤'));
  assert.ok(narrow.includes('项目  排版'));
  assert.ok(
    narrow
      .split('\n')
      .map((line) => line.trim())
      .join('')
      .includes('**literal**'),
    'wrapped code retains literal markdown characters',
  );
  assert.equal(rich.markdown.content, content);
  checks.narrowLightThemePreservesContent = true;
  await writeFile(resolve(directory, 'narrow-frame.txt'), narrow);
  await writeFile(resolve(directory, 'checks.json'), JSON.stringify(checks, null, 2));
  console.log(JSON.stringify(checks));
} finally {
  rich.dispose();
  await test.dispose();
}
