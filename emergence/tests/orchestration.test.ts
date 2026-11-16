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

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'emergence-e4-')),
    cwd = join(home, 'project');
  await mkdir(cwd);
  const ctx = await harness(home, ['master', 'worker'], new Provider());
  process.env.E4_FIXTURE_KEY = 'local-fixture';
  const config = structuredClone(defaultConfig);
  config.defaultModel = 'master';
  config.models = ['master', 'worker'].map((id) => ({
    ...defaultConfig.models[0],
    id,
    model: id,
    apiKeyEnv: 'E4_FIXTURE_KEY',
  }));
  config.permissions = { defaultMode: 'auto', rules: [{ tool: 'work', effect: 'allow' }] };
  config.orchestration.maxConcurrent = 1;
  let executions = 0;
  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'work',
        description: 'controlled work',
        parameters: { scenario: { type: 'string', required: true } },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        async execute(args, exec) {
          executions++;
          await delay(args.scenario === 'slow' ? 1600 : 20, undefined, { signal: exec.signal });
          if (args.scenario === 'tool-error') throw new Error('ACTUAL_TOOL_FAILURE');
          return 'verified';
        },
      }),
    ),
  );
  const w = new WorkspaceController(ctx, { home, cwd, modelId: 'master', appConfig: config });
  await w.initialize();
  const master = w.current,
    worker = await w.split('row', cwd, 'worker'),
    second = await w.split('column', cwd, 'worker');
  w.collaboration.configure(master.id, [worker.id, second.id]);
  const contract = {
    role: 'developer',
    scope: ['project'],
    acceptance: ['controlled work returns verified'],
    maxSteps: 8,
    maxDurationMs: 10000,
  };
  // An explicit custom execution role can retain Auto, but cannot widen the issuer or worker policy.
  config.orchestration.roles.push({
    id: 'developer',
    description: 'fixture',
    prompt: 'Return actual evidence',
    mode: 'auto',
    rules: [{ tool: 'work', effect: 'allow' }],
    deny: [],
    skills: [],
  });
  return {
    w,
    ctx,
    master,
    worker,
    second,
    contract,
    count: () => executions,
    close: async () => {
      await w.close();
      await ctx.fiber.dispose();
    },
  };
}
test('E4 completion waits for evidence review; dependent tasks remain queued until acceptance', async () => {
  const f = await fixture();
  try {
    const c = f.w.collaboration,
      a = await c.enqueue(f.master.id, f.worker.id, 'a', 'unit:good', [], f.contract);
    const b = await c.enqueue(f.master.id, f.second.id, 'b', 'unit:good', [a.id], f.contract);
    await until(() => a.status === 'needs_review');
    assert.equal(b.status, 'queued');
    assert.equal(f.count(), 1);
    await assert.rejects(c.review(a.id, true, ''), /./);
    await c.review(a.id, true, 'Verified controlled work result and turn evidence');
    await until(() => b.status === 'needs_review');
    assert.equal(a.status, 'succeeded');
    assert.equal(f.count(), 2);
    assert.ok(a.steps > 0);
    await assert.rejects(c.review(a.id, true, 'again'), /验收/);
    await f.w.save();
    const saved = JSON.parse(await readFile(f.w.path, 'utf8'));
    assert.equal(saved.collaboration.tasks[0].review.accepted, true);
  } finally {
    await f.close();
  }
});
test('E4 real failures cannot be approved, repairs are linked and bounded, takeover prevents repair', async () => {
  const f = await fixture();
  try {
    const c = f.w.collaboration,
      a = await c.enqueue(f.master.id, f.worker.id, 'a', 'unit:tool-error', [], f.contract);
    await until(() => a.status === 'needs_review');
    await assert.rejects(c.review(a.id, true, 'claimed pass'), /真实失败/);
    await c.review(a.id, false, 'tool failed');
    const repair = await c.repair(a.id, 'fix the failing operation');
    assert.equal(repair.repairOf, a.id);
    assert.equal(repair.repairCount, 1);
    await assert.rejects(c.repair(a.id, 'duplicate'), /已创建/);
    await until(() => repair.status === 'needs_review');
    await assert.rejects(c.repair(repair.id, 'again'), /预算/);
    const b = await c.enqueue(f.master.id, f.second.id, 'b', 'unit:slow', [], f.contract);
    await until(() => b.status === 'running');
    await c.takeover(f.second.id);
    await assert.rejects(c.repair(b.id, 'try again'), /不可修复/);
  } finally {
    await f.close();
  }
});
test('E4 role permissions block execution even when worker and master permit it', async () => {
  const f = await fixture();
  try {
    const c = f.w.collaboration,
      a = await c.enqueue(f.master.id, f.worker.id, 'a', 'unit:good', [], {
        ...f.contract,
        role: 'researcher',
      });
    await until(() => a.status === 'needs_review');
    assert.equal(f.count(), 0);
    assert.ok(a.result!.errors.length);
    await assert.rejects(c.review(a.id, true, 'model said pass'), /真实失败/);
    await assert.rejects(
      c.enqueue(f.master.id, f.worker.id, 'unknown', 'unit:good', [], { ...f.contract, role: 'missing' }),
      /角色不存在/,
    );
  } finally {
    await f.close();
  }
});
test('E4 step/time/concurrency budgets stop work and preserve queued assignments', async () => {
  const f = await fixture();
  try {
    const c = f.w.collaboration,
      a = await c.enqueue(f.master.id, f.worker.id, 'a', 'unit:slow', [], {
        ...f.contract,
        maxDurationMs: 1000,
      });
    const b = await c.enqueue(f.master.id, f.second.id, 'b', 'unit:good', [], { ...f.contract, maxSteps: 1 });
    await until(() => a.status === 'running');
    assert.equal(b.status, 'queued');
    await until(() => a.status === 'cancelled');
    assert.match(a.cancelReason!, /预算/);
    await until(() => ['failed', 'needs_review'].includes(b.status));
    assert.equal(b.steps, 1);
    assert.notEqual(b.status, 'succeeded');
  } finally {
    await f.close();
  }
});

