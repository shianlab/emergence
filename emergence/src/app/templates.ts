import { mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { canonicalDirectory, withLease } from '../core/storage/lease.ts';
import { replaceJsonFile } from '../core/storage/safe-json-file.ts';
import { layoutSchema, leaves } from './layout.ts';

export const templateName = z
  .string()
  .regex(/^[a-z0-9_-]{1,48}$/, '模板名限 1–48 位小写字母、数字、下划线、短横线');
export const templateSchema = z
  .object({
    version: z.literal(1),
    name: templateName,
    focused: z.string(),
    layout: layoutSchema,
    panes: z
      .array(z.object({ id: z.string(), cwd: z.string(), modelId: z.string() }).strict())
      .min(1)
      .max(16),
    roles: z.object({ master: z.string().optional(), workers: z.array(z.string()).max(15) }).strict(),
  })
  .strict()
  .superRefine((t, ctx) => {
    const ids = t.panes.map((p) => p.id),
      visible = leaves(t.layout);
    if (
      new Set(ids).size !== ids.length ||
      new Set(visible).size !== visible.length ||
      visible.some((id) => !ids.includes(id)) ||
      !visible.includes(t.focused)
    )
      ctx.addIssue({ code: 'custom', path: ['layout'], message: '模板的窗口布局或焦点无效' });
    if (
      (t.roles.master && !ids.includes(t.roles.master)) ||
      new Set(t.roles.workers).size !== t.roles.workers.length ||
      t.roles.workers.some((id) => !ids.includes(id) || id === t.roles.master)
    )
      ctx.addIssue({ code: 'custom', path: ['roles'], message: '旧模板的窗口角色记录无效' });
  });
export type WorkspaceTemplate = z.infer<typeof templateSchema>;
function path(home: string, name: string) {
  return join(home, 'templates', templateName.parse(name) + '.json');
}
export async function readTemplate(home: string, name: string) {
  const raw = await readFile(path(home, name), 'utf8');
  if (raw.length > 1_000_000) throw new Error('模板文件过大');
  const t = templateSchema.parse(JSON.parse(raw));
  if (t.name !== name) throw new Error('模板名与文件名不一致');
  return t;
}
export async function writeTemplate(home: string, template: WorkspaceTemplate) {
  const t = templateSchema.parse(template),
    target = path(home, t.name);
  await withLease(`template:${await canonicalDirectory(home)}:${t.name}`, '工作台模板', async () => {
    await mkdir(join(home, 'templates'), { recursive: true });
    await replaceJsonFile(target, t, {
      invalidMessage: '工作台模板路径不是普通文件，未覆盖',
      pretty: true,
      newline: true,
    });
  });
}
export async function listTemplates(home: string) {
  return (
    await readdir(join(home, 'templates')).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return [];
      throw e;
    })
  )
    .filter((n) => /^[a-z0-9_-]{1,48}\.json$/.test(n))
    .map((n) => n.slice(0, -5));
}
export async function deleteTemplate(home: string, name: string) {
  await withLease(
    `template:${await canonicalDirectory(home)}:${templateName.parse(name)}`,
    '工作台模板',
    () => unlink(path(home, name)),
  );
}
