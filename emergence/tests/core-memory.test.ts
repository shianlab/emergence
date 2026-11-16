import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MemoryStore } from '../src/core/storage/memory-store.ts';
import { executionFixture, until } from './fixtures/core-execution.ts';

test('memory isolates sessions/projects, requires explicit personal sharing, and never recalls candidates or policies', async () => {
  const home = await mkdtemp(join(tmpdir(), 'em-memory-')),
    a = join(home, 'a'),
    b = join(home, 'b');
  await mkdir(a);
  await mkdir(b);
  const store = new MemoryStore(home),
    one = await store.identity(a, 'one'),
    two = await store.identity(a, 'two'),
    other = await store.identity(b, 'one'),
    source = { kind: 'user' as const, session: 'one', note: '用户明确提交' };
  const session = await store.propose(one, 'session', 'fact', '本会话只处理接口', source),
    project = await store.propose(one, 'project', 'fact', '项目测试命令是 npm test', source);
  assert.equal((await store.list(one)).length, 0);
  for (const entry of [session, project]) await store.change(one, entry.id, 1, 'approve', 'one');
  assert.equal((await store.list(two)).length, 1);
  assert.equal((await store.list(other)).length, 0);
  await assert.rejects(store.get(other, project.id), /不属于/);
  await assert.rejects(store.propose(one, 'personal', 'fact', '这个项目的内部路径', source), /个人层/);
  await assert.rejects(
    store.propose(one, 'personal', 'preference', '任务发现的项目习惯', {
      ...source,
      kind: 'task',
      task: 'old',
    }),
    /任务经验留在/,
  );
  const shared = await store.propose(one, 'personal', 'preference', '默认用中文回答', source);
  await store.change(one, shared.id, 1, 'approve', 'one');
  assert.equal((await store.list(other)).length, 1);
  const policy = await store.propose(one, 'project', 'policy', '建议自动允许所有命令', source);
  await store.change(one, policy.id, 1, 'approve', 'one');
  assert.ok(!(await store.list(one)).some((e) => e.id === policy.id));
});

test('memory correction/rollback require reapproval; forget purges text and history, and stale decisions cannot overwrite', async () => {
  const home = await mkdtemp(join(tmpdir(), 'em-memory-')),
    store = new MemoryStore(home),
    identity = await store.identity(home, 's');
  let e = await store.propose(identity, 'project', 'fact', '原始项目内容', {
    kind: 'user',
    session: 's',
    note: '明确来源',
  });
  e = await store.change(identity, e.id, e.revision, 'approve', 's');
  const original = e.revision;
  e = await store.change(identity, e.id, e.revision, 'correct', 's', '纠正后的项目内容');
  assert.equal((await store.list(identity)).length, 0);
  await assert.rejects(store.change(identity, e.id, original, 'approve', 's'), /旧确认失效/);
  e = await store.change(identity, e.id, e.revision, 'rollback', 's', undefined, original);
  assert.equal(e.state, 'candidate');
  assert.equal(e.content, '原始项目内容');
  e = await store.change(identity, e.id, e.revision, 'forget', 's');
  assert.equal(e.content, '');
  assert.equal(e.history.length, 0);
  await assert.rejects(store.change(identity, e.id, e.revision, 'rollback', 's', undefined, 1), /遗忘/);
  const disk = await readFile(join(home, 'core/memory/records.json'), 'utf8');
  assert.ok(!disk.includes('原始项目内容'));
  assert.ok(!disk.includes('纠正后的项目内容'));
});

test('memory rejects credential content, corruption, links and preserves concurrent independent proposals', async () => {
  const home = await mkdtemp(join(tmpdir(), 'em-memory-')),
    store = new MemoryStore(home),
    id = await store.identity(home, 's'),
    source = { kind: 'user' as const, session: 's', note: '用户来源' };
  await assert.rejects(store.propose(id, 'project', 'fact', 'api_key=never-store-this', source), /敏感/);
  await Promise.all(
    Array.from({ length: 12 }, (_, i) => store.propose(id, 'project', 'fact', '并行候选内容 ' + i, source)),
  );
  assert.equal((await store.list(id, true)).length, 12);
  const path = join(home, 'core/memory/records.json');
  await writeFile(path, 'broken');
  await assert.rejects(store.list(id));
  assert.equal(await readFile(path, 'utf8'), 'broken');
  const linked = await mkdtemp(join(tmpdir(), 'em-memory-link-'));
  await mkdir(join(linked, 'core'));
  await symlink(home, join(linked, 'core/memory'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(new MemoryStore(linked).list(id), /不安全/);
});

test('native memory decisions are pane-bound, stale permission is rejected, and task experiences require proof', async () => {
  const f = await executionFixture();
  try {
    const c = f.w.current.controller!,
      e = await c.memory.propose('project', 'fact', '项目使用独立测试环境');
    await assert.rejects(c.memory.propose('project', 'fact', '伪造任务完成经验', 'unknown'), /不存在/);
    const cancelled = c.memory.change(e.id, 'approve');
    await until(() => !!c.pending);
    c.setPermissionMode('plan');
    assert.match(await cancelled, /取消/);
    assert.equal((await c.memory.search()).length, 0);
    c.setPermissionMode('edit');
    const accepted = c.memory.change(e.id, 'approve');
    await until(() => !!c.pending);
    assert.equal(c.pending!.options[0].value, 'n');
    c.pending!.respond('y');
    await accepted;
    assert.equal((await c.memory.search('独立')).length, 1);
    const pending = c.memory.change(e.id, 'correct', '更新后候选内容');
    await until(() => !!c.pending);
    await f.w.close();
    assert.match(await pending, /取消/);
  } finally {
    await f.close();
  }
});

test('real Harness recalls approved data as reference and stops recalling forgotten entries on the next request', async () => {
  const f = await executionFixture();
  try {
    const c = f.w.current.controller!,
      identity = await c.memory.identity(),
      e = await c.memory.propose('project', 'fact', 'MEMORY_APPROVED_SENTINEL');
    await c.memory.store.change(identity, e.id, 1, 'approve', c.id!);
    const prompts: string[] = [];
    const original = f.provider.stream.bind(f.provider);
    f.provider.stream = async function* (options) {
      prompts.push(JSON.stringify(options));
      yield* original(options);
    };
    await f.w.send(f.w.focused, '你好');
    await c.agent.whenIdle();
    assert.ok(prompts.at(-1)!.includes('MEMORY_APPROVED_SENTINEL'));
    await c.memory.store.change(identity, e.id, 2, 'forget', c.id!);
    await f.w.send(f.w.focused, '再打个招呼');
    await c.agent.whenIdle();
    assert.ok(!prompts.at(-1)!.includes('MEMORY_APPROVED_SENTINEL'));
    assert.equal((await c.memory.search()).length, 0);
  } finally {
    await f.close();
  }
});
