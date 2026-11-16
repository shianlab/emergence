import xterm from '@xterm/headless';
import { spawn } from 'node-pty';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { saveConfig } from '../src/app/config.ts';
import { defaultConfig } from '../src/core/domain/configuration.ts';
import { exitTerminal, sendTerminalInput } from './fixtures/terminal-interaction.ts';
import { richModelServer } from './fixtures/tui-rich-server.ts';
const dir = resolve('../artifacts/tui-phase2');
await mkdir(dir, { recursive: true });
const root = await mkdtemp(join(dir, 'terminal-')),
  home = join(root, 'home'),
  cwd = join(root, '项目');
await mkdir(cwd);
await writeFile(join(cwd, 'literal.md'), '# TOOL_RAW **literal_tool**\nsecond literal line\n');
const server = await richModelServer(),
  config = structuredClone(defaultConfig);
config.models[0] = { ...config.models[0], baseURL: server.baseURL, apiKeyEnv: 'TUI_RICH_TERMINAL_KEY' };
await saveConfig(home, config);
const terminal = new xterm.Terminal({ cols: 120, rows: 70, allowProposedApi: true });
const child = spawn(process.execPath, [resolve('bin/emergence.cjs'), cwd, '--home', home], {
  cwd: process.cwd(),
  cols: 120,
  rows: 70,
  useConptyDll: true,
  env: {
    ...process.env,
    TERM: 'xterm-256color',
    TUI_RICH_TERMINAL_KEY: 'rich-local-secret',
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
    await delay(40);
  }
  frames.failure = screen();
  throw new Error(label + '\n' + screen());
}
const send = (value: string) => sendTerminalInput(value, screen, (data) => child.write(data));
try {
  await until('home ready', () => screen().includes('描述你要完成'));
  await send('tui-rich:render # USER_RAW **literal_user**');
  await until('rich reply', () => screen().includes('PHASE2_RICH_COMPLETE'));
  let frame = screen();
  frames.rich = frame;
  assert.ok(frame.includes('加粗重点'));
  assert.ok(!frame.includes('**加粗重点**'));
  assert.ok(!frame.includes('# 已完成首轮检查'));
  assert.ok(frame.includes('**literal_code**'));
  assert.ok(frame.includes('**literal_user**'));
  checks.actualCLIConcealsMarkdownOnlyForAssistant = true;
  let bold = false;
  for (let y = 0; y < terminal.rows; y++)
    for (let x = 0; x < terminal.cols; x++) {
      const cell = terminal.buffer.active.getLine(y)?.getCell(x);
      if (cell?.getChars() === '加') bold = Boolean(cell.isBold());
    }
  assert.ok(bold);
  checks.boldStyleSurvivesConPTY = true;
  assert.equal(server.requests.length, 1);
  await send('/view raw');
  await until('raw source', () => screen().includes('**加粗重点**'));
  await send('/view render');
  await until('render restored', () => screen().includes('加粗重点') && !screen().includes('**加粗重点**'));
  assert.equal(server.requests.length, 1);
  checks.sourceActionsDoNotCallModel = true;
  await send('tui-rich:tool');
  await until('tool completes', () => screen().includes('PHASE2_TOOL_COMPLETE'));
  await send('/view tools');
  await until('literal tool details', () => screen().includes('**literal_tool**'));
  assert.ok(screen().includes('read · 完成'));
  assert.ok(screen().includes('# TOOL_RAW'));
  frames.tool = screen();
  checks.realToolResultsStayLiteral = true;
  child.resize(80, 36);
  terminal.resize(80, 36);
  await until(
    'narrow view',
    () => screen().includes('PHASE2_TOOL_COMPLETE') && screen().includes('deepseek-flash'),
  );
  frames.narrow = screen();
  checks.resizeRetainsConversation = true;
  await exitTerminal(screen, (data) => child.write(data));
  const code = await Promise.race([
    exited,
    delay(15000).then(() => {
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
  assert.ok(logs.includes('**加粗重点**'));
  assert.ok(logs.includes('**literal_tool**'));
  assert.ok(!bytes.includes('rich-local-secret'));
  checks.rawHistoryAndSecretRedaction = true;
  await writeFile(
    join(dir, 'terminal.json'),
    JSON.stringify({ passed: true, root, checks, frames, calls: server.requests.length }, null, 2),
  );
  console.log(JSON.stringify(checks));
} catch (error) {
  await writeFile(
    join(dir, 'terminal.json'),
    JSON.stringify({ passed: false, root, error: String(error), checks, frames }, null, 2),
  );
  throw error;
} finally {
  if (!ended) child.kill();
  terminal.dispose();
  await server.close();
}
process.exit(0);
