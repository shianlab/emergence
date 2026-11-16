import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { rgbToHex, TextAttributes } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { mountWorkspaceUI } from '../src/app/workspace-ui.ts';
import { WorkspaceController } from '../src/app/workspace.ts';
import { defaultConfig } from '../src/core/domain/configuration.ts';
import { harness } from '../tests/fixtures/harness.ts';

const directory = resolve('../artifacts/tui-phase3');
await mkdir(directory, { recursive: true });
const root = await mkdtemp(join(directory, 'preview-')),
  config = structuredClone(defaultConfig);
config.models[0].apiKeyEnv = 'TUI_PREVIEW_KEY';
const previous = process.env.TUI_PREVIEW_KEY;
process.env.TUI_PREVIEW_KEY = 'local-fixture';
let release: (() => void) | undefined;
class Provider extends LlmAdapter {
  async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, defaultMaxTokens: 512 };
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const running = JSON.stringify(options.messages).includes('preview-running');
    const text = running
      ? '正在核对输入区与状态反馈。\n\n- 保留当前草稿\n- 按顺序处理后续输入'
      : '## 输入与反馈已接入\n\n**输入区随内容增长**，较长的草稿在编辑区内滚动。\n\n1. 中文和多行粘贴保留原文\n2. 命令与聊天草稿分开\n3. 运行、排队和确认显示真实状态\n\n使用 `/` 或 `Ctrl+P` 查找命令。';
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    if (running)
      await new Promise<void>((done) => {
        release = done;
        options.signal?.addEventListener('abort', () => done(), { once: true });
      });
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
const ctx = await harness(root, ['deepseek'], new Provider());
const workspace = new WorkspaceController(ctx, {
  home: root,
  cwd: resolve('..'),
  modelId: 'deepseek',
  appConfig: config,
});
await workspace.initialize();
const test = await createTestRenderer({ width: 108, height: 34, kittyKeyboard: true });
const ui = mountWorkspaceUI(test.renderer, workspace, () => {}),
  pane = workspace.current,
  view = ui.views.get(pane.id)!;
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );
const frames: { title: string; html: string }[] = [];
async function capture(title: string) {
  await test.flush();
  await test.renderOnce();
  frames.push({
    title,
    html: test
      .captureSpans()
      .lines.map(
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
      .join('\n'),
  });
}
try {
  await workspace.send(pane.id, '继续完善输入体验');
  await pane.controller!.agent.whenIdle();
  view.input.setText('接下来检查两项：\n  1. 中文输入与多行草稿\n  2. 发送失败后的恢复');
  await capture('多行输入');
  test.mockInput.pressKey('p', { ctrl: true });
  await test.flush();
  ui.commandInput.setText('view');
  await capture('查找命令');
  test.mockInput.pressEscape();
  await delay(100);
  await test.flush();
  view.input.setText('');
  await workspace.send(pane.id, 'preview-running');
  for (let i = 0; i < 100 && !release; i++) await delay(5);
  await workspace.send(pane.id, '随后检查快捷键');
  await workspace.send(pane.id, '随后检查窄屏');
  view.input.setText('这条还未发送，可以继续编辑。');
  await capture('运行与排队');
  const buttons = frames
    .map((frame, i) => `<button data-index="${i}" aria-pressed="${i === 0}">${frame.title}</button>`)
    .join('');
  const panels = frames
    .map((frame, i) => `<section class="terminal" ${i ? 'hidden' : ''}>${frame.html}</section>`)
    .join('\n');
  await writeFile(
    resolve('../artifacts/brand/composer-preview.html'),
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>涌现 · 输入与反馈</title><style>
*{box-sizing:border-box}body{margin:0;background:#111;color:#dedede;font-family:"Cascadia Mono",Consolas,"Microsoft YaHei UI",monospace}main{width:max-content;min-width:100%;padding:22px 24px}header{display:flex;align-items:center;justify-content:space-between;max-width:1080px;margin:0 auto 18px;font:12px/1.6 system-ui,sans-serif;color:#999}nav{display:flex;gap:6px}button{font:inherit;cursor:pointer;border:1px solid #333;background:#111;color:#999;padding:5px 12px}button[aria-pressed=true]{background:#222;color:#eee;border-color:#555}.terminal{width:108ch;font-size:14px;line-height:17px;margin:auto}.line{height:17px;white-space:pre}span{display:inline-block;height:17px;vertical-align:top}[hidden]{display:none}
</style><main><header><div>涌现 / 第三阶段<br>实际 OpenTUI 帧 · 示例内容 · 下方终端帧为静态快照</div><nav>${buttons}</nav></header>${panels}</main><script>document.querySelectorAll('button').forEach(button=>button.onclick=()=>{document.querySelectorAll('section').forEach((section,index)=>section.hidden=index!==Number(button.dataset.index));document.querySelectorAll('button').forEach(item=>item.setAttribute('aria-pressed',String(item===button)))})</script></html>`,
  );
} finally {
  release?.();
  ui.dispose();
  await workspace.close();
  await ctx.fiber.dispose();
  await test.dispose();
  if (previous === undefined) delete process.env.TUI_PREVIEW_KEY;
  else process.env.TUI_PREVIEW_KEY = previous;
  if (dirname(root) !== directory || !basename(root).startsWith('preview-'))
    throw new Error('Unexpected preview cleanup path');
  await rm(root, { recursive: true, force: true });
}
