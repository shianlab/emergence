import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import xterm from '@xterm/headless';
import { spawn } from 'node-pty';
import { homeDirectory, loadConfig, saveConfig } from '../src/app/config.ts';
import { hydrateCredentials } from '../src/app/credentials.ts';
import { writeTemplate } from '../src/app/templates.ts';
import { safeError } from '../src/core/adapters/redaction.ts';
import type { CollaborationState } from '../src/core/domain/task.ts';
import { enterWorkspace } from './fixtures/enter-workspace.ts';
import { exitTerminal, sendTerminalInput } from './fixtures/terminal-interaction.ts';
import { liveMetrics } from './fixtures/live-budget.ts';

if (!process.argv.includes('--live')) throw new Error('Explicit --live required');
const output = resolve('../artifacts/clarification-20261116');
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(output, 'live-'));
const home = join(root, 'home'),
  project = join(root, 'project');
await mkdir(project);
const config = await loadConfig(homeDirectory());
const master = config.models.find((m) => m.id === 'glm-coding');
const worker = config.models.find((m) => m.id === 'deepseek');
assert.ok(master && worker, 'GLM and DeepSeek profiles must be configured');
await hydrateCredentials(homeDirectory(), [master.apiKeyEnv, worker.apiKeyEnv]);
assert.ok(process.env[master.apiKeyEnv] && process.env[worker.apiKeyEnv], 'Live credentials unavailable');
await saveConfig(home, {
  ...config,
  models: [master, worker],
  defaultModel: master.id,
  windowModels: { slots: {} },
  mcp: [],
  extensions: [],
  skillDirs: [],
  permissions: { defaultMode: 'edit', rules: [] },
  toolPolicy: { deny: ['pwsh', 'bash', 'subagent', 'web_search', 'web_fetch', 'mcp__*'], confirm: [] },
});
const facts =
  '涌现 Emergence 是终端中的多窗口 Agent 应用。Emergence Harness 整合执行底座、原生 KIM 需求理解与规划、工具权限和窗口协作。主控分析任务后派给执行窗口，依据实际产物审查验收。模型供应商不等于应用身份。\n';
await writeFile(join(project, 'facts.txt'), facts);
await writeTemplate(home, {
  version: 1,
  name: 'clarification',
  focused: 'main',
  layout: {
    kind: 'split',
    id: 'two',
    axis: 'row',
    ratio: 0.5,
    first: { kind: 'pane', pane: 'main' },
    second: { kind: 'pane', pane: 'worker' },
  },
  panes: [
    { id: 'main', cwd: project, modelId: master.id },
    { id: 'worker', cwd: project, modelId: worker.id },
  ],
  roles: { master: 'main', workers: ['worker'] },
});
const prompt =
  '请和另外一个窗口协作，基于 facts.txt 给涌现写一份 80 到 150 字的简单介绍，保存为 intro.md。先向我询问使用中文还是英文；收到回答后继续完成原任务，不要停在计划。只新增 intro.md，不修改 facts.txt，不访问外网或运行命令。';
await writeFile(
  join(root, 'input.json'),
  JSON.stringify(
    {
      prompt,
      master: { id: master.id, model: master.model, maxTokens: master.maxTokens },
      worker: { id: worker.id, model: worker.model, maxTokens: worker.maxTokens },
      answer: '中文',
      limits: { requests: 40, tokens: 500000, deadlineMs: 360000 },
    },
    null,
    2,
  ),
);
const statePath = join(
  home,
  'workspaces',
  createHash('sha256').update(project.toLowerCase()).digest('hex').slice(0, 20) + '.json',
);
const state = async (): Promise<CollaborationState | undefined> => {
  try {
    return JSON.parse(await readFile(statePath, 'utf8')).collaboration;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
};
const terminal = new xterm.Terminal({ cols: 170, rows: 52, allowProposedApi: true });
const child = spawn(
  process.execPath,
  [resolve('bin/emergence.cjs'), project, '--home', home, '--template', 'clarification'],
  {
    cwd: process.cwd(),
    cols: 170,
    rows: 52,
    useConptyDll: true,
    env: { ...process.env, TERM: 'xterm-256color', NODE_PATH: '', NODE_OPTIONS: '' },
  },
);
let ended = false;
child.onExit(() => {
  ended = true;
});
child.onData((value) => terminal.write(value));
const screen = () =>
  Array.from(
    { length: terminal.rows },
    (_, y) => terminal.buffer.active.getLine(y)?.translateToString(true) ?? '',
  ).join('\n');
async function until(label: string, predicate: () => boolean | Promise<boolean>, limit = 30000) {
  const deadline = Date.now() + limit;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    if (ended) throw new Error('Terminal exited: ' + label);
    await delay(200);
  }
  throw new Error('Timed out: ' + label);
}
async function languageQuestion() {
  const files = await readdir(join(home, 'sessions'), { recursive: true });
  for (const file of files.filter((f) => f.endsWith('session.v4.jsonl'))) {
    const lines = (await readFile(join(home, 'sessions', file), 'utf8')).split('\n').slice(0, -1);
    for (const line of lines.filter(Boolean)) {
      const event = JSON.parse(line);
      if (event.type !== 'tool/call' || event.data.name !== 'ask_user_question') continue;
      const q = JSON.parse(event.data.arguments).questions?.[0];
      const index = q?.options?.findIndex(
        (o: { label: string }) => /中文/.test(o.label) && !/英文|双语/.test(o.label),
      );
      if (index >= 0)
        return { id: event.data.callId, question: q.question, label: q.options[index].label, index };
    }
  }
}
const started = Date.now();
let passed = false,
  answered = false,
  error: string | undefined,
  previous = '';
