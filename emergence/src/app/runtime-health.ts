import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import type { dataRuntime } from '../domains/data/service.ts';

const execute = promisify(execFile);
export interface HealthCheck {
  name: string;
  status: 'ok' | 'warning' | 'error';
  detail: string;
}

/** Fixed, read-only probes: never run project scripts or decrypt model credentials. */
export async function checkGit(cwd: string): Promise<HealthCheck> {
  try {
    await execute('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 16384,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    return { name: 'git', status: 'ok', detail: '已识别 Git 仓库，可使用版本与工作树功能。' };
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    const noRepository = /not a git repository/i.test(String((error as { stderr?: string }).stderr ?? ''));
    return {
      name: 'git',
      status: 'warning',
      detail: missing
        ? '未找到 Git；普通编程和数据分析仍可使用，版本管理功能需要安装 Git。'
        : noRepository
          ? '当前目录不是 Git 仓库；普通任务仍可使用。请确认是否已切换到目标项目，无需把整个用户目录初始化为仓库。'
          : 'Git 检查未完成（可能超时、目录不可访问或仓库信任限制）；普通任务仍可使用。请在终端运行 git status 查看原因。',
    };
  }
}

export async function checkDataRuntime(
  runtime: Awaited<ReturnType<typeof dataRuntime>>,
): Promise<HealthCheck> {
  try {
    await Promise.all([access(runtime.python), access(runtime.worker)]);
    const { stdout } = await execute(runtime.python, ['-I', '-B', runtime.probe, runtime.lock], {
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 16384,
      cwd: runtime.root,
      env: { SystemRoot: process.env.SystemRoot, PATH: dirname(runtime.python) },
    });
    const result = JSON.parse(stdout);
    if (!result.python || !result.packages) throw new Error('Unexpected probe result');
    return {
      name: 'data',
      status: 'ok',
      detail: `Python ${result.python}；已核对版本并加载 ${Object.entries(result.packages)
        .map(([name, version]) => `${name} ${version}`)
        .join('、')}。`,
    };
  } catch {
    return {
      name: 'data',
      status: 'warning',
      detail:
        '数据 Python 环境缺失、版本不符或检查超时；对话和编程仍可使用。请运行 emergence data-init --python "Python 3.14 的 python.exe 路径"；源码环境也可执行 scripts/setup-data.ps1，再重试 /doctor。',
    };
  }
}
