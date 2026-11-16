// Opt-in two configured models + production CLI / Windows terminal; inspect each pending fixture edit or read-only command.
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
import { diagnosticSnapshots, observeUntil, stopOwnedProcess } from './fixtures/observation.ts';
import { checkLiveBudget, liveLimits, liveMetrics } from './fixtures/live-budget.ts';
import { approvalEvents } from './fixtures/approval-events.ts';
import { fixtureDecision, fixtureWorkdir, fixtureFileOperation } from './fixtures/live-approvals.ts';
import { captureAcceptance } from './fixtures/acceptance-capture.ts';
import { evaluateAcceptance, fixtureScript } from './fixtures/acceptance-oracle.ts';
import {
  diagnoseAcceptance,
  terminalRunFailure,
  type AcceptanceFinding,
} from './fixtures/acceptance-diagnostics.ts';
if (!process.argv.includes('--live')) throw new Error('Explicit --live required');
const sameProject = process.env.EMERGENCE_LIVE_TOPOLOGY === 'same';
const planningOnly = process.env.EMERGENCE_LIVE_PLANNING_ONLY === '1';
// Observer deadline includes operator approval time; production budgets remain unchanged.
const observerTimeoutMs = Number(process.env.EMERGENCE_LIVE_TIMEOUT_MS ?? 600000);
if (!Number.isInteger(observerTimeoutMs) || observerTimeoutMs < 180000 || observerTimeoutMs > 1800000)
  throw new Error('Live observer timeout must be 180000..1800000 ms');
const buildPaths = ['dist/cli.mjs', 'dist/plugin.mjs'];
const buildHashes = async () =>
  Object.fromEntries(
    await Promise.all(
      buildPaths.map(async (path) => [
        path,
        createHash('sha256')
          .update(await readFile(path))
          .digest('hex'),
      ]),
    ),
  );
const initialBuild = await buildHashes();
const sourceHome = homeDirectory(),
  config = await loadConfig(sourceHome),
  model = config.models.find((m) => m.id === (process.env.EMERGENCE_LIVE_MASTER ?? config.defaultModel));
if (!model) throw new Error('Requested live master model is not configured');
const outputTokens = Number(process.env.EMERGENCE_LIVE_OUTPUT_TOKENS ?? 8192);
if (!Number.isInteger(outputTokens) || outputTokens < 1024 || outputTokens > 16384)
  throw new Error('Live output tokens must be 1024..16384');
const otherModel =
  config.models.find((m) => m.id === process.env.EMERGENCE_LIVE_WORKER) ??
  config.models.find((m) => m.id !== model.id && m.model !== model.model);
if (!otherModel) throw new Error('Need two distinct configured models for this acceptance');
await hydrateCredentials(sourceHome, [model.apiKeyEnv, otherModel.apiKeyEnv]);
if (!process.env[model.apiKeyEnv] || !process.env[otherModel.apiKeyEnv])
  throw new Error('Both configured models require available credentials');
const root = await mkdtemp(join(tmpdir(), 'emergence-team-live-')),
  home = join(root, 'home'),
  project = join(root, 'project'),
  otherProject = sameProject ? project : join(root, 'other-project'),
  projects = [...new Set([project, otherProject])],
  dir = resolve(process.env.EMERGENCE_TEAM_LIVE_DIR ?? '../artifacts/master-phase4');
await mkdir(dir, { recursive: true });
await writeFile(
  join(dir, 'environment.json'),
  JSON.stringify(
    {
      root,
      home,
      projects,
      model: model.id,
      worker: otherModel.id,
      observerTimeoutMs,
      initialBuild,
      limits: liveLimits,
    },
    null,
    2,
  ),
);
for (const cwd of projects) {
  await mkdir(cwd);
  await writeFile(join(cwd, 'notes.txt'), 'Welcome\n');
}
const check = join(project, 'verify.cjs');
await writeFile(check, fixtureScript);
await writeFile(join(otherProject, 'verify.cjs'), await readFile(check));
const baseline = createHash('sha256')
  .update(await readFile(check))
  .digest('hex');
const quote = (s: string) => "'" + s.replaceAll("'", "''") + "'",
  verification = `& ${quote(process.execPath.replaceAll('\\', '/'))} './verify.cjs'`;
