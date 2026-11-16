import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionUsage } from '../../src/app/tui/session-usage.ts';
import { diagnosticSnapshots } from './observation.ts';

// Receipt budgets are checked between requests; an in-flight response can overshoot.
// Missing provider usage is recorded, never silently converted to zero.
export const liveLimits = { requests: 80, tokens: 1500000, toolCalls: 120, outputTokens: 8192 };
export async function liveMetrics(home: string) {
  const result = { requests: 0, tokens: 0, reported: 0, missing: 0, toolCalls: 0, toolErrors: 0 };
  result.requests = (await diagnosticSnapshots(home))
    .flatMap((s) => s.runs)
    .reduce((sum, run) => sum + run.requests, 0);
  let files: string[];
  try {
    files = await readdir(join(home, 'sessions'), { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result;
    throw error;
  }
  for (const file of files.filter((f) => f.endsWith('session.v4.jsonl'))) {
    const usage = new SessionUsage();
    const lines = (await readFile(join(home, 'sessions', file), 'utf8')).split('\n');
    // Ignore only an incomplete tail written concurrently by the production process.
    for (const line of lines.slice(0, -1).filter(Boolean)) {
      const event = JSON.parse(line) as SessionEvent;
      usage.append(event);
      if (event.type === 'tool/call') result.toolCalls++;
      if (event.type === 'tool/result' && event.data.message.isError) result.toolErrors++;
    }
    result.tokens += usage.total;
    result.reported += usage.reported;
    result.missing += usage.missing;
  }
  return result;
}
export async function checkLiveBudget(home: string) {
  const result = await liveMetrics(home);
  for (const key of ['requests', 'tokens', 'toolCalls'] as const)
    if (result[key] >= liveLimits[key])
      throw new Error(`Live observation ${key} budget reached: ${result[key]}`);
  return result;
}
