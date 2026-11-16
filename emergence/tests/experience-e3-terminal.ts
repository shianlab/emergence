import xterm from '@xterm/headless';
import { spawn } from 'node-pty';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig, saveConfig } from '../src/app/config.ts';
import { defaultConfig } from '../src/core/domain/configuration.ts';

const dir = resolve('../artifacts/experience-e3');
await mkdir(dir, { recursive: true });
// Keep default Git-root discovery independent from the repository running this test.
const root = await mkdtemp(join(tmpdir(), 'emergence-e3-terminal-')),
  home = join(root, 'home'),
  a = join(root, '中文 项目 A'),
  b = join(root, '项目 B');
await Promise.all(
  [home, a, b, join(home, 'harness'), join(a, 'src')].map((path) => mkdir(path, { recursive: true })),
);
await Promise.all([
  writeFile(join(home, 'emergence.md'), 'PERSONAL_PROOF'),
  writeFile(join(home, 'harness', 'AGENTS.md'), 'LEGACY_GLOBAL_MUST_NOT_LOAD'),
  writeFile(join(a, 'AGENTS.md'), 'PROJECT_A_PROOF'),
  writeFile(join(a, 'src', 'EMERGENCE.md'), 'NESTED_PROOF'),
  writeFile(join(a, 'src', 'result.txt'), 'FILE_BODY'),
  writeFile(
    join(a, 'package.json'),
    JSON.stringify({ name: 'terminal-e3', scripts: { test: 'fixture-never-executed' } }),
  ),
  writeFile(join(b, 'EMERGENCE.md'), 'PROJECT_B_PROOF'),
  writeFile(join(b, 'CLAUDE.md'), 'CLAUDE_OPT_IN_PROOF'),
]);
const received: Array<{ latest: string; full: string }> = [];
const server = createServer(async (req, res) => {
  try {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const texts = body.messages.map((m: { content: unknown }) =>
      typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    );
    const latest = texts.filter((t: string) => t.includes('Emergence instruction snapshot.')).at(-1) ?? '';
    received.push({ latest, full: JSON.stringify(body.messages) });
    const task = texts.findLastIndex(
      (t: string) => t === 'inspectnested' || t.includes('"text":"inspectnested"'),
    );
    const call = task >= 0 && !body.messages.slice(task + 1).some((m: { role: string }) => m.role === 'tool');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = (delta: object, finish_reason: string | null = null) =>
      res.write(
        `data: ${JSON.stringify({ id: 'e3', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    if (call) {
      emit({
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: 'e3-read',
            type: 'function',
            function: { name: 'read', arguments: JSON.stringify({ file_path: 'src/result.txt' }) },
          },
        ],
      });
      emit({}, 'tool_calls');
    } else {
      emit({
        role: 'assistant',
        content:
          'E3_CONTEXT ' +
          [
            'PERSONAL_PROOF',
            'PROJECT_A_PROOF',
            'PROJECT_B_PROOF',
            'PROJECT_V2',
            'NESTED_PROOF',
            'CLAUDE_OPT_IN_PROOF',
          ]
            .filter((marker) => latest.includes(marker))
            .join(' '),
      });
      emit({}, 'stop');
    }
    res.end('data: [DONE]\n\n');
  } catch (error) {
    res.writeHead(500);
    res.end(String(error));
  }
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const port = (server.address() as { port: number }).port;
const config = structuredClone(defaultConfig);
config.models = [
  {
    ...config.models[0],
    id: 'local',
    provider: 'Local',
    model: 'fixture-e3',
    baseURL: `http://127.0.0.1:${port}/v1`,
    apiKeyEnv: 'E3_TERMINAL_KEY',
  },
];
config.defaultModel = 'local';
await saveConfig(home, config);
const terminal = new xterm.Terminal({ cols: 132, rows: 42, allowProposedApi: true });
const child = spawn(
  process.execPath,
  [resolve('bin/emergence.cjs'), a, '--home', home, '--permission', 'ask'],
  {
    cwd: process.cwd(),
    cols: 132,
    rows: 42,
    useConptyDll: true,
    env: {
      ...process.env,
      E3_TERMINAL_KEY: 'local-e3-secret',
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
async function until(label: string, predicate: () => boolean) {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    if (ended) break;
    await delay(40);
  }
  throw new Error(label + '\n' + screen());
}
async function send(text: string) {
  child.write(`\x1b[200~${text}\x1b[201~`);
  await delay(90);
  child.write('\r');
}
async function command(text: string) {
  child.write('\x10');
  await delay(90);
  child.write('\x01');
  await send(text);
  await delay(180);
}
async function ask(text = 'hello') {
  const count = received.length;
  await send(text);
  await until(
    text,
    () => received.length > count && screen().includes('就绪') && screen().includes('E3_CONTEXT'),
  );
}
try {
  await until('home', () => screen().includes('描述你要完成'));
  await ask();
  assert.match(received[0].latest, /PERSONAL_PROOF/);
  assert.match(received[0].latest, /PROJECT_A_PROOF/);
  assert.ok(!received[0].full.includes('LEGACY_GLOBAL_MUST_NOT_LOAD'));
  checks.realModelContextAndNoLegacyDoubleLoad = true;
  await command('/instructions');
  await until('sources', () => screen().includes('Emergence 规则来源') && screen().includes('AGENTS.md'));
  frames.sources = screen();
  checks.sourcesAndPriorityVisible = true;
  await command('/init');
  await until('preview', () => screen().includes('/init apply') && screen().includes('npm run test'));
  await assert.rejects(access(join(a, 'EMERGENCE.md')));
  checks.projectAwarePreviewDoesNotWrite = true;
  await command('/init apply');
  await until('approval', () => screen().includes('写入已预览草案'));
  frames.approval = screen();
  await delay(400);
  child.write('\r');
  await until('saved', () => screen().includes('已保存') && screen().includes('EMERGENCE.md'));
  assert.match(await readFile(join(a, 'EMERGENCE.md'), 'utf8'), /terminal-e3/);
  checks.enterApprovalWritesActualFile = true;
  await writeFile(
    join(a, 'EMERGENCE.md'),
    (await readFile(join(a, 'EMERGENCE.md'), 'utf8')) + '\nPROJECT_V2\n',
  );
  await command('/instructions reload');
  await ask();
  assert.match(received.at(-1)!.latest, /PROJECT_V2/);
  checks.reloadReachesNextModelRequest = true;
  await unlink(join(a, 'EMERGENCE.md'));
  await command('/instructions reload');
  await ask();
  assert.ok(!received.at(-1)!.latest.includes('PROJECT_V2'));
  checks.removedFileSupersedesOldSnapshot = true;
  await ask('inspectnested');
  await until(
    'nested admitted',
    () => received.at(-1)!.latest.includes('NESTED_PROOF') && screen().includes('就绪'),
  );
  assert.ok(received.at(-1)!.full.includes('FILE_BODY'));
  checks.actualFileReadLoadsNestedRules = true;
  await command(`/split right "${b}"`);
  await until('split', () => screen().includes('2 会话'));
  await command('/maximize');
  await ask();
  assert.match(received.at(-1)!.latest, /PROJECT_B_PROOF/);
  assert.ok(!received.at(-1)!.latest.includes('PROJECT_A_PROOF'));
  assert.ok(!received.at(-1)!.latest.includes('NESTED_PROOF'));
  assert.ok(!received.at(-1)!.latest.includes('CLAUDE_OPT_IN_PROOF'));
  checks.projectsIsolatedAndClaudeOffByDefault = true;
  const latest = await loadConfig(home);
  latest.instructions.claude = true;
  await saveConfig(home, latest);
  await command('/settings reload');
  await ask();
  assert.match(received.at(-1)!.latest, /CLAUDE_OPT_IN_PROOF/);
  checks.claudeCompatibilityOptIn = true;
  await command('/permission plan');
  await command('/init');
  await command('/init apply');
  await until('plan blocks init', () => screen().includes('计划模式禁止'));
  assert.equal(await readFile(join(b, 'EMERGENCE.md'), 'utf8'), 'PROJECT_B_PROOF');
  checks.planCannotInitializeFiles = true;
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
  assert.equal(terminal.buffer.active.type, 'normal');
  assert.ok(!bytes.includes('local-e3-secret'));
  checks.cleanExitAndRedaction = true;
  await writeFile(
    join(dir, 'terminal.json'),
    JSON.stringify(
      {
        passed: true,
        timestamp: new Date().toISOString(),
        root,
        checks,
        frames,
        requestCount: received.length,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(checks));
} catch (error) {
  await writeFile(
    join(dir, 'terminal.json'),
    JSON.stringify(
      {
        passed: false,
        root,
        checks,
        error: String(error),
        frame: screen(),
        latestContext: received.at(-1)?.latest,
      },
      null,
      2,
    ),
  );
  console.error(error);
  process.exitCode = 1;
} finally {
  if (!ended) child.kill();
  terminal.dispose();
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
}
process.exit(process.exitCode ?? 0);
