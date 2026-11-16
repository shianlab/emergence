import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { HistoricalOrchestrationWorkspace as WorkspaceController } from './fixtures/historical-orchestration.ts';
import { defaultConfig } from '../src/core/domain/configuration.ts';
import { harness } from './fixtures/harness.ts';

class Provider extends LlmAdapter {
  async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, defaultMaxTokens: 1024 };
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const messages = options.messages.map((m) => ({ role: m.role, text: JSON.stringify(m.content) }));
    const index = messages.findLastIndex((m) => m.role === 'user' && m.text.includes('[Emergence task '));
    const scenario =
      messages.findLastIndex((m) => m.role === 'user' && m.text.includes('manual instruction')) > index
        ? undefined
        : messages[index]?.text.match(/unit:(slow|good|tool-error|shell-fail|report-fail)/)?.[1];
    if (!scenario || options.model === 'master') {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'receipt acknowledged' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'receipt acknowledged' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    const count = messages.slice(index + 1).filter((m) => m.role === 'tool').length;
    const name = count === 0 ? (scenario === 'shell-fail' ? 'pwsh' : 'work') : 'emergence_report';
    const args =
      count === 0
        ? { scenario }
        : {
            outcome: scenario === 'report-fail' ? 'failed' : 'success',
            summary: '模型声称完成 ' + scenario,
            artifacts: ['result.txt'],
          };
    const id = ToolCallId(`call-${count}`),
      raw = JSON.stringify(args);
    yield { type: 'block-start', index: 0, blockType: 'tool-call' };
    yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: raw };
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: raw } };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  }
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 600; i++) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error('Task-state timeout');
}

