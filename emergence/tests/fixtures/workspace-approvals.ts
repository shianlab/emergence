import UserApproval from '@deepseek-ai/dsh-user-approval';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { executionFixture, until } from './core-execution.ts';
import type { PaneState } from '../../src/app/workspace.ts';

/** Real Harness queues/approval audit, deterministic model and real local writes. No network control port. */
export async function approvalFixture(count = 3, observe?: (args: Record<string, unknown>) => void) {
  const f = await executionFixture();
  await f.ctx.plugin(UserApproval);
  if (observe)
    f.ctx.on('tools/pre-execute', async (exec, next) => {
      if (exec.name === 'write') observe(exec.arguments as Record<string, unknown>);
      return next();
    });
  const master = f.w.current,
    workers: PaneState[] = [];
  for (let i = 0; i < count; i++) {
    const cwd = join(f.home, 'worker-' + i);
    await mkdir(cwd);
    const pane = await f.w.split('row', cwd);
    pane.controller!.setPermissionMode('ask');
    workers.push(pane);
  }
  async function start() {
    const tasks = [];
    for (const p of workers)
      tasks.push(await f.w.taskEngine.enqueue(p.id, p.id, 'approval-' + p.id, 'fixture:write'));
    await until(() => workers.every((p) => !!p.controller!.pending));
    return tasks;
  }
  return { ...f, master, workers, start };
}
