import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { scopeTarget } from '@deepseek-ai/dsh-scope';
import { rgbToHex, TextAttributes } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { mountWorkspaceUI } from '../src/app/workspace-ui.ts';
import { WorkspaceController } from '../src/app/workspace.ts';
import { defaultConfig } from '../src/core/domain/configuration.ts';
import { contractSchema } from '../src/core/domain/orchestration.ts';
import { taskSchema } from '../src/core/domain/task.ts';
import { harness } from '../tests/fixtures/harness.ts';

const directory = resolve('../artifacts/tui-phase4');
await mkdir(directory, { recursive: true });
const root = await mkdtemp(join(directory, 'preview-')),
  workerDirectory = join(root, '界面实现');
await mkdir(workerDirectory);
const config = structuredClone(defaultConfig);
config.models[0].apiKeyEnv = 'TUI_WORKSPACE_PREVIEW_KEY';
const previous = process.env.TUI_WORKSPACE_PREVIEW_KEY;
process.env.TUI_WORKSPACE_PREVIEW_KEY = 'local-fixture';
class Provider extends LlmAdapter {
  async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, defaultMaxTokens: 512 };
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const worker = options.messages.some((message) => JSON.stringify(message).includes('worker-preview'));
    const text = worker
      ? '## 界面调整已提交\n\n已完成输入区布局和命令提示。\n\n- 中文草稿保留\n- 终端缩放保持当前会话\n- 等待主控核对实际结果'
      : '## 按验收项核对\n\n**主控负责确认结果**，执行窗口保持各自的会话。\n\n1. 查看任务的真实回执\n2. 核对交付文件和测试证据\n3. 验收后继续后续任务\n\n当前草稿、阅读位置和确认请求分别归属各自窗口。';
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'usage', usage: { inputTokens: worker ? 640 : 1280, outputTokens: worker ? 128 : 256 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
const ctx = await harness(root, ['deepseek'], new Provider());
const workspace = new WorkspaceController(ctx, {
  home: root,
  cwd: resolve('..'),
  modelId: 'deepseek',
  appConfig: config,
  fresh: true,
});
await workspace.initialize();
const test = await createTestRenderer({ width: 160, height: 42, kittyKeyboard: true });
const ui = mountWorkspaceUI(test.renderer, workspace, () => {}),
  main = workspace.current,
  worker = await workspace.split('row', workerDirectory);
workspace.collaboration.configure(main.id, [worker.id]);
workspace.collaboration.pause(true);
workspace.focus(main.id);
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );
const frames: { label: string; width: number; html: string }[] = [];
let approval: Promise<unknown> | undefined;
async function capture(label: string) {
  await test.flush();
  await test.renderOnce();
  await test.flush();
  const snapshot = test.captureSpans();
  frames.push({
    label,
    width: test.renderer.width,
    html: snapshot.lines
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
      .join('\n'),
  });
}
try {
  await workspace.send(main.id, '核对第四阶段的界面调整');
  await main.controller!.agent.whenIdle();
  await workspace.send(worker.id, 'worker-preview');
  await worker.controller!.agent.whenIdle();
  const at = new Date().toISOString();
  const base = {
    requestKey: 'preview',
    issuer: main.id,
    issuerSession: main.controller!.id,
    target: worker.id,
    targetSession: worker.controller!.id,
    cwd: workerDirectory,
    modelId: worker.modelId,
    createdAt: at,
    updatedAt: at,
    dependsOn: [],
  };
  const review = taskSchema.parse({
    ...base,
    id: 'ui-review-021',
    status: 'needs_review',
    objective: '核对输入区与多窗格的实际终端效果',
    progress: '执行已结束，等待逐项验收',
    contract: contractSchema.parse({
      scope: ['src/app/tui'],
      acceptance: ['中文草稿与选区保持', '70 列任务页可返回', '提供原生终端检查证据'],
      deliverables: ['workspace-ui.ts', 'native.json'],
    }),
    steps: 8,
    result: {
      summary: '输入、状态与窗口导航已接入，需主控核对验收。',
      errors: [],
      artifacts: ['src/app/workspace-ui.ts', 'artifacts/tui-phase4/native.json'],
      fromSeq: 5,
      toSeq: 18,
    },
  });
  workspace.collaboration.state.tasks.push(
    review,
    taskSchema.parse({
      ...base,
      requestKey: 'preview-wait',
      id: 'ui-confirm-022',
      status: 'waiting_user',
      objective: '确认当前执行窗口的检查命令',
      progress: '等待所属窗口回答',
    }),
    taskSchema.parse({
      ...base,
      requestKey: 'preview-queue',
      id: 'ui-followup-023',
      status: 'queued',
      objective: '验收后整理交付记录',
      progress: '尚未派发',
      dependsOn: [review.id],
    }),
  );
  workspace.changed();
  const agent = worker.controller!.agent;
  approval = ctx.waterfall(
    scopeTarget(agent, agent),
    'approval/request',
    {
      agent,
      toolName: 'pwsh',
      reason: '检查当前项目的界面构建\n目录：' + workerDirectory + '\n命令：npm run typecheck',
    },
    async () => 'unavailable' as const,
  );
  for (let i = 0; i < 100 && !worker.controller!.pending; i++) await delay(5);
  ui.views.get(main.id)!.input.setText('先看任务证据，再确认下一步。');
  await capture('会话与焦点');
  await workspace.send(main.id, '/task show ' + review.id);
  await capture('任务详情');
  test.resize(70, 30);
  await capture('窄屏任务页');
  const buttons = frames
    .map(
      (frame, index) => `<button data-index="${index}" aria-pressed="${index === 0}">${frame.label}</button>`,
    )
    .join('');
  const panels = frames
    .map(
      (frame, index) =>
        `<section style="width:${frame.width}ch" ${index ? 'hidden' : ''}>${frame.html}</section>`,
    )
    .join('\n');
  await writeFile(
    resolve('../artifacts/brand/workspace-preview.html'),
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>涌现 · 工作台与任务</title><style>
*{box-sizing:border-box}body{margin:0;background:#111;color:#ddd;font-family:"Cascadia Mono",Consolas,"Microsoft YaHei UI",monospace}main{padding:22px 24px;width:max-content;min-width:100%}header{width:calc(100vw - 48px);max-width:1260px;display:flex;flex-wrap:wrap;gap:14px;align-items:center;justify-content:space-between;margin-bottom:20px;font:12px/1.6 system-ui,sans-serif;color:#999}nav{display:flex;gap:6px}button{font:inherit;border:1px solid #333;background:#111;color:#999;padding:5px 12px;cursor:pointer}button[aria-pressed=true]{background:#222;color:#eee;border-color:#555}section{font-size:13px;line-height:16px}.line{height:16px;white-space:pre}span{display:inline-block;height:16px;vertical-align:top}[hidden]{display:none}
</style><main><header><div>涌现 / 第四阶段<br>实际 OpenTUI 组件 · 示例任务 · 静态终端帧</div><nav>${buttons}</nav></header>${panels}</main><script>document.querySelectorAll('button').forEach(button=>button.onclick=()=>{document.querySelectorAll('section').forEach((section,index)=>section.hidden=index!==Number(button.dataset.index));document.querySelectorAll('button').forEach(item=>item.setAttribute('aria-pressed',String(item===button)))})</script></html>`,
  );
} finally {
  ui.dispose();
  await workspace.close();
  await approval;
  await ctx.fiber.dispose();
  await test.dispose();
  if (previous === undefined) delete process.env.TUI_WORKSPACE_PREVIEW_KEY;
  else process.env.TUI_WORKSPACE_PREVIEW_KEY = previous;
  if (dirname(root) !== directory || !basename(root).startsWith('preview-'))
    throw new Error('Unexpected preview cleanup path');
  await rm(root, { recursive: true, force: true });
}
