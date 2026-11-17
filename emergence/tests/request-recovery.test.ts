import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LlmError, ToolCallId, resolveRetryPolicy, type StreamChunk } from '@deepseek-ai/dsh-llm';
import * as Retry from '@deepseek-ai/dsh-llm-retry';
import UserApproval from '@deepseek-ai/dsh-user-approval';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { mountModelResponseValidation } from '../src/core/adapters/model-response.ts';
import { modelProviders } from '../src/app/model-config-runtime.ts';
import { defaultConfig } from '../src/core/domain/configuration.ts';
import { executionFixture, ExecutionProvider, until } from './fixtures/core-execution.ts';
import { setTimeout as delay } from 'node:timers/promises';

class RecoveringProvider extends ExecutionProvider {
  providerRetryPolicy() {
    return resolveRetryPolicy(Object.values(modelProviders(defaultConfig))[0].retryPolicy, 'fixture');
  }
}
async function fixture() {
  const f = await executionFixture(undefined, false, new RecoveringProvider());
  await f.ctx.plugin(Retry);
  f.ctx.effect(() => mountModelResponseValidation(f.ctx));
  const master = f.w.current,
    worker = await f.w.split('row');
  return {
    ...f,
    worker,
    master,
    start: () => f.w.taskEngine.enqueue(worker.id, worker.id, 'request-recovery', 'fixture:write'),
    events: () => worker.controller!.agent.session.snapshotEvents(),
  };
}

test('R4 500/429 transport faults retry only the failed model request and keep durable attempt identities', async () => {
  for (const code of ['SERVER', 'RATE_LIMIT']) {
    const f = await fixture();
    try {
      const original = f.provider.stream.bind(f.provider);
      let attempts = 0;
      f.provider.stream = async function* (options) {
        if (++attempts === 1) throw new LlmError(code === 'SERVER' ? 'HTTP 500' : 'HTTP 429', code);
        yield* original(options);
      };
      const task = await f.start();
      await until(() => !!task.endedAt);
      assert.equal(task.status, 'succeeded', JSON.stringify(task.result));
      assert.equal(f.writes(), 1);
      const retry = f.events().filter((e) => e.type === 'llm/retry');
      assert.equal(retry.length, 1);
      assert.equal(retry[0].data.retry, 1);
      assert.equal(retry[0].data.mode === 'normal' && retry[0].data.maxRetries, 2);
      assert.equal(f.events().filter((e) => e.type === 'llm/retry-started').length, 1);
      assert.ok(f.worker.controller!.diagnostics.snapshot!.durations['model-wait'] >= 400);
      assert.equal(f.w.taskEngine.state.tasks.length, 1);
    } finally {
      await f.close();
    }
  }
});

test('R4 incomplete streamed tool arguments are discarded before retry and never execute', async () => {
  const f = await fixture();
  try {
    const original = f.provider.stream.bind(f.provider);
    let attempts = 0;
    f.provider.stream = async function* (options): AsyncIterable<StreamChunk> {
      if (++attempts === 1) {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield {
          type: 'tool-call-delta',
          index: 0,
          id: ToolCallId('partial'),
          name: 'write',
          argumentsDelta: '{"file_path":',
        };
        throw new LlmError('stream ended without done', 'STREAM_CLOSED');
      }
      assert.ok(
        !JSON.stringify(options.messages).includes('partial'),
        'failed draft cannot enter model history',
      );
      yield* original(options);
    };
    const task = await f.start();
    await until(() => !!task.endedAt);
    assert.equal(task.status, 'succeeded');
    assert.equal(f.writes(), 1);
    assert.equal(f.events().filter((e) => e.type === 'tool/call' && e.data.callId === 'partial').length, 0);
  } finally {
    await f.close();
  }
});

test('R4 exhausted retries and permanent errors terminate instead of replaying business tasks', async () => {
  for (const [code, expected] of [
    ['SERVER', 3],
    ['MALFORMED_RESPONSE', 3],
    ['AUTH', 1],
    ['TIMEOUT', 1],
  ] as const) {
    const f = await fixture();
    try {
      let calls = 0;
      f.provider.stream = async function* () {
        calls++;
        throw new LlmError('fixture failure', code);
      };
      const task = await f.start();
      await until(() => !!task.endedAt);
      assert.equal(calls, expected);
      assert.equal(task.status, 'failed');
      assert.equal(f.worker.controller!.busy, false);
      assert.equal(f.writes(), 0);
      assert.equal(f.w.taskEngine.state.tasks.length, 1);
    } finally {
      await f.close();
    }
  }
});

