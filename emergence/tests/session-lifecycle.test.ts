import { LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SessionController } from '../src/app/controller.ts';
import { SessionLifecycle } from '../src/app/session-lifecycle.ts';
import { defaultConfig } from '../src/core/domain/configuration.ts';
import { acquireLease, canonicalDirectory } from '../src/core/storage/lease.ts';
import { harness } from './fixtures/harness.ts';

class Provider extends LlmAdapter {
  async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, defaultMaxTokens: 2048 };
  }
  async *stream(): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
function gate() {
  return Promise.withResolvers<void>();
}
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'emergence-session-lifecycle-'));
  const ctx = await harness(home, ['deepseek'], new Provider());
  const launch = { home, cwd: home, modelId: 'deepseek', appConfig: structuredClone(defaultConfig) };
  const hooks: ConstructorParameters<typeof SessionLifecycle>[2] = {
    beforeSwitch() {},
    resetAccess() {},
    async bind() {},
    bindChild() {},
    resetDisplay() {},
    stopping() {},
    cancelling() {},
    cancelInteractions() {},
    notice() {},
    error() {},
    changed() {},
  };
  const session = new SessionLifecycle(ctx, launch, hooks);
  return {
    ctx,
    home,
    launch,
    hooks,
    session,
    async close() {
      await session.close({ beforeDispose: [], afterDispose: [] }, []);
      await ctx.fiber.dispose();
    },
  };
}
async function assertReleased(home: string, id: string) {
  const release = await acquireLease(`session:${await canonicalDirectory(home)}:${id}`, 'test session');
  await release();
}

test('session switch has one owner; close waits for an in-flight binding and releases both handles', async () => {
  const f = await fixture(),
    binding = gate(),
    resume = gate();
  try {
    await f.session.open();
    const previous = f.session.current!.id;
    let candidate = '';
    f.hooks.bind = async (agent) => {
      candidate = agent.id;
      binding.resolve();
      await resume.promise;
    };
    const opening = f.session.open();
    const rejected = assert.rejects(opening, /关闭/);
    await binding.promise;
    assert.equal(f.session.busy, true);
    assert.throws(() => f.session.open(), /切换/);
    assert.throws(() => f.session.assertReady(), /切换/);
    const close = f.session.close({ beforeDispose: [], afterDispose: [] }, []);
    assert.equal(close, f.session.close({ beforeDispose: [], afterDispose: [] }, []));
    resume.resolve();
    await rejected;
    await close;
    assert.equal(f.ctx.agents.list().length, 0);
    await assertReleased(f.home, previous);
    await assertReleased(f.home, candidate);
  } finally {
    resume.resolve();
    await f.close();
  }
});

test('failed binding rolls back the current session, persisted selection and candidate lease', async () => {
  const f = await fixture();
  try {
    await f.session.open();
    const previous = f.session.current!,
      saved = await readFile(join(f.home, 'last-session.json'), 'utf8');
    let candidate = '';
    f.hooks.bind = async (agent) => {
      if (agent !== previous) {
        candidate = agent.id;
        throw new Error('binding failed');
      }
    };
    await assert.rejects(f.session.open(), /binding failed/);
    assert.equal(f.session.busy, false);
    assert.equal(f.session.current, previous);
    assert.deepEqual(f.ctx.agents.list(), [previous]);
    assert.equal(await readFile(join(f.home, 'last-session.json'), 'utf8'), saved);
    await assertReleased(f.home, candidate);
    f.hooks.bind = async () => {};
    await f.session.open();
    await assertReleased(f.home, previous.id);
  } finally {
    await f.close();
  }
});

test('every cleanup runs after failures; closing twice cannot double-release resources', async () => {
  const f = await fixture(),
    visited: string[] = [];
  try {
    await f.session.open();
    const id = f.session.current!.id;
    const close = f.session.close(
      {
        beforeDispose: [
          () => {
            visited.push('before');
            throw new Error('before failed');
          },
        ],
        afterDispose: [
          () => {
            visited.push('after');
            throw new Error('after failed');
          },
          () => {
            visited.push('last');
          },
        ],
      },
      [
        () => {
          visited.push('listener');
        },
      ],
    );
    await assert.rejects(
      close,
      (error: unknown) => error instanceof AggregateError && error.errors.length === 2,
    );
    assert.equal(close, f.session.close({ beforeDispose: [], afterDispose: [] }, []));
    assert.deepEqual(visited, ['before', 'after', 'last', 'listener']);
    assert.equal(f.ctx.agents.list().length, 0);
    await assertReleased(f.home, id);
  } finally {
    await f.ctx.fiber.dispose();
  }
});

test('concurrent cancellation shares one operation and settles before close', async () => {
  const f = await fixture();
  try {
    await f.session.open();
    let cancellations = 0;
    const visibleBusy: boolean[] = [];
    f.hooks.changed = () => {
      visibleBusy.push(f.session.busy);
    };
    f.hooks.cancelling = () => {
      cancellations++;
    };
    const first = f.session.cancel(),
      second = f.session.cancel();
    assert.equal(first, second);
    await Promise.all([first, second]);
    assert.equal(cancellations, 1);
    assert.equal(visibleBusy.at(-1), false, 'the final notification must expose the settled idle state');
  } finally {
    await f.close();
  }
});

test('a delayed model selection cannot change a replacement session', async (t) => {
  const f = await fixture(),
    entered = gate(),
    release = gate();
  const c = new SessionController(f.ctx, f.launch);
  try {
    await c.open();
    const resolve = f.ctx.llm.resolveModelInfo.bind(f.ctx.llm);
    t.mock.method(f.ctx.llm, 'resolveModelInfo', async (...args: Parameters<typeof resolve>) => {
      entered.resolve();
      await release.promise;
      return resolve(...args);
    });
    const selection = c.command('/model deepseek');
    const rejected = assert.rejects(selection, /会话状态已变化/);
    await entered.promise;
    await c.open();
    release.resolve();
    await rejected;
    assert.equal(c.launch.modelId, 'deepseek');
  } finally {
    release.resolve();
    await c.close();
    await f.close();
  }
});
