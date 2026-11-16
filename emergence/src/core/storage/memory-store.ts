import { randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { checkedMemoryText } from '../adapters/memory-content.ts';
import {
  memoryFile,
  memoryKind,
  memoryScope,
  memorySource,
  type MemoryEntry,
  type MemoryIdentity,
  type MemorySource,
} from '../domain/memory.ts';
import { digest } from './execution-journal.ts';
import { withLease } from './lease.ts';
import { readJsonFile, replaceJsonFile } from './safe-json-file.ts';

/** Bounded local memory. A forgotten entry retains an ID tombstone, never its text or historical text. */
export class MemoryStore {
  constructor(private home: string) {}
  async identity(project: string, session: string): Promise<MemoryIdentity> {
    const path = await realpath(project);
    return { project: digest(process.platform === 'win32' ? path.toLowerCase() : path), session };
  }
  private owner(scope: MemoryEntry['scope'], identity: MemoryIdentity) {
    return scope === 'personal'
      ? 'personal'
      : scope === 'project'
        ? identity.project
        : digest([identity.project, identity.session]);
  }
  private visible(e: MemoryEntry, identity: MemoryIdentity) {
    return e.owner === this.owner(e.scope, identity);
  }
  private async file() {
    let dir = await realpath(this.home);
    for (const part of ['core', 'memory']) {
      dir = join(dir, part);
      await mkdir(dir).catch((e) => {
        if (e.code !== 'EEXIST') throw e;
      });
      const info = await lstat(dir);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('记忆目录不安全');
    }
    return join(dir, 'records.json');
  }
  private async access<T>(
    action: (data: ReturnType<typeof memoryFile.parse>) => T,
    write = false,
  ): Promise<T> {
    const path = await this.file();
    return withLease(
      'memory:' + (process.platform === 'win32' ? path.toLowerCase() : path),
      '记忆存储',
      async () => {
        let data: ReturnType<typeof memoryFile.parse> = { version: 1, entries: [] };
        try {
          data = memoryFile.parse(await readJsonFile(path, 6_000_000, '记忆文件不安全或超过预算'));
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }
        const result = action(data);
        if (write)
          await replaceJsonFile(path, memoryFile.parse(data), {
            invalidMessage: '记忆文件不安全或超过预算',
            maxBytes: 6_000_000,
            budgetMessage: '记忆容量已满，请先整理',
          });
        return structuredClone(result);
      },
    );
  }
  list(identity: MemoryIdentity, all = false) {
    return this.access((d) =>
      d.entries.filter(
        (e) => this.visible(e, identity) && (all || (e.state === 'approved' && e.kind !== 'policy')),
      ),
    );
  }
  async get(identity: MemoryIdentity, id: string) {
    const entry = (await this.list(identity, true)).find((e) => e.id === id);
    if (!entry) throw new Error('记忆不存在或不属于当前项目/会话');
    return entry;
  }
  async propose(
    identity: MemoryIdentity,
    scope: MemoryEntry['scope'],
    kind: MemoryEntry['kind'],
    content: string,
    source: MemorySource,
  ) {
    scope = memoryScope.parse(scope);
    kind = memoryKind.parse(kind);
    content = checkedMemoryText(content);
    source = memorySource.parse(source);
    checkedMemoryText(source.note);
    if (scope === 'personal' && kind !== 'preference')
      throw new Error('个人层仅保存显式共享的通用偏好；项目事实和策略不得跨项目共享');
    if (scope === 'personal' && source.kind !== 'user')
      throw new Error('任务经验留在项目或会话内；跨项目通用偏好请用户明确提交 personal preference 候选');
    return this.access((d) => {
      const e: MemoryEntry = {
        id: randomUUID().slice(0, 12),
        scope,
        owner: this.owner(scope, identity),
        kind,
        state: 'candidate',
        revision: 1,
        content,
        source,
        at: new Date().toISOString(),
        history: [],
      };
      d.entries.push(e);
      return e;
    }, true);
  }
  change(
    identity: MemoryIdentity,
    id: string,
    revision: number,
    action: 'approve' | 'correct' | 'forget' | 'rollback',
    actor: string,
    text?: string,
    target?: number,
  ) {
    return this.access((d) => {
      const e = d.entries.find((e) => e.id === id && this.visible(e, identity));
      if (!e || e.revision !== revision) throw new Error('记忆已变化，旧确认失效');
      if (e.state === 'forgotten') throw new Error('记忆已遗忘，不能通过历史或回滚恢复正文');
      if (action === 'approve' && e.state !== 'candidate') throw new Error('只能批准候选记忆');
      const previous = {
        revision: e.revision,
        content: e.content,
        source: e.source,
        at: e.at,
        actor,
        action,
      };
      if (action === 'forget') {
        e.content = '';
        e.history = [];
        e.source = { kind: 'user', session: actor, note: '已遗忘；正文与历史正文已移除' };
        e.state = 'forgotten';
      } else {
        if (action === 'correct') {
          e.content = checkedMemoryText(text ?? '');
          e.source = { kind: 'user', session: actor, note: '用户纠错，需重新批准' };
        }
        if (action === 'rollback') {
          const old = e.history.find((v) => v.revision === target);
          if (!old) throw new Error('历史版本不存在');
          e.content = checkedMemoryText(old.content);
          e.source = old.source;
        }
        e.history = [...e.history, previous].slice(-10);
        e.state = action === 'approve' ? 'approved' : 'candidate';
      }
      e.approvedBy = action === 'approve' ? actor : undefined;
      e.revision++;
      e.at = new Date().toISOString();
      return e;
    }, true);
  }
}
