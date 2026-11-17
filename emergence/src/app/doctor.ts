import { constants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { registerSecretNames, safeError } from '../core/adapters/redaction.ts';
import { configSchema } from '../core/domain/configuration.ts';
import { dataRuntime } from '../domains/data/service.ts';
import { checkDataRuntime, checkGit, type HealthCheck } from './runtime-health.ts';
import { MIN_NODE, VERSION } from './version.ts';
import { createUpdateService } from './updates/runtime.ts';

const require = createRequire(import.meta.url);
export function runtimeSupported(version = process.versions.node) {
  const [major, minor, patch] = version.split('.').map(Number);
  return major > 26 || (major === 26 && (minor > 12 || (minor === 12 && patch >= 1)));
}
export async function diagnose(home: string, cwd: string) {
  const checks: HealthCheck[] = [];
  checks.push({
    name: 'runtime',
    status: runtimeSupported() ? 'ok' : 'error',
    detail: `Node ${process.versions.node}；最低要求 ${MIN_NODE}`,
  });
  checks.push({
    name: 'platform',
    status: process.platform === 'win32' && process.arch === 'x64' ? 'ok' : 'warning',
    detail: `${process.platform}/${process.arch}；当前验收平台为 Windows 11 x64`,
  });
  let models: Array<{ id: string; api: string; credential: string }> = [];
  try {
    const config = configSchema.parse(JSON.parse(await readFile(join(home, 'config.json'), 'utf8')));
    registerSecretNames(config.models.map((m) => m.apiKeyEnv));
    let encryptedStore = false;
    try {
      const encrypted = JSON.parse(await readFile(join(home, 'credentials.dpapi.json'), 'utf8'));
      if (encrypted.version !== 1 || typeof encrypted.encrypted !== 'string' || !encrypted.encrypted)
        throw new Error('invalid envelope');
      encryptedStore = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        checks.push({
          name: 'credentials',
          status: 'error',
          detail: '无法读取加密凭据文件；请打开 /model-config 检查模型配置。',
        });
    }
    models = config.models.map((m) => ({
      id: m.id,
      api: m.api,
      credential: process.env[m.apiKeyEnv]
        ? 'environment'
        : encryptedStore
          ? 'encrypted store present; profile binding unverified'
          : 'missing',
    }));
    checks.push({
      name: 'config',
      status: 'ok',
      detail: `配置格式 ${config.version}；${config.models.length} 个模型配置`,
    });
    const missing = models.filter((model) => model.credential === 'missing');
    if (missing.length)
      checks.push({
        name: 'credentials',
        status: 'warning',
        detail: `${missing.length} 个模型未找到凭据；请使用 /model-config 配置密钥。`,
      });
  } catch (error) {
    checks.push({
      name: 'config',
      status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'warning' : 'error',
      detail:
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? '尚未初始化；首次启动会创建默认配置。请用 /model-config 配置模型与密钥。'
          : safeError(error),
    });
  }
  for (const dependency of ['@deepseek-ai/dsh/package.json', '@opentui/core']) {
    try {
      require.resolve(dependency);
      checks.push({ name: dependency, status: 'ok', detail: '已安装' });
    } catch {
      checks.push({ name: dependency, status: 'error', detail: '依赖缺失；请修复应用安装。' });
    }
  }
  let writable = home;
  while (true) {
    try {
      await access(writable, constants.W_OK);
      checks.push({
        name: 'home',
        status: 'ok',
        detail: '配置目录或最近的已有上级目录可写',
      });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(writable) === writable) {
        checks.push({ name: 'home', status: 'error', detail: safeError(error) });
        break;
      }
      writable = dirname(writable);
    }
  }
  try {
    await access(cwd, constants.R_OK);
    if (!(await stat(cwd)).isDirectory()) throw new Error('项目路径必须是目录');
    checks.push({ name: 'project', status: 'ok', detail: '目录可访问' });
  } catch (error) {
    checks.push({ name: 'project', status: 'error', detail: safeError(error) });
  }
  checks.push(
    ...(await Promise.all([
      checkGit(cwd),
      dataRuntime(home)
        .then(checkDataRuntime)
        .catch((error): HealthCheck => ({
          name: 'data',
          status: 'warning',
          detail: `数据资源或环境配置异常：${safeError(error)}；请核对应用文件和数据环境，编程与对话仍可使用。`,
        })),
    ])),
  );
  const updates = await createUpdateService();
  const update = { source: updates.location.kind, ...(await updates.inspect()) };
  updates.dispose();
  return {
    version: VERSION,
    update,
    ok: !checks.some((c) => c.status === 'error'),
    timestamp: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    terminal: {
      tty: !!process.stdin.isTTY,
      term: safeError(process.env.TERM ?? ''),
      windowsTerminal: !!process.env.WT_SESSION,
    },
    home,
    cwd,
    configSchema: 1,
    models,
    checks,
    note: 'Read-only diagnostics. No model request, no credential decryption, no task replay.',
  };
}

export function formatDiagnosis(report: Awaited<ReturnType<typeof diagnose>>) {
  const names: Record<string, string> = {
    runtime: '运行环境',
    platform: '系统',
    config: '模型配置',
    credentials: '密钥',
    home: '配置目录',
    project: '项目目录',
    git: '版本管理（可选）',
    data: '数据环境',
    '@deepseek-ai/dsh/package.json': '执行基座',
    '@opentui/core': '终端界面',
  };
  const statuses = { ok: '正常', warning: '提示', error: '故障' };
  const credentials = (value: string) =>
    value === 'environment'
      ? '已配置环境变量（未验证连通性）'
      : value === 'missing'
        ? '未找到凭据'
        : '存在加密凭据库（未解密，模型绑定待验证）';
  return [
    `Emergence ${report.version} · ${report.ok ? '运行诊断完成' : '存在需要修复的故障'}`,
    `当前项目：${report.cwd}`,
    `版本更新：${report.update.source} · ${report.update.message}${report.update.checkedAt ? ' · 上次检查 ' + new Date(report.update.checkedAt).toISOString() : ''}`,
    ...report.checks.map(
      (check) => `[${statuses[check.status]}] ${names[check.name] ?? check.name}：${check.detail}`,
    ),
    ...report.models.map((model) => `模型 ${model.id}：${credentials(model.credential)}`),
    '本次只读诊断，不发送模型请求、不解密密钥、不回放任务。提示不代表应用不能运行。',
  ].join('\n');
}
