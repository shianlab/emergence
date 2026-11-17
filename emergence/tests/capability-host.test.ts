import { LlmAdapter, ToolCallId, createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { PermissionMode } from '../src/core/domain/permissions.ts';
import { CodeUnderstanding } from '../src/domains/code/harness.ts';
import { CodeWorkHarness } from '../src/domains/code/work-harness.ts';
import { DataFoundation } from '../src/domains/data/harness.ts';
import type { DataHost } from '../src/domains/data/host.ts';
import { harness } from './fixtures/harness.ts';

class CapabilityProvider extends LlmAdapter {
  queue: Array<{ name: string; args: object }> = [];
  sequence = 0;
  async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, defaultMaxTokens: 1024 };
  }
  async *stream(): AsyncIterable<StreamChunk> {
    const next = this.queue.shift();
    if (!next) {
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    const id = ToolCallId('capability-' + ++this.sequence),
      raw = JSON.stringify(next.args);
    yield { type: 'block-start', index: 0, blockType: 'tool-call' };
    yield { type: 'tool-call-delta', index: 0, id, name: next.name, argumentsDelta: raw };
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: next.name, arguments: raw } };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  }
}

test('native Code/Data run on minimal ports without an app controller and observe live permissions', async () => {
  const home = await mkdtemp(join(tmpdir(), 'emergence-capability-host-'));
  const root = join(home, 'project');
  await mkdir(root);
  await writeFile(join(root, 'sample.csv'), 'value\n2\n3\n');
  await writeFile(join(root, 'sample.ts'), 'export const value = 5;\n');
  const provider = new CapabilityProvider();
  const ctx = await harness(home, ['fixture'], provider);
  const results = new Map<string, unknown>();
  const failures: string[] = [];
  ctx.on('tools/result', (exec, result) => {
    results.set(exec.name, result.value);
    if (result.isError) failures.push(exec.name);
  });
  const handle = await ctx.agents.create({
    sessionId: SessionId(randomUUID()),
    meta: { cwd: root },
    agentOptions: { provider: 'fixture', model: 'fixture' },
  });
  let mode: PermissionMode = 'edit',
    confirmations = 0;
  const host: DataHost = {
    ctx,
    home,
    owns: (agent) => agent === handle.agent,
    permissionSnapshot: () => ({ mode, root, rules: [], deny: [], confirm: [] }),
    permissionConstraints: () => [],
    get permissionMode() {
      return mode;
    },
    confirmDecision: async () => {
      confirmations++;
      return false;
    },
  };
  const code = new CodeUnderstanding(host),
    work = new CodeWorkHarness(host),
    data = new DataFoundation(host);
  const disposers = [...code.mount(), ...work.mount(), ...data.mount()];
  code.register(handle.agent);
  work.register(handle.agent);
  data.register(handle.agent);
  const run = async () => {
    handle.agent.followup(
      createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'exercise native capabilities' }],
      }),
    );
    await handle.agent.whenIdle();
    assert.equal(provider.queue.length, 0);
  };
  try {
    provider.queue.push(
      { name: 'emergence_code_project', args: {} },
      { name: 'emergence_code_work', args: { action: 'begin', objective: 'inspect project' } },
      {
        name: 'emergence_data_query',
        args: { file_path: 'sample.csv', sql: 'SELECT sum(CAST(value AS INTEGER)) AS total FROM data' },
      },
    );
    await run();
    assert.deepEqual(failures, []);
    assert.equal(
      (results.get('emergence_code_project') as { profile: { languages: Record<string, number> } }).profile
        .languages['.ts'],
      1,
    );
    assert.deepEqual((results.get('emergence_data_query') as { query: { rows: string[][] } }).query.rows, [
      ['5'],
    ]);
    assert.equal(await readFile(join(root, 'sample.csv'), 'utf8'), 'value\n2\n3\n');
    const evidence = await work.evidence(handle.agent);
    assert.ok(evidence.result?.runId);
    assert.deepEqual(evidence.repairedChecks, []);
    mode = 'plan';
    provider.queue.push({
      name: 'emergence_data_definition',
      args: { action: 'save', name: 'metric', definition_json: '{}' },
    });
    await run();
    assert.match(JSON.stringify(handle.agent.session.snapshotEvents()), /计划模式不能保存确认口径/);
    assert.equal(confirmations, 0);
  } finally {
    for (const dispose of disposers.reverse()) dispose();
    await handle.dispose();
    await ctx.fiber.dispose();
    await rm(home, { recursive: true, force: true });
  }
});
