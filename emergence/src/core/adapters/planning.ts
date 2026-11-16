import { schemaParameter, schemaParameters, parseProtocol, protocolInput } from './tool-protocol.ts';
import { workProposalSchema, planProposalSchema } from '../domain/plan-proposal.ts';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { randomUUID } from 'node:crypto';
import type { CorePlanning } from '../application/planning-service.ts';
import {
  coordinatorControlNames,
  coordinatorToolAllowed,
  planningToolNames,
} from '../domain/planning-tools.ts';
import { analysisRequestSchema } from '../domain/planning.ts';
import { requirementTexts } from '../domain/requirements.ts';
import { budgetReasons, orchestrationLimits } from '../domain/run-budget.ts';
import { isEvidenceRead, toolOutcome } from '../domain/tool-contract.ts';
import { safeError } from './redaction.ts';
import { inventoryPage, planningResources } from '../domain/inventory-view.ts';
type Host = Pick<
  CorePlanning,
  | 'c'
  | 'enabled'
  | 'states'
  | 'proposed'
  | 'route'
  | 'state'
  | 'establish'
  | 'blockDispatch'
  | 'save'
  | 'environment'
  | 'submit'
  | 'intake'
  | 'run'
  | 'coordinates'
  | 'toolVisible'
  | 'drafts'
  | 'onExecute'
  | 'inventory'
  | 'watchPlanningBudget'
  | 'budgetTimer'
  | 'admit'
  | 'planningBudget'
  | 'stopping'
  | 'context'
  | 'guard'