const allowedCommands = new Set([
  verification,
  "(Get-FileHash -Algorithm SHA256 -Path '.\\verify.cjs').Hash",
  "(Get-FileHash -Algorithm SHA256 -Path './verify.cjs').Hash",
  "Get-FileHash -Algorithm SHA256 -Path './verify.cjs' | Select-Object -ExpandProperty Hash",
  "(Get-FileHash -Path './verify.cjs' -Algorithm SHA256).Hash.ToLower()",
]);
await saveConfig(home, {
  ...config,
  defaultModel: model.id,
  windowModels: { slots: {} },
  models: [
    { ...model, maxTokens: outputTokens },
    { ...otherModel, maxTokens: outputTokens },
  ],
  core: { ...config.core, mode: 'observe', planning: { ...config.core.planning, enabled: true } },
  mcp: [],
  extensions: [],
  skillDirs: [],
  permissions: {
    defaultMode: 'auto',
    rules: projects.flatMap((cwd) => [
      { tool: 'write', path: join(cwd, 'verify.cjs'), effect: 'deny' as const },
      { tool: 'edit', path: join(cwd, 'verify.cjs'), effect: 'deny' as const },
    ]),
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
    ratio: 0.34,
    first: { kind: 'pane', pane: 'main' },
    second: sameProject
      ? { kind: 'pane', pane: 'worker' }
      : {
          kind: 'split',
          id: 'workers',
          axis: 'row',
          ratio: 0.5,
          first: { kind: 'pane', pane: 'worker' },
          second: { kind: 'pane', pane: 'worker2' },
        },
  },
  panes: [
    { id: 'main', cwd: project, modelId: model.id },
    { id: 'worker', cwd: project, modelId: sameProject ? otherModel.id : model.id },
    ...(sameProject ? [] : [{ id: 'worker2', cwd: otherProject, modelId: otherModel.id }]),
  ],
  roles: { master: 'main', workers: sameProject ? ['worker'] : ['worker', 'worker2'] },
});
const key = createHash('sha256').update(project.toLowerCase()).digest('hex').slice(0, 20),
  statePath = join(home, 'workspaces', key + '.json');
const state = async (): Promise<
  | {
      focused: string;
      panes: Array<{ id: string; sessionId: string; cwd: string }>;
      collaboration: CollaborationState;
    }
  | undefined
