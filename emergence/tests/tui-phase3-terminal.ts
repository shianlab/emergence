import xterm from '@xterm/headless';
import { spawn } from 'node-pty';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { saveConfig } from '../src/app/config.ts';
import { defaultConfig } from '../src/core/domain/configuration.ts';
import { modelServer } from './fixtures/model-server.ts';
import { exitTerminal, sendTerminalInput } from './fixtures/terminal-interaction.ts';

const dir = resolve('../artifacts/tui-phase3');
await mkdir(dir, { recursive: true });
const root = await mkdtemp(join(dir, 'terminal-')),
  home = join(root, 'home'),
  cwd = join(root, '中文 项目');
await mkdir(cwd);
const server = await modelServer(),
  config = structuredClone(defaultConfig);
config.models[0] = { ...config.models[0], apiKeyEnv: 'TUI_COMPOSER_TERMINAL_KEY', baseURL: server.baseURL };
await saveConfig(home, config);
const terminal = new xterm.Terminal({ cols: 120, rows: 40, allowProposedApi: true });
const child = spawn(process.execPath, [resolve('bin/emergence.cjs'), cwd, '--home', home], {
  cwd: process.cwd(),
  cols: 120,
  rows: 40,
  useConptyDll: true,
  env: {
    ...process.env,
    TERM: 'xterm-256color',
    TUI_COMPOSER_TERMINAL_KEY: 'phase3-local-secret',
    NODE_OPTIONS: '',
    NODE_PATH: '',
  },
});
let bytes = '',
  ended = false;