>;
export function registerPlanningTools(host: Host, target: Agent) {
  const agent = target,
    active = async (candidate: Agent) => {
      if (!host.c.owns(candidate) || !host.enabled) return false;
      const r = host.states.get(candidate)!;
      await r.loaded;
      const claimed = host.proposed.get(candidate);
      if (claimed?.at(-1)?.source.kind === 'emergence-task') return false;
      const proposed = claimed?.filter((m) => m.source.kind === 'user');
      if (!proposed?.length) return r.value.route === 'planned';
      const text = proposed
        .flatMap((m) => m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])))
        .join('\n');
      return (
        host.route(text).route === 'planned' ||
        (r.value.route === 'planned' &&
          (r.value.status === 'needs-input' ||
            /^(继续|可以|确认|没问题|按这个|是的|好的|continue|yes|go ahead)/i.test(text.trim())))
      );
    };
  return [
    agent.ctx.tools.register(
      defineTool({
        name: 'emergence_decide',
        description:
          '主控结构化决定：answer 仅用于直接问答；blocked 用于无法推进并说明缺口。不会派工。工作任务应使用 analyze 和 plan_work。',
        parameters: {
          action: { type: 'string', enum: ['answer', 'blocked'], required: true },
          reason: { type: 'string', required: true },
        },
        output: {
          schema: { type: 'json' },
          render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }],
        },
        execute: async (args, exec) => {
          const r = host.state(exec.agent!);
          await r.loaded;
          if (!r.value.autonomy || r.value.executions?.length) throw new Error('当前没有待决定的主控请求');
          if (!args.reason.trim() || args.reason.length > 1000)
            throw new Error('请给出 1..1000 字符的真实理由');
          if (
            args.action === 'answer' &&
            (r.value.route !== 'direct' || r.value.analysis?.intent === 'execute')
          )
            throw new Error('工作任务需要需求分析和分工，不能标成直接问答');
          if (args.action === 'blocked') host.blockDispatch(r, args.reason);
          else {
            r.value.autonomy.decision = 'answer';
            r.value.autonomy.reason = safeError(args.reason);
            host.save(r);
          }
          return { decision: args.action, reason: safeError(args.reason) };
        },
      }),
      {
        when: ({ agent }) =>
          agent === target &&
          agent === host.c.agent &&
          host.enabled &&
          Boolean(host.environment?.().coordinating),
      },
    ),
    agent.ctx.tools.register(
      defineTool({
        name: 'emergence_plan_work',
        description:
          '主控工作分解（只规划）：使用分析回执 requirements.revision 填 requirementRevision。steps 提交 id/objective/role/project/capabilities/dependsOn/scope/requirementIds/purpose；purpose=delivery 是交付，user-check 是用户明确要求的研究/检查交付（仍引用其验收编号），assurance 是宿主核验（subject 指关联交付 ID），宿主会拒绝计划内 assurance 并要求移除，以免重复核验。每步引用验收编号，全部验收必须被覆盖。约束、总目标、验收文字由宿主继承，不重复提交。新增需求放 suggestions（sourceIds 为用户消息来源，conflictsWith 为冲突需求编号），不能自动授权；普通实现方式写 reason/assumptions。宿主匹配窗口与模型，通过准入且 intent=execute 后自动派工，仍须权限。',
        parameters: {
          work: schemaParameter(workProposalSchema),
          work_json: { type: 'string', description: 'Deprecated v0.1 compatibility; use work.' },
        },
        output: {
          schema: { type: 'json' },
          render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }],
        },
        execute: async (args, exec) => {
          const r = host.state(exec.agent!);
          await r.loaded;
          if (!r.value.analysis?.intent) throw new Error('先分析需求并明确 intent');
          if (r.value.executions?.length) throw new Error('已经派发，不重复提交');
          const result = await host.submit(
            exec.agent!,
            protocolInput(args, 'work', 'work_json'),
            exec.signal,
            true,
          );
          // The existing turn-stopping hook owns dispatch. A valid plan does not
          // need another model response just to tell that hook it may proceed.
          if (
            r.value.status === 'ready' &&
            r.value.analysis.intent === 'execute' &&
            !r.value.analysis.questions?.length
          )
            exec.concludeTurn();
          return result;
        },
      }),
      {
        when: ({ agent }) =>
          agent === target &&
          agent === host.c.agent &&
          host.enabled &&
          host.toolVisible(agent, 'emergence_plan_work') &&
          Boolean(host.environment?.().coordinating),
      },
    ),
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
          const r = host.state(exec.agent!);
          await r.loaded;
          if (r.value.executions?.length)
            throw new Error('执行图已提交；请等待任务结果，不重置正在执行的目标');
          if (r.value.analysis) throw new Error('本次请求已有目标分析；请使用计划修订承接后续发现');
          const { route: requestedRoute, ...parsedAnalysis } = parseProtocol(analysisRequestSchema, args);
          const ranks = { direct: 0, focused: 1, planned: 2 };
          const env = host.environment?.();
          const route =
            requestedRoute === 'focused' &&
            (env?.coordinating || (env?.mode === 'collaborate' && env.windows.some((w) => w.dispatchable)))
              ? 'planned'
              : requestedRoute;
          if (ranks[route] > ranks[r.value.route]) r.value.route = route;
          const requirements = host.establish(r, parsedAnalysis);
          r.value.analysis = {
            ...parsedAnalysis,
            constraints: requirementTexts(requirements, 'constraint'),
            acceptance: requirementTexts(requirements, 'acceptance'),
            nonGoals: requirementTexts(requirements, 'nonGoal'),
          };
          if (r.value.analysis.intent === 'clarify' || r.value.analysis.questions?.length)
            r.value.status = 'needs-input';
          r.value.routeReason = safeError(parsedAnalysis.reason).slice(0, 200);
          host.drafts.prepare(exec.agent!);
          host.save(r);
          host.c.changed();
          const intake = host.intake(exec.agent!);
          if (
            !host.coordinates(exec.agent!) ||
            r.value.analysis.intent !== 'execute' ||
            r.value.analysis.questions?.length
          )
            return intake;
          return { ...intake, resources: planningResources(await host.inventory(exec.agent!, exec.signal)) };
        },
      }),
      {
        when: ({ agent }) =>
          agent === target &&
          host.enabled &&
          host.proposed.get(agent)?.at(-1)?.source.kind !== 'emergence-task' &&
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
        when: ({ agent }) =>
          agent === target &&
          agent === host.c.agent &&
          !host.coordinates(agent) &&
          !!host.onExecute &&
          active(agent),
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
            s = host.state(exec.agent!).value,
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
          '提交计划（不会执行）：requirementRevision 引用 emergence_analyze 返回的 requirements.revision；steps 的 requirementIds 引用验收编号，覆盖全部验收。purpose=delivery 或 user-check 描述交付；assurance（subject 指交付 ID）由宿主自动生成，不应放入计划。窗口、会话、项目、模型绑定须来自清单。宿主继承目标与约束；新增需求用 suggestions，不会自动成为授权。证据仅引用成功读取 callId；阻塞未知不得标 ready。',
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
      { when: ({ agent }) => agent === target && !host.coordinates(agent) && active(agent) },
    ),
  ];
}
export function mountPlanningHarness(host: Host) {
  let releaseCoordinatorMenu: (() => void) | undefined;
  const c = host.c;
  const changed = () => {
    if (!host.environment?.().coordinating || !host.enabled) {
      releaseCoordinatorMenu?.();
      releaseCoordinatorMenu = undefined;
    }
    host.watchPlanningBudget();
  };
  c.on('change', changed);
  return [
    () => {
      releaseCoordinatorMenu?.();
      clearTimeout(host.budgetTimer);
      c.off('change', changed);
    },
    // Harness resolves tools before pre-step. Preview only claimed (not merely queued) input
    // for activation; commit the task state only after pre-step accepts the messages.
    c.ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      if (agent === c.agent) {
        releaseCoordinatorMenu?.();
        releaseCoordinatorMenu = undefined;
        if (host.coordinates(agent) && message.source.kind !== 'emergence-task') {
          const allow = c.ctx.tools
            .definitions()
            .filter((tool) => coordinatorToolAllowed(tool.name))
            .map((tool) => tool.name);
          // Global tools registered later must not bypass the menu. Scoped
          // providers use host.toolVisible because native masks exempt them.
          if (allow.length) releaseCoordinatorMenu = agent.ctx.tools.restrict({ allow });
        }
      }
      if (c.owns(agent) && host.enabled) {
        host.state(agent);
        host.proposed.set(agent, [...(host.proposed.get(agent) ?? []), message]);
      }
    }),
    c.ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      try {
        const result = await next();
        if (c.owns(agent) && host.enabled && result.kind !== 'reject') {
          await host.admit(agent, result.messages);
          signal.throwIfAborted();
          const r = host.states.get(agent),
            a = r?.value.autonomy;
          if (r && a && !r.value.executions?.length && !a.decision && host.environment?.().coordinating) {
            const exceeded = host.planningBudget()?.exceeded;
            host.watchPlanningBudget();
            if (a.steps >= orchestrationLimits.planningSteps || exceeded) {
              // A slow provider can finish a valid plan in the final allowed step.
              // Settle that plan through the normal permission gate before stopping planning.
              if (
                r.value.status === 'ready' &&
                r.value.plan &&
                r.value.analysis?.intent === 'execute' &&
                !r.value.analysis.questions?.length
              ) {
                await host.stopping(agent, signal);
                if (r.value.executions?.length) return result;
                if (host.c.permissionMode === 'plan') return { kind: 'reject' as const };
                if (a.decision) throw new Error(a.reason ?? '主控派工未完成');
              }
              const reason = `主控规划${a.steps >= orchestrationLimits.planningSteps ? `已达到 ${orchestrationLimits.planningSteps} 轮模型调用上限` : '已超过规划时长上限：' + budgetReasons[exceeded ?? 'execution']}（当前 ${a.steps} 轮，${Math.floor((Date.now() - a.startedAt) / 1000)} 秒）；这是内部规划预算，不是账户余额或 Token 额度。尚无可派发方案，请补充要求或发送“继续”重试`;
              host.blockDispatch(r, reason);
              throw new Error(reason);
            }
            a.steps++;
            host.save(r);
          }
        }
        return result;
      } finally {
        host.proposed.delete(agent);
      }
    }),
    c.ctx.on('agent/turn-stopping', ({ agent, turn, signal }) => {
      // Read the committed native finish, never infer truncation from prose or
      // an earlier turn. Native max-tokens also suppresses partial tool calls.
      const message = agent.session
        .snapshotEvents()
        .findLast((event) => event.type === 'assistant/message' && event.data.turn === turn);
      const finish =
        message?.type === 'assistant/message'
          ? message.data.stream.findLast(
              (record) => record.type === 'chunk' && record.chunk.type === 'finish',
            )
          : undefined;
      const reason =
        finish?.type === 'chunk' &&
        finish.chunk.type === 'finish' &&
        finish.chunk.reason.kind === 'max-tokens'
          ? 'max-tokens'
          : undefined;
      return host.stopping(agent, signal, reason);
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
      const r = host.states.get(exec.agent!);
      if (
        r &&
        r.value.route === 'planned' &&
        isEvidenceRead(exec.name, exec.arguments) &&
        r.value.status !== 'ready'
      ) {
        const reason = host.guard(exec);
        if (reason) throw new Error(reason);
        r.value.research++;
        r.reading.add(exec.callId);
        host.save(r);
        try {
          return await next();
        } finally {
          r.reading.delete(exec.callId);
        }
      }
      return next();
    }),
    c.ctx.on('tools/result', (exec, result) => {
      if (!c.owns(exec.agent) || !host.enabled || result.isError || planningToolNames.has(exec.name)) return;
      const value = result.value;
      if (toolOutcome(exec.name, value, !!result.isError, exec.signal.aborted) !== 'succeeded') return;
      const control = host.states.get(exec.agent!);
      if (
        control?.value.route === 'direct' &&
        control.value.autonomy &&
        coordinatorControlNames.has(exec.name)
      ) {
        control.value.autonomy.decision = 'answer';
        control.value.autonomy.reason = '已通过原生治理工具处理本次请求';
        host.save(control);
      }
      const r = host.states.get(exec.agent!);
      if (!r || r.value.route === 'direct') return;
      if (!r.value.receipts.some((receipt) => receipt.id === exec.callId))
        r.value.receipts.push({
          id: exec.callId,
          tool: exec.name,
          read: isEvidenceRead(exec.name, exec.arguments),
        });
      r.value.receipts = r.value.receipts.slice(-64);
      host.save(r);
    }),
  ];
}
