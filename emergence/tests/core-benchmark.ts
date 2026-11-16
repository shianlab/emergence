import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { executionFixture } from './fixtures/core-execution.ts';

const dir = resolve('../artifacts/core-phase6');
await mkdir(dir, { recursive: true });
const samples: Array<{
  mode: string;
  ms: number;
  calls: number;
  inputCharacters: number;
  heapDelta: number;
}> = [];
for (let round = 0; round < 8; round++)
  for (const mode of round % 2 ? (['observe', 'off'] as const) : (['off', 'observe'] as const)) {
    const f = await executionFixture();
    try {
      await f.w.current.controller!.core.setMode(mode);
      let calls = 0,
        inputCharacters = 0;
      const original = f.provider.stream.bind(f.provider);
      f.provider.stream = async function* (options) {
        calls++;
        inputCharacters = JSON.stringify(options.messages).length;
        yield* original(options);
      };
      global.gc?.();
      const heap = process.memoryUsage().heapUsed,
        start = performance.now();
      await f.w.send(f.w.focused, '你好');
      await f.w.current.controller!.agent.whenIdle();
      const ms = performance.now() - start;
      global.gc?.();
      samples.push({ mode, ms, calls, inputCharacters, heapDelta: process.memoryUsage().heapUsed - heap });
      assert.equal(calls, 1);
    } finally {
      await f.close();
    }
  }
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return (sorted[3] + sorted[4]) / 2;
};
const groups = Object.fromEntries(
  ['off', 'observe'].map((mode) => {
    const rows = samples.filter((s) => s.mode === mode),
      sorted = rows.map((s) => s.ms).sort((a, b) => a - b);
    return [
      mode,
      {
        samples: rows.length,
        medianMs: median(sorted),
        p95Ms: sorted.at(-1),
        minMs: sorted[0],
        modelCalls: rows.map((r) => r.calls),
        inputCharacters: rows.map((r) => r.inputCharacters),
        medianHeapDelta: median(rows.map((r) => r.heapDelta)),
      },
    ];
  }),
);
// The runtime now reports the real core state and intake on every request.
// That bounded context intentionally differs between off/observe; model call count must stay one.
assert.ok(
  Math.max(...groups.observe.inputCharacters) - Math.min(...groups.off.inputCharacters) < 2500,
  'ordinary chat governance context must remain bounded',
);
await writeFile(
  join(dir, 'benchmark.json'),
  JSON.stringify(
    {
      passed: true,
      timestamp: new Date().toISOString(),
      groups,
      samples,
      scope:
        'Current build core off/observe ablation, 8 fresh local Harness sessions each, alternating order, deterministic zero-network provider. Characters are measured, token/cost unknown. Not a historical pre-integration build or real-model quality benchmark.',
    },
    null,
    2,
  ),
);
console.log(JSON.stringify(groups));
