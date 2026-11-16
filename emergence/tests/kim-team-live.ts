// Explicit real-provider acceptance in an isolated home/project; no installed Skill may execute.
import xterm from '@xterm/headless';
import { spawn } from 'node-pty';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { homeDirectory, loadConfig, saveConfig } from '../src/app/config.ts';
import { hydrateCredentials } from '../src/app/credentials.ts';
import { writeTemplate } from '../src/app/templates.ts';
import { safeError } from '../src/core/adapters/redaction.ts';
import type { CollaborationState } from '../src/core/domain/task.ts';
import { enterWorkspace } from './fixtures/enter-workspace.ts';
import { exitTerminal, sendTerminalInput } from './fixtures/terminal-interaction.ts';
if (!process.argv.includes('--live')) throw new Error('Explicit --live required');
const sourceHome = homeDirectory(),
  config = await loadConfig(sourceHome),
  model = config.models.find((m) => m.id === config.defaultModel)!;
await hydrateCredentials(sourceHome, [model.apiKeyEnv]);
const root = await mkdtemp(join(tmpdir(), 'emergence-kim-live-')),
  home = join(root, 'home'),
  project = join(root, 'project'),
  dir = resolve('../artifacts/kim-core');
await mkdir(project);
await mkdir(dir, { recursive: true });
await writeFile(join(project, 'notes.txt'), 'Welcome\n');
await saveConfig(home, {
  ...config,
  models: [{ ...model, maxTokens: 2400 }],
  core: { ...config.core, mode: 'observe', planning: { ...config.core.planning, enabled: true } },
  mcp: [],
  extensions: [],
  skillDirs: [],
  permissions: { defaultMode: 'auto', rules: [{ tool: 'emergence_dispatch', effect: 'allow' }] },
  toolPolicy: {
    deny: ['skill', 'pwsh', 'bash', 'subagent', 'mcp__*', 'web_search', 'web_fetch'],
    confirm: [],
  },
});
await writeTemplate(home, {
  version: 1,
  name: 'kim-check',
  focused: 'main',
  layout: {
    kind: 'split',
    id: 'split',
    axis: 'row',
    ratio: 0.5,
    first: { kind: 'pane', pane: 'main' },
    second: { kind: 'pane', pane: 'worker' },
  },
  panes: [
    { id: 'main', cwd: project, modelId: model.id },
    { id: 'worker', cwd: project, modelId: model.id },
  ],
  roles: { master: 'main', workers: ['worker'] },
});
const key = createHash('sha256').update(project.toLowerCase()).digest('hex').slice(0, 20),
  statePath = join(home, 'workspaces', key + '.json');
type State = { collaboration: CollaborationState };
const state = async (): Promise<State | undefined> => {
  try {
    return JSON.parse(await readFile(statePath, 'utf8'));
  } catch {
    return undefined;
  }
};
const terminal = new xterm.Terminal({ cols: 160, rows: 46, allowProposedApi: true });
const quote = (s: string) => "'" + s.replaceAll("'", "''") + "'";
const command = `& ${quote(process.execPath)} ${quote(resolve('bin/emergence.cjs'))} ${quote(project)} --home ${quote(home)} --template kim-check`;
const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', command], {
  cwd: process.cwd(),
  cols: 160,
  rows: 46,
  useConptyDll: true,
  env: { ...process.env, TERM: 'xterm-256color' },
});
let ended = false;
child.onExit(() => {
  ended = true;
});
child.onData((text) => terminal.write(text));
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
const started = Date.now();
let passed = false,
  error: string | undefined;
try {
  await until('startup', () => screen().includes('描述你要完成') || screen().includes('[关闭]'));
  await enterWorkspace(
    screen,
    (s) => child.write(s),
    (l, p) => until(l, p),
  );
  // Templates deliberately restore independent/paused; explicitly activate this test's team.
  await sendTerminalInput('/mode collaborate', screen, (s) => child.write(s));
  await until('configured team', async () => (await state())?.collaboration.mode === 'collaborate');
  await sendTerminalInput(
    '帮我修改 notes.txt，把 Welcome 换成 欢迎使用涌现，保留换行。让执行窗口完成，读回核对并报告实际结果。仅处理这个文件，不使用命令或外部服务。',
    screen,
    (s) => child.write(s),
  );
  await until(
    'real worker completion',
    async () => {
      const tasks = (await state())?.collaboration.tasks ?? [];
      return tasks.some(
        (t) =>
          !t.assessment &&
          t.target !== t.issuer &&
          ['needs_review', 'succeeded'].includes(t.status) &&
          t.result?.artifacts.length,
      );
    },
    150000,
  );
  assert.equal(await readFile(join(project, 'notes.txt'), 'utf8'), '欢迎使用涌现\n');
  passed = true;
} catch (e) {
  error = safeError(e);
} finally {
  const saved = await state();
  const finalFrame = screen();
  if (!ended) {
    await exitTerminal(screen, (s) => child.write(s));
    for (let i = 0; i < 30 && !ended; i++) await delay(100);
    if (!ended) child.kill();
  }
  const events = [] as Array<{
    type: string;
    data?: { name?: string; message?: { isError?: boolean }; source?: { kind?: string; name?: string } };
  }>;
  for (const file of await readdir(join(home, 'sessions'), { recursive: true }).catch(() => []))
    if (file.endsWith('.jsonl')) {
      for (const line of (await readFile(join(home, 'sessions', file), 'utf8')).split('\n'))
        try {
          events.push(JSON.parse(line));
        } catch {}
    }
  const tools = events.filter((e) => e.type === 'tool/call').map((e) => e.data?.name),
    skillInvocations = events.filter(
      (e) => e.type === 'user/message' && e.data?.source?.kind === 'skill-invocation',
    ).length;
  const hasPlan = tools.includes('emergence_plan') && tools.includes('emergence_execute_plan');
  passed = passed && hasPlan && !tools.includes('skill') && !skillInvocations;
  await writeFile(
    join(dir, 'live-team.json'),
    JSON.stringify(
      {
        passed,
        timestamp: new Date().toISOString(),
        durationMs: Date.now() - started,
        host: new URL(model.baseURL).hostname,
        model: model.model,
        project,
        skillToolDenied: true,
        skillInvocations,
        tools,
        error,
        hasPlan,
        tasks: saved?.collaboration.tasks.map((t) => ({
          id: t.id,
          issuer: t.issuer,
          target: t.target,
          status: t.status,
          assessment: t.assessment?.kind,
          errors: t.result?.errors,
        })),
        scope:
          'Real CLI/Windows ConPTY and configured model, native planning and worker file execution; external Skill tool denied. Stops at actual worker receipt, not a claim of full real-model assurance/memory quality.',
      },
      null,
      2,
    ),
  );
  if (!passed) await writeFile(join(dir, 'failure-frame.txt'), safeError(finalFrame));
  terminal.dispose();
}
console.log(
  passed
    ? 'PASS real model planned and dispatched worker with external Skill disabled'
    : 'FAIL see artifacts/kim-core/live-team.json',
);
if (!passed) process.exitCode = 1;
// Dedicated Windows driver: node-pty retains a conout worker after its shell exits.
process.exit(process.exitCode ?? 0);
