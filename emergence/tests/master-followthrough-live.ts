// Opt-in real model + production CLI / Windows terminal. Only one predeclared read-only command is approved.
import xterm from '@xterm/headless';
import { spawn } from 'node-pty';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
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
import {
  diagnosticSnapshots,
  ObservationDeadline,
  observeUntil,
  stopOwnedProcess,
} from './fixtures/observation.ts';
if (!process.argv.includes('--live')) throw new Error('Explicit --live required');
const sourceHome = homeDirectory(),
  config = await loadConfig(sourceHome),
  model = config.models.find((m) => m.id === config.defaultModel)!;
await hydrateCredentials(sourceHome, [model.apiKeyEnv]);
const root = await mkdtemp(join(tmpdir(), 'emergence-followthrough-live-')),
  home = join(root, 'home'),
  project = join(root, 'project'),
  dir = resolve(process.env.EMERGENCE_FOLLOWTHROUGH_LIVE_DIR ?? '../artifacts/master-phase3');
await mkdir(project);
await mkdir(dir, { recursive: true });
await writeFile(join(project, 'notes.txt'), 'Welcome\n');
const check = join(project, 'verify.cjs');
await writeFile(
  check,
  "const fs=require('fs');if(fs.readFileSync('notes.txt','utf8')!=='欢迎使用涌现\\n')process.exit(7);console.log('content and newline verified');\n",
);
const baseline = createHash('sha256')
  .update(await readFile(check))
  .digest('hex');
const quote = (s: string) => "'" + s.replaceAll("'", "''") + "'",
  verification = `& ${quote(process.execPath.replaceAll('\\', '/'))} './verify.cjs'`;
const allowedCommands = new Set([
  verification,
  "(Get-FileHash -Algorithm SHA256 -Path '.\\verify.cjs').Hash",
  "(Get-FileHash -Algorithm SHA256 -Path './verify.cjs').Hash",
]);
await saveConfig(home, {
  ...config,
  models: [{ ...model, maxTokens: 3000 }],
  windowModels: { slots: {} },
  core: { ...config.core, mode: 'observe', planning: { ...config.core.planning, enabled: true } },
  mcp: [],
  extensions: [],
  skillDirs: [],
  permissions: {
    defaultMode: 'auto',
    rules: [
      { tool: 'write', path: check, effect: 'deny' },
      { tool: 'edit', path: check, effect: 'deny' },
    ],
  },
  toolPolicy: { deny: ['bash', 'subagent', 'mcp__*', 'web_search', 'web_fetch'], confirm: [] },
});
await writeTemplate(home, {
  version: 1,
  name: 'followthrough-check',
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
const state = async (): Promise<{ focused: string; collaboration: CollaborationState } | undefined> => {
  try {
    return JSON.parse(await readFile(statePath, 'utf8'));
  } catch {
    return undefined;
  }
};
const terminal = new xterm.Terminal({ cols: 160, rows: 46, allowProposedApi: true });
const command = `& ${quote(process.execPath)} ${quote(resolve('bin/emergence.cjs'))} ${quote(project)} --home ${quote(home)} --template followthrough-check --approve-command ${quote(verification)}`;
const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', command], {
  cwd: process.cwd(),
  cols: 160,
  rows: 46,
  useConptyDll: true,
  env: { ...process.env, TERM: 'xterm-256color' },
});
let ended = false;
child.onExit(() => (ended = true));
child.onData((text) => terminal.write(text));
const screen = () =>
  Array.from(
    { length: terminal.rows },
    (_, y) => terminal.buffer.active.getLine(y)?.translateToString(true) ?? '',
  ).join('\n');
async function until(label: string, predicate: () => boolean | Promise<boolean>, limit = 30000) {
  await observeUntil(
    label,
    async () => {
      if (ended) throw new Error('Terminal exited: ' + label);
      return predicate();
    },
    {
      limitMs: limit,
      snapshot: async () => ({ state: await state(), diagnostics: await diagnosticSnapshots(home) }),
      stop: () => stopOwnedProcess(child, () => ended),
    },
  );
}
let observation: ObservationDeadline | undefined;
let passed = false,
  error: string | undefined;
