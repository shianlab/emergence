import xterm from '@xterm/headless';
import { spawn } from 'node-pty';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { saveConfig } from '../src/app/config.ts';
import { enterWorkspace } from './fixtures/enter-workspace.ts';
import { modelServer } from './fixtures/model-server.ts';
import { exitTerminal, sendTerminalInput } from './fixtures/terminal-interaction.ts';

const root = await mkdtemp(resolve('../artifacts/phase2/terminal-'));
const home = join(root, 'home'),
  project = join(root, '中文 项目');
await mkdir(project);
const server = await modelServer();
await saveConfig(home, {
  version: 1,
  defaultModel: 'local',
  shellMode: 'ask-local',
  models: [
    {
      id: 'local',
      provider: 'Local',
      model: 'fixture-openai',
      api: 'openai-completions',
      baseURL: server.baseURL,
      apiKeyEnv: 'PHASE2_TEST_KEY',
      contextWindow: 128000,
      maxTokens: 8192,
    },
    {
      id: 'anthropic',
      provider: 'Anthropic',
      model: 'fixture-anthropic',
      api: 'anthropic-messages',
      baseURL: server.baseURL,
      apiKeyEnv: 'PHASE2_TEST_KEY',
      contextWindow: 128000,
      maxTokens: 8192,
    },
  ],
  mcp: [],
  skillDirs: [],
});
const terminal = new xterm.Terminal({ cols: 110, rows: 34, allowProposedApi: true });
const quote = (s: string) => "'" + s.replaceAll("'", "''") + "'";
const command = `& ${quote(process.execPath)} ${quote(resolve('bin/emergence.cjs'))} ${quote(project)} --home ${quote(home)}; Write-Output EMERGENCE_RETURNED`;
const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', command], {
  cwd: process.cwd(),
  cols: 110,
  rows: 34,
  useConptyDll: true,
  env: { ...process.env, PHASE2_TEST_KEY: 'phase2-test-secret', TERM: 'xterm-256color' },
});
let bytes = '',
  ended = false;
child.onData((text) => {
  bytes += text;
  terminal.write(text);
});
const exit = new Promise<number>((resolveExit) =>
  child.onExit((e) => {
    ended = true;
    resolveExit(e.exitCode);
  }),
);
const screen = () =>
  Array.from(
    { length: terminal.rows },
    (_, y) => terminal.buffer.active.getLine(y)?.translateToString(true) ?? '',
  ).join('\n');
const frames: Record<string, string> = {};
async function until(name: string, predicate: () => boolean, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (predicate()) return;
    if (ended) break;
    await delay(50);
  }
  frames.failure = screen();
  throw new Error(`Terminal timeout: ${name}\n${screen()}\n${bytes.slice(-1200)}`);
}
async function send(text: string) {
  await sendTerminalInput(text, screen, (bytes) => child.write(bytes));
}
const checks: Record<string, boolean> = {};
try {
  await until(
    'ready',
    () =>
      (screen().includes('输入任务或 /help') ||
        screen().includes('Task or /help') ||
        screen().includes('描述你要完成') ||
        screen().includes('Describe your task')) &&
      screen().includes('就绪'),
  );
  await enterWorkspace(screen, (bytes) => child.write(bytes), until);
  frames.ready = screen();
  checks.startup = true;
  await send('phase2:question');
  await until('question', () => screen().includes('请选择验证颜色'));
  frames.question = screen();
  await send('1');
  await until('question complete', () => screen().includes('QUESTION_COMPLETE'));
  checks.questionAnswered = true;
  await send('phase2:shell');
  await until('approval', () => screen().includes('需要确认：pwsh'));
  frames.approval = screen();
  await send('n');
  await until('deny complete', () => screen().includes('OPENAI_OK') && screen().includes('就绪'));
  checks.approvalRejected = true;
  await send('phase2:shell');
  await until('second approval', () => screen().includes('需要确认：pwsh'));
  await send('y');
  await until(
    'allow complete',
    () =>
      (screen().includes('└ 完成') || screen().includes('pwsh · 完成')) &&
      screen().includes('SHELL_APPROVED') &&
      screen().includes('就绪'),
  );
  frames.allowed = screen();
  checks.approvalAllowed = true;
  await send('phase2:cancel');
  await until('stream running', () => screen().includes('正在等待取消'));
  child.write('\x1b');
  await until('cancel complete', () => server.cancelled > 0 && screen().includes('已停止当前任务'));
  checks.cancelledStream = true;
  await send('/model anthropic');
  await until('model switched', () => screen().includes('Anthropic/fixture-anthropic'));
  await send('hello');
  await until('second protocol', () => screen().includes('ANTHROPIC_OK'));
  checks.modelSwitch = true;
  child.resize(55, 24);
  terminal.resize(55, 24);
  await delay(200);
  frames.narrow = screen();
  child.resize(110, 34);
  terminal.resize(110, 34);
  await delay(200);
  await exitTerminal(screen, (bytes) => child.write(bytes));
  const exitCode = await Promise.race([
    exit,
    delay(15000).then(() => {
      throw new Error('Shutdown timeout');
    }),
  ]);
  checks.cleanExit = exitCode === 0;
  checks.shellReturned = bytes.includes('EMERGENCE_RETURNED');
  checks.normalBufferRestored = terminal.buffer.active.type === 'normal';
  const files = await readdir(join(home, 'sessions'), { recursive: true });
  const logs = (
    await Promise.all(
      files.filter((f) => f.endsWith('.jsonl')).map((f) => readFile(join(home, 'sessions', f), 'utf8')),
    )
  ).join('\n');
  checks.approvalAuditSaved =
    logs.includes('approval/decided') && logs.includes('rejected') && logs.includes('allowed-once');
  const records = logs
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line));
  checks.questionSaved = records.some(
    (record) =>
      record.type === 'tool/result' &&
      !record.data.message.isError &&
      record.data.message.content.some(
        (block: { type: string; text?: string }) =>
          block.type === 'text' && block.text?.includes('"selected":["蓝色"]'),
      ),
  );
  checks.noSecretInUI = !bytes.includes('phase2-test-secret');
  for (const [name, value] of Object.entries(checks)) assert.equal(value, true, name);
  await writeFile(
    resolve('../artifacts/phase2/terminal.json'),
    JSON.stringify({ passed: true, root, checks, frames, calls: server.calls }, null, 2),
  );
  console.log(JSON.stringify(checks, null, 2));
} catch (error) {
  await writeFile(
    resolve('../artifacts/phase2/terminal.json'),
    JSON.stringify({ passed: false, root, checks, frames, error: String(error) }, null, 2),
  );
  console.error(error);
  process.exitCode = 1;
} finally {
  if (!ended) child.kill();
  terminal.dispose();
  await server.close();
}
// Dedicated Windows integration driver: node-pty retains its conout worker after a natural child exit.
process.exit(process.exitCode ?? 0);
