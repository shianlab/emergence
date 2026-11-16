import { Context } from '@deepseek-ai/cordis';
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import LlmRuntime, { createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native';
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { artifactDir, report } from '../src/report.ts';

/** A deterministic provider; the actual Harness loop, inbox and event log are unmodified. */
class ControlledProvider extends LlmAdapter {
  requests: Array<{ provider: string; model: string; signal?: AbortSignal }> = [];
  private toolRequested = new Set<string>();

  async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, defaultMaxTokens: 1024 };
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push({ provider: options.provider, model: options.model, signal: options.signal });
    if (options.model.startsWith('tool-') && !this.toolRequested.has(options.model)) {
      this.toolRequested.add(options.model);
      const id = ToolCallId(`call-${options.model}`);
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id, name: 'phase1_read_marker', argumentsDelta: '{}' };
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id, name: 'phase1_read_marker', arguments: '{}' },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    const text = `${options.provider}/${options.model}: 涌现任务完成 ✓`;
    yield { type: 'block-start', index: 0, blockType: 'text' };
    for (const char of text) {
      await delay(3, undefined, { signal: options.signal });
      yield { type: 'text-delta', index: 0, text: char };
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

async function until(predicate: () => boolean): Promise<void> {
  for (let n = 0; n < 500; n++) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error('Timed out waiting for Harness event');
}

function send(agent: Agent, text: string) {
  return agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
}

export async function probeHarness() {
  const started = performance.now();
  const ctx = new Context();
  const provider = new ControlledProvider();
  const handles: AgentHandle[] = [];
  const events: Array<{ session: string; type: string; status?: string; revision?: number }> = [];
  let remainingAfterCleanup = -1;
  const checks: Record<string, boolean> = {};
  const toolStarts: string[] = [];
  const toolResults: Record<string, string> = {};
  const toolAborted: string[] = [];
  try {
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(SessionStore);
    await ctx.plugin(SessionProjectionRegistry);
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(ToolRuntime);
    await ctx.plugin(NativeToolExecutor);
    await ctx.plugin(AgentRegistry);
    await ctx.plugin(AgentLoop, { agents: [] });
    ctx.effect(() => ctx.llm.registerAdapter(['probe-a', 'probe-b'], provider));
    ctx.effect(() =>
      ctx.tools.register(
        defineTool({
          name: 'phase1_read_marker',
          description: 'Read a marker in this probe session directory.',
          parameters: {},
          output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
          async execute(_args, exec) {
            if (!exec.agent?.session.header.cwd) throw new Error('Missing owning session directory');
            const id = exec.agent.session.id;
            toolStarts.push(id);
            try {
              const content = await readFile(resolve(exec.agent.session.header.cwd, 'marker.txt'), {
                encoding: 'utf8',
                signal: exec.signal,
              });
              await delay(150, undefined, { signal: exec.signal });
              toolResults[id] = content;
              return content;
            } catch (error) {
              if (exec.signal.aborted) toolAborted.push(id);
              throw error;
            }
          },
        }),
      ),
    );
    ctx.on('agent/status', ({ agent, status }) => {
      events.push({ session: agent.session.id, type: 'status', status });
    });
    ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      events.push({ session: agent.session.id, type: frame.type, revision: frame.revision });
    });

    const cwdA = resolve(artifactDir, '项目 A');
    const cwdB = resolve(artifactDir, '项目 B');
    await Promise.all([mkdir(cwdA, { recursive: true }), mkdir(cwdB, { recursive: true })]);
    await Promise.all([
      writeFile(resolve(cwdA, 'marker.txt'), 'project-a'),
      writeFile(resolve(cwdB, 'marker.txt'), 'project-b'),
    ]);
    for (const [id, cwd, route, model] of [
      ['session-a', cwdA, 'probe-a', 'model-a'],
      ['session-b', cwdB, 'probe-b', 'model-b'],
    ]) {
      handles.push(
        await ctx.agents.create({
          sessionId: SessionId(id),
          meta: { cwd },
          agentOptions: { provider: route, model },
        }),
      );
    }
    const [a, b] = handles.map((h) => h.agent);
    send(a, '执行 A');
    send(b, '执行 B');
    await until(
      () =>
        provider.requests.length >= 2 && events.some((e) => e.session === a.session.id && e.type === 'chunk'),
    );
    a.cancel({ kind: 'user' });
    await Promise.all([a.whenIdle(), b.whenIdle()]);
    checks.cancelOneDoesNotAbortOther =
      provider.requests.find((r) => r.provider === 'probe-a')?.signal?.aborted === true &&
      provider.requests.find((r) => r.provider === 'probe-b')?.signal?.aborted !== true;
    checks.otherSessionCommits = b.session.snapshotEvents().some((e) => e.type === 'assistant/message');
    checks.independentDirectories = a.session.header.cwd === cwdA && b.session.header.cwd === cwdB;
    checks.independentModelRoutes =
      provider.requests[0].provider !== provider.requests[1].provider &&
      new Set(provider.requests.slice(0, 2).map((r) => r.model)).size === 2;
    checks.streamEventsAreRouted = ['session-a', 'session-b'].every((id) =>
      events.some((e) => e.session === id && e.type === 'chunk'),
    );

    a.model.select({ provider: 'probe-b', model: 'model-switched' });
    send(a, '取消后继续并切换模型');
    await a.whenIdle();
    checks.modelSwitchNextTurn = provider.requests.at(-1)?.model === 'model-switched';
    checks.cancelledSessionReusable = a.session.snapshotEvents().some((e) => e.type === 'assistant/message');
    const before = provider.requests.length;
    send(b, '任务一');
    await until(() => provider.requests.length > before);
    send(b, '任务二排队');
    await b.whenIdle();
    checks.followupQueueDrains = provider.requests.length >= before + 2;
    a.model.select({ provider: 'probe-a', model: 'tool-a' });
    b.model.select({ provider: 'probe-b', model: 'tool-b' });
    send(a, 'read marker A');
    send(b, 'read marker B');
    await until(() => toolStarts.length === 2);
    a.cancel({ kind: 'user' });
    await Promise.all([a.whenIdle(), b.whenIdle()]);
    checks.toolCancellationIsolated = toolAborted.includes('session-a') && !toolAborted.includes('session-b');
    checks.scopedToolReadsOwnDirectory =
      toolResults['session-b'] === 'project-b' && !('session-a' in toolResults);
    checks.realToolResultRecorded = b.session.snapshotEvents().some((e) => e.type === 'tool/result');
    await handles[0].dispose();
    checks.disposeOneKeepsOther =
      ctx.agents.get(a.session.id) === undefined && ctx.agents.get(b.session.id) === b;
    await handles[1].dispose();
    remainingAfterCleanup = ctx.agents.list().length;
    checks.noAgentsAfterDispose = remainingAfterCleanup === 0;
    for (const [name, passed] of Object.entries(checks)) assert.equal(passed, true, name);
    const result = {
      kind: 'real-harness-controlled-provider',
      harnessVersion: '0.2.2-alpha.2',
      runtime: process.version,
      externalModelTested: false,
      credentialsAvailable: Boolean(process.env.DEEPSEEK_API_KEY),
      checks,
      requests: provider.requests.map(({ provider: route, model }) => ({ provider: route, model })),
      events,
      toolStarts,
      toolResults,
      toolAborted,
      remainingAfterCleanup,
      durationMs: Math.round(performance.now() - started),
    };
    await report('harness.json', result);
    return result;
  } finally {
    await Promise.all(handles.map((h) => h.dispose()));
    await ctx.fiber.dispose();
  }
}

if (process.argv[1]?.endsWith('harness.ts')) {
  const result = await probeHarness();
  console.log(JSON.stringify({ checks: result.checks, durationMs: result.durationMs }, null, 2));
}