test('E4 repaired dependency releases downstream work without rewriting failed attempt history', async () => {
  const f = await fixture();
  try {
    const c = f.w.collaboration,
      a = await c.enqueue(f.master.id, f.worker.id, 'a', 'unit:good', [], f.contract);
    const b = await c.enqueue(f.master.id, f.second.id, 'b', 'unit:good', [a.id], f.contract);
    await until(() => a.status === 'needs_review');
    await c.review(a.id, false, 'need stronger evidence');
    assert.equal(b.status, 'queued');
    const repair = await c.repair(a.id, 'provide stronger evidence');
    await until(() => repair.status === 'needs_review');
    await c.review(repair.id, true, 'verified actual tool result');
    await until(() => b.status === 'needs_review');
    assert.equal(a.status, 'needs_review');
    assert.equal(repair.status, 'succeeded');
  } finally {
    await f.close();
  }
});

test('audit: repairs retain original role limits and handoff constraints after configuration changes', async () => {
  const f = await fixture();
  try {
    const c = f.w.collaboration;
    const task = await c.enqueue(f.master.id, f.worker.id, 'audit-role', 'unit:good', [], {
      ...f.contract,
      role: 'researcher',
      context: 'ORIGINAL_REQUIRED_CONSTRAINT',
    });
    await until(() => task.status === 'needs_review');
    assert.equal(f.count(), 0);
    f.w.launch.appConfig.orchestration.roles.push({
      id: 'researcher',
      description: 'changed',
      prompt: 'changed',
      mode: 'auto',
      rules: [{ tool: 'work', effect: 'allow' }],
      deny: [],
      skills: [],
    });
    const repair = await c.repair(task.id, 'retry with evidence');
    assert.equal(repair.rolePermission?.mode, 'plan');
    assert.match(repair.contract!.context, /ORIGINAL_REQUIRED_CONSTRAINT/);
    await until(() => repair.status === 'needs_review');
    assert.equal(f.count(), 0);
  } finally {
    await f.close();
  }
});
test('audit: repairs cannot silently move to a replacement worker session', async () => {
  const f = await fixture();
  try {
    const c = f.w.collaboration,
      task = await c.enqueue(f.master.id, f.worker.id, 'audit-session', 'unit:good', [], f.contract);
    await until(() => task.status === 'needs_review');
    await f.w.send(f.worker.id, '/new');
    await assert.rejects(c.repair(task.id, 'retry'), /会话|目录|模型/);
  } finally {
    await f.close();
  }
});