const started = Date.now();
const approvedCalls = new Set<string>();
const commandByCall = new Map<string, string>();
const reviewedCommands: Array<{ callId: string; command: string }> = [];
async function approveFixedCheck(saved: NonNullable<Awaited<ReturnType<typeof state>>>) {
  const task = saved.collaboration.tasks.find((t) => t.status === 'waiting_user');
  if (!task) return;
  const files = (await readdir(join(home, 'sessions'), { recursive: true })).filter(
    (f) => f.endsWith('.jsonl') && f.includes(task.targetSession),
  );
  const calls = [] as Array<{ callId: string; name: string; arguments: string }>;
  const resolved = new Set<string>();
  for (const file of files)
    for (const line of (await readFile(join(home, 'sessions', file), 'utf8')).split('\n'))
      try {
        const event = JSON.parse(line);
        if (event.type === 'tool/call') calls.push(event.data);
        if (event.type === 'tool/result') resolved.add(event.data.message.toolCallId);
      } catch {}
  // Models may issue a read in parallel after a command. The last call is not necessarily the approval.
  const waiting = calls.filter((c) => c.name === 'pwsh' && !resolved.has(c.callId));
  if (waiting.length !== 1) return;
  const call = waiting[0];
  if (approvedCalls.has(call.callId)) return;
  const args = JSON.parse(call.arguments);
  if (call.name !== 'pwsh' || resolve(args.workdir ?? project) !== resolve(project))
    throw new Error('Pending operation is not a project-local command; not approved.');
  const hashOnly =
    /^(?:\(Get-FileHash -Algorithm SHA256 -(?:LiteralPath|Path) ['"]\.\\verify\.cjs['"]\)\.Hash|Get-FileHash -Algorithm SHA256 -(?:LiteralPath|Path) ['"]\.\\verify\.cjs['"] \| Select-Object -ExpandProperty Hash)$/;
  if (!allowedCommands.has(args.command) && !hashOnly.test(args.command)) {
    const fingerprint = createHash('sha256').update(JSON.stringify(args)).digest('hex'),
      approvalPath = join(root, 'operator-approval.json');
    await writeFile(
      join(dir, 'pending-live-approval.json'),
      JSON.stringify(
        { callId: call.callId, tool: call.name, args, project, fingerprint, approvalPath },
        null,
        2,
      ),
    );
    let approval: { callId?: string; fingerprint?: string; approved?: boolean } | undefined;
    try {
      approval = JSON.parse(await readFile(approvalPath, 'utf8'));
    } catch {}
    if (
      approval?.callId !== call.callId ||
      approval.fingerprint !== fingerprint ||
      approval.approved !== true
    )
      return;
    reviewedCommands.push({ callId: call.callId, command: args.command });
  }
  // CLI one-shot approvals deliberately do not propagate to worker windows. Inspect the actual call, then use its own pane's approval.
  await sendTerminalInput('/focus ' + task.target, screen, (s) => child.write(s));
  await until(
    'approval belongs to focused worker',
    async () => (await state())?.focused === task.target,
    5000,
  );
  approvedCalls.add(call.callId);
  commandByCall.set(call.callId, args.command);
  await sendTerminalInput('y', screen, (s) => child.write(s));
}
try {
  await until('startup', () => screen().includes('描述你要完成') || screen().includes('[关闭]'));
  await enterWorkspace(
    screen,
    (s) => child.write(s),
    (l, p) => until(l, p),
  );
  await sendTerminalInput('/mode collaborate', screen, (s) => child.write(s));
  await until('team', async () => (await state())?.collaboration.mode === 'collaborate');
  await sendTerminalInput(
    `把 notes.txt 的 Welcome 改为 欢迎使用涌现，保留末尾换行。仅修改 notes.txt，读回检查。目录初始只有 notes.txt 和 verify.cjs；verify.cjs 初始 SHA256 是 ${baseline}，须保持不变。这是 Windows PowerShell 项目，命令工具是 pwsh，不使用 bash。verify.cjs 已提供验收检查；需要运行验证时只使用这个已批准的精确命令：${verification}。命令前后不得追加任何语句（含 Write-Output），退出码由工具返回。不访问外部服务。`,
    screen,
    (s) => child.write(s),
  );
  await until(
    'automatic acceptance',
    async () => {
      const saved = await state(),
        record = saved?.collaboration.coordinations?.at(-1);
      if (record && ['blocked', 'cancelled'].includes(record.phase))
        throw new Error(record.blockReason ?? record.phase);
      if (record?.phase === 'waiting-input' && saved) await approveFixedCheck(saved);
      return record?.phase === 'completed';
    },
    600000,
  );
  const saved = (await state())!.collaboration;
  assert.equal(await readFile(join(project, 'notes.txt'), 'utf8'), '欢迎使用涌现\n');
  assert.ok(saved.tasks.some((t) => t.assessment?.kind === 'review' && t.status === 'succeeded'));
  assert.ok(
    saved.tasks.some(
      (t) =>
        t.assessment?.kind === 'verify' &&
        t.status === 'succeeded' &&
        t.receipts.some(
          (r) => r.kind === 'command' && r.exitCode === 0 && commandByCall.get(r.id) === verification,
        ),
    ),
    'independent verification must actually run the exact supplied script, not merely hash a file',
  );
  passed = true;
} catch (e) {
  if (e instanceof ObservationDeadline) observation = e;
  error = safeError(e);
} finally {
  const saved = await state(),
    frame = screen();
  if (!ended) {
    try {
      await exitTerminal(screen, (s) => child.write(s));
      for (let n = 0; n < 30 && !ended; n++) await delay(100);
      if (!ended) await stopOwnedProcess(child, () => ended);
    } catch (cleanup) {
      passed = false;
      error = (error ?? '') + '；测试进程停止未确认：' + safeError(cleanup);
    }
  }
  await writeFile(
    join(dir, 'live-followthrough.json'),
    JSON.stringify(
      {
        passed,
        timestamp: new Date().toISOString(),
        durationMs: Date.now() - started,
        processExitConfirmed: ended,
        observation: observation && {
          kind: observation.kind,
          limitMs: observation.limitMs,
          lastState: observation.lastState,
          cleanupError: observation.cleanupError,
        },
        diagnostics: await diagnosticSnapshots(home),
        model: model.model,
        host: new URL(model.baseURL).hostname,
        project,
        error,
        approvedCommand: verification,
        approvedToolCalls: [...approvedCalls],
        approvedCommands: Object.fromEntries(commandByCall),
        operatorReviewedCommands: reviewedCommands,
        records: saved?.collaboration.coordinations,
        tasks: saved?.collaboration.tasks,
        scope:
          'Real configured model through production CLI and Windows ConPTY. One natural objective; automatic planning, implementation, independent review, real read-only process verification and final acceptance. No test-issued audit/review/repair calls; only exact bounded verification/hash commands are approved in their own panes. Repair is covered by deterministic tests.',
      },
      null,
      2,
    ),
  );
  if (!passed) await writeFile(join(dir, 'failure-frame.txt'), safeError(frame));
  terminal.dispose();
}
console.log(
  passed
    ? 'PASS real model automatic followthrough'
    : 'FAIL see artifacts/master-phase3/live-followthrough.json',
);
process.exit(passed ? 0 : 1);
