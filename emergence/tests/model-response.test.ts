import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { validateModelResponse } from '../src/core/adapters/model-response.ts';

const options: GenerateOptions = {
  provider: 'fixture',
  model: 'fixture',
  messages: [],
  tools: [
    {
      name: 'operation',
      description: 'fixture',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    },
  ],
};
const block = (args: string, name = 'operation'): StreamChunk => ({
  type: 'block-end',
  index: 0,
  block: { type: 'tool-call', id: ToolCallId('fixture-call'), name, arguments: args },
});
async function collect(chunks: StreamChunk[]) {
  const result: StreamChunk[] = [];
  for await (const chunk of validateModelResponse(
    options,
    (async function* () {
      yield* chunks;
    })(),
  ))
    result.push(chunk);
  return result;
}
test('advertised schema rejects missing and invalid parameters before response commit', async () => {
  for (const args of ['{}', '{"command":3}', '{"command":']) {
    const finish = (await collect([block(args), { type: 'finish', reason: { kind: 'tool-calls' } }])).at(-1)!;
    assert.equal(finish.type, 'finish');
    assert.ok(finish.type === 'finish' && finish.reason.kind === 'error');
    assert.equal(finish.reason.failure.code, 'MALFORMED_RESPONSE');
  }
});
test('valid response, usage and provider replay metadata pass through unchanged', async () => {
  const chunks: StreamChunk[] = [
    block('{"command":"fixture-check"}'),
    { type: 'usage', usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 } },
    {
      type: 'finish',
      reason: { kind: 'tool-calls' },
      replayState: { response: { fixture: 'unchanged' }, blocks: [{ opaque: 'fixture' }] },
    },
  ];
  const output = await collect(chunks);
  assert.deepEqual(output, chunks);
  output.forEach((chunk, index) => assert.equal(chunk, chunks[index]));
});
test('output truncation and cancellation retain the original stop reason', async () => {
  for (const kind of ['max-tokens', 'aborted'] as const) {
    const chunks: StreamChunk[] = [
      block('{}'),
      {
        type: 'finish',
        reason:
          kind === 'aborted'
            ? { kind, failure: { code: 'ABORTED', message: 'fixture cancelled' } }
            : { kind },
      },
    ];
    assert.deepEqual(await collect(chunks), chunks);
  }
});
test('unadvertised tools remain owned by the native visibility and permission gates', async () => {
  const chunks: StreamChunk[] = [
    block('{}', 'unadvertised'),
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ];
  assert.deepEqual(await collect(chunks), chunks);
});
