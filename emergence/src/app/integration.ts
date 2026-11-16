import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { safeError } from '../core/adapters/redaction.ts';

export const integrationSchema = z
  .object({
    id: z.string(),
    source: z.string(),
    target: z.string(),
    sourceCwd: z.string(),
    targetCwd: z.string(),
    commit: z.string(),
    status: z.enum(['merging', 'merged', 'conflict', 'failed', 'needs_review']),
    detail: z.string().max(8000),
    conflicts: z.array(z.string()).max(100),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type IntegrationRecord = z.infer<typeof integrationSchema>;
const git = async (cwd: string, args: string[]) =>
  (
    await promisify(execFile)('git', args, { cwd, windowsHide: true, timeout: 30000, maxBuffer: 2_000_000 })
  ).stdout.trim();
const canonical = async (path: string) => {
  const full = await realpath(path);
  return process.platform === 'win32' ? full.toLowerCase() : full;
};

/** User-requested integration only. Never stash, reset or cross repository boundaries. */
export async function prepareIntegration(
  source: { id: string; cwd: string },
  target: { id: string; cwd: string },
): Promise<IntegrationRecord> {
  if ((await canonical(source.cwd)) === (await canonical(target.cwd)))
    throw new Error('源和目标必须是不同的工作树');
  const [sourceCommon, targetCommon] = await Promise.all([
    git(source.cwd, ['rev-parse', '--git-common-dir']),
    git(target.cwd, ['rev-parse', '--git-common-dir']),
  ]);
  if (
    (await canonical(resolve(source.cwd, sourceCommon))) !==
    (await canonical(resolve(target.cwd, targetCommon)))
  )
    throw new Error('跨项目整合已拒绝：源和目标不属于同一 Git 仓库');
  for (const path of [source.cwd, target.cwd]) {
    if (await git(path, ['status', '--porcelain']))
      throw new Error(`工作树有未提交内容，请先提交或处理：${path}`);
    try {
      await git(path, ['rev-parse', '--verify', 'MERGE_HEAD']);
    } catch {
      continue;
    }
    throw new Error(`工作树已有待处理合并：${path}`);
  }
  const commit = await git(source.cwd, ['rev-parse', 'HEAD']);
  const time = new Date().toISOString();
  return {
    id: randomUUID().slice(0, 12),
    source: source.id,
    target: target.id,
    sourceCwd: source.cwd,
    targetCwd: target.cwd,
    commit,
    status: 'merging',
    detail: '用户请求整合，尚未执行 Git merge',
    conflicts: [],
    createdAt: time,
    updatedAt: time,
  };
}
export async function performIntegration(record: IntegrationRecord) {
  try {
    record.detail = (await git(record.targetCwd, ['merge', '--no-ff', '--no-edit', record.commit])).slice(
      0,
      8000,
    );
    record.status = 'merged';
  } catch (error) {
    record.conflicts = (
      await git(record.targetCwd, ['diff', '--name-only', '--diff-filter=U']).catch(() => '')
    )
      .split('\n')
      .filter(Boolean)
      .slice(0, 100);
    record.status = record.conflicts.length ? 'conflict' : 'failed';
    record.detail =
      safeError(error).slice(0, 8000) +
      (record.conflicts.length ? '\n保留冲突现场，请解决后提交，或显式 git merge --abort。' : '');
  }
  record.updatedAt = new Date().toISOString();
  return record;
}
