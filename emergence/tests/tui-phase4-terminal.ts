import xterm from '@xterm/headless';
import { spawn } from 'node-pty';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { saveConfig } from '../src/app/config.ts';
import { defaultConfig } from '../src/core/domain/configuration.ts';
import { configurationModelServer } from './fixtures/configuration-model-server.ts';
import { exitTerminal, sendTerminalInput } from './fixtures/terminal-interaction.ts';

// The shipped CLI uses independent sessions. tui-phase4.ts separately covers
// native task details, inspector keyboard isolation and background approvals.
const dir = resolve('../artifacts/tui-phase4');
await mkdir(dir, { recursive: true });
const root = await mkdtemp(join(dir, 'terminal-')),
  home = join(root, 'home'),
  firstProject = join(root, '项目 一'),
  secondProject = join(root, '项目 二');
await mkdir(firstProject);
await mkdir(secondProject);
const server = await configurationModelServer(),
  config = structuredClone(defaultConfig);
config.defaultModel = 'first';
config.models = ['first', 'second'].map((id) => ({
  ...config.models[0],
  id,
  provider: id,
  model: 'fixture-' + id,
  apiKeyEnv: 'TUI_PANES_TERMINAL_KEY',
  baseURL: server.baseURL,
}));
await saveConfig(home, config);
const terminal = new xterm.Terminal({ cols: 160, rows: 46, allowProposedApi: true });
const child = spawn(process.execPath, [resolve('bin/emergence.cjs'), firstProject, '--home', home], {
  cwd: process.cwd(),
  cols: 160,
  rows: 46,
  useConptyDll: true,
  env: {
    ...process.env,
    TERM: 'xterm-256color',
    TUI_PANES_TERMINAL_KEY: 'fixture-secret-value',
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
type State = {
  focused: string;
  panes: Array<{ id: string; sessionId: string; draft: string; cwd: string; modelId: string }>;
  collaboration: { master?: string; workers: string[]; tasks: unknown[] };
};
async function state(): Promise<State | undefined> {
  try {
    const name = (await readdir(join(home, 'workspaces'))).find((file) => file.endsWith('.json'))!;
    return JSON.parse(await readFile(join(home, 'workspaces', name), 'utf8'));
  } catch {
    return undefined;
  }
}
const checks: Record<string, boolean> = {},
  frames: Record<string, string> = {};
async function until(label: string, predicate: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 450; i++) {
    if (await predicate()) return;
    if (ended) break;
    await delay(40);
  }
  throw new Error(label + '\n' + screen());
}
const send = (value: string) => sendTerminalInput(value, screen, (data) => child.write(data));
try {
  await until('home', () => screen().includes('描述你要完成'));
  assert.equal(server.calls.length, 0);
  await send('hello');
  await until('workspace', () => screen().includes('CONFIG_REPLY:fixture-first'));
  checks.homeWaitsForFirstSubmission = true;
  await send(`/split right "${secondProject}" second`);
  await until('two panes', async () => (await state())?.panes.length === 2);
  await until(
    'independent header',
    () => screen().includes('独立模式') && screen().includes('second/fixture-second'),
  );
  const identity = (await state())!;
  assert.equal(identity.panes[0].cwd, firstProject);
  assert.equal(identity.panes[1].cwd, secondProject);
  assert.equal(identity.panes[1].modelId, 'second');
  assert.equal(identity.collaboration.master, undefined);
  assert.equal('workers' in identity.collaboration, false);
  assert.doesNotMatch(screen(), /主控|执行窗口|协作模式/);
  checks.independentProjectsAndModels = true;
  await send('hello second');
  await until('second response', () => screen().includes('CONFIG_REPLY:fixture-second'));
  assert.ok(server.calls.some((call) => call.model === 'fixture-first' && call.stream));
  assert.ok(server.calls.some((call) => call.model === 'fixture-second' && call.stream));
  checks.eachWindowRoutesToItsOwnModel = true;
  await send('/focus 1');
  await until('first focused', async () => (await state())?.focused === identity.panes[0].id);
  const draft = '检查期间保留🙂\n第二行草稿';
  child.write(`\x1b[200~${draft}\x1b[201~`);
  await until('draft persisted', async () => (await state())?.panes[0].draft === draft);
  const calls = server.calls.length;
  await send('/focus 2');
  await until('second focused', async () => (await state())?.focused === identity.panes[1].id);
  assert.equal((await state())!.panes[0].draft, draft);
  assert.equal(server.calls.length, calls);
  await send('/focus 1');
  await until('draft restored', () => screen().includes('检查期间保留') && screen().includes('第二行草稿'));
  checks.focusSwitchPreservesDraftWithoutModelCalls = true;
  frames.wide = screen();
  child.resize(48, 22);
  terminal.resize(48, 22);
  await until('narrow input', () => screen().includes('检查期间保留') && screen().includes('Tokens'));
  assert.equal((await state())!.panes[0].draft, draft);
  frames.narrow = screen();
  child.resize(160, 46);
  terminal.resize(160, 46);
  await until('wide restored', () => screen().includes('second/fixture-second'));
  assert.equal((await state())!.panes[0].draft, draft);
  checks.resizePreservesDraftAndUsageFooter = true;
  await send('/focus 2');
  await send('/terminate');
  await until('second closed', async () => (await state())?.panes.length === 1);
  assert.equal((await state())!.panes[0].id, identity.panes[0].id);
  assert.equal((await state())!.panes[0].draft, draft);
  checks.closeKeepsOtherSessionAndDraft = true;
  assert.equal(server.calls.length, calls);
  assert.doesNotMatch(screen(), /Enter 发送|Shift\+Enter 换行|F2\/F3 分屏/);
  checks.chromeActionsDoNotCallModelOrRestoreShortcutClutter = true;
  await exitTerminal(screen, (value) => child.write(value));
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const code = await Promise.race([
      exited,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Exit timeout')), 15000);
      }),
    ]);
    assert.equal(code, 0);
  } finally {
    clearTimeout(timeout);
  }
  await new Promise<void>((done) => terminal.write('', done));
  assert.equal(terminal.buffer.active.type, 'normal');
  assert.ok(bytes.includes('\x1b[?25h'));
  assert.ok(!bytes.includes('fixture-secret-value'));
  checks.cleanExitRestoresTerminalAndRedactsSecrets = true;
  await writeFile(
    join(dir, 'terminal.json'),
    JSON.stringify({ passed: true, root, checks, frames }, null, 2),
  );
  console.log(JSON.stringify(checks));
} catch (error) {
  await writeFile(
    join(dir, 'terminal.json'),
    JSON.stringify({ passed: false, root, error: String(error), checks, frames, frame: screen() }, null, 2),
  );
  console.error(error);
  process.exitCode = 1;
} finally {
  if (!ended) child.kill();
  terminal.dispose();
  await server.close();
}
process.exit(process.exitCode ?? 0);
