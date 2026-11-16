import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { acquireLease } from './lease.ts';

export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Opt-in semantic identity; legacy journal hashes retain their original byte-order contract. */
export const stableDigest = (value: unknown) =>
  createHash('sha256')
    .update(
      JSON.stringify(value, (_key, item) =>
        item && typeof item === 'object' && !Array.isArray(item)
          ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
          : item,
      ),
    )
    .digest('hex');
export interface ExecutionEffect {
  id: string;
  task: string;
  run: string;
  actor: string;
  call: string;
  tool: string;
  argumentsHash: string;
  state: 'started' | 'returned' | 'failed' | 'uncertain';
  at: string;
  file?: string;
  before?: string;
  after?: string;
  resultHash?: string;
}
type Snapshot = { tasks: Array<{ id: string }>; [key: string]: unknown };

/** One OS lease plus a monotonically increasing database fence. All state/effect commits are transactions. */
export class ExecutionJournal {
  private db?: DatabaseSync;
  private release?: () => Promise<void>;
  private owner = randomUUID();
  epoch = 0;
  path = '';
  constructor(
    private home: string,
    private key: string,
  ) {}
  async open() {
    let dir = await realpath(this.home);
    for (const part of ['core', 'execution']) {
      dir = join(dir, part);
      await mkdir(dir).catch((e) => {
        if (e.code !== 'EEXIST') throw e;
      });
      const info = await lstat(dir);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('执行台账目录不安全');
    }
    this.path = join(dir, digest(this.key) + '.sqlite');
    this.release = await acquireLease(
      'execution:' + (process.platform === 'win32' ? this.path.toLowerCase() : this.path),
      '执行台账',
    );
    try {
      for (const suffix of ['', '-wal', '-shm', '-journal'])
        try {
          const info = await lstat(this.path + suffix);
          if (info.isSymbolicLink() || !info.isFile()) throw new Error('执行台账路径不安全');
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }
      this.db = new DatabaseSync(this.path);
      const version = this.db.prepare('PRAGMA user_version').get()!.user_version;
      if (version !== 0 && version !== 1) throw new Error('执行台账版本不兼容；原文件已保留');
      if (this.db.prepare('PRAGMA quick_check').get()!.quick_check !== 'ok')
        throw new Error('执行台账损坏；原文件已保留');
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
      this.db
        .exec(`CREATE TABLE IF NOT EXISTS ownership (id INTEGER PRIMARY KEY CHECK(id=1), epoch INTEGER NOT NULL, owner TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS metadata (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL, hash TEXT NOT NULL, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS effects (id TEXT PRIMARY KEY, task TEXT NOT NULL, run TEXT NOT NULL, body TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS effects_task ON effects(task);
        CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, epoch INTEGER NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL);
        PRAGMA user_version=1;`);
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.epoch = Number(this.db.prepare('SELECT epoch FROM ownership WHERE id=1').get()?.epoch ?? 0) + 1;
        this.db
          .prepare(
            'INSERT INTO ownership VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET epoch=excluded.epoch,owner=excluded.owner',
          )
          .run(this.epoch, this.owner);
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    } catch (e) {
      await this.close();
      throw e;
    }
  }
  assertOwner() {
    const row = this.db?.prepare('SELECT epoch,owner FROM ownership WHERE id=1').get();
    if (!row || row.epoch !== this.epoch || row.owner !== this.owner)
      throw new Error('执行租约已失效，已阻止过期执行器写回');
  }
  private transaction(action: (db: DatabaseSync) => void) {
    this.assertOwner();
    const db = this.db!;
    db.exec('BEGIN IMMEDIATE');
    try {
      this.assertOwner();
      action(db);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  private event(db: DatabaseSync, kind: string, body: unknown) {
    db.prepare('INSERT INTO events(epoch,at,kind,body) VALUES(?,?,?,?)').run(
      this.epoch,
      new Date().toISOString(),
      kind,
      JSON.stringify(body),
    );
  }
  load(): unknown | undefined {
    this.assertOwner();
    const row = this.db!.prepare('SELECT body FROM metadata WHERE id=1').get();
    if (!row) return;
    return {
      ...JSON.parse(String(row.body)),
      tasks: this.db!.prepare('SELECT body FROM tasks ORDER BY ordinal')
        .all()
        .map((r) => JSON.parse(String(r.body))),
    };
  }
  async backupLegacy(path: string) {
    try {
      const bytes = await readFile(path);
      await writeFile(this.path + '.legacy-' + randomUUID() + '.json', bytes, { flag: 'wx', mode: 0o600 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  async archive() {
    const value = this.load();
    if (value)
      await writeFile(this.path + '.archive-' + randomUUID() + '.json', JSON.stringify(value), {
        flag: 'wx',
        mode: 0o600,
      });
  }
  commit(snapshot: Snapshot, kind = 'checkpoint') {
    const { tasks, ...meta } = snapshot;
    this.transaction((db) => {
      const changed: string[] = [],
        ids = new Set(tasks.map((t) => t.id));
      for (const row of db.prepare('SELECT id FROM tasks').all())
        if (!ids.has(String(row.id))) db.prepare('DELETE FROM tasks WHERE id=?').run(row.id!);
      tasks.forEach((task, index) => {
        const hash = digest(task),
          old = db.prepare('SELECT hash FROM tasks WHERE id=?').get(task.id);
        if (old?.hash === hash) return;
        db.prepare(
          'INSERT INTO tasks VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET ordinal=excluded.ordinal,hash=excluded.hash,body=excluded.body',
        ).run(task.id, index, hash, JSON.stringify(task));
        changed.push(task.id);
      });
      const body = JSON.stringify(meta),
        previous = db.prepare('SELECT body FROM metadata WHERE id=1').get()?.body;
      if (previous !== body)
        db.prepare('INSERT INTO metadata VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(
          body,
        );
      if (changed.length || previous !== body) this.event(db, kind, { changed, hash: digest(snapshot) });
    });
  }
  effect(value: ExecutionEffect) {
    this.transaction((db) => {
      db.prepare('INSERT INTO effects VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(
        value.id,
        value.task,
        value.run,
        JSON.stringify(value),
      );
      this.event(db, 'effect-' + value.state, {
        id: value.id,
        task: value.task,
        run: value.run,
        hash: digest(value),
      });
    });
  }
  effects(task: string): ExecutionEffect[] {
    this.assertOwner();
    return this.db!.prepare('SELECT body FROM effects WHERE task=? ORDER BY rowid')
      .all(task)
      .map((r) => JSON.parse(String(r.body)));
  }
  decision(task: string, body: unknown) {
    this.transaction((db) => this.event(db, 'recovery-decision', { task, body }));
  }
  events(limit = 30) {
    this.assertOwner();
    return this.db!.prepare('SELECT seq,epoch,at,kind,body FROM events ORDER BY seq DESC LIMIT ?').all(
      Math.max(1, Math.min(100, limit)),
    );
  }
  async close() {
    this.db?.close();
    this.db = undefined;
    await this.release?.();
    this.release = undefined;
  }
}
