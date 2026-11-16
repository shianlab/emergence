// Explicit, opt-in live supplier smoke test. Not included in the recurring inspector.
import xterm from '@xterm/headless';
import { spawn } from 'node-pty';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { homeDirectory, loadConfig, saveConfig } from '../src/app/config.ts';
import { hydrateCredentials } from '../src/app/credentials.ts';
import { safeError } from '../src/core/adapters/redaction.ts';
import type { CollaborationState } from '../src/core/domain/task.ts';

const originalHome = homeDirectory(),
  config = await loadConfig(originalHome);
const model = config.models.find((m) => m.provider === 'deepseek' && m.model === 'deepseek-flash');
if (!model) throw new Error('No configured DeepSeek Flash model');
await hydrateCredentials(originalHome, [model.apiKeyEnv]);
if (!process.env[model.apiKeyEnv]) throw new Error('DeepSeek credential unavailable');
const artifacts = resolve('../artifacts/phase4');
await mkdir(artifacts, { recursive: true });
const root = await mkdtemp(join(artifacts, 'live-')),
  home = join(root, 'home'),
  a = join(root, '项目 A'),
  b = join(root, '项目 B');
await mkdir(a);
await mkdir(b);
await saveConfig(home, {
  ...config,
  defaultModel: model.id,
  models: [{ ...model, maxTokens: 2048 }],
  mcp: [],
  skillDirs: [],
});
type Saved = {
  focused: string;
  panes: Array<{ id: string; sessionId: string }>;
  collaboration: CollaborationState;
};
async function state(): Promise<Saved | undefined> {
  try {
    const file = (await readdir(join(home, 'workspaces'))).find((n) => n.endsWith('.json'))!;
    return JSON.parse(await readFile(join(home, 'workspaces', file), 'utf8'));
  } catch {
    return undefined;
  }
}
const terminal = new xterm.Terminal({ cols: 160, rows: 48, allowProposedApi: true });
const quote = (s: string) => "'" + s.replaceAll("'", "''") + "'";
const command = `& ${quote(process.execPath)} ${quote(resolve('bin/emergence.cjs'))} ${quote(a)} --home ${quote(home)} --fresh; Write-Output EMERGENCE_RETURNED`;
const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', command], {
  cwd: process.cwd(),
  cols: 160,
  rows: 48,
  useConptyDll: true,
  env: { ...process.env, TERM: 'xterm-256color' },
});
let ended = false,
  bytes = '';
child.onData((text) => {
  bytes += text;
  terminal.write(text);
});
const exit = new Promise<number>((done) =>
  child.onExit((event) => {
    ended = true;
    done(event.exitCode);
  }),
);
const screen = () =>
  Array.from(
    { length: terminal.rows },
    (_, y) => terminal.buffer.active.getLine(y)?.translateToString(true) ?? '',
  ).join('\n');
async function until(label: string, predicate: () => boolean | Promise<boolean>, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return;
    if (ended) break;
    await delay(100);
  }
  throw new Error('Timeout: ' + label + '\n' + screen());
}
async function send(text: string) {
  child.write('\x01');
  child.write(`\x1b[200~${text}\x1b[201~`);
  await delay(80);
  child.write('\r');
  await delay(100);
}
let evidence: object;
try {
  await until('startup', () => screen().includes('就绪'));
  await send(`/split right "${a}" ${model.id}`);
  await until('two panes', async () => (await state())?.panes.length === 2);
  await send(`/split down "${b}" ${model.id}`);
  await until('three panes', async () => (await state())?.panes.length === 3);
  await send('/focus 1');
  await send('/mode collaborate 1 2 3');
  const panes = (await state())!.panes;
  await send(
    `执行一次有界的协作验收，只允许创建两项任务。你作为主控必须调用 emergence_dispatch：向 ${panes[1].id} 派发 request_key=live-alpha，要求在它自己的项目目录用 write 创建 live-alpha.txt，内容严格为 ALPHA_OK，然后用 read 读回并检查，最后 emergence_report 报告。向 ${panes[2].id} 派发 request_key=live-beta，要求在它自己的项目目录用 write 创建 live-beta.txt，内容严格为 BETA_OK，然后用 read 读回并检查，最后 emergence_report 报告。使用 emergence_wait 收取两项任务的实际结束回执，最后简短汇报。不要调用 shell，不要创建其他任务；收到任务回执只汇报，不再派发。`,
  );
  await until(
    'two successful real tasks',
    async () => {
      const saved = await state(),
        tasks = saved?.collaboration.tasks ?? [];
      if (tasks.length > 2) throw new Error('Bounded live test created unexpected extra tasks');
      if (tasks.some((t) => ['failed', 'needs_review', 'cancelled', 'blocked'].includes(t.status)))
        throw new Error(
          'Live task did not succeed: ' +
            JSON.stringify(tasks.map((t) => ({ id: t.id, status: t.status, result: t.result }))),
        );
      return tasks.length === 2 && tasks.every((t) => t.status === 'succeeded');
    },
    110000,
  );
  assert.equal((await readFile(join(a, 'live-alpha.txt'), 'utf8')).trim(), 'ALPHA_OK');
  assert.equal((await readFile(join(b, 'live-beta.txt'), 'utf8')).trim(), 'BETA_OK');
  await delay(1000);
  const saved = (await state())!;
  const files = (await readdir(join(home, 'sessions'), { recursive: true })).filter((n) =>
    n.endsWith('.jsonl'),
  );
  const records = (await Promise.all(files.map((f) => readFile(join(home, 'sessions', f), 'utf8')))).flatMap(
    (raw) =>
      raw
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line)),
  );
  const toolNames = records.filter((r) => r.type === 'tool/call').map((r) => r.data.name);
  assert.ok(toolNames.filter((n) => n === 'emergence_dispatch').length >= 2);
  assert.ok(toolNames.filter((n) => n === 'read').length >= 2);
  assert.ok(toolNames.filter((n) => n === 'emergence_report').length === 2);
  assert.ok(records.some((r) => r.type === 'user/message' && r.data.source.kind === 'emergence-receipt'));
  evidence = {
    timestamp: new Date().toISOString(),
    passed: true,
    provider: model.provider,
    model: model.model,
    root,
    tasks: saved.collaboration.tasks.map((t) => ({
      id: t.id,
      target: t.target,
      status: t.status,
      result: t.result,
    })),
    tools: toolNames,
    filesVerified: true,
    receiptObserved: true,
  };
  child.write('\x03');
  assert.equal(
    await Promise.race([
      exit,
      delay(15000).then(() => {
        throw new Error('Live UI shutdown timeout');
      }),
    ]),
    0,
  );
  assert.ok(bytes.includes('EMERGENCE_RETURNED'));
  console.log('PASS real DeepSeek master + two workers, file write/read, reports and receipt');
} catch (error) {
  evidence = {
    timestamp: new Date().toISOString(),
    passed: false,
    provider: model.provider,
    model: model.model,
    root,
    error: safeError(error),
    screen: safeError(screen()),
  };
  console.error(safeError(error));
  process.exitCode = 1;
} finally {
  if (!ended) child.kill();
  terminal.dispose();
}
await writeFile(join(artifacts, 'live-deepseek.json'), JSON.stringify(evidence!, null, 2));
process.exit(process.exitCode ?? 0);