test('malformed response discards every uncommitted call and recovers without repeating a returned write', async () => {
  const f = await fixture();
  try {
    const original = f.provider.stream.bind(f.provider);
    let faults = 0;
    f.provider.stream = async function* (options): AsyncIterable<StreamChunk> {
      if (f.writes() && faults++ === 0) {
        const id = ToolCallId('discarded-complete');
        const raw = JSON.stringify({ file_path: 'unexpected.txt', content: 'must never execute' });
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'tool-call-delta', index: 0, id, name: 'write', argumentsDelta: raw };
        yield {
          type: 'block-end',
          index: 0,
          block: { type: 'tool-call', id, name: 'write', arguments: raw },
        };
        yield { type: 'block-start', index: 1, blockType: 'tool-call' };
        yield {
          type: 'tool-call-delta',
          index: 1,
          id: ToolCallId('malformed-report'),
          name: 'emergence_report',
          argumentsDelta: '{"summary":"bad " quote"}',
        };
        throw new LlmError('completed tool arguments invalid', 'MALFORMED_RESPONSE');
      }
      assert.ok(!JSON.stringify(options.messages).includes('discarded-complete'));
      yield* original(options);
    };
    const task = await f.start();
    await until(() => !!task.endedAt);
    assert.equal(task.status, 'succeeded');
    assert.equal(f.writes(), 1);
    assert.equal(f.w.taskEngine.state.tasks.length, 1);
    assert.equal(f.w.taskEngine.journal.effects(task.id).length, 1);
    const retries = f.events().filter((e) => e.type === 'llm/retry');
    assert.equal(retries.length, 1);
    assert.equal(retries[0].data.failure.code, 'MALFORMED_RESPONSE');
    assert.ok(
      !f
        .events()
        .some(
          (e) => e.type === 'tool/call' && ['discarded-complete', 'malformed-report'].includes(e.data.callId),
        ),
    );
  } finally {
    await f.close();
  }
});

test('R4 cancellation and original deadlines stop retry backoff; neither resets the turn budget', async () => {
  for (const cancellation of [true, false]) {
    const f = await fixture();
    try {
      if (!cancellation) f.worker.controller!.launch.appConfig.orchestration.budgets.planningMs = 1000;
      let calls = 0;
      f.provider.stream = async function* () {
        calls++;
        throw new LlmError('HTTP 500', 'SERVER');
      };
      const task = await f.start();
      await until(() => f.events().some((e) => e.type === 'llm/retry'));
      if (cancellation) await f.w.taskEngine.cancel(task.id);
      await until(() => !!task.endedAt);
      assert.equal(
        task.status,
        'cancelled',
        JSON.stringify({
          cancellation,
          calls,
          diagnostic: f.worker.controller!.diagnostics.snapshot,
          retry: f.events().filter((e) => e.type === 'llm/retry'),
        }),
      );
      assert.ok(calls <= 2);
      if (!cancellation) assert.match(task.cancelReason!, /模型首段响应/);
      const requests = f.worker.controller!.diagnostics.snapshot!.requests;
      await delay(650);
      assert.equal(f.events().filter((e) => e.type === 'llm/retry-started').length, requests - 1);
      assert.equal(f.worker.controller!.diagnostics.snapshot!.requests, requests);
      assert.equal(f.worker.controller!.busy, false);
    } finally {
      await f.close();
    }
  }
});

test('R4 loss after a returned write retries the following request only and never repeats that write', async () => {
  const f = await fixture();
  try {
    const original = f.provider.stream.bind(f.provider);
    let faults = 0;
    f.provider.stream = async function* (options) {
      if (f.writes() && faults++ < 2) throw new LlmError('connection reset after write', 'TRANSPORT');
      yield* original(options);
    };
    const task = await f.start();
    await until(() => !!task.endedAt);
    assert.equal(task.status, 'succeeded');
    assert.equal(f.writes(), 1);
    assert.equal(f.events().filter((e) => e.type === 'llm/retry').length, 2);
    assert.equal(f.w.taskEngine.journal.effects(task.id).length, 1);
  } finally {
    await f.close();
  }
});

test('missing command is rejected before approval; a corrected call still requires its own permission', async () => {
  for (const exhausted of [false, true]) {
    const f = await fixture();
    try {
      await f.ctx.plugin(UserApproval);
      let commands = 0;
      f.ctx.effect(() =>
        f.ctx.tools.register(
          defineTool({
            name: 'pwsh',
            description: 'fixture command',
            parameters: { command: { type: 'string', required: true } },
            output: {
              schema: { type: 'json' },
              render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
            },
            async execute() {
              commands++;
              return { exitCode: 0 };
            },
          }),
        ),
      );
      const original = f.provider.stream.bind(f.provider);
      let requests = 0;
      f.provider.stream = async function* (options): AsyncIterable<StreamChunk> {
        requests++;
        assert.ok(!JSON.stringify(options.messages).includes('missing-command'));
        if (exhausted || requests <= 2) {
          const invalid = exhausted || requests === 1;
          const id = ToolCallId(invalid ? 'missing-command' : 'corrected-command');
          const raw = JSON.stringify(invalid ? { description: 'List files' } : { command: 'fixture-check' });
          yield { type: 'block-start', index: 0, blockType: 'tool-call' };
          yield { type: 'tool-call-delta', index: 0, id, name: 'pwsh', argumentsDelta: raw };
          yield {
            type: 'block-end',
            index: 0,
            block: { type: 'tool-call', id, name: 'pwsh', arguments: raw },
          };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        yield* original(options);
      };
      const task = await f.start();
      const approvals = new Set<string>();
      await until(() => {
        const pending = f.worker.controller!.pending;
        if (pending && !approvals.has(pending.id)) {
          assert.equal(pending.binding?.callId, 'corrected-command');
          approvals.add(pending.id);
          pending.respond('y');
        }
        return !!task.endedAt;
      });
      assert.equal(task.status, exhausted ? 'failed' : 'succeeded', JSON.stringify(task.result));
      assert.equal(commands, exhausted ? 0 : 1);
      assert.equal(approvals.size, exhausted ? 0 : 1);
      assert.equal(f.events().filter((e) => e.type === 'llm/retry').length, exhausted ? 2 : 1);
      assert.ok(!f.events().some((e) => e.type === 'tool/call' && e.data.callId === 'missing-command'));
      if (exhausted) assert.equal(requests, 3);
    } finally {
      await f.close();
    }
  }
});
