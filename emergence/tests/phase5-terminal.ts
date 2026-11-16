import xterm from '@xterm/headless';
import { spawn } from 'node-pty';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig, saveConfig } from '../src/app/config.ts';
import { defaultConfig } from '../src/core/domain/configuration.ts';
import { enterWorkspace } from './fixtures/enter-workspace.ts';
import { modelServer } from './fixtures/model-server.ts';
import { exitTerminal, sendTerminalInput } from './fixtures/terminal-interaction.ts';

const artifacts = resolve('../artifacts/phase5');
await mkdir(artifacts, { recursive: true });
// A standalone fixture must not inherit the source checkout's Git root or Skills.
const root = await mkdtemp(join(tmpdir(), 'emergence-phase5-terminal-')),
  home = join(root, 'home'),
  a = join(root, '项目 A'),
  b = join(root, '项目 B');
await mkdir(a);
await mkdir(b);
const skillDir = join(a, '.agents/skills/phase5-proof');
await mkdir(skillDir, { recursive: true });
await writeFile(
  join(skillDir, 'SKILL.md'),
  '---\nname: phase5-proof\ndescription: Phase five skill proof\n---\nPHASE5_SKILL_BODY\n',
);
const server = await modelServer();
await saveConfig(home, {
  ...structuredClone(defaultConfig),
  defaultModel: 'one',
  models: ['one', 'two'].map((id) => ({
    ...defaultConfig.models[0],
    id,
    provider: id,
    model: `fixture-${id}`,
    apiKeyEnv: 'PHASE5_KEY',
    baseURL: server.baseURL,
  })),
  mcp: [
    {
      serverName: 'proof',
      transport: 'stdio',
      command: process.execPath,
      args: [resolve('tests/fixtures/mcp.cjs')],
    },
  ],
});
type Saved = {
  focused: string;
  panes: Array<{ id: string; sessionId: string; cwd: string; modelId: string; draft: string }>;
  collaboration: { mode: string; master: string; workers: string[] };
};
async function state(): Promise<Saved | undefined> {
  try {
    const file = (await readdir(join(home, 'workspaces'))).find((n) => /^[a-f0-9]{20}\.json$/.test(n));
    return JSON.parse(await readFile(join(home, 'workspaces', file!), 'utf8'));
  } catch {
    return;
  }
}
const checks: Record<string, boolean> = {},
  frames: Record<string, string> = {};
