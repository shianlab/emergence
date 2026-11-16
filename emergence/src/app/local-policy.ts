import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';

interface Owner {
  owns(agent?: Agent): boolean;
}
const policies = new WeakMap<Context, { owners: Set<Owner>; dispose(): void }>();
export const localShell = (name: string) => name === 'pwsh' || name === 'bash';

/** Unattributed local execution fails closed; owned descendants use their window's approval queue. */
export function registerLocalOwner(ctx: Context, owner: Owner) {
  let policy = policies.get(ctx);
  if (!policy) {
    const owners = new Set<Owner>();
    const dispose = ctx.on('tools/pre-execute', async (exec, next) => {
      if (localShell(exec.name) && ![...owners].some((candidate) => candidate.owns(exec.agent)))
        return { kind: 'deny', reason: '本地命令没有可接收确认的所属窗口，已拒绝执行' };
      return next();
    });
    policy = { owners, dispose };
    policies.set(ctx, policy);
  }
  policy.owners.add(owner);
  return () => {
    policy!.owners.delete(owner);
    if (!policy!.owners.size) {
      policy!.dispose();
      policies.delete(ctx);
    }
  };
}
