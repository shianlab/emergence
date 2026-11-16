import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import type { TextareaRenderable } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { mountWorkspaceUI } from '../src/app/workspace-ui.ts';
import { WorkspaceController } from '../src/app/workspace.ts';
import { defaultConfig } from '../src/core/domain/configuration.ts';
import { harness } from './fixtures/harness.ts';

class Provider extends LlmAdapter {
  sustained = false;
  requests = 0;
  async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, defaultMaxTokens: 512 };
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests++;
    yield { type: 'block-start', index: 0, blockType: 'text' };
    let text = '';
    for (let i = 0; i < (this.sustained ? 24 : 1); i++) {
      const chunk = `流式输出${i} `;
      text += chunk;
      yield { type: 'text-delta', index: 0, text: chunk };
      if (this.sustained) await delay(30, undefined, { signal: options.signal });
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
const dir = resolve('../artifacts/phase6');
await mkdir(dir, { recursive: true });
const home = await mkdtemp(join(dir, 'stability-')),
  config = structuredClone(defaultConfig);
config.models[0].apiKeyEnv = 'PHASE6_STABILITY_KEY';
process.env.PHASE6_STABILITY_KEY = 'local-fixture';
const adapter = new Provider(),
  ctx = await harness(home, ['deepseek'], adapter),
  w = new WorkspaceController(ctx, { home, cwd: home, modelId: 'deepseek', appConfig: config });
const native = await createTestRenderer({ width: 160, height: 46, useMouse: true });
let ui: ReturnType<typeof mountWorkspaceUI> | undefined;
const duration = Number(process.env.EMERGENCE_SOAK_MS ?? 300000);
if (duration < 1000 || duration > 3600000) throw new Error('Invalid bounded soak duration');
const latencies: number[] = [],
  samples: Array<{ elapsedMs: number; rss: number; heap: number; panes: number }> = [],
  failures: string[] = [];
const jobs: Promise<void>[] = [];
let stop = false,
  cycles = 0,
  completedTurns = 0;
const closingPanes = new Set<string>();
const lag = monitorEventLoopDelay({ resolution: 20 });
lag.enable();
global.gc?.();
const before = process.memoryUsage(),
  cpu = process.cpuUsage();
let started = performance.now();
function work(id: string) {
  const job = (async () => {
    while (!stop && !closingPanes.has(id) && w.panes.has(id)) {
      try {
        const pane = w.panes.get(id)!;
        await w.send(id, 'sustained fixture');
        const agent = pane.controller!.agent;
        await agent.whenIdle();
        completedTurns++;
      } catch (error) {
        if (!stop && !closingPanes.has(id) && w.panes.has(id)) failures.push(String(error));
        break;
      }
    }
  })();
  jobs.push(job);
}
try {
  await w.initialize();
  const original = w.focused;
  for (let i = 0; i < 200; i++) {
    await w.send(original, `history seed ${i}`);
    await w.current.controller!.agent.whenIdle();
  }
  while (w.panes.size < 4) await w.split('row');
  ui = mountWorkspaceUI(native.renderer, w, () => {});
  await native.renderOnce();
  await native.renderOnce();
  adapter.sustained = true;
  started = performance.now();
  for (const id of w.panes.keys()) work(id);
  let nextSample = 0,
    nextCycle = 60000,
    nextNotice = 30000,
    inputCount = 0;
  while (performance.now() - started < duration) {
    const begin = performance.now();
    const editor: TextareaRenderable = ui!.views.get(w.focused)!.input;
    await native.mockInput.pasteBracketedText('中文🙂');
    await native.flush();
    await native.renderOnce();
    assert.equal(
      w.current.draft,
      '中文🙂',
      JSON.stringify({
        focused: w.focused,
        inputFocused: editor.focused,
        inputText: editor.plainText,
        frame: native.captureCharFrame(),
      }),
    );
    latencies.push(performance.now() - begin);
    editor.setText('');
    inputCount++;
    const elapsed = performance.now() - started;
    if (elapsed >= nextSample) {
      const memory = process.memoryUsage();
      samples.push({
        elapsedMs: Math.round(elapsed),
        rss: memory.rss,
        heap: memory.heapUsed,
        panes: w.panes.size,
      });
      nextSample += 5000;
    }
    if (inputCount % 20 === 0) w.cycle();
    if (inputCount % 60 === 0) {
      native.resize(inputCount % 120 === 0 ? 160 : 110, 46);
      await native.renderOnce();
    }
    if (elapsed >= nextCycle) {
      const close = [...w.panes.keys()].filter((id) => id !== original).slice(-2);
      close.forEach((id) => closingPanes.add(id));
      await Promise.all(close.map((id) => w.closePane(id)));
      while (w.panes.size < 4) {
        const pane = await w.split('row');
        work(pane.id);
      }
      cycles++;
      nextCycle += 60000;
    }
    if (elapsed >= nextNotice) {
      console.log(`Soak ${Math.round(elapsed / 1000)}s: ${completedTurns} turns, ${w.panes.size} panes`);
      nextNotice += 30000;
    }
    await delay(180);
  }
  assert.ok(
    w.panes
      .get(original)!
      .controller!.transcript()
      .some((t) => t.includes('history seed 0')),
  );
  stop = true;
  await Promise.all([...w.panes.values()].map((p) => p.controller!.cancel()));
  await Promise.all(jobs);
  const cpuUsed = process.cpuUsage(cpu);
  ui.dispose();
  ui = undefined;
  await native.dispose();
  await w.close();
  const registryEmpty = ctx.agents.list().length === 0;
  assert.ok(registryEmpty);
  await ctx.fiber.dispose();
  global.gc?.();
  await delay(150);
  global.gc?.();
  const after = process.memoryUsage();
  lag.disable();
  latencies.sort((a, b) => a - b);
  const p95 = latencies[Math.floor(latencies.length * 0.95)],
    peakRss = Math.max(...samples.map((s) => s.rss));
  const checks = {
    noErrors: failures.length === 0,
    inputP95Under150ms: p95 < 150,
    peakRssUnder1GiB: peakRss < 1024 ** 3,
    retainedHeapUnder80MiB: after.heapUsed < before.heapUsed + 80 * 1024 ** 2,
    registryEmpty,
  };
  const result = {
    timestamp: new Date().toISOString(),
    passed: Object.values(checks).every(Boolean),
    runtime: process.version,
    platform: process.platform,
    durationMs: Math.round(performance.now() - started),
    configuredDurationMs: duration,
    checks,
    completedTurns,
    requests: adapter.requests,
    initialHistoryTurns: 200,
    peakPanes: 4,
    createCloseCycles: cycles,
    inputSamples: latencies.length,
    inputP95Ms: p95,
    inputMaxMs: latencies.at(-1),
    peakRss,
    before,
    after,
    cpuOneCorePercent: ((cpuUsed.user + cpuUsed.system) / 1000 / (performance.now() - started)) * 100,
    eventLoopP99Ms: lag.percentile(99) / 1e6,
    samples,
    failures,
    scope:
      'Five-minute synthetic-stream soak with real Harness, JSONL persistence and native OpenTUI frames; does not simulate paid network latency or prove day-long stability.',
  };
  await writeFile(join(dir, 'stability.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, samples: undefined }, null, 2));
  assert.ok(result.passed);
} finally {
  stop = true;
  lag.disable();
  ui?.dispose();
  if (!native.renderer.isDestroyed) await native.dispose();
  await w.close();
  await Promise.allSettled(jobs);
  await ctx.fiber.dispose();
}
