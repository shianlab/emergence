import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { ToolConfirmation } from '../../core/domain/permissions.ts';
import { withLease } from '../../core/storage/lease.ts';
import { readJsonFile, replaceJsonFile } from '../../core/storage/safe-json-file.ts';
export const definitionSchema = z
  .object({
    name: z.string().min(1).max(100),
    method: z.enum(['clean', 'metric', 'reconcile', 'retention', 'funnel', 'attribution', 'ab', 'series']),
    params: z.record(z.string(), z.json()),
    formula: z.string().min(1).max(2000),
    grain: z.string().min(1).max(300),
    numerator: z.string().max(500),
    denominator: z.string().max(500),
    filters: z.string().max(1000),
    timezone: z.string().min(1).max(100),
    unit: z.string().min(1).max(100),
    source: z.string().min(1).max(1000),
    assumptions: z.array(z.string().max(500)).max(20),
  })
  .strict();
const recordSchema = z
  .object({
    schemaVersion: z.literal(1),
    project: z.string(),
    definition: definitionSchema,
    status: z.enum(['user-confirmed', 'auto-approved']),
    version: z.string(),
    confirmedAt: z.string(),
  })
  .strict();
export type Definition = z.infer<typeof definitionSchema>;
export type AnalysisDefinition =
  | z.infer<typeof recordSchema>
  | {
      status: 'assumed';
      definition: Omit<Definition, 'formula' | 'numerator' | 'denominator' | 'filters'> &
        Partial<Pick<Definition, 'formula' | 'numerator' | 'denominator' | 'filters'>>;
    };
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export class Definitions {
  constructor(
    private home: string,
    private project: string,
  ) {}
  private async path(name: string) {
    let dir = await realpath(this.home);
    for (const part of ['core', 'data-definitions']) {
      dir = join(dir, part);
      await mkdir(dir).catch((e) => {
        if (e.code !== 'EEXIST') throw e;
      });
      const stat = await lstat(dir);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('口径目录不安全');
    }
    return join(dir, hash((await realpath(this.project)) + '\0' + name) + '.json');
  }
  async get(name: string) {
    const path = await this.path(name);
    try {
      const record = recordSchema.parse(await readJsonFile(path, 32000, '口径文件无效'));
      if (
        record.project !== (await realpath(this.project)) ||
        record.definition.name !== name ||
        record.version !== hash(JSON.stringify(record.definition))
      )
        throw new Error('口径版本或项目不匹配');
      return record;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }
  async evidence(name: string) {
    const path = await this.path(name);
    await this.get(name);
    return { path, hash: hash(await readFile(path, 'utf8')), state: 'present' as const };
  }
  async save(definition: Definition, previous: string | null, approve: () => Promise<ToolConfirmation>) {
    const value = definitionSchema.parse(definition),
      path = await this.path(value.name);
    return withLease('data-definition:' + path, '数据口径', async () => {
      const existing = await this.get(value.name);
      if ((existing?.version ?? null) !== previous) throw new Error('口径已被其他窗口修改，请重新读取');
      const confirmation = await approve();
      if (!confirmation) throw new Error('口径确认已取消');
      const record = {
        schemaVersion: 1 as const,
        project: await realpath(this.project),
        definition: value,
        status: confirmation,
        version: hash(JSON.stringify(value)),
        confirmedAt: new Date().toISOString(),
      };
      await replaceJsonFile(path, record, { invalidMessage: '口径文件无效', maxBytes: 32000, pretty: true });
      return record;
    });
  }
}
