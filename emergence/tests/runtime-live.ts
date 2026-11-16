// Opt-in: exercises the configured real model in an isolated temporary project.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { homeDirectory, loadConfig, saveConfig } from '../src/app/config.ts';
import { hydrateCredentials } from '../src/app/credentials.ts';
import { safeError } from '../src/core/adapters/redaction.ts';
import {
  diagnosticSnapshots,
  ObservationDeadline,
  observeUntil,
  stopOwnedProcess,
} from './fixtures/observation.ts';
if (!process.argv.includes('--live')) throw new Error('Explicit --live required');
const originalHome = homeDirectory(),
  config = await loadConfig(originalHome),
  model = config.models.find((m) => m.id === config.defaultModel)!;
await hydrateCredentials(originalHome, [model.apiKeyEnv]);
const root = await mkdtemp(join(tmpdir(), 'emergence-runtime-live-')),
  home = join(root, 'home'),
  project = join(root, 'project');
await mkdir(project);
await writeFile(join(project, 'notes.txt'), 'Welcome\n');
await saveConfig(home, {
  ...config,
  models: [{ ...model, maxTokens: 1600 }],
  core: { ...config.core, mode: 'observe', planning: { ...config.core.planning, enabled: true } },
  mcp: [],
  extensions: [],
  skillDirs: [],
  permissions: { defaultMode: 'edit', rules: [] },
  toolPolicy: { deny: ['pwsh', 'bash', 'subagent', 'mcp__*', 'web_search', 'web_fetch'], confirm: [] },
});
async function run(prompt: string) {
  const child = spawn(process.execPath, ['bin/emergence.cjs', project, '--home', home, '--print', prompt], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '',
    err = '',
    ended = false,
    overflow = false;
  let code: number | null = null,
    failure: Error | undefined;
  child.once('exit', (value) => {
    code = value;
    ended = true;
  });
  child.once('error', (error) => {
    failure = error;
    ended = true;
  });
  child.stdout.on('data', (b) => {
    out += b;
    if (out.length > 600000) overflow = true;
  });
  child.stderr.on('data', (b) => {
    err += b;
    if (err.length > 600000) overflow = true;
  });
  const stop = () =>
    stopOwnedProcess(
      {
        pid: child.pid!,
        kill: () => {
          child.kill();
        },
      },
      () => ended,
    );
  try {
    await observeUntil(
      'single-window inference',
      async () => {
        if (overflow) throw new Error('Observation output limit reached');
        if (failure) throw failure;
        return ended;
      },
      {
        limitMs: 90000,
        snapshot: async () => ({ diagnostics: await diagnosticSnapshots(home), exitCode: code }),
        stop,
      },
    );
  } catch (error) {
    if (error instanceof ObservationDeadline) {
      await mkdir('../artifacts/intent-context', { recursive: true });
      await writeFile(
        '../artifacts/intent-context/runtime-observation.json',
        JSON.stringify(
          {
            kind: error.kind,
            limitMs: error.limitMs,
            lastState: error.lastState,
            cleanupError: error.cleanupError,
          },
          null,
          2,
        ),
      );
    }
    throw error;
  } finally {
    if (!ended) await stop();
  }
  if (code !== 0) throw new Error(safeError(err).slice(-1500));
  return JSON.parse(out.trim().split('\n').at(-1)!) as { transcript: string[] };
}
const identity = await run(
  '请说明你的应用名称、当前模型 ID，以及内置治理是否自动参与任务。只根据宿主状态回答，不读文件，不调用外部服务。',
);
const answer = identity.transcript.filter((s) => s.startsWith('涌现 ›')).join('\n');
assert.ok(answer.includes('Emergence') && answer.includes(model.model));
const discussion = await run(
  '我想让 notes.txt 的欢迎语更适合第一次使用的人，语气亲切一些，保留中文。先帮我理清这件事的目标和约束，给个判断就好，暂时不要修改文件。',
);
assert.equal(
  await readFile(join(project, 'notes.txt'), 'utf8'),
  'Welcome\n',
  'discussion must not modify the file',
);
const analysisResult = discussion.transcript
  .filter((s) => s.startsWith('└'))
  .map((s) => {
    try {
      return JSON.parse(s.slice(s.indexOf('{')));
    } catch {
      return null;
    }
  })
  .find((s) => s?.analysis)?.analysis;
assert.ok(analysisResult, 'natural discussion must produce host-recorded requirement analysis');
assert.equal(analysisResult.intent, 'discuss');
assert.ok(
  analysisResult.objective && analysisResult.constraints?.length && analysisResult.acceptance?.length,
);
await mkdir('../artifacts/intent-context', { recursive: true });
await writeFile(
  '../artifacts/intent-context/live.json',
  JSON.stringify(
    {
      passed: true,
      timestamp: new Date().toISOString(),
      model: model.model,
      analysis: analysisResult,
      tools: discussion.transcript.filter((s) => s.startsWith('┌ 工具')).map((s) => s.split('\n')[0]),
      unchangedFile: true,
      scope:
        'One real-provider natural discussion; semantic quality is not guaranteed for every possible input.',
    },
    null,
    2,
  ),
);
const task = await run(
  '帮我修改当前项目的 notes.txt，把 Welcome 改成 欢迎使用涌现，保留换行，完成后读回核对。只处理这一个文件。',
);
assert.equal(await readFile(join(project, 'notes.txt'), 'utf8'), '欢迎使用涌现\n');
const tools = task.transcript.filter((s) => s.startsWith('┌ 工具')).map((s) => s.split('\n')[0]);
assert.ok(
  tools.some((s) => s.includes('emergence_analyze')),
  'natural task must invoke native semantic analysis without the user naming it',
);
await mkdir('../artifacts/runtime-team', { recursive: true });
await writeFile(
  '../artifacts/runtime-team/live.json',
  JSON.stringify(
    {
      passed: true,
      timestamp: new Date().toISOString(),
      host: new URL(model.baseURL).hostname,
      model: model.model,
      identityAnswer: safeError(answer),
      tools,
      actualReadWrite: true,
      scope:
        'Real configured model; natural one-file task with no explicit core/skill/tool trigger. Isolated project; not a broad autonomy-quality benchmark.',
    },
    null,
    2,
  ),
);
console.log(
  'PASS real provider identity, natural discussion analysis without file changes, and automatic semantic intake before file edit',
);
