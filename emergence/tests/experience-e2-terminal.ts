import xterm from '@xterm/headless';
import { spawn } from 'node-pty';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { saveConfig } from '../src/app/config.ts';
import { defaultConfig } from '../src/core/domain/configuration.ts';
import { modelServer } from './fixtures/model-server.ts';
const dir = resolve('../artifacts/experience-e2');
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
    apiKeyEnv: 'E2_TEST_KEY',
  },
];
config.defaultModel = 'local';
config.permissions.rules = [{ tool: 'pwsh', effect: 'allow', command: "Write-Output 'SHELL_APPROVED'" }];
await saveConfig(home, config);
const terminal = new xterm.Terminal({ cols: 120, rows: 38, allowProposedApi: true });
const child = spawn(
  process.execPath,
  [resolve('bin/emergence.cjs'), cwd, '--home', home, '--permission', 'plan'],
  {
    cwd: process.cwd(),
    cols: 120,
    rows: 38,
    useConptyDll: true,
    env: {
      ...process.env,
      E2_TEST_KEY: 'local-e2-fixture',
      TERM: 'xterm-256color',
      NODE_OPTIONS: '',
      NODE_PATH: '',
    },
  },
);
let ended = false,
  bytes = '';
child.onData((text) => {
  bytes += text;
  terminal.write(text);
});
const exited = new Promise<number>((done) =>
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
async function until(label: string, test: () => boolean) {
  for (let i = 0; i < 400; i++) {
    if (test()) return;
    if (ended) break;
    await delay(40);
  }
  throw new Error(label + '\n' + screen());
}
async function send(text: string) {
  child.write(`\x1b[200~${text}\x1b[201~`);
  await delay(100);
  child.write('\r');
}
async function command(text: string) {
  child.write('\x10');
  await delay(100);
  await send(text);
  await delay(200);
}
async function answer(keys = '\r') {
  await delay(420);
  child.write(keys);
}
try {
  await until('home', () => screen().includes('描述你要完成'));
  await send('phase3:write:A');
  await until('plan result', () => screen().includes('WRITE_COMPLETE_A') && screen().includes('就绪'));
  await assert.rejects(access(join(cwd, 'proof-A.txt')));
  assert.ok(screen().includes('计划模式禁止'));
  checks.planPreventsRealWrite = true;
  frames.plan = screen();
  child.write('\x1b[Z');
  await until('Shift Tab', () => screen().includes('权限已切换：询问'));
  checks.legacyShiftTabWorks = true;
  await command('/new');
  await send('phase3:write:A');
  await until('ask write', () => screen().includes('需要确认：write'));
  await answer();
  await until('write done', () => screen().includes('WRITE_COMPLETE_A') && screen().includes('就绪'));
  assert.match(await readFile(join(cwd, 'proof-A.txt'), 'utf8'), /fixture-openai/);
  checks.askEnterWrites = true;
  await send('phase2:shell');
  await until('session grant', () => screen().includes('本会话允许相同操作'));
  frames.grant = screen();
  await answer('\x1b[B\x1b[B\r');
  await until('shell done', () => screen().includes('SHELL_APPROVED') && screen().includes('就绪'));
  const before = server.calls.length;
  await send('phase2:shell');
  await until('repeated shell done', () => server.calls.length >= before + 2 && screen().includes('就绪'));
  assert.ok(!screen().includes('需要确认：pwsh'));
  checks.sessionGrantReusesExactCommand = true;
  await command('/permission edit');
  await command('/new');
  await send('phase3:write:A');
  await until('edit write', () => screen().includes('WRITE_COMPLETE_A') && screen().includes('就绪'));
  assert.ok(!screen().includes('需要确认：write'));
  checks.editAutomaticallyWritesProjectFile = true;
  await command('/permission auto');
  await command('/new');
  await send('phase2:shell');
  await until('auto exact command', () => screen().includes('SHELL_APPROVED') && screen().includes('就绪'));
  assert.ok(!screen().includes('需要确认：pwsh'));
  checks.autoHonorsExactAllowRule = true;
  await command('/permission');
  await until('mode picker', () => screen().includes('执行权限') && screen().includes('按显式规则'));
  frames.menu = screen();
  await answer('\x1b[A\r');
  await until('menu applied', () => screen().includes('权限已切换：自动编辑'));
  checks.menuArrowsEnter = true;
  await command('/exit');
  assert.equal(
    await Promise.race([
      exited,
      delay(10000).then(() => {
        throw new Error('exit timeout');
      }),
    ]),
    0,
  );
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
  assert.deepEqual(
    records.filter((r) => r.type === 'approval/decided').map((r) => r.data.outcome),
    ['allowed-once', 'allowed-once'],
  );
  checks.approvalAuditMatchesTwoUserChoices = true;
  assert.equal(bytes.includes('local-e2-fixture'), false);
  checks.noSecretInTerminal = true;
  await writeFile(
    join(dir, 'terminal.json'),
    JSON.stringify({ passed: true, timestamp: new Date().toISOString(), root, checks, frames }, null, 2),
  );
  console.log(JSON.stringify(checks));
} catch (error) {
  await writeFile(
    join(dir, 'terminal.json'),
    JSON.stringify({ passed: false, root, checks, error: String(error), frame: screen() }, null, 2),
  );
  console.error(error);
  process.exitCode = 1;
} finally {
  if (!ended) child.kill();
  terminal.dispose();
  await server.close();
}
process.exit(process.exitCode ?? 0);