const quote = (s: string) => "'" + s.replaceAll("'", "''") + "'";
async function open(template?: string) {
  const terminal = new xterm.Terminal({ cols: 144, rows: 44, allowProposedApi: true });
  const command = `& ${quote(process.execPath)} ${quote(resolve('bin/emergence.cjs'))} ${quote(a)} --home ${quote(home)}${template ? ` --template ${quote(template)}` : ''}; Write-Output EMERGENCE_RETURNED`;
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', command], {
    cwd: process.cwd(),
    cols: 144,
    rows: 44,
    useConptyDll: true,
    env: { ...process.env, PHASE5_KEY: 'phase5-local-secret', TERM: 'xterm-256color' },
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
  async function until(label: string, predicate: () => boolean | Promise<boolean>) {
    for (let i = 0; i < 300; i++) {
      if (await predicate()) return;
      if (ended) break;
      await delay(50);
    }
    frames.failure = screen();
    throw new Error(`Timeout: ${label}\n${screen()}\n${bytes.slice(-600)}`);
  }
  async function send(text: string) {
    await sendTerminalInput(text, screen, (bytes) => child.write(bytes));
  }
  await until(
    'startup',
    () =>
      (screen().includes('输入任务或 /help') ||
        screen().includes('Task or /help') ||
        screen().includes('描述你要完成') ||
        screen().includes('Describe your task')) &&
      (screen().includes('就绪') || screen().includes('Ready')),
  );
  await enterWorkspace(screen, (bytes) => child.write(bytes), until);
  return {
    child,
    screen,
    until,
    send,
    terminal,
    async close() {
      await exitTerminal(screen, (bytes) => child.write(bytes));
      const code = await Promise.race([
        exit,
        delay(15000).then(() => {
          throw new Error('Exit timeout');
        }),
      ]);
      assert.equal(code, 0);
      assert.ok(bytes.includes('EMERGENCE_RETURNED'));
      assert.equal(terminal.buffer.active.type, 'normal');
      terminal.dispose();
    },
    dispose() {
      if (!ended) child.kill();
      terminal.dispose();
    },
  };
}
let ui: Awaited<ReturnType<typeof open>> | undefined;
try {
  ui = await open();
  await ui.until('initial save', async () => (await state())?.panes.length === 1);
  await ui.send('/skills phase5-proof');
  await ui.until('real skill catalog', () => ui!.screen().includes('PHASE5_SKILL_BODY'));
  await ui.send('/skill phase5-proof');
  await ui.until('skill injection', () => ui!.screen().includes('已为本窗口加载技能'));
  checks.skillDiscoveryAndInjection = true;
  await ui.send('/mcp disable proof');
  await ui.until('MCP disabled', () => ui!.screen().includes('proof · disabled'));
  await ui.send('/mcp enable proof');
  await ui.until('MCP enabled', () => ui!.screen().includes('proof · active'));
  checks.mcpLifecycle = true;
  await ui.send('/extensions enable inspector');
  await ui.until('extension active', () => ui!.screen().includes('inspector · active'));
  await ui.send('/x_inspector_project');
  await ui.until('extension command', () => ui!.screen().includes('uptimeSeconds'));
  await ui.send('/panel inspector.project');
  await ui.until('extension panel', () => ui!.screen().includes('entries'));
  await ui.send('phase5:extension');
  await ui.until('unknown extension asks', () =>
    ui!.screen().includes('需要确认：ext_inspector_project_info'),
  );
  await ui.send('y');
  await ui.until('actual extension model tool', () => ui!.screen().includes('EXTENSION_COMPLETE'));
  const skillLogs = (await readdir(join(home, 'sessions'), { recursive: true })).filter((n) =>
    n.endsWith('.jsonl'),
  );
  const skillRecords = (
    await Promise.all(skillLogs.map((n) => readFile(join(home, 'sessions', n), 'utf8')))
  ).join('\n');
  assert.ok(
    skillRecords.includes('skill-invocation') &&
      skillRecords.includes('Base directory for this skill:') &&
      skillRecords.includes('PHASE5_SKILL_BODY'),
  );
  checks.extensionCommandPanelAndRealTool = true;
  await ui.send('/extensions disable inspector');
  await ui.until('extension disabled', () => ui!.screen().includes('inspector · disabled'));
  await ui.send('/tools');
  await ui.until('tool catalog', () => ui!.screen().includes('pwsh'));
  // The catalog can exceed one screen as real tools are added; inspect its tail.
  ui.child.write('\x1b[6~'.repeat(5));
  await ui.until(
    'extension tool removed',
    () => ui!.screen().includes('mcp__proof__echo') && !ui!.screen().includes('ext_inspector_project_info'),
  );
  checks.extensionDisabled = true;
  await ui.send('phase5:subagent');
  await ui.until('child completed with fixed delegation permissions', async () => {
    const logs = (await readdir(join(home, 'sessions'), { recursive: true })).filter((n) =>
      n.endsWith('.jsonl'),
    );
    return (await Promise.all(logs.map((n) => readFile(join(home, 'sessions', n), 'utf8')))).some(
      (s) =>
        s.includes('"source":"delegation"') &&
        s.includes('"outcome":"rejected"') &&
        s.includes('CHILD_COMPLETE'),
    );
  });
  assert.equal(await readFile(join(a, 'phase5-child.txt'), 'utf8'), 'NATIVE_SUBAGENT_PROOF');
  frames.childSettled = ui.screen();
  await ui.send('/agents');
  await ui.until(
    'child ownership panel',
    () => ui!.screen().includes('subagent') && ui!.screen().includes('inactive'),
  );
  checks.nativeSubagentAndFixedDelegationPermissions = true;
  await ui.send('/permissions confirm write');
  await ui.send('phase3:write:B');
  await ui.until('configured tool confirmation', () => ui!.screen().includes('需要确认：write'));
  await ui.send('y');
  await ui.until('write after exact confirmation', () => ui!.screen().includes('WRITE_COMPLETE_B'));
  assert.equal(await readFile(join(a, 'proof-B.txt'), 'utf8'), 'fixture-one:B');
  await ui.send('/permissions allow write');
  checks.configuredToolConfirmation = true;
  await ui.send(`/split right "${b}" two`);
  await ui.until('two panes', async () => (await state())?.panes.length === 2);
  await ui.send('/template save dual');
  await ui.until('template save', () => ui!.screen().includes('已保存模板 dual'));
  const before = (await state())!.panes.map((p) => p.sessionId);
  await ui.send('/template load dual');
  await ui.until('fresh template sessions', async () => {
    const s = await state();
    return s?.panes.length === 2 && s.panes.every((p) => !before.includes(p.sessionId));
  });
  assert.deepEqual(
    (await state())!.panes.map((p) => [p.cwd, p.modelId]),
    [
      [a, 'one'],
      [b, 'two'],
    ],
  );
  assert.equal((await state())!.collaboration.mode, 'independent');
  checks.multiProjectModelTemplate = true;
  await ui.send('/theme amber');
  await ui.send('/bind close F10');
  await ui.send('/language en');
  await ui.until(
    'English chrome',
    () => ui!.screen().includes('[Close]') && ui!.screen().includes('Independent'),
  );
  await ui.send('/statusbar fields model,context');
  await ui.until(
    'legacy preferences retained',
    async () => (await loadConfig(home)).ui.statusBar.fields.join(',') === 'model,context',
  );
  // The accepted clean footer deliberately supersedes legacy field selection.
  await ui.until('clean footer remains readable', () => ui!.screen().includes('Tokens 0'));
  assert.ok(!ui.screen().includes('context — (limit 128000)'));
  frames.customized = ui.screen();
  checks.livePreferences = true;
  ui.child.write('\x1b[21~');
  await ui.until('custom F10 closes pane', async () => (await state())?.panes.length === 1);
  checks.customShortcut = true;
  await ui.close();
  ui = await open('dual');
  await ui.until('CLI template', async () => (await state())?.panes.length === 2);
  await ui.until(
    'preferences restored',
    () => ui!.screen().includes('[Close]') && ui!.screen().includes('Independent'),
  );
  await ui.send('/keys');
  await ui.until('restored close binding', () => ui!.screen().includes('close: F10'));
  ui.child.write('\x1b');
  await delay(150);
  checks.startupTemplateAndPreferencePersistence = true;
  ui.child.resize(50, 24);
  ui.terminal.resize(50, 24);
  await delay(250);
  assert.ok(ui.screen().includes('[Close]'));
  frames.narrow = ui.screen();
  checks.narrowLayout = true;
  await ui.close();
  ui = undefined;
  checks.cleanExit = true;
  const config = await loadConfig(home);
  assert.equal(config.ui.keys.close, 'F10');
  assert.equal(config.ui.language, 'en');
  await writeFile(
    join(artifacts, 'terminal.json'),
    JSON.stringify(
      { timestamp: new Date().toISOString(), passed: true, checks, frames, root, calls: server.calls },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(checks));
} catch (error) {
  await writeFile(
    join(artifacts, 'terminal.json'),
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        passed: false,
        error: String(error),
        checks,
        frames,
        root,
        calls: server.calls,
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  ui?.dispose();
  await server.close();
}
// node-pty ConPTY retains its conout worker; product and shell exits are asserted above.
process.exit(0);
