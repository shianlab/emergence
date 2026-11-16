import { CoreObserver } from '../application/observer.ts';
import type { SessionPort as SessionController } from '../application/runtime-ports.ts';
import type { PermissionFact } from '../domain/contracts.ts';
import { toolContract } from '../domain/tool-contract.ts';
import { FileObservationStore } from '../storage/observation-store.ts';
import { loadCoreCatalog } from './catalog.ts';

export function createCoreObserver(home: string, mode: 'observe' | 'off') {
  try {
    return new CoreObserver(loadCoreCatalog(), mode, new FileObservationStore(home));
  } catch {
    return new CoreObserver(undefined, mode, new FileObservationStore(home), 'CORE_ASSET_INVALID');
  }
}
export function toolKind(name: string, args?: unknown): PermissionFact['toolKind'] {
  const operation = toolContract(name, args).operation;
  return operation === 'command'
    ? 'shell'
    : ['read', 'write', 'delegate'].includes(operation)
      ? (operation as 'read' | 'write' | 'delegate')
      : 'other';
}
/** Does not modify pre-step results or prompts. Owns no scheduler or approval path. */
export function mountCoreObservation(controller: SessionController) {
  const c = controller;
  return [
    c.ctx.on('agent/pre-step', async ({ agent }, next) => {
      const result = await next();
      if (c.owns(agent) && result.kind !== 'reject') c.core.modelStep(agent.id);
      return result;
    }),
    c.ctx.on('tools/result', (exec) => {
      if (c.owns(exec.agent)) c.core.toolFinished(exec.agent!.id);
    }),
    c.ctx.on('agent/status', ({ agent, status }) => {
      if (c.owns(agent) && status === 'idle') c.core.idle(agent.id);
    }),
    c.ctx.on('agent/error', ({ agent }) => {
      if (c.owns(agent)) c.core.error(agent.id);
    }),
  ];
}
