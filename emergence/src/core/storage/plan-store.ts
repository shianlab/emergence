import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { legacyPlanningStateSchema, planningStateSchema, type PlanningState } from '../domain/planning.ts';
import { readJsonFile, replaceJsonFile } from './safe-json-file.ts';
import { canonicalDirectory, withLease } from './lease.ts';

function decode(input: unknown): PlanningState {
  if (input && typeof input === 'object' && 'version' in input && input.version === 1) {
    const legacy = legacyPlanningStateSchema.parse(input);
    return planningStateSchema.parse({
      ...legacy,
      version: 2,
      status: 'blocked',
      issues: ['旧版计划保留供查看；需求来源尚未编号，请提交用户指令重新分析后派发。'],
    });
  }
  return planningStateSchema.parse(input);
}

export const planScope = (session: string, project: string) =>
  createHash('sha256')
    .update(JSON.stringify([session, process.platform === 'win32' ? project.toLowerCase() : project]))
    .digest('hex');
/** Session-local planning data, never long-term memory or an execution checkpoint. */
export class PlanStore {
  constructor(private home: string) {}
  private async directory(create: boolean) {
    let path = this.home;
    for (const part of ['core', 'plans']) {
      path = join(path, part);
      if (create)
        await mkdir(path).catch((e) => {
          if (e.code !== 'EEXIST') throw e;
        });
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('PLAN_UNSAFE_PATH');
    }
    return path;
  }
  async read(scope: string): Promise<PlanningState | undefined> {
    if (!/^[a-f0-9]{64}$/.test(scope)) throw new Error('PLAN_SCOPE_INVALID');
    try {
      const path = join(await this.directory(false), scope + '.json');
      const value = decode(await readJsonFile(path, 200000, 'PLAN_FILE_INVALID'));
      if (value.scope !== scope) throw new Error('PLAN_SCOPE_INVALID');
      return value;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw e;
    }
  }
  async write(input: PlanningState) {
    const value = planningStateSchema.parse(input),
      dir = await this.directory(true),
      path = join(dir, value.scope + '.json');
    await withLease(
      'plan-store:' + (await canonicalDirectory(dir)) + ':' + value.scope,
      '计划存储',
      async () => {
        let previous: unknown;
        try {
          previous = await readJsonFile(path, 200000, 'PLAN_FILE_INVALID');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        if (previous !== undefined) {
          if (decode(previous).scope !== value.scope) throw new Error('PLAN_SCOPE_INVALID');
          if ((previous as { version: number }).version === 1) {
            const bytes = await readFile(path);
            // Check the bytes being backed up too, before replacing any old record.
            const original = legacyPlanningStateSchema.parse(JSON.parse(bytes.toString('utf8')));
            if (original.scope !== value.scope) throw new Error('PLAN_SCOPE_INVALID');
            const backup = path + '.v1.bak';
            try {
              await writeFile(backup, bytes, { flag: 'wx', mode: 0o600 });
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
              const saved = legacyPlanningStateSchema.parse(
                await readJsonFile(backup, 200000, 'PLAN_BACKUP_INVALID'),
              );
              if (JSON.stringify(saved) !== JSON.stringify(original)) throw new Error('PLAN_BACKUP_CONFLICT');
            }
          }
        }
        await replaceJsonFile(path, value, { invalidMessage: 'PLAN_UNSAFE_PATH', maxBytes: 200000 });
      },
    );
  }
}
