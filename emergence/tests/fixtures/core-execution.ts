import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { HistoricalOrchestrationWorkspace as WorkspaceController } from './historical-orchestration.ts';
import { defaultConfig } from '../../src/core/domain/configuration.ts';
import { harness } from './harness.ts';

export class ExecutionProvider extends LlmAdapter {
  calls = 0;
  async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, defaultMaxTokens: 1024 };
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls++;
    const messages = options.messages.map((m) => ({ role: m.role, text: JSON.stringify(m.content) }));
    const index = messages.findLastIndex((m) => m.role === 'user' && m.text.includes('[Emergence task '));
    const count = messages.slice(index + 1).filter((m) => m.role === 'tool').length;
    if (index < 0 || count >= 2) {
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    const name = count === 0 ? 'write' : 'emergence_report',
      args =
        count === 0
          ? { file_path: 'result.txt', content: 'persisted actual effect' }
          : { outcome: 'success', summary: '实际写入完成', artifacts: ['result.txt'] };
    const id = ToolCallId('exec-' + this.calls),
      raw = JSON.stringify(args);
    yield { type: 'block-start', index: 0, blockType: 'tool-call' };
    yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: raw };
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: raw } };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  }
}
export async function until(predicate: () => boolean) {
  for (let n = 0; n < 600; n++) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error('execution test timeout');
}
export async function executionFixture(home?: string, crash = false, provider = new ExecutionProvider()) {
  home ??= await mkdtemp(join(tmpdir(), 'emergence-execution-'));
  const cwd = join(home, 'project');
  await mkdir(cwd, { recursive: true });
  const config = structuredClone(defaultConfig);
  config.models[0].apiKeyEnv = 'CORE_EXECUTION_FIXTURE';
  const previous = process.env.CORE_EXECUTION_FIXTURE;
  process.env.CORE_EXECUTION_FIXTURE = 'local-fixture';
  const ctx = await harness(home, ['deepseek'], provider);
  let writes = 0;
  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'write',
        description: 'actual local fixture write',
        parameters: {
          file_path: { type: 'string', required: true },
          content: { type: 'string', required: true },
        },
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
        async execute(args, exec) {
          writes++;
          await writeFile(join(ctx.workingDirectory.get(exec.agent!.session), args.file_path), args.content);
          if (crash) {
            process.send?.({ kind: 'effect-written' });
            await new Promise(() => {});
          }
          await delay(25);
          return 'written';
        },
      }),
    ),
  );
  const launch = { home, cwd, modelId: 'deepseek', appConfig: config },
    w = new WorkspaceController(ctx, launch);
  await w.initialize();
  return {
    home,
    cwd,
    config,
    provider,
    ctx,
    w,
    launch,
    writes: () => writes,
    async close() {
      await w.close();
      await ctx.fiber.dispose();
      if (previous === undefined) delete process.env.CORE_EXECUTION_FIXTURE;
      else process.env.CORE_EXECUTION_FIXTURE = previous;
    },
  };
}