child.onData((value) => {
  bytes += value;
  terminal.write(value);
});
const exited = new Promise<number>((done) =>
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
const frames: Record<string, string> = {},
  checks: Record<string, boolean> = {};
async function until(label: string, predicate: () => boolean) {
  for (let i = 0; i < 450; i++) {
    if (predicate()) return;
    if (ended) break;
    await delay(35);
  }
  frames.failure = screen();
  throw new Error(label + '\n' + screen());
}
const paste = (value: string) => child.write(`\x1b[200~${value}\x1b[201~`);
const esc = async () => {
  child.write('\x1b');
  await delay(180);
};
const ctrlP = async () => {
  child.write('\x10');
  await delay(120);
};
const send = (value: string) => sendTerminalInput(value, screen, (data) => child.write(data));
try {
  await until('home', () => screen().includes('描述你要完成'));
  child.write('/');
  await until(
    'home slash menu',
    () => screen().includes('选择你要进行的操作') && screen().includes('/model'),
  );
  frames.homeCommands = screen();
  assert.equal(server.calls.length, 0);
  child.write('模型');
  await until('home Chinese search', () => screen().includes('切换模型') && !screen().includes('/new'));
  child.write('\r');
  await until('home model choice', () => screen().includes('选择模型'));
  // Opening a command arms a 350 ms cross-request Enter guard. Wait past it
  // before submitting the next command; fast machines otherwise drop this Enter.
  await esc();
  child.write('\x01');
  paste('/帮助');
  await delay(400);
  child.write('\r');
  await until('home Chinese help', () => screen().includes('涌现使用帮助'));
  frames.homeHelp = screen();
  await esc();
  child.write('\x01');
  paste('/not-a-command');
  await delay(120);
  child.write('\r');
  await delay(200);
  assert.equal(server.calls.length, 0);
  assert.ok(screen().includes('没有匹配项'));
  await esc();
  child.write('\x01');
  child.write('\x7f');
  await delay(100);
  checks.homeSlashChineseHelpAndUnknownCommandStayLocal = true;
  const first = '  中文输入🙂\n  保留第二行缩进\n第三行  ';
  paste(first);
  await delay(200);
  assert.equal(server.calls.length, 0);
  assert.ok(screen().includes('第三行'));
  child.write('\r');
  await until('first reply', () => screen().includes('OPENAI_OK') && screen().includes('就绪'));
  assert.equal(server.calls.length, 1);
  checks.firstMultilineInputSendsExactlyOnce = true;
  const draft = '命令取消后保留🙂\n第二行草稿';
  paste(draft);
  await delay(150);
  await ctrlP();
  paste('模型');
  await until('filtered commands', () => screen().includes('/model') && screen().includes('Tokens'));
  frames.palette = screen();
  assert.ok(!screen().includes('/split right'));
  await esc();
  assert.ok(screen().includes('命令取消后保留'));
  assert.ok(screen().includes('第二行草稿'));
  checks.paletteSearchAndCancelPreserveChineseDraft = true;
  await ctrlP();
  paste('/model');
  await delay(100);
  child.write('\r');
  await until(
    'model listing',
    () => screen().includes('选择当前窗口模型') && screen().includes('deepseek-flash'),
  );
  assert.equal(server.calls.length, 1);
  await esc();
  assert.ok(screen().includes('第二行草稿'));
  checks.localCommandsDoNotSubmitChatDraft = true;
  await ctrlP();
  paste('/model missing-config');
  await delay(120);
  child.write('\r');
  await until(
    'failed command retained',
    () => screen().includes('模型配置不存在') && screen().includes('/model missing-config'),
  );
  await esc();
  assert.ok(screen().includes('命令取消后保留'));
  checks.failedCommandCanBeCorrectedWithoutLosingDraft = true;
  child.write('\x01');
  paste('/he');
  await until('slash completion', () => screen().includes('/help') && screen().includes('命令'));
  child.write('\r');
  await until('help panel', () => screen().includes('开始对话'));
  await esc();
  checks.slashPickerRunsImplementedCommand = true;
  await send('phase2:cancel');
  await until('running hint', () => screen().includes('Tokens') && screen().includes('正在输出'));
  paste('等待任务一');
  await delay(100);
  child.write('\r');
  await delay(150);
  paste('等待任务二');
  await delay(100);
  child.write('\r');
  await until('two queued', () => screen().includes('排队 2'));
  frames.queued = screen();
  assert.equal(server.calls.length, 2);
  paste('运行期间新草稿🙂');
  await delay(120);
  child.resize(80, 26);
  terminal.resize(80, 26);
  await until(
    'narrow running state',
    () => screen().includes('排队 2') && screen().includes('Tokens') && screen().includes('运行期间新草稿'),
  );
  checks.runningQueueAndResizeKeepUnsentDraft = true;
  await esc();
  await until('stopped', () => screen().includes('已停止当前任务') && screen().includes('Tokens'));
  assert.ok(screen().includes('运行期间新草稿'));
  assert.ok(!screen().includes('排队 2'));
  assert.equal(server.calls.length, 2);
  checks.stopCancelsActiveAndQueuedWorkOnly = true;
  await send('/bind escape F9');
  await esc();
  child.write('\x01');
  paste('phase2:cancel');
  await delay(100);
  child.write('\r');
  await until('configured stop hint', () => screen().includes('Tokens') && !screen().includes('○ 就绪'));
  child.write('\x1b[20~');
  await until(
    'configured stop key',
    () => screen().includes('已停止当前任务') && screen().includes('Tokens'),
  );
  checks.configuredStopKeyWorksWithoutPersistentHints = true;
  await exitTerminal(screen, (data) => child.write(data));
  const code = await Promise.race([
    exited,
    delay(12000).then(() => {
      throw new Error('Exit timeout');
    }),
  ]);
  assert.equal(code, 0);
  assert.equal(terminal.buffer.active.type, 'normal');
  assert.ok(bytes.includes('\x1b[?25h'));
  checks.cleanExitRestoresTerminal = true;
  const logs = (
    await Promise.all(
      (await readdir(join(home, 'sessions'), { recursive: true }))
        .filter((file) => file.endsWith('.jsonl'))
        .map((file) => readFile(join(home, 'sessions', file), 'utf8')),
    )
  ).join('\n');
  assert.ok(logs.includes('保留第二行缩进'));
  assert.ok(logs.includes('  中文输入🙂'));
  assert.ok(logs.includes('第三行  '));
  assert.ok(!bytes.includes('phase3-local-secret'));
  checks.originalMultilineHistoryAndSecretRedaction = true;
  await writeFile(
    join(dir, 'terminal.json'),
    JSON.stringify({ passed: true, root, checks, frames, calls: server.calls.length }, null, 2),
  );
  console.log(JSON.stringify(checks));
} catch (error) {
  await writeFile(
    join(dir, 'terminal.json'),
    JSON.stringify({ passed: false, root, error: String(error), checks, frames, frame: screen() }, null, 2),
  );
  throw error;
} finally {
  if (!ended) child.kill();
  terminal.dispose();
  await server.close();
}
process.exit(0);
