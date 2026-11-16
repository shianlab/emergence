import xterm from '@xterm/headless';
import { spawn } from 'node-pty';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { saveConfig } from '../src/app/config.ts';
import { defaultConfig } from '../src/core/domain/configuration.ts';
import { modelServer } from './fixtures/model-server.ts';

const dir = resolve('../artifacts/experience-e1');
await mkdir(dir, { recursive: true });
const root = await mkdtemp(join(dir, 'terminal-')),
  home = join(root, 'home'),
  cwd = join(root, '中文 项目');
await mkdir(cwd);
const server = await modelServer(),
  config = structuredClone(defaultConfig);
config.models = [
  {
    ...config.models[0],
    id: 'local',
    provider: 'Local',
    model: 'fixture-openai',
    baseURL: server.baseURL,
    apiKeyEnv: 'E1_TEST_KEY',
  },
];
config.defaultModel = 'local';
await saveConfig(home, config);
const terminal = new xterm.Terminal({ cols: 120, rows: 38, allowProposedApi: true });
const child = spawn(process.execPath, [resolve('bin/emergence.cjs'), cwd, '--home', home], {
  cwd: process.cwd(),
  cols: 120,
  rows: 38,
  useConptyDll: true,
  env: {
    ...process.env,
    E1_TEST_KEY: 'local-fixture-secret',
    TERM: 'xterm-256color',
    NODE_OPTIONS: '',
    NODE_PATH: '',
  },
});
let ended = false,
  bytes = '';
child.onData((text) => {
  bytes += text;
  terminal.write(text);
});
const exit = new Promise<number>((done) =>
  child.onExit((e) => {
    ended = true;
    done(e.exitCode);
  }),
);
const screen = () =>
  Array.from(
    { length: terminal.rows },
    (_, y) => terminal.buffer.active.getLine(y)?.translateToString(true) ?? '',
  ).join('\n');
const checks: Record<string, boolean> = {},
  frames: Record<string, string> = {};
async function until(label: string, predicate: () => boolean) {
  for (let i = 0; i < 350; i++) {
    if (predicate()) return;
    if (ended) break;
    await delay(40);
  }
  throw new Error(`${label}\n${screen()}\n${bytes.slice(-400)}`);
}
async function send(text: string) {
  child.write(`\x1b[200~${text}\x1b[201~`);
  await delay(100);
  child.write('\r');
}
async function answer(keys = '\r') {
  await delay(400);
  child.write(keys);
}
try {
  await until('首页', () => screen().includes('描述你要完成'));
  child.write('\x1b[200~尚未发送的草稿🙂\x1b[201~');
  await delay(180);
  child.write('\x03');
  await delay(180);
  assert.equal(ended, false);
  assert.ok(!screen().includes('尚未发送的草稿'));
  checks.homeCtrlCClearsDraft = true;
  await send('phase2:question');
  await until('结构化问题', () => screen().includes('请选择验证颜色') && screen().includes('蓝色'));
  frames.question = screen();
  await answer('\x1b[B\r');
  await until('问题完成', () => screen().includes('QUESTION_COMPLETE') && screen().includes('就绪'));
  checks.arrowQuestion = true;
  await send('phase2:shell');
  await until('拒绝命令', () => screen().includes('需要确认：pwsh') && screen().includes('允许本次'));
  frames.permission = screen();
  await answer('\x1b[B\r');
  await until('拒绝返回', () => screen().includes('OPENAI_OK') && screen().includes('就绪'));
  checks.arrowReject = true;
  await send('phase2:shell');
  await until('允许命令', () => screen().includes('需要确认：pwsh'));
  await answer();
  await until(
    '命令实际执行',
    () =>
      screen().includes('SHELL_APPROVED') &&
      (screen().includes('└ 完成') || screen().includes('pwsh · 完成')) &&
      screen().includes('就绪'),
  );
  checks.enterExecutesTool = true;
  await send('phase2:shell');
  await until('取消命令', () => screen().includes('需要确认：pwsh'));
  await answer('\x1b');
  await until('取消后继续', () => screen().includes('OPENAI_OK') && screen().includes('就绪'));
  assert.equal(ended, false);
  checks.escapeCancelsApproval = true;
  await send('phase2:cancel');
  await until('流式输出', () => screen().includes('正在等待取消'));
  child.write('\x03');
  await until('停止当前任务', () => server.cancelled > 0 && screen().includes('已停止当前任务'));
  assert.equal(ended, false);
  checks.ctrlCStopsWithoutExit = true;
  child.resize(64, 24);
  terminal.resize(64, 24);
  await delay(200);
  frames.narrow = screen();
  child.resize(120, 38);
  terminal.resize(120, 38);
  await delay(200);
  child.write('\x03');
  await until('退出提示', () => screen().includes('再次按 Ctrl+C'));
  assert.equal(ended, false);
  child.write('\x03');
  const code = await Promise.race([
    exit,
    delay(10000).then(() => {
      throw new Error('Exit timeout');
    }),
  ]);
  assert.equal(code, 0);
  assert.equal(terminal.buffer.active.type, 'normal');
  checks.doubleCtrlCRestoresTerminal = true;
  const files = await readdir(join(home, 'sessions'), { recursive: true });
  const records = (
    await Promise.all(
      files.filter((f) => f.endsWith('.jsonl')).map((f) => readFile(join(home, 'sessions', f), 'utf8')),
    )
  )
    .join('\n')
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l));
  const decisions = records.filter((r) => r.type === 'approval/decided').map((r) => r.data.outcome);
  assert.deepEqual(decisions, ['rejected', 'allowed-once', 'cancelled']);
  assert.ok(records.some((r) => r.type === 'tool/result' && JSON.stringify(r.data).includes('绿色')));
  checks.auditMatchesKeys = true;
  assert.equal(bytes.includes('local-fixture-secret'), false);
  checks.noCredentialInTerminal = true;
  await writeFile(
    join(dir, 'terminal.json'),
    JSON.stringify({ passed: true, timestamp: new Date().toISOString(), checks, frames, root }, null, 2),
  );
  console.log(JSON.stringify(checks));
} catch (error) {
  await writeFile(
    join(dir, 'terminal.json'),
    JSON.stringify({ passed: false, error: String(error), checks, frames, root, frame: screen() }, null, 2),
  );
  console.error(error);
  process.exitCode = 1;
} finally {
  if (!ended) child.kill();
  terminal.dispose();
  await server.close();
}
process.exit(process.exitCode ?? 0);
