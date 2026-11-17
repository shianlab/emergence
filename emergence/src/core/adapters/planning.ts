import type { Agent } from '@deepseek-ai/dsh-agent';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { randomUUID } from 'node:crypto';
import type { CorePlanning } from '../application/planning-service.ts';
import { analysisRequestSchema } from '../domain/intent.ts';
import { inventoryPage } from '../domain/inventory-view.ts';
import { planProposalSchema } from '../domain/plan-proposal.ts';
import { planningToolNames } from '../domain/planning-tools.ts';
import { isEvidenceRead, toolOutcome } from '../domain/tool-contract.ts';
import { parseProtocol, protocolInput, schemaParameter, schemaParameters } from './tool-protocol.ts';
type Host = Pick<
  CorePlanning,
  | 'c'
  | 'enabled'
  | 'active'
  | 'isContracted'
  | 'analyze'
  | 'snapshot'
  | 'claim'
  | 'clearClaim'
  | 'beginRead'
  | 'observeCall'
  | 'finishCall'
  | 'recordReceipt'
  | 'submit'
  | 'intake'
  | 'run'
  | 'onExecute'
  | 'inventory'
  | 'admit'
  | 'context'
  | 'guard'
>;
export function registerPlanningTools(host: Host, target: Agent) {
  const agent = target,
    active = async (candidate: Agent) => {
      if (!host.c.owns(candidate) || !host.enabled) return false;
      return host.active(candidate);
    };
  return [
    agent.ctx.tools.register(
      defineTool({
        name: 'emergence_analyze',
        description:
          '内置需求理解：整理目标、约束、验收、nonGoals 和关键问题。intent 为 discuss/execute/clarify；只讨论或待澄清不实施。延续任务自动继承 inheritedRequirements，未改动要求可省略；用户明确修改才用 changes（action:add/replace/remove，targetId，kind，text，sourceId 为本轮 source.admittedIds，reason）。每份用户输入只分析一次；真实澄清答复接纳后更新理解，版本由宿主分配；新增计划建议不能自动改变需求。纯事实问答无需调用。',
        parameters: schemaParameters(analysisRequestSchema),
        output: {
          schema: { type: 'json' },
          render: (_a, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        execute: async (args, exec) => {
          return host.analyze(exec.agent!, parseProtocol(analysisRequestSchema, args));
        },
      }),
      {
        when: ({ agent }) =>
          agent === target &&
          host.enabled &&
          !host.isContracted(agent) &&
          !host.c.permissionConstraints(agent).length,
      },
    ),
    agent.ctx.tools.register(
      defineTool({
        name: 'emergence_execute_plan',
        description:
          '将当前通过检查的计划一次性提交到持久任务图。plan_id 必须使用 emergence_plan 返回的 planId；重复计划不会重复创建任务。提交后结束本轮，让原调度器启动执行。',
        parameters: { plan_id: { type: 'string', required: true } },
        output: {
          schema: { type: 'json' },
          render: (_a, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        execute: async (args, exec) => ({
          tasks: (await host.run(true, args.plan_id, exec.signal)).map((t) => t.id),
          notice: '已提交。请结束本轮；/tasks 为实际执行状态。',
        }),
      }),
      {
        when: ({ agent }) => agent === target && agent === host.c.agent && !!host.onExecute && active(agent),
      },
    ),
    agent.ctx.tools.register(
      defineTool({
        name: 'emergence_capabilities',
        description:
          '查询本机实际能力、窗口绑定及成功读取回执。清单仅是候选，执行仍须权限。offset 为能力分页、windowOffset 为窗口分页，默认均为 0；窗口 capabilities 仅列本页可用能力，不表示其他页的能力不存在。用 nextOffset/nextWindowOffset 继续读取。',
        parameters: { offset: { type: 'integer' }, windowOffset: { type: 'integer' } },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        execute: async (args, exec) => {
          const i = await host.inventory(exec.agent!, exec.signal),
            s = host.snapshot(exec.agent!)!,
            offset = args.offset ?? 0;
          if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset 必须是非负整数');
          return {
            ...inventoryPage(i, offset, args.windowOffset ?? 0),
            receipts: s.receipts,
            requirements: s.requirements ?? null,
            inheritedRequirements: s.inheritedRequirements ?? null,
            source: s.source ?? null,
          };
        },
      }),
      { when: ({ agent }) => agent === target && active(agent) },
    ),
    agent.ctx.tools.register(
      defineTool({
        name: 'emergence_plan',
        description:
          '提交计划（不会执行）：requirementRevision 引用 emergence_analyze 返回的 requirements.revision；steps 的 requirementIds 引用验收编号，覆盖全部验收。purpose=delivery 或 user-check 描述交付；不支持计划内独立审查步骤；验收以真实回执和用户确认为准。窗口、会话、项目、模型绑定须来自清单。宿主继承目标与约束；新增需求用 suggestions，不会自动成为授权。证据仅引用成功读取 callId；阻塞未知不得标 ready。',
        parameters: {
          plan: schemaParameter(planProposalSchema),
          plan_json: { type: 'string', description: 'Deprecated v0.1 compatibility; use plan.' },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        execute: async (args, exec) =>
          host.submit(exec.agent!, protocolInput(args, 'plan', 'plan_json'), exec.signal),
      }),
      { when: ({ agent }) => agent === target && active(agent) },
    ),
  ];
}
export function mountPlanningHarness(host: Host) {
  const c = host.c;
  return [
    // Harness resolves tools before pre-step. Preview only claimed (not merely queued) input
    // for activation; commit the task state only after pre-step accepts the messages.
    c.ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      if (c.owns(agent) && host.enabled) {
        host.claim(agent, message);
      }
    }),
    c.ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      try {
        const result = await next();
        if (c.owns(agent) && host.enabled && result.kind !== 'reject') {
          await host.admit(agent, result.messages);
          signal.throwIfAborted();
        }
        return result;
      } finally {
        host.clearClaim(agent);
      }
    }),
    c.ctx.systemPrompt.context({
      name: 'emergence-planning-' + randomUUID(),
      order: 920,
      required: true,
      interpolate: false,
      text: ({ agent }) => (agent && c.owns(agent) ? host.context(agent) : ''),
    }),
    c.ctx.on('tools/execute', async (exec, next) => {
      if (!c.owns(exec.agent) || !host.enabled) return next();
      host.observeCall(exec.agent!, exec.callId);
      if (!isEvidenceRead(exec.name, exec.arguments)) return next();
      const reason = host.guard(exec);
      if (reason) throw new Error(reason);
      const finish = host.beginRead(exec.agent!, exec.callId);
      try {
        return await next();
      } finally {
        finish?.();
      }
    }),
    c.ctx.on('tools/result', (exec, result) => {
      if (!c.owns(exec.agent)) return;
      try {
        if (!host.enabled || result.isError || planningToolNames.has(exec.name)) return;
        if (toolOutcome(exec.name, result.value, !!result.isError, exec.signal.aborted) !== 'succeeded')
          return;
        host.recordReceipt(exec.agent!, exec.callId, exec.name, isEvidenceRead(exec.name, exec.arguments));
      } finally {
        host.finishCall(exec.agent!, exec.callId);
      }
    }),
  ];
}
