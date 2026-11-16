import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { taskSchema } from '../../src/core/domain/task.ts';
import { coordinationSchema } from '../../src/core/domain/team.ts';
import { runDiagnosticSchema } from '../../src/core/domain/run-diagnostics.ts';
import type { ExecutionEffect } from '../../src/core/storage/execution-journal.ts';
import { bytesHash, fixtureScript, type AcceptanceSnapshot } from './acceptance-oracle.ts';
import { readNativeJournals, type NativeJournal } from './native-evidence.ts';

const effectSchema = z
  .object({
    id: z.string(),
    task: z.string(),
    run: z.string(),
    actor: z.string(),
    call: z.string(),
    tool: z.string(),
    argumentsHash: z.string(),
    state: z.enum(['started', 'returned', 'failed', 'uncertain']),
    at: z.string(),
    file: z.string().optional(),
    before: z.string().optional(),
    after: z.string().optional(),
    resultHash: z.string().optional(),
  })
  .strict();
const liveSchema = z.object({
  home: z.string(),
  projects: z.array(z.string()).min(1),
  approvedCommand: z.string(),
  tasks: z.array(taskSchema),
  records: z.array(coordinationSchema),
  diagnostics: z.array(z.object({ runs: z.array(runDiagnosticSchema) })).default([]),
});

export function evidenceJournals(journals: NativeJournal[], tasks: AcceptanceSnapshot['tasks']) {
  const receiptCalls = new Set(tasks.flatMap((t) => t.receipts.map((r) => t.targetSession + ':' + r.id)));
  return journals.map((journal) => {
    const calls = new Set(receiptCalls);
    for (const event of journal.events)
      if (event.type === 'approval/asked') {
        const data = z.object({ callId: z.string() }).parse(event.data);
        calls.add(journal.session + ':' + data.callId);
      }
    return {
      session: journal.session,
      events: journal.events.filter((event) => {
        if (event.type === 'approval/asked' || event.type === 'approval/decided') return true;
        if (event.type === 'tool/call')
          return calls.has(journal.session + ':' + z.object({ callId: z.string() }).parse(event.data).callId);
        if (event.type === 'tool/result')
          return calls.has(
            journal.session +
              ':' +
              z.object({ message: z.object({ toolCallId: z.string() }) }).parse(event.data).message
                .toolCallId,
          );
        return false;
      }),
    };
  });
}

export async function captureAcceptance(input: {
  home: string;
  projects: string[];
  tasks: AcceptanceSnapshot['tasks'];
  records: AcceptanceSnapshot['records'];
  verification: string;
  runs: AcceptanceSnapshot['runs'];
  since: number;
  sessions: string[];
}): Promise<AcceptanceSnapshot> {
  const effects: ExecutionEffect[] = [],
    execution = join(input.home, 'core', 'execution');
  let databases: string[];
  try {
    databases = await readdir(execution);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    databases = [];
  }
  for (const name of databases.filter((n) => /^[a-f0-9]{64}\.sqlite$/.test(n))) {
    const db = new DatabaseSync(join(execution, name), { readOnly: true });
    try {
      for (const row of db.prepare('SELECT body FROM effects').all()) {
        const effect = effectSchema.parse(JSON.parse(String(row.body)));
        if (input.tasks.some((t) => t.id === effect.task)) effects.push(effect);
      }
    } finally {
      db.close();
    }
  }
  return {
    version: 1,
    tasks: input.tasks,
    records: input.records,
    verification: input.verification,
    scriptHash: bytesHash(fixtureScript),
    runs: input.runs,
    since: input.since,
    sessions: input.sessions,
    effects,
    journals: evidenceJournals(await readNativeJournals(input.home), input.tasks),
    projects: await Promise.all(
      input.projects.map(async (cwd) => ({
        cwd,
        files: await Promise.all(
          (await readdir(cwd))
            .filter((n) => !n.startsWith('.'))
            .sort()
            .map(async (name) => {
              const path = join(cwd, name),
                stat = await lstat(path);
              return {
                name,
                hash:
                  stat.isFile() && !stat.isSymbolicLink() && stat.size < 1024 * 1024
                    ? bytesHash(await readFile(path))
                    : 'unknown:not-bounded-regular-file',
              };
            }),
        ),
      })),
    ),
  };
}

/** Reads legacy evidence and current isolated fixture files; never rewrites its historical verdict. */
export async function captureHistoricalAcceptance(path: string) {
  const bytes = await readFile(path),
    live = liveSchema.parse(JSON.parse(bytes.toString('utf8')));
  const runs = live.diagnostics.flatMap((d) => d.runs);
  const snapshot = await captureAcceptance({
    ...live,
    verification: live.approvedCommand,
    runs,
    since: Math.min(...runs.map((r) => r.startedAt)),
    sessions: [...new Set(runs.map((r) => r.session))],
  });
  return { source: path, sourceHash: bytesHash(bytes), capturedAt: new Date().toISOString(), snapshot };
}
