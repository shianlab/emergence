import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';

const eventSchema = z.object({
  type: z.string(),
  seq: z.number().int(),
  time: z.number(),
  data: z.unknown(),
});
export type NativeEvent = z.infer<typeof eventSchema>;
export interface NativeJournal {
  session: string;
  events: NativeEvent[];
}
const callSchema = z.object({ callId: z.string(), name: z.string(), arguments: z.string() });
const resultSchema = z.object({
  message: z.object({ toolCallId: z.string(), isError: z.boolean().optional() }),
  meta: z.object({ cwd: z.string().optional() }).passthrough().optional(),
});

/** Persistence appends complete lines; an unfinished final line is not an event. */
export function completeNativeEvents(journal: string): NativeEvent[] {
  let previous = -1;
  return journal
    .split('\n')
    .slice(0, -1)
    .filter(Boolean)
    .flatMap((line, index) => {
      const parsed = JSON.parse(line);
      if (index === 0 && parsed.type === 'session') {
        z.object({ type: z.literal('session'), version: z.literal(4), id: z.string() }).parse(parsed);
        return [];
      }
      const event = eventSchema.parse(parsed);
      if (event.seq <= previous) throw new Error('Native journal sequence is not increasing');
      previous = event.seq;
      return [event];
    });
}

export function indexNativeEvidence(journals: NativeJournal[]) {
  const index = new Map<
    string,
    {
      calls: Map<string, { seq: number; time: number; name: string; arguments: string }>;
      results: Map<string, { seq: number; time: number; isError: boolean; cwd?: string }>;
    }
  >();
  for (const journal of journals) {
    if (index.has(journal.session)) throw new Error('Duplicate native session');
    const calls: Map<string, { seq: number; time: number; name: string; arguments: string }> = new Map();
    const results: Map<string, { seq: number; time: number; isError: boolean; cwd?: string }> = new Map();
    let previous = -1;
    for (const event of journal.events) {
      if (event.seq <= previous) throw new Error('Native journal sequence is not increasing');
      previous = event.seq;
      if (event.type === 'tool/call') {
        const call = callSchema.parse(event.data);
        if (calls.has(call.callId)) throw new Error('Duplicate native call identity');
        calls.set(call.callId, { ...call, seq: event.seq, time: event.time });
      }
      if (event.type === 'tool/result') {
        const result = resultSchema.parse(event.data),
          id = result.message.toolCallId;
        if (results.has(id)) throw new Error('Duplicate native result identity');
        results.set(id, {
          seq: event.seq,
          time: event.time,
          isError: result.message.isError === true,
          cwd: result.meta?.cwd,
        });
      }
    }
    index.set(journal.session, { calls, results });
  }
  return index;
}

export async function readNativeJournals(home: string): Promise<NativeJournal[]> {
  const root = join(home, 'sessions');
  let files: string[];
  try {
    files = await readdir(root, { recursive: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  return Promise.all(
    files
      .filter((f) => basename(f) === 'session.v4.jsonl')
      .map(async (f) => ({
        session: basename(dirname(f)),
        events: completeNativeEvents(await readFile(join(root, f), 'utf8')),
      })),
  );
}
