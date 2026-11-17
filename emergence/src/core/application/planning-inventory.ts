import type { Agent } from '@deepseek-ai/dsh-agent';
import { evaluatePermissions } from '../adapters/permissions.ts';
import { safeError } from '../adapters/redaction.ts';
import { roles } from '../domain/orchestration.ts';
import { type Capability, type Inventory, type TaskPlan } from '../domain/planning.ts';
import { toolContract } from '../domain/tool-contract.ts';
import { allocationRevision } from './allocation-snapshot.ts';
import type { PlanningEnvironment, PlanningHost, PlanningWindow } from './planning-ports.ts';
import { projectRef } from './project-contract.ts';
export async function collectPlanningInventory(
  c: PlanningHost,
  environment: (() => PlanningEnvironment) | undefined,
  agent: Agent,
  signal: AbortSignal,
): Promise<Inventory> {
  const env: PlanningEnvironment = environment?.() ?? {
    mode: 'independent' as const,
    currentWindow: 'current',
    windows: [{ id: 'current', controller: c, dispatchable: false }],
    mcp: [],
  };
  const capabilities = new Map<string, Capability>(),
    diagnostics: string[] = [];
  const revision = allocationRevision(env);
  const windows: Inventory['windows'] = [];
  for (const pane of env.windows) {
    const owner = pane.controller,
      a = owner === c ? agent : owner.agent,
      ids: string[] = [];
    const facts: Capability[] = [],
      ownReceipts = owner.planning.snapshot(a)?.receipts ?? [];
    let active = new Set<string>();
    const selection = a.model.current();
    if (selection)
      try {
        const resolved = await c.ctx.tools.resolve({ agent: a, modelSelection: selection, signal });
        try {
          active = new Set(resolved.view(a).keys());
        } finally {
          resolved.dispose();
        }
      } catch {
        diagnostics.push(`窗口 ${pane.id} 的工具激活检查失败；不推测可用性`);
      }
    for (const tool of c.ctx.tools.definitions(a)) {
      const id = (tool.name.startsWith('mcp__') ? 'mcp-tool:' : 'tool:') + tool.name;
      ids.push(id);
      const decision = evaluatePermissions([owner.permissionSnapshot(), ...owner.permissionConstraints(a)], {
        name: tool.name,
        arguments: {},
        cwd: owner.cwd,
        actor: a.id,
      });
      const callable =
        active.has(tool.name) &&
        owner.executionModel(a)?.capabilities?.tools !== false &&
        decision.effect !== 'deny';
      const item: Capability = {
        id,
        kind: tool.name.startsWith('mcp__') ? 'mcp-tool' : 'tool',
        registered: true,
        connected: null,
        callable,
        contract: toolContract(tool.name),
        verified: ownReceipts.some((r) => r.tool === tool.name),
        detail: `已在窗口 ${pane.id} 注册；实际参数仍须通过运行时权限检查`,
      };
      facts.push(item);
      if (!capabilities.has(id) || callable) capabilities.set(id, item);
      if (!callable) ids.pop();
    }
    try {
      if (c.ctx.skills)
        for (const skill of await c.ctx.skills.list({ cwd: owner.cwd, scope: a, signal })) {
          const id = 'skill:' + skill.name,
            callable = skill.invocation.modelInvocable && ids.includes('tool:skill');
          if (callable) ids.push(id);
          const item: Capability = {
            id,
            kind: 'skill',
            registered: true,
            connected: null,
            callable,
            verified: false,
            detail: safeError(skill.description).slice(0, 240),
          };
          facts.push(item);
          if (!capabilities.has(id) || callable) capabilities.set(id, item);
        }
      else diagnostics.push(`窗口 ${pane.id} 的 Skills 服务未加载`);
    } catch {
      diagnostics.push(`窗口 ${pane.id} 的 Skills 读取失败；不推测可用性`);
    }
    windows.push({
      id: pane.id,
      session: a.session.id,
      project: c.ctx.workingDirectory.get(a.session),
      projectId: projectRef(c.ctx.workingDirectory.get(a.session)).id,
      model: owner.executionModel(a)?.id ?? owner.launch.modelId,
      dispatchable: pane.dispatchable,
      capabilities: ids,
      capabilityFacts: facts,
    });
  }
  for (const model of c.launch.appConfig.models)
    capabilities.set('model:' + model.id, {
      id: 'model:' + model.id,
      kind: 'model',
      registered: true,
      connected: null,
      callable: Boolean(process.env[model.apiKeyEnv]),
      verified: false,
      detail: `配置存在；凭据${process.env[model.apiKeyEnv] ? '已提供' : '缺失'}；连通性未经本清单验证`,
    });
  for (const role of roles(c.launch.appConfig.orchestration))
    capabilities.set('role:' + role.id, {
      id: 'role:' + role.id,
      kind: 'role',
      registered: true,
      connected: null,
      callable: true,
      verified: false,
      detail: role.description,
      ...(role.modelId ? { model: role.modelId } : {}),
    });
  for (const role of c.core.catalog?.roles ?? [])
    capabilities.set('method:' + role.id, {
      id: 'method:' + role.id,
      kind: 'method',
      registered: true,
      connected: null,
      callable: false,
      verified: false,
      detail: role.name + '：内置治理方法，不是独立执行代理',
    });
  for (const name of ['kim-service', 'graphify'])
    if (!env.mcp.some((s) => s.id === 'mcp:' + name))
      capabilities.set('mcp:' + name, {
        id: 'mcp:' + name,
        kind: 'mcp',
        registered: false,
        connected: false,
        callable: false,
        verified: false,
        detail: '可选外部记忆/图服务未配置；核心本地记忆独立工作，不自动同步数据',
      });
  for (const server of env.mcp) capabilities.set(server.id, server);
  if (revision !== allocationRevision(environment?.() ?? env)) {
    diagnostics.push('窗口绑定、权限或负载在能力查询期间变化；本次快照不可用于派工，请重新查询');
    for (const window of windows) {
      window.stale = true;
      window.dispatchable = false;
      window.capabilities = [];
      window.capabilityFacts = [];
    }
  }
  return {
    snapshot: { version: 1, revision },
    capabilities: [...capabilities.values()],
    windows,
    mode: env.mode,
    currentWindow: env.currentWindow,
    diagnostics,
  };
}
export function planningBindingsValid(
  plan: TaskPlan | undefined,
  agent: Agent,
  current: PlanningWindow,
  env: PlanningEnvironment | undefined,
) {
  for (const step of plan?.steps ?? []) {
    const window = env?.windows.find((w) => w.id === step.window);
    const owner = window?.controller ?? (!env && step.window === 'current' ? current : undefined);
    const executionAgent = owner === current ? agent : owner?.agent;
    if (
      !owner ||
      !executionAgent ||
      executionAgent.session.id !== step.session ||
      current.ctx.workingDirectory.get(executionAgent.session) !== step.project ||
      (owner.executionModel(executionAgent)?.id ?? owner.launch.modelId) !== step.model ||
      (env && step.window !== env.currentWindow && !window?.dispatchable)
    )
      return false;
  }

  return true;
}