test('collaboration uses exact turns, durable deduplication, queues, dependencies, actual failures, takeover and restart without replay', async () => {
  const home = await mkdtemp(join(tmpdir(), 'emergence-collab-')),
    cwd = join(home, '项目');
  await mkdir(cwd);
  const ctx = await harness(home, ['master', 'worker'], new Provider());
  const key = process.env.COLLAB_TEST_KEY;
  process.env.COLLAB_TEST_KEY = 'local-fixture';
  const config = structuredClone(defaultConfig);
  config.defaultModel = 'master';
  config.models = ['master', 'worker'].map((id) => ({
    ...defaultConfig.models[0],
    id,
    model: id,
    apiKeyEnv: 'COLLAB_TEST_KEY',
  }));
  // The synthetic pwsh tool deliberately returns a nonzero exit inside a successful transport envelope.
  config.shellMode = 'sandbox';
  config.permissions = {
    defaultMode: 'auto',
    rules: ['work', 'pwsh'].map((tool) => ({ tool, effect: 'allow' })),
  };
  let executions = 0;
  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'work',
        description: 'Controlled task work',
        parameters: { scenario: { type: 'string', required: true } },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        async execute(args, exec) {
          executions++;
          await delay(args.scenario === 'slow' ? 800 : 25, undefined, { signal: exec.signal });
          if (args.scenario === 'tool-error') throw new Error('ACTUAL_TOOL_FAILURE');
          return 'work verified';
        },
      }),
    ),
  );
  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'pwsh',
        description: 'Controlled unsuccessful shell',
        parameters: { scenario: { type: 'string' } },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        async execute() {
          return { kind: 'foreground', exitCode: 7, timedOut: false, signal: null };
        },
      }),
    ),
  );
  const launch = { home, cwd, modelId: 'master', appConfig: config };
  let workspace = new WorkspaceController(ctx, launch);
  try {
    await workspace.initialize();
    const master = workspace.current,
      worker = await workspace.split('row', cwd, 'worker'),
      second = await workspace.split('column', cwd, 'worker');
    const c = workspace.collaboration;
    c.configure(master.id, [worker.id, second.id]);
    await assert.rejects(c.enqueue(worker.id, second.id, 'unauthorized', 'unit:good'), /只有当前主控/);
    const a = await c.enqueue(master.id, worker.id, 'stable', 'unit:good');
    const duplicate = await c.enqueue(master.id, worker.id, 'stable', 'unit:good');
    assert.equal(a.id, duplicate.id);
    await assert.rejects(c.enqueue(master.id, worker.id, 'stable', 'unit:slow'), /参数不同/);
    await until(() => a.status === 'succeeded');
    assert.ok(a.turn !== undefined);
    assert.ok(a.result!.toSeq > a.result!.fromSeq);
    assert.equal(executions, 1);
    const events = worker.controller!.agent.session.snapshotEvents();
    assert.equal(events.filter((e) => e.type === 'user/message' && e.data.id === a.messageId).length, 1);
    await until(() => master.controller!.transcript().some((line) => line.includes('任务实际回执')));
    const failed = await c.enqueue(master.id, worker.id, 'tool-fail', 'unit:tool-error');
    const blocked = await c.enqueue(master.id, second.id, 'bad-dependency', 'unit:good', [failed.id]);
    await until(() => failed.status === 'needs_review' && blocked.status === 'blocked');
    assert.ok(failed.result!.errors.some((s) => s.includes('ACTUAL_TOOL_FAILURE')));
    assert.equal(failed.report!.outcome, 'success');
    const shell = await c.enqueue(master.id, worker.id, 'shell-fail', 'unit:shell-fail');
    await until(() => shell.status === 'needs_review');
    const reported = await c.enqueue(master.id, second.id, 'reported-fail', 'unit:report-fail');
    await until(() => reported.status === 'failed');
    const slow = await c.enqueue(master.id, worker.id, 'slow', 'unit:slow');
    await until(() => slow.status === 'running');
    const queued = await c.enqueue(master.id, worker.id, 'queued', 'unit:good');
    assert.equal(queued.status, 'queued');
    await c.cancel(queued.id);
    assert.equal(queued.status, 'cancelled');
    const dependent = await c.enqueue(master.id, second.id, 'dependency', 'unit:good', [slow.id]);
    assert.equal(dependent.status, 'queued');
    c.independent();
    await assert.rejects(c.enqueue(master.id, second.id, 'independent', 'unit:good'), /派发已停止/);
    await until(() => slow.status === 'succeeded');
    assert.equal(dependent.status, 'queued');
    c.configure(master.id, [worker.id, second.id]);
    await until(() => dependent.status === 'succeeded');
    const takeover = await c.enqueue(master.id, worker.id, 'takeover', 'unit:slow');
    await until(() => takeover.status === 'running');
    const parked = await c.enqueue(master.id, worker.id, 'parked', 'unit:good');
    await c.note(takeover.id, '检查后再结束');
    assert.equal(takeover.notes.length, 1);
    await assert.rejects(workspace.send(worker.id, '直接插入'), /takeover/);
    await c.takeover(worker.id);
    assert.equal(takeover.status, 'cancelled');
    assert.equal(parked.status, 'queued');
    await workspace.send(worker.id, 'manual instruction');
    await worker.controller!.agent.whenIdle();
    assert.equal(parked.status, 'queued');
    c.release(worker.id);
    await until(() => parked.status === 'succeeded');
    c.pause(true);
    await assert.rejects(c.enqueue(master.id, worker.id, 'paused', 'unit:good'), /派发已停止/);
    c.pause(false);
    const restart = await c.enqueue(master.id, worker.id, 'restart', 'unit:slow');
    await until(() => restart.status === 'running');
    await workspace.save();
    const snapshot = JSON.parse(await readFile(workspace.path, 'utf8'));
    assert.equal(
      snapshot.collaboration.tasks.find((t: { id: string }) => t.id === restart.id).targetSession,
      worker.controller!.id,
    );
    await workspace.close();
    const before = executions;
    workspace = new WorkspaceController(ctx, launch);
    await workspace.initialize();
    assert.equal(workspace.collaboration.task(restart.id).status, 'interrupted');
    assert.equal(workspace.collaboration.state.mode, 'independent');
    await delay(100);
    assert.equal(executions, before, 'restart must never replay an in-flight task');
    workspace.collaboration.configure(master.id, [worker.id, second.id]);
    const again = await workspace.collaboration.enqueue(master.id, worker.id, 'stable', 'unit:good');
    assert.equal(again.id, a.id);
    const owned = await workspace.collaboration.enqueue(master.id, worker.id, 'close-owned', 'unit:slow');
    await until(() => owned.status === 'running');
    const queuedClose = await workspace.collaboration.enqueue(
      master.id,
      worker.id,
      'close-queued',
      'unit:good',
    );
    const unaffected = await workspace.collaboration.enqueue(
      master.id,
      second.id,
      'close-unaffected',
      'unit:slow',
    );
    await workspace.closePane(worker.id);
    assert.equal(owned.status, 'cancelled');
    assert.equal(queuedClose.status, 'cancelled');
    assert.notEqual(unaffected.status, 'cancelled');
    await until(() => unaffected.status === 'succeeded');
    assert.ok(!workspace.panes.has(worker.id));
  } finally {
    await workspace.close();
    await ctx.fiber.dispose();
    if (key === undefined) delete process.env.COLLAB_TEST_KEY;
    else process.env.COLLAB_TEST_KEY = key;
  }
});
