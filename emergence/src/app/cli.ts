import { dump } from 'js-yaml';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { safeError } from '../core/adapters/redaction.ts';
import { configSchema, modelSchema } from '../core/domain/configuration.ts';
import { standardPermissionModeSchema } from '../core/domain/permissions.ts';
import { readJsonFile } from '../core/storage/safe-json-file.ts';
import { childEnvironment } from '../platform/child-environment.ts';
import { initializeData } from '../domains/data/initialize.ts';
import { homeDirectory, loadConfig, migrateConfig, updateConfig } from './config.ts';
import {
  credentialSource,
  prepareModelCredentials,
  registerModelCredentials,
  saveCredential,
} from './credentials.ts';
import { diagnose, formatDiagnosis } from './doctor.ts';
import { modelProviders } from './model-config-runtime.ts';
import { startModelConfiguration } from './model-config.ts';
import { windowModel } from './model-configuration.ts';
import { cleanStaleProfiles, markProfile, removeProfile } from './profiles.ts';
import { VERSION } from './version.ts';
import { runInstallationCommand } from './installation-command.ts';

const appRoot = resolve(fileURLToPath(new URL('.', import.meta.url)));
const require = createRequire(import.meta.url);
const help = `涌现 · Emergence ${VERSION}

emergence [项目目录]                  启动终端工作台
emergence [项目目录] --resume <id>    恢复会话
emergence [项目目录] --print <任务>   执行后输出 JSON
emergence models                     查看模型配置与密钥是否已配置
emergence config                     显示配置文件路径
emergence model-config               打开可视化模型配置窗口
emergence config ui                  同上；关闭小窗即退出独立配置服务
emergence doctor [项目目录] --json    只读诊断运行时、配置与依赖
emergence update                    检查并安全更新到官方稳定版
emergence update --check            仅检查版本并输出 JSON
emergence update --source <目录>     从完整发行包离线升级
emergence repair --source <目录>     修复当前版本，保留用户配置
emergence rollback                  回退到通过验证的上一版本
emergence installation status|cleanup|recover  安装状态、清理旧版、恢复中断操作
emergence data-init --python <路径>   初始化数据环境（Windows x64 / Python 3.14）
emergence config migrate             备份并补齐旧配置的默认设置
emergence auth --key-file <路径>      加密保存当前模型的密钥（Windows）
emergence config add --id <名称> --provider <供应商> --model <模型>
  --api <协议> --base-url <端点> --key-env <环境变量名>

选项：--model <配置名称>  --home <配置目录>  --template <模板名>  --help  --version
      --permission plan|ask|edit|auto（恢复布局时覆盖焦点窗口）
      普通启动先进入首页；/continue 继续上次工作台；--fresh 从首页新建（保留历史）
自动化命令授权：--approve-command <完整命令>（仅允许完全相同的一次命令请求）
界面：F2/F3 左右/上下分屏，Tab 切换，F6 关闭窗口，F7 最大化，F8 隐藏。
      F4 任务列表；各窗口独立接收任务，不支持跨窗口控制或派活。
      /template · /theme · /bind · /settings · /capabilities · /extensions
      /instructions 查看规则来源；/init 预览 EMERGENCE.md；/init apply 按权限写入。
      Enter 发送，Shift+Enter 换行，Shift+Tab 切权限，/permission 打开模式菜单。
      Esc 停止焦点任务；Ctrl+C 清空/停止，空闲连按两次退出；/help 帮助。`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      home: { type: 'string' },
      model: { type: 'string' },
      resume: { type: 'string' },
      template: { type: 'string' },
      print: { type: 'string' },
      fresh: { type: 'boolean' },
      id: { type: 'string' },
      provider: { type: 'string' },
      api: { type: 'string' },
      'base-url': { type: 'string' },
      'key-env': { type: 'string' },
      'approve-command': { type: 'string', multiple: true },
      permission: { type: 'string' },
      'key-file': { type: 'string' },
      json: { type: 'boolean' },
      output: { type: 'string' },
      'native-service': { type: 'boolean' },
      python: { type: 'string' },
      source: { type: 'string' },
      check: { type: 'boolean' },
      'wheel-dir': { type: 'string' },
      offline: { type: 'boolean' },
      'force-data-init': { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(help);
    return;
  }
  if (values.version) {
    console.log(VERSION);
    return;
  }
  const home = homeDirectory(values.home);
  if (['update', 'repair', 'rollback', 'installation'].includes(positionals[0])) {
    try {
      const config = configSchema.parse(
        await readJsonFile(join(home, 'config.json'), 4 * 1024 * 1024, '模型配置无效'),
      );
      registerModelCredentials(config.models.map((model) => model.apiKeyEnv));
    } catch {
      /* Repair and update also work when model configuration is missing or damaged. */
    }
    await runInstallationCommand(appRoot, positionals, values.source, values.check);
    return;
  }
  if (values.template && (values.resume || values.print || values.model))
    throw new Error('--template 自带各窗口模型，不能与 --resume、--print、--model 混用');
  const permissionMode =
    values.permission === undefined ? undefined : standardPermissionModeSchema.parse(values.permission);
  if (positionals[0] === 'doctor') {
    if (positionals.length > 2) throw new Error('用法：emergence doctor [项目目录] [--json] [--output 文件]');
    const report = await diagnose(home, resolve(positionals[1] ?? process.cwd()));
    const text = safeError(JSON.stringify(report, null, 2));
    if (values.output) await writeFile(resolve(values.output), text + '\n', { flag: 'wx', mode: 0o600 });
    console.log(values.json ? text : safeError(formatDiagnosis(report)));
    process.exitCode = report.ok ? 0 : 1;
    return;
  }
  if (positionals[0] === 'data-init') {
    if (positionals.length !== 1 || !values.python)
      throw new Error(
        '用法：emergence data-init --python "Python 3.14 的 python.exe 路径" [--home 目录] [--offline --wheel-dir 目录] [--force-data-init]',
      );
    const result = await initializeData(home, {
      python: values.python,
      wheelDirectory: values['wheel-dir'],
      offline: values.offline,
      force: values['force-data-init'],
    });
    console.log(
      safeError(
        JSON.stringify({
          ...result,
          message: result.changed ? '数据环境已验证并启用，旧环境保留' : '已有数据环境通过验证，无需重复安装',
        }),
      ),
    );
    return;
  }
  const config = await loadConfig(home);
  const credentialNames = config.models.map((model) => model.apiKeyEnv);
  registerModelCredentials(credentialNames);
  if (positionals[0] === 'auth') {
    if (!values['key-file'])
      throw new Error('用法：emergence auth --key-file <密钥文件路径> [--model <配置名称>]');
    const model = config.models.find((m) => m.id === (values.model ?? config.defaultModel));
    if (!model) throw new Error('找不到模型配置');
    const secret = (await readFile(resolve(values['key-file']), 'utf8')).replace(/^\uFEFF/, '').trim();
    if (secret.length < 8 || /[\r\n]/.test(secret)) throw new Error('密钥文件应只包含一行 API 密钥');
    await saveCredential(home, model.apiKeyEnv, secret);
    console.log(`已为 ${model.id} 加密保存凭据；以后直接运行 emergence 即可`);
    return;
  }
  if (positionals[0] === 'model-config' || (positionals[0] === 'config' && positionals[1] === 'ui')) {
    const service = await startModelConfiguration(home);
    const stop = () => {
      void service.close().catch((error) => {
        console.error(safeError(error));
        process.exitCode = 1;
      });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    if (values['native-service']) {
      console.log(JSON.stringify({ url: service.url }));
      process.stdin.setEncoding('utf8');
      process.stdin.resume();
      process.stdin.once('end', stop);
      process.stdin.on('data', (value) => {
        if (String(value).includes('close')) {
          process.stdin.pause();
          stop();
        }
      });
      return;
    }
    try {
      await service.open();
      await service.waitForWindow();
    } finally {
      await service.close();
    }
    return;
  }
  if (positionals[0] === 'config') {
    if (positionals[1] === 'migrate') {
      console.log(JSON.stringify(await migrateConfig(home)));
      return;
    }
    if (positionals[1] === 'add') {
      const model = modelSchema.parse({
        id: values.id,
        provider: values.provider,
        model: values.model,
        api: values.api ?? 'openai-completions',
        baseURL: values['base-url'],
        apiKeyEnv: values['key-env'],
      });
      await updateConfig(home, (latest) => {
        latest.models = [...latest.models.filter((m) => m.id !== model.id), model];
      });
      console.log(`已保存模型配置：${model.id}`);
    } else if (positionals[1] === 'default') {
      if (!values.id) throw new Error('用法：emergence config default --id <已配置模型>');
      await updateConfig(home, (latest) => {
        latest.defaultModel = values.id!;
      });
      console.log(`默认模型：${values.id}`);
    } else console.log(join(home, 'config.json'));
    return;
  }
  if (positionals[0] === 'models') {
    await prepareModelCredentials(home, credentialNames);
    for (const m of config.models)
      console.log(
        `${m.id}  ${m.provider}/${m.model}  ${m.apiKeyEnv}: ${credentialSource(home, m.apiKeyEnv) !== 'missing' ? '已配置' : '未配置'}`,
      );
    return;
  }
  if (positionals.length > 1) throw new Error('只接受一个项目目录；用 --print 指定任务');
  const cwd = resolve(positionals[0] ?? process.cwd());
  if (!(await stat(cwd)).isDirectory()) throw new Error('项目路径不是目录');
  const modelId = values.model ?? windowModel(config, 'single');
  if (!config.models.some((m) => m.id === modelId))
    throw new Error(`找不到模型配置：${modelId}，使用 emergence models 查看`);
  if (!values.print && !process.stdin.isTTY)
    throw new Error('交互模式需要终端；自动化执行请使用 --print <任务>');
  await cleanStaleProfiles(home);
  const profileName = `emergence-${randomUUID()}`;
  const profileDir = join(home, 'harness/profiles', profileName);
  await mkdir(profileDir, { recursive: true });
  await markProfile(profileDir);
  await writeFile(
    join(profileDir, 'package.json'),
    JSON.stringify({
      name: 'emergence-profile',
      private: true,
      type: 'module',
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    }),
  );
  const overrides: object[] = [
    ...[
      'hmr',
      'session-log-deepseek',
      'plugin-package-inventory-deepseek',
      'session-telemetry-otel',
      'session-title-llm',
      'agent-instructions',
    ].map((id) => ({ id, disabled: true })),
    { id: 'session-persistence-jsonl', config: { root: join(home, 'sessions'), compression: 'none' } },
    {
      id: 'system-prompt',
      config: {
        includeHarnessIdentity: false,
        personaPrefix:
          'You are Emergence, running in Emergence Harness. Work in the user project, inspect before changing files, use tools and skills when relevant. Report failures honestly.',
      },
    },
    { id: 'llm-pi-ai', config: { providers: modelProviders(config) } },
    {
      insert: [
        { id: 'emergence-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
        {
          id: 'emergence',
          name: join(appRoot, 'plugin.mjs').replaceAll('\\', '/'),
          config: {
            home,
            cwd,
            modelId,
            permissionMode,
            fresh: values.fresh,
            template: values.template,
            explicitModel: values.model !== undefined,
            resume: values.resume,
            prompt: values.print,
            approvedCommands: values['approve-command'] ?? [],
            credentialsFromLauncher: true,
            appConfig: config,
          },
        },
      ],
    },
  ];
  if (config.shellMode === 'ask-local')
    overrides.push(
      { id: 'permission', disabled: true },
      { id: process.platform === 'win32' ? 'pwsh-sandbox' : 'bash-sandbox', disabled: true },
      {
        insert: [
          {
            id: 'emergence-local-shell',
            name:
              process.platform === 'win32' ? '@deepseek-ai/dsh-pwsh-local' : '@deepseek-ai/dsh-bash-local',
          },
        ],
      },
    );
  if (config.skillDirs.length)
    overrides.push({ id: 'skill-filesystem', config: { customSkillDirs: config.skillDirs } });
  await writeFile(join(profileDir, 'cordis.patch.yml'), dump(overrides, { lineWidth: 140, noRefs: true }));
  const dshManifest = require.resolve('@deepseek-ai/dsh/package.json');
  const dshBin = join(dshManifest, '../lib/bin.js');
  const child = spawn(
    process.execPath,
    ['--experimental-ffi', '--disable-warning=ExperimentalWarning', dshBin, '--profile', profileName],
    {
      cwd,
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      env: { ...childEnvironment({ harness: true }), DSH_HOME: join(home, 'harness') },
    },
  );
  const marked = markProfile(profileDir, child.pid).catch((error) => {
    console.error(safeError(error));
    child.kill();
  });
  const startupTimeout = setTimeout(() => {
    console.error('涌现应用启动超时，请查看上方插件诊断');
    child.kill();
  }, 30000);
  let credentialsSent = false;
  child.on('message', (message) => {
    if (!message || typeof message !== 'object' || !('type' in message)) return;
    if (message.type === 'emergence-ready') clearTimeout(startupTimeout);
    if (message.type !== 'emergence-model-credentials-request' || credentialsSent) return;
    credentialsSent = true;
    const overrides = Object.fromEntries(
      credentialNames.flatMap((name) => (process.env[name] ? [[name, process.env[name]]] : [])),
    );
    child.send({ type: 'emergence-model-credentials', values: overrides }, (error) => {
      if (error) {
        console.error('无法向工作台传递模型凭据');
        child.kill();
      }
    });
  });
  process.on('SIGINT', () => {
    if (process.platform !== 'win32') child.kill('SIGINT');
  });
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  child.on('error', (error) => {
    console.error(safeError(error));
    process.exitCode = 1;
  });
  child.on('exit', (code) => {
    clearTimeout(startupTimeout);
    process.exitCode = code ?? 1;
    void (async () => {
      await marked;
      await removeProfile(profileDir);
    })();
  });
}
void main().catch((error) => {
  console.error('涌现：' + safeError(error));
  process.exitCode = 1;
});