> => {
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
let goalStarted: number | undefined;
let observedFailure: AcceptanceFinding | undefined;
async function until(label: string, predicate: () => boolean | Promise<boolean>, limit = 30000) {
  await observeUntil(
    label,
    async () => {
      if (ended) throw new Error('Terminal exited: ' + label);
      if (goalStarted !== undefined) {
        const saved = await state();
        const sessions = [
          ...(saved?.panes.map((p) => p.sessionId) ?? []),
          ...(saved?.collaboration.tasks.map((t) => t.targetSession) ?? []),
        ];
        observedFailure = terminalRunFailure(
          (await diagnosticSnapshots(home)).flatMap((d) => d.runs),
          goalStarted,
          sessions,
        );
        if (observedFailure)
          throw new Error(`${observedFailure.stage}/${observedFailure.code}: ${observedFailure.detail}`);
      }
      return await predicate();
    },
    {
      limitMs: limit,
      snapshot: async () => ({ state: await state(), diagnostics: await diagnosticSnapshots(home) }),
      stop: () => stopOwnedProcess(child, () => ended),
    },
  );
}
let passed = false,
  error: string | undefined;
const started = Date.now();
const approvalDecisions = new Map<string, string>();
const commandByCall = new Map<string, string>();
const reviewedCommands: Array<{ callId: string; command: string }> = [];
async function approveFixedCheck(saved: NonNullable<Awaited<ReturnType<typeof state>>>) {
  // Discover native pending requests for every live owner, independent of the task label.
  for (const pane of saved.panes) {
    const task = { target: pane.id, targetSession: pane.sessionId, cwd: pane.cwd };
    const files = (await readdir(join(home, 'sessions'), { recursive: true })).filter(
      (f) => f.endsWith('session.v4.jsonl') && f.includes(task.targetSession),
    );
    if (files.length !== 1) continue;
    const journal = join(home, 'sessions', files[0]);
    const readApprovals = async () => approvalEvents(await readFile(journal, 'utf8'));
    const request = (await readApprovals()).pending[0];
    if (!request || approvalDecisions.has(request.id)) continue;
    const call = request.call;
    const confirm = async (decision: 'allow' | 'deny' | 'cancel' = 'allow') => {
      if ((await readApprovals()).pending[0]?.id !== request.id) return;
      await sendTerminalInput(`/approval ${request.id} 1 ${decision}`, screen, (s) => child.write(s));
      await until(
        'approval decision receipt',
        async () => (await readApprovals()).decisions.has(request.id),
        5000,
      );
      assert.equal(
        (await readApprovals()).decisions.get(request.id),
        { allow: 'allowed-once', deny: 'rejected', cancel: 'cancelled' }[decision],
      );
      approvalDecisions.set(
        request.id,
        { allow: 'allowed-once', deny: 'rejected', cancel: 'cancelled' }[decision],
      );
    };
    const args = JSON.parse(call.arguments);
    if (!fixtureWorkdir(task.cwd, task.cwd, projects)) throw new Error('Task escaped isolated projects');
    if (call.name !== 'pwsh') {
      // Cross-project edits need explicit approval. Only the exact fixture file/content is allowed.
      const path = resolve(task.cwd, args.file_path ?? args.path ?? '');
      if (!fixtureFileOperation(call.name, args, task.cwd, projects))
        throw new Error('Unexpected edit awaiting approval; not approved');
      reviewedCommands.push({ callId: call.callId, command: call.name + ' ' + path });
      await confirm();
      continue;
    }
    if (!fixtureWorkdir(args.workdir, task.cwd, projects))
      throw new Error('Pending command has the wrong working directory; not approved.');
    if (!allowedCommands.has(args.command)) {
      const fingerprint = createHash('sha256').update(JSON.stringify(args)).digest('hex'),
        approvalPath = join(root, `operator-approval-${request.id}.json`);
      await writeFile(
        join(dir, `pending-live-approval-${request.id}.json`),
        JSON.stringify(
          { callId: call.callId, tool: call.name, args, project: task.cwd, fingerprint, approvalPath },
          null,
          2,
        ),
      );
      let approval: unknown;
      try {
        approval = JSON.parse(await readFile(approvalPath, 'utf8'));
      } catch {}
      const decision = fixtureDecision(approval, call.callId, fingerprint);
      if (!decision) continue;
      reviewedCommands.push({ callId: call.callId, command: args.command });
      if (decision !== 'allow') {
        await confirm(decision);
        continue;
      }
    }
    commandByCall.set(call.callId, args.command);
    await confirm();
  }
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
  goalStarted = Date.now();
  await sendTerminalInput(
    `${sameProject ? `修改项目 ${project}` : `分别修改两个项目（${project} 和 ${otherProject}）`}中的 notes.txt：把 Welcome 改为 欢迎使用涌现，保留末尾换行。${sameProject ? '读回并验证。' : '两个项目分别读回和验证，不能只改其中一个。'}每个目录初始只有 notes.txt 和 verify.cjs；仅修改各自 notes.txt。verify.cjs 初始 SHA256 为 ${baseline}，须保持不变。这是 Windows PowerShell，命令工具是 pwsh，不使用 bash。各目录已有验收脚本；运行验证只使用这个精确命令并将工作目录设为对应项目：${verification}。命令前后不得追加语句，退出码由工具返回。不访问外部服务。`,
    screen,
    (s) => child.write(s),
  );
  await until(
    'automatic acceptance',
    async () => {
      await checkLiveBudget(home);
      const saved = await state(),
        record = saved?.collaboration.coordinations?.at(-1);
      if (record && ['blocked', 'cancelled'].includes(record.phase))
        throw new Error(record.blockReason ?? record.phase);
      if (saved) await approveFixedCheck(saved);
      return planningOnly
        ? Boolean(
            record?.executions.length &&
            projects.every((cwd) =>
              saved?.collaboration.tasks.some((t) => record.executions.includes(t.id) && t.cwd === cwd),
            ),
          )
        : record?.phase === 'completed';
    },
    observerTimeoutMs,
  );
  const saved = (await state())!.collaboration;
  const business = saved.tasks.filter((task) => !task.assessment && !task.repairOf);
  const identities = business.map((task) => `${task.issuerSession}:${task.requestKey}`);
  assert.equal(new Set(identities).size, identities.length, 'No duplicate dispatch identity');
  assert.ok(
    saved.tasks.every((task) => projects.includes(task.cwd)),
    'No out-of-project tasks',
  );
  for (const cwd of projects)
    assert.deepEqual((await readdir(cwd)).filter((name) => !name.startsWith('.')).sort(), [
      'notes.txt',
      'verify.cjs',
    ]);
  // Final fixture verification uses the same native-evidence oracle as offline replay after flush/exit.
  assert.equal(
    new Set(saved.tasks.filter((t) => !t.assessment).map((t) => t.modelId)).size,
    sameProject ? 1 : 2,
  );
  assert.equal(
    new Set(saved.tasks.filter((t) => !t.assessment).map((t) => t.target)).size,
    sameProject ? 1 : 2,
  );
  assert.ok(projects.every((cwd) => saved.tasks.some((t) => t.cwd === cwd && !t.assessment)));
  passed = true;
} catch (e) {
  error = safeError(e);
} finally {
  const saved = await state(),
    frame = screen();
  if (!ended) {
    await exitTerminal(screen, (s) => child.write(s));
    for (let n = 0; n < 30 && !ended; n++) await delay(100);
    if (!ended) {
      try {
        await stopOwnedProcess(child, () => ended);
      } catch (e) {
        passed = false;
        error = [error, safeError(e)].filter(Boolean).join('; ');
      }
    }
  }
  const finalBuild = await buildHashes();
  if (JSON.stringify(finalBuild) !== JSON.stringify(initialBuild)) {
    passed = false;
    error = 'Build changed during live acceptance';
  }
  const goal = saved?.collaboration.coordinations?.at(-1);
  const dispatched = saved?.collaboration.tasks.filter((t) => goal?.executions.includes(t.id)) ?? [];
  const planningDurationMs =
    goal && dispatched.length
      ? Math.max(...dispatched.map((t) => Date.parse(t.createdAt))) - Date.parse(goal.createdAt)
      : null;
  const diagnostics = await diagnosticSnapshots(home);
  let acceptance: ReturnType<typeof evaluateAcceptance> | undefined;
  let findings: AcceptanceFinding[] = observedFailure ? [observedFailure] : [];
  try {
    if (passed) {
      assert.ok(diagnostics.length > 0, 'Final runtime diagnostics are required');
      assert.ok(
        diagnostics.every((d) => d.runs.every((run) => run.outcome !== 'running')),
        'Runtime timing snapshot remained running after process exit; metrics are incomplete',
      );
    }
    const snapshot = await captureAcceptance({
      home,
      projects,
      tasks: saved?.collaboration.tasks ?? [],
      records: saved?.collaboration.coordinations ?? [],
      verification,
      runs: diagnostics.flatMap((d) => d.runs),
      since: goalStarted ?? started,
      sessions: [
        ...(saved?.panes.map((p) => p.sessionId) ?? []),
        ...(saved?.collaboration.tasks.map((t) => t.targetSession) ?? []),
      ],
    });
    await writeFile(join(dir, 'acceptance-evidence.json'), JSON.stringify(snapshot, null, 2) + '\n');
    if (passed && !planningOnly) {
      acceptance = evaluateAcceptance(snapshot);
      passed = acceptance.passed;
      if (!passed)
        error =
          'Native evidence acceptance failed: ' +
          acceptance.findings
            .filter((f) => f.severity !== 'warning')
            .map((f) => f.code)
            .join(', ');
    }
    findings.push(...(acceptance?.findings ?? diagnoseAcceptance(snapshot)));
  } catch (e) {
    passed = false;
    error = [error, safeError(e)].filter(Boolean).join('; ');
    findings.push({
      stage: 'verification',
      code: 'evidence-capture-failed',
      severity: 'error',
      detail: safeError(e),
    });
  }
  await writeFile(
    join(dir, 'live-team.json'),
    JSON.stringify(
      {
        passed,
        home,
        root,
        sameProject,
        processExitConfirmed: ended,
        limits: liveLimits,
        metrics: await liveMetrics(home),
        diagnostics,
        acceptance,
        findings,
        planningOnly,
        observerTimeoutMs,
        planningDurationMs,
        initialBuild,
        finalBuild,
        timestamp: new Date().toISOString(),
        durationMs: Date.now() - started,
        outputTokens,
        masterModel: model.id,
        models: [model, otherModel].map((m) => ({
          id: m.id,
          model: m.model,
          host: new URL(m.baseURL).hostname,
        })),
        projects,
        error,
        approvedCommand: verification,
        approvedToolCalls: [...approvalDecisions]
          .filter(([, outcome]) => outcome === 'allowed-once')
          .map(([id]) => id),
        approvalDecisions: Object.fromEntries(approvalDecisions),
        approvedCommands: Object.fromEntries(commandByCall),
        operatorReviewedCommands: reviewedCommands,
        records: saved?.collaboration.coordinations,
        tasks: saved?.collaboration.tasks,
        scope: planningOnly
          ? 'Production CLI / Windows ConPTY, original two-model/two-project natural goal; acceptance stops at actual durable dispatch. Worker verification and review intentionally not assessed.'
          : `${sameProject ? 'Two panes, one project' : 'Three panes, two projects'} with two distinct configured models through production CLI / Windows ConPTY. Natural goal, automatic allocation, implementation, independent verification/review and final acceptance. No test-issued orchestration calls. Only inspected local fixture edits and read-only commands approved. Repair, failure, invalid plans, cancellation and restart covered by deterministic tests.`,
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
    ? planningOnly
      ? 'PASS real multi-model planning and dispatch only'
      : 'PASS real multi-model multi-project automatic followthrough'
    : 'FAIL see configured live-team.json',
);
process.exit(passed ? 0 : 1);
