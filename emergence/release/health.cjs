// Candidate probes use only the bundled runtime and a disposable, credential-free home.
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

function probe(command, args, cwd, env, timeout = 45000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '',
      settled = false;
    let failure;
    function stop(error) {
      if (failure) return;
      failure = error;
      if (child.pid) {
        const killer = spawn(
          path.join(env.SystemRoot, 'System32/taskkill.exe'),
          ['/pid', String(child.pid), '/t', '/f'],
          { windowsHide: true, stdio: 'ignore' },
        );
        killer.on('error', () => child.kill());
        killer.on('close', (code) => {
          if (code !== 0) child.kill();
        });
      }
    }
    const timer = setTimeout(() => stop(new Error('Startup probe timed out')), timeout);
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(output.trim());
    }
    child.stdout.on('data', (data) => {
      if (failure) return;
      output += data.toString('utf8');
      if (output.length > 1024 * 1024) {
        stop(new Error('Startup probe output exceeded limit'));
      }
    });
    child.stderr.resume(); // Do not persist potentially sensitive dependency diagnostics.
    child.once('error', () => finish(new Error('Cannot start bundled application')));
    child.once('close', (code) =>
      finish(failure ?? (code === 0 ? null : new Error('Startup probe failed (exit ' + code + ')'))),
    );
  });
}
async function checkInstallation(root, version, { legacy = false } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'Emergence-health-'));
  const env = Object.fromEntries(
    ['SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'LOCALAPPDATA', 'APPDATA', 'OS', 'PATHEXT'].flatMap(
      (k) => (process.env[k] ? [[k, process.env[k]]] : []),
    ),
  );
  Object.assign(env, {
    USERPROFILE: home,
    HOME: home,
    EMERGENCE_HOME: home,
    EMERGENCE_INSTALL_PROBE_KEY: 'local-installation-probe',
    PATH: [
      path.join(env.SystemRoot, 'System32'),
      path.join(env.SystemRoot, 'System32/WindowsPowerShell/v1.0'),
    ].join(';'),
  });
  const node = path.join(root, 'runtime/node.exe');
  const cli = path.join(root, 'app/bin/emergence.cjs');
  const checks = [];
  async function check(name, run) {
    const start = Date.now();
    try {
      await run();
      checks.push({ name, milliseconds: Date.now() - start });
    } catch {
      throw new Error('安装启动检查失败：' + name + '。候选版本未启用，请保留安装日志。');
    }
  }
  try {
    await check('CLI 版本', async () => {
      if ((await probe(node, [cli, '--version'], home, env)) !== version) throw new Error('Version mismatch');
    });
    await check('终端原生依赖', () =>
      probe(
        node,
        [
          '--experimental-ffi',
          '--input-type=module',
          '-e',
          'import {createRequire} from "node:module";import{pathToFileURL}from"node:url";const r=createRequire(process.argv[1]);await import(pathToFileURL(r.resolve("@opentui/core")));const{DatabaseSync}=await import("node:sqlite");const db=new DatabaseSync(":memory:");db.exec("select 1");db.close();',
          cli,
        ],
        home,
        env,
      ),
    );
    await check('Harness 与内置工具', async () => {
      await probe(node, [cli, 'config', '--home', home], home, env);
      const file = path.join(home, 'config.json');
      const config = JSON.parse(await fs.readFile(file, 'utf8'));
      config.models = [
        {
          ...config.models[0],
          id: 'installation-probe',
          provider: 'installation-probe',
          model: 'installation-probe',
          api: 'openai-completions',
          baseURL: 'http://127.0.0.1:9/v1',
          apiKeyEnv: 'EMERGENCE_INSTALL_PROBE_KEY',
        },
      ];
      config.defaultModel = 'installation-probe';
      await fs.writeFile(file, JSON.stringify(config));
      const output = await probe(node, [cli, home, '--home', home, '--print', '/tools'], home, env);
      const result = JSON.parse(output.split('\n').at(-1));
      if (result.error || !result.sessionId || !result.notice?.includes('emergence_'))
        throw new Error('Harness not ready');
    });
    await check('原生模型配置依赖', async () => {
      // Published 1.00/1.01 do not implement the non-UI probe; never send them an unknown switch.
      if (legacy) {
        await fs.access(path.join(root, '涌现模型配置.exe'));
        return;
      }
      const result = await probe(path.join(root, '涌现模型配置.exe'), ['--installation-check'], home, env);
      if (JSON.parse(result).ok !== true) throw new Error('Native dependency failure');
    });
    return checks;
  } finally {
    // A fresh private directory, never a user home; reject links before recursive cleanup.
    async function noLinks(folder) {
      if ((await fs.lstat(folder)).isSymbolicLink()) throw new Error('Unsafe probe cleanup');
      for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new Error('Unsafe probe cleanup');
        if (entry.isDirectory()) await noLinks(path.join(folder, entry.name));
      }
    }
    if (path.dirname(home) !== path.resolve(os.tmpdir()) || !/^Emergence-health-/.test(path.basename(home)))
      throw new Error('Unsafe probe directory');
    await noLinks(home);
    await fs.rm(home, { recursive: true });
  }
}
module.exports = { checkInstallation };