try {
  await until('startup', () => screen().includes('描述你要完成') || screen().includes('[关闭]'));
  await enterWorkspace(
    screen,
    (s) => child.write(s),
    (label, predicate) => until(label, predicate),
  );
  await sendTerminalInput('/mode collaborate', screen, (s) => child.write(s));
  await until('team', async () => (await state())?.mode === 'collaborate');
  await sendTerminalInput(prompt, screen, (s) => child.write(s));
  await until(
    'clarification and real reviewed delivery',
    async () => {
      const metrics = await liveMetrics(home);
      if (metrics.requests >= 40 || metrics.tokens >= 500000) throw new Error('Live sample budget exhausted');
      if (!answered) {
        const q = await languageQuestion();
        if (q && screen().includes(q.label) && screen().includes(q.question.slice(0, 12))) {
          child.write('\x1b[B'.repeat(q.index) + '\r');
          answered = true;
          console.log('Answered the real language question through the terminal');
        }
      }
      const s = await state();
      const goal = s?.coordinations?.at(-1);
      const progress = JSON.stringify({
        requests: metrics.requests,
        phase: goal?.phase,
        tasks: s?.tasks.map((t) => ({ status: t.status, role: t.role?.id })),
      });
      if (progress !== previous) {
        console.log(progress);
        previous = progress;
      }
      if (goal?.phase === 'blocked' || goal?.phase === 'cancelled')
        throw new Error(goal.blockReason ?? goal.phase);
      return !!answered && goal?.phase === 'completed';
    },
    360000,
  );
  const s = (await state())!;
  assert.ok(s.tasks.some((t) => !t.assessment && t.issuer !== t.target && t.status === 'succeeded'));
  const intro = await readFile(join(project, 'intro.md'), 'utf8');
  assert.match(intro, /涌现|Emergence/);
  assert.match(intro, /[\u4e00-\u9fff]/);
  assert.equal(await readFile(join(project, 'facts.txt'), 'utf8'), facts);
  passed = true;
} catch (e) {
  error = safeError(e);
} finally {
  const saved = await state();
  await writeFile(join(root, 'terminal.txt'), safeError(screen()));
  if (!ended) {
    await exitTerminal(screen, (s) => child.write(s));
    for (let i = 0; i < 30 && !ended; i++) await delay(100);
    if (!ended) child.kill();
  }
  terminal.dispose();
  const report = {
    passed,
    answered,
    error,
    elapsedMs: Date.now() - started,
    root,
    metrics: await liveMetrics(home),
    coordination: saved?.coordinations?.at(-1),
    tasks: saved?.tasks.map((t) => ({
      id: t.id,
      status: t.status,
      issuer: t.issuer,
      target: t.target,
      assessment: t.assessment,
    })),
  };
  await writeFile(join(root, 'result.json'), safeError(JSON.stringify(report, null, 2)));
  await writeFile(join(output, 'live-latest.json'), JSON.stringify({ root, passed, error }, null, 2));
  console.log(
    JSON.stringify({ root, passed, answered, error, elapsedMs: report.elapsedMs, metrics: report.metrics }),
  );
}
// ConPTY retains native handles after the owned child exits; reports are flushed above.
process.exit(passed ? 0 : 1);
