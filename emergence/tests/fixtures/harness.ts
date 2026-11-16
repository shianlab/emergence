import { Context } from '@deepseek-ai/cordis';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import Filesystem from '@deepseek-ai/dsh-fs-local';
import Llm, { type LlmAdapter } from '@deepseek-ai/dsh-llm';
import Sessions from '@deepseek-ai/dsh-session';
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import Projections from '@deepseek-ai/dsh-session-projection';
import Prompt from '@deepseek-ai/dsh-system-prompt';
import * as Executor from '@deepseek-ai/dsh-tool-executor-native';
import Tools from '@deepseek-ai/dsh-tools';
import WorkingDirectory from '@deepseek-ai/dsh-working-directory';
import { join } from 'node:path';

export async function harness(home: string, models: string[], adapter: LlmAdapter) {
  const ctx = new Context();
  await ctx.plugin(Llm);
  await ctx.plugin(Sessions);
  await ctx.plugin(Projections);
  await ctx.plugin(Prompt, { includeHarnessIdentity: false });
  await ctx.plugin(Tools);
  await ctx.plugin(Executor);
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(Filesystem);
  await ctx.plugin(WorkingDirectory);
  await ctx.plugin(Persistence, { root: join(home, 'sessions'), compression: 'none' });
  await ctx.plugin(AgentLoop, { agents: [] });
  ctx.effect(() => ctx.llm.registerAdapter(models, adapter));
  return ctx;
}
