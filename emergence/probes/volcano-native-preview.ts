import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const previousNoColor = process.env.NO_COLOR,
  previousTerm = process.env.TERM;
delete process.env.NO_COLOR;
process.env.TERM = 'xterm-256color';
try {
  await import('./workspace-preview.ts');
} finally {
  if (previousNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = previousNoColor;
  if (previousTerm === undefined) delete process.env.TERM;
  else process.env.TERM = previousTerm;
}
const directory = resolve('../artifacts/brand');
const html = (await readFile(resolve(directory, 'workspace-preview.html'), 'utf8'))
  .replace('<title>涌现 · 工作台与任务</title>', '<title>涌现 · A 版火山兽实际终端</title>')
  .replace('涌现 / 第四阶段', '涌现 / A 版火山兽')
  .replace('实际 OpenTUI 组件 · 示例任务 · 静态终端帧', '实际终端组件 · A 版已接入 · 此页为静态截图预览');
await writeFile(resolve(directory, 'volcano-native-preview.html'), html);
