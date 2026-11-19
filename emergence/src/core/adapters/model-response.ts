import type { Context } from '@deepseek-ai/cordis';
import { isAgentLoopRequest, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';

export const outputLimitRecoveryCode = 'EMERGENCE_OUTPUT_LIMIT';

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

/** Let the Harness retry at most one clipped response per turn, before it dispatches tools. */
export function mountModelResponseHandling(ctx: Context) {
  const recoveries = new WeakMap<AbortSignal, { session: string; retrying: boolean }>();
  async function* recoverClippedResponse(
    stream: AsyncIterable<StreamChunk>,
    signal: AbortSignal,
    session: string,
  ): AsyncIterable<StreamChunk> {
    let toolStarted = false;
    let visibleText = false;
    for await (const chunk of stream) {
      if (
        chunk.type === 'tool-call-delta' ||
        (chunk.type === 'block-end' && chunk.block.type === 'tool-call')
      )
        toolStarted = true;
      if (
        (chunk.type === 'text-delta' && chunk.text.trim()) ||
        (chunk.type === 'block-end' && chunk.block.type === 'text' && chunk.block.text.trim())
      )
        visibleText = true;
      if (
        chunk.type === 'finish' &&
        chunk.reason.kind === 'max-tokens' &&
        (toolStarted || !visibleText) &&
        !signal.aborted &&
        !recoveries.has(signal)
      ) {
        recoveries.set(signal, { session, retrying: false });
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: { code: outputLimitRecoveryCode, message: '模型单次输出到达上限，当前调用未提交' },
          },
        };
        return;
      }
      yield chunk;
    }
  }
  const disposers = [
    ctx.on('llm/stream', (options, next) => {
      if (!isAgentLoopRequest(options)) return next();
      const stream = validateModelResponse(options, next());
      return options.signal && options.sessionId
        ? recoverClippedResponse(stream, options.signal, options.sessionId)
        : stream;
    }),
    ctx.on('agent/request-error', async ({ agent, failure, signal }, next) => {
      if (failure.code !== outputLimitRecoveryCode) return next();
      const recovery = recoveries.get(signal);
      if (signal.aborted || recovery?.session !== agent.session.id || recovery.retrying) return;
      recovery.retrying = true;
      return { kind: 'retry' };
    }),
    ctx.systemPrompt.context({
      name: 'emergence-output-limit-recovery',
      order: 960,
      required: true,
      interpolate: false,
      text: ({ agent, signal }) => {
        const recovery = signal && recoveries.get(signal);
        return recovery?.retrying && recovery.session === agent?.session.id
          ? '输出上限恢复：上一条模型输出被截断，本步工具没有执行。保留已完成的工具回执，从尚未完成的部分继续。减少推理和文字说明。需要使用工具时，下一步只发一个短工具调用；文件按段落写入并核对已有内容，再单独转换成目标格式。不要重复已完成的操作。'
          : '';
      },
    }),
  ];
  return () => disposers.forEach((dispose) => dispose());
}
