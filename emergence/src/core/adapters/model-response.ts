import type { Context } from '@deepseek-ai/cordis';
import { isAgentLoopRequest, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';

/** Validate the exact advertised schema before the loop commits a response or asks for approval. */
export async function* validateModelResponse(
  options: GenerateOptions,
  stream: AsyncIterable<StreamChunk>,
): AsyncIterable<StreamChunk> {
  const schemas = new Map(options.tools?.map((tool) => [tool.name, tool.parameters]));
  let failure: string | undefined;
  for await (const chunk of stream) {
    if (!failure && chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
      const schema = schemas.get(chunk.block.name);
      if (schema) {
        assertSupportedJsonSchema(schema);
        let args: unknown;
        try {
          args = JSON.parse(chunk.block.arguments);
        } catch {
          failure = `${chunk.block.name}: 工具参数不是完整 JSON`;
        }
        if (!failure) {
          const issues = validateJsonSchemaValue(schema, args);
          if (issues.length) failure = `${chunk.block.name}: ${issues.slice(0, 4).join('; ')}`;
        }
      }
    }
    // Preserve usage, reasoning/replay chunks, cancellation and output truncation unchanged.
    // The existing request executor discards all uncommitted blocks on this typed failure.
    if (failure && chunk.type === 'finish' && ['stop', 'tool-calls'].includes(chunk.reason.kind)) {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { message: `MODEL_TOOL_ARGUMENTS: ${failure.slice(0, 1000)}`, code: 'MALFORMED_RESPONSE' },
        },
      };
      return;
    }
    yield chunk;
  }
}

export function mountModelResponseValidation(ctx: Context) {
  return ctx.on('llm/stream', (options, next) =>
    isAgentLoopRequest(options) ? validateModelResponse(options, next()) : next(),
  );
}
