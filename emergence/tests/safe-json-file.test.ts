import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { readJsonFile, replaceJsonFile } from '../src/core/storage/safe-json-file.ts';
import { RunDiagnostics } from '../src/core/application/run-diagnostics.ts';
import { RunDiagnosticsStore } from '../src/core/storage/run-diagnostics-store.ts';
import { budgetPolicySchema } from '../src/core/domain/run-budget.ts';
import { digest } from '../src/core/storage/execution-journal.ts';
import { executionFixture } from './fixtures/core-execution.ts';

const options = { invalidMessage: 'Invalid snapshot', maxBytes: 10000 };

test(
  'workspace persistence shares bounded atomic replacement and recovers its write queue after a locked target',
  { skip: process.platform !== 'win32', timeout: 15000 },
  async () => {
    const f = await executionFixture();
    let release = async () => {};
    try {
      f.w.current.draft = 'before';
      await f.w.save();
      release = await lockFile(f.w.path);
      f.w.current.draft = 'after short lock';
      await Promise.all([f.w.save(), delay(70).then(release)]);
      const snapshot = (await readJsonFile(f.w.path, 32000000, 'Invalid workspace')) as {
        panes: Array<{ draft: string }>;
      };
      assert.equal(snapshot.panes[0].draft, 'after short lock');
      release = await lockFile(f.w.path);
      f.w.current.draft = 'must not truncate old snapshot';
      await assert.rejects(f.w.save(), (error: NodeJS.ErrnoException) =>
        ['EPERM', 'EACCES', 'EBUSY'].includes(error.code ?? ''),
      );
      assert.deepEqual(await readJsonFile(f.w.path, 32000000, 'Invalid workspace'), snapshot);
      await release();
      f.w.current.draft = 'recovered';
      await f.w.save();
      assert.equal(
        ((await readJsonFile(f.w.path, 32000000, 'Invalid workspace')) as typeof snapshot).panes[0].draft,
        'recovered',
      );
      assert.equal(f.writes(), 0, 'persistence recovery never replays a business effect');
      assert.ok((await readdir(join(f.home, 'workspaces'))).every((name) => !name.endsWith('.tmp')));
    } finally {
      await release();
      await f.close();
    }
  },
);

test('atomic snapshots remain readable during concurrent observation without dropping writes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'emergence-json-'));
  const path = join(dir, 'snapshot.json');
  await replaceJsonFile(path, { revision: 0 }, options);
  let done = false;
  await Promise.all([
    (async () => {
      try {
        for (let revision = 1; revision <= 500; revision++)
          await replaceJsonFile(path, { revision }, options);
      } finally {
        done = true;
      }
    })(),
    (async () => {
      let previous = 0;
      while (!done) {
        const value = (await readJsonFile(path, 10000, 'Invalid snapshot')) as { revision: number };
        assert.ok(value.revision >= previous && value.revision <= 500);
        previous = value.revision;
        await delay(1);
      }
    })(),
  ]);
  assert.deepEqual(await readJsonFile(path, 10000, 'Invalid snapshot'), { revision: 500 });
  assert.deepEqual(await readdir(dir), ['snapshot.json']);
});

test(
  'a failed timing save keeps memory accounting and the final snapshot recovers after a reader unlocks',
  { skip: process.platform !== 'win32', timeout: 10000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), 'emergence-timing-lock-'));
    const store = new RunDiagnosticsStore(home);
    const clock = new RunDiagnostics(
      store,
      () => budgetPolicySchema.parse({}),
      async () => {},
    );
    await clock.bind('session');
    clock.start();
    clock.assign('task');
    clock.model('start');
    await store.write('session', [clock.snapshot!]);
    const release = await lockFile(join(home, 'core', 'run-diagnostics', digest('session') + '.json'));
    try {
      clock.end();
      await clock.close();
      assert.match(clock.error!, /保存失败/);
      assert.equal((await store.read('session'))[0].outcome, 'running');
      assert.equal(clock.snapshot!.outcome, 'ended');
    } finally {
      await release();
    }
    const snapshot = clock.snapshot!;
    await clock.close();
    assert.equal(clock.error, undefined);
    assert.deepEqual(await store.read('session'), [snapshot]);
    assert.equal(snapshot.requests, 1);
    assert.equal(snapshot.task, 'task');
  },
);

async function lockFile(path: string) {
  const child = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$file = [System.IO.File]::Open('${path.replaceAll("'", "''")}', 'Open', 'Read', 'Read'); try { [Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); [Console]::ReadLine() | Out-Null } finally { $file.Dispose() }`,
    ],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const exited = once(child, 'exit');
  try {
    await Promise.race([
      once(child.stdout, 'data', { signal: AbortSignal.timeout(3000) }).then(([data]) =>
        assert.match(String(data), /locked/),
      ),
      exited.then(() => {
        throw new Error('Lock fixture exited before acquiring the file');
      }),
    ]);
  } catch (error) {
    child.kill();
    await exited;
    throw error;
  }
  let released = false;
  return async () => {
    if (!released) {
      released = true;
      child.stdin.end('\n');
    }
    await exited;
  };
}

test(
  'Windows replacement waits for a short reader lock; a persistent lock fails with the old snapshot intact',
  { skip: process.platform !== 'win32', timeout: 10000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'emergence-json-lock-'));
    const path = join(dir, 'snapshot.json');
    await writeFile(path, JSON.stringify({ revision: 0 }));
    let release = await lockFile(path);
    try {
      await Promise.all([replaceJsonFile(path, { revision: 1 }, options), delay(70).then(release)]);
    } finally {
      await release();
    }
    assert.deepEqual(await readJsonFile(path, 10000, 'Invalid snapshot'), { revision: 1 });
    release = await lockFile(path);
    try {
      await assert.rejects(replaceJsonFile(path, { revision: 2 }, options), (error: NodeJS.ErrnoException) =>
        ['EPERM', 'EACCES', 'EBUSY'].includes(error.code ?? ''),
      );
      assert.deepEqual(await readJsonFile(path, 10000, 'Invalid snapshot'), { revision: 1 });
      assert.deepEqual(await readdir(dir), ['snapshot.json']);
    } finally {
      await release();
    }
    await replaceJsonFile(path, { revision: 3 }, options);
    assert.deepEqual(await readJsonFile(path, 10000, 'Invalid snapshot'), { revision: 3 });
  },
);
