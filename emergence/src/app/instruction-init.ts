import { randomUUID } from 'node:crypto';
import { lstat, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { withLease } from '../core/storage/lease.ts';
import { boundedText, digest, inside, pathIdentity } from './instruction-files.ts';

export type InitDraft = {
  target: string;
  boundary: string;
  content: string;
  previous?: string;
  previousHash?: string;
  bytes: number;
  maxFileBytes: number;
};
export async function prepareInstructionDraft(
  root: string,
  home: string,
  kind: 'project' | 'personal' | 'local',
  maxFileBytes = 65536,
): Promise<InitDraft> {
  const boundary = await realpath(kind === 'personal' ? home : root),
    names =
      kind === 'local' ? ['EMERGENCE.local.md', 'emergence.local.md'] : ['EMERGENCE.md', 'emergence.md'];
  let target = join(boundary, names[0]),
    previous: string | undefined;
  for (const name of names) {
    const candidate = join(boundary, name);
    try {
      const info = await lstat(candidate);
      if (info.isSymbolicLink() || !info.isFile())
        throw new Error('初始化目标不是普通文件，不能自动替换链接');
      previous = await boundedText(candidate, maxFileBytes, true);
      target = candidate;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const commands: string[] = [],
    facts: string[] = [];
  if (kind === 'project') {
    try {
      const file = await realpath(join(boundary, 'package.json'));
      if (!inside(boundary, file)) throw new Error('manifest link outside project');
      const pkg = JSON.parse(await boundedText(file, 131072));
      if (typeof pkg.name === 'string') facts.push(`- 包名：${JSON.stringify(pkg.name.slice(0, 160))}`);
      const manager =
        typeof pkg.packageManager === 'string' && /^(pnpm|yarn|bun)@/.test(pkg.packageManager)
          ? pkg.packageManager.split('@')[0]
          : 'npm';
      for (const script of ['build', 'typecheck', 'lint', 'test'])
        if (typeof pkg.scripts?.[script] === 'string') commands.push(`- ${manager} run ${script}`);
    } catch {
      /* Unsupported/malformed metadata is never executed or guessed. */
    }
    for (const file of ['pyproject.toml', 'Cargo.toml', 'go.mod']) {
      try {
        if ((await lstat(join(boundary, file))).isFile())
          facts.push(`- 存在 ${file}；运行命令需按项目文档核实。`);
      } catch {}
    }
  }
  const section =
    kind === 'personal'
      ? '## Emergence 个人偏好\n\n- 沟通语言：中文。\n- 根据任务检查项目和证据，再修改文件。\n- 完成后说明实际变更、验证结果和未完成事项。\n- 在这里补充你的长期偏好；不要存放 API 密钥。\n'
      : kind === 'local'
        ? '## Emergence 本机项目约定\n\n- 在这里填写仅适用于本机的工作方式和路径。\n- 本文件不应包含密钥；需要本机私有时请由项目维护者加入 Git 忽略规则。\n'
        : `## 项目概况\n\n- 项目目录名：${JSON.stringify(basename(boundary))}\n${facts.length ? facts.join('\n') : '- 项目目标、结构和入口：请结合实际项目补充。'}\n\n## 已发现的验证入口\n\n${commands.length ? commands.join('\n') : '- 未推断测试命令。先查看项目文档，再确定执行方式。'}\n\n上述命令来自配置中的脚本名称，尚未运行，也不代表验证通过。\n\n## 工作约定\n\n- 修改前阅读相关源码和所在目录规则，保留现有约定和其他窗口的改动。\n- 变更后执行与任务相关的检查，报告实际结果和未完成项。\n- 不把密钥写入代码、日志或本文件。\n- 本文档提供项目指导；用户当前指令及运行时权限始终优先。\n\n## 验收标准\n\n- 目标行为可复现；检查结果有证据；已知限制明确说明。\n`;
  const marker = '<!-- emergence:init:v1 -->';
  const addition = `${marker}\n${section}`;
  const content = previous?.includes(marker)
    ? previous
    : previous === undefined
      ? `# ${kind === 'project' ? 'EMERGENCE · 项目约定' : 'EMERGENCE · 个性化约定'}\n\n${addition}`
      : previous + (previous.endsWith('\n') ? '\n' : '\n\n') + addition;
  if (Buffer.byteLength(content) > maxFileBytes)
    throw new Error('草案超过规则文件大小上限，请精简原文件或调整 instructions.maxFileBytes');
  return {
    target,
    boundary,
    content,
    previous,
    previousHash: previous === undefined ? undefined : digest(previous),
    bytes: Buffer.byteLength(content),
    maxFileBytes,
  };
}
export async function writeInstructionDraft(draft: InitDraft) {
  return withLease(`instruction-init:${pathIdentity(draft.target)}`, '规则文件初始化', async () => {
    if (pathIdentity(await realpath(dirname(draft.target))) !== pathIdentity(draft.boundary))
      throw new Error('初始化目录已变化，请重新 /init');
    try {
      const info = await lstat(draft.target);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error('目标类型已变化，请重新 /init');
      const current = await boundedText(draft.target, draft.maxFileBytes, true);
      if (draft.previousHash === undefined || digest(current) !== draft.previousHash)
        throw new Error('文件在预览后已变化，未写入；请重新 /init');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (draft.previousHash !== undefined) throw new Error('原文件已被删除，未写入；请重新 /init');
    }
    if (draft.previous === draft.content) return undefined;
    if (draft.previous === undefined) {
      await writeFile(draft.target, draft.content, { flag: 'wx', mode: 0o600 });
      return undefined;
    }
    // A byte-for-byte backup precedes the atomic replacement. The lease serializes Emergence writers.
    const backup = draft.target + '.backup-' + randomUUID();
    await writeFile(backup, draft.previous, { flag: 'wx', mode: 0o600 });
    const temp = draft.target + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temp, draft.content, { flag: 'wx', mode: 0o600 });
      if (
        digest(await boundedText(draft.target, draft.maxFileBytes, true)) !== draft.previousHash ||
        (await lstat(draft.target)).isSymbolicLink()
      )
        throw new Error('文件在写入前发生变化，未替换；请重新 /init');
      await rename(temp, draft.target);
      return backup;
    } finally {
      await unlink(temp).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
    }
  });
}
