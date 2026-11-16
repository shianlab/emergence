import { defineTool } from '@deepseek-ai/dsh-tools';
import type { Collaboration } from '../application/task-coordinator.ts';
import { roles } from '../domain/orchestration.ts';
import { settledTaskStatuses as terminal } from '../domain/task.ts';
import { safeError } from './redaction.ts';
const bounded = (value: unknown, length = 1000) => safeError(value).slice(0, length);
type Host = Pick<
  Collaboration,
  'lifecycle' | 'active' | 'view' | 'assurance' | 'state' | 'enqueue' | 'review' | 'task' | 'repair' | 'wait'
>;
export function mountCollaborationTools(host: Host & Pick<Collaboration, 'workspace'>): Array<() => void> {
  const workspace = host.workspace,
    ctx = workspace.ctx;
  const disposers: Array<() => void> = [];
  disposers.push(
    ctx.systemPrompt.context({
      name: 'emergence-collaboration',
      order: 900,
      required: true,
      interpolate: false,
      text: ({ agent }) => {
        const pane = [...workspace.panes.values()].find((p) => p.controller?.id === agent?.session.id);
        if (!pane) return '';
        const task = host.active.get(pane.id);
        if (task)
          return `Emergence assigned task ${task.id}. Work only on this task in ${task.cwd}. Report with emergence_report. Tool failures and nonzero shell exits require review; a success summary cannot override them. Do not dispatch work to other sessions.\n${task.allocation?.paths ? '这是有明确文件范围的任务：只用 read/read_image/write/edit 处理以下路径；不能用 glob/grep、Shell、子代理或外部工具。需要扩大范围时向主控报告，不绕过门禁。' + JSON.stringify(task.allocation.paths) + '\n' : ''}${JSON.stringify(host.view(task))}\n${host.assurance.context(task)}`;
        if (host.state.mode !== 'collaborate' || pane.id !== host.state.master) return '';
        const automatic = !!agent && pane.controller!.planning.coordinates(agent);
        if (automatic) {
          const members = workspace.team
            .roster()
            .map(
              ({
                id,
                project,
                model,
                position,
                preference,
                state,
                queued,
                running,
                queueable,
                reason,
                permission,
              }) => ({
                id,
                project,
                model,
                position,
                preference,
                state,
                queued,
                running,
                queueable,
                reason,
                permissionMode: permission?.mode,
              }),
            );
          return (
            'Emergence 主控团队。当前使用内置自动规划；主控提交工作分解，宿主匹配窗口并跟进独立验收。' +
            '\n派发状态：' +
            (host.state.paused ? '暂停' : '可用') +
            '\n窗口摘要（完整能力与权限用 emergence_team 查询；偏好不代表能力或授权）：' +
            JSON.stringify(members) +
            '\n可用角色：' +
            JSON.stringify(
              roles(workspace.launch.appConfig.orchestration).map(({ id, description, mode }) => ({
                id,
                description,
                mode,
              })),
            ) +
            '\n最近任务摘要（详细证据用 emergence_tasks 查询）：' +
            JSON.stringify(
              host.state.tasks
                .slice(-12)
                .map(({ id, target, status, objective }) => ({ id, target, status, objective })),
            ) +
            '\n只有宿主总任务 completed 才能报告完成。工具审批仍由用户决定，不抢占用户接管或独立工作的窗口。'
          );
        }
        return (
          `You coordinate Emergence worker windows. Use emergence_dispatch with a stable unique request_key per assignment. Dispatch only the user's requested work. Prefer contract_json with role, scope, acceptance, deliverables and budgets. Contracted completion needs emergence_review with independently checked evidence. Use emergence_repair only within the same authorized objective; never accept a worker claim alone. Use emergence_wait/emergence_tasks to receive actual results. Queued, waiting_user, blocked, interrupted and needs_review are not success. Never claim tests passed without evidence. Git integration is a user command.\nDispatch ${host.state.paused ? 'paused' : 'enabled'}. Workers:\n` +
          host.state.workers
            .map((id) => {
              const p = workspace.panes.get(id);
              return `${id}: ${p?.cwd} · ${p?.modelId}${host.state.owned.includes(id) ? ' [human control]' : ''}`;
            })
            .join('\n') +
          '\n主控职责：理解总目标、选择合适执行窗口并跟进结果；用户不必代输派工命令。用 emergence_team 查询窗口角色、权限与能力。偏好不是能力保证，不抢占独立工作；没有任务时不自行启动。实时团队：' +
          JSON.stringify(workspace.team.roster()) +
          '\n带 followthrough 的总任务提交后，由宿主自动跟进独立审查、验证、有限修复和收尾。不要为这些任务重复调用 audit/review/repair，也不要为等待回执不断调用 wait。只有宿主总任务状态 completed 才能宣布完成；工具审批仍由用户决定。' +
          '\nAvailable roles: ' +
          JSON.stringify(roles(workspace.launch.appConfig.orchestration)) +
          '\nRecent task receipts:\n' +
          JSON.stringify(host.state.tasks.slice(-12).map((t) => host.view(t)))
        );
      },
    }),
  );
  if (workspace.executionScope === 'workspace') {
    const master = (session?: string) =>
      workspace.executionScope === 'workspace' &&
      host.state.mode === 'collaborate' &&
      workspace.panes.get(host.state.master ?? '')?.controller?.id === session;
    disposers.push(
      ctx.tools.register(
        defineTool({
          name: 'emergence_dispatch',
          description:
            'Assign work to one configured worker pane. Stable request_key deduplicates retries. The receipt is acceptance, not completion. depends_on lists existing task IDs; all must succeed before execution.',
          parameters: {
            target: { type: 'string', required: true },
            request_key: { type: 'string', required: true },
            objective: { type: 'string', required: true },
            depends_on: { type: 'array', items: { type: 'string' } },
            contract_json: {
              type: 'string',
              description:
                'JSON object: role, scope array, acceptance array, deliverables array, context, maxSteps, maxDurationMs, maxRepairs. Use for reviewed, budgeted work.',
            },
          },
          output: {
            schema: { type: 'json' },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
          },
          execute: async (args, exec) => {
            exec.signal.throwIfAborted();
            const pane = [...workspace.panes.values()].find(
              (p) => p.controller?.id === exec.agent?.session.id,
            );
            if (!pane) throw new Error('派发来源会话无效');
            const task = await host.enqueue(
              pane.id,
              args.target,
              args.request_key,
              args.objective,
              args.depends_on ?? [],
              args.contract_json ? JSON.parse(args.contract_json) : undefined,
            );
            return host.view(task);
          },
        }),
        {
          when: ({ agent }) =>
            master(agent.session.id) &&
            !workspace.panes.get(host.state.master!)?.controller?.planning.coordinates(agent),
        },
      ),
    );
    disposers.push(
      ctx.tools.register(
        defineTool({
          name: 'emergence_review',
          description:
            'Review a completed contracted task. Inspect actual artifacts and test evidence first; provide criterion-by-criterion evidence. Acceptance releases dependencies. Cannot override tool failures.',
          parameters: {
            task_id: { type: 'string', required: true },
            accepted: { type: 'boolean', required: true },
            evidence: { type: 'string', required: true },
          },
          output: {
            schema: { type: 'json' },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
          },
          execute: async (args, exec) => {
            if (!master(exec.agent?.session.id)) throw new Error('只有主控可验收');
            await host.review(args.task_id, args.accepted, args.evidence, 'model');
            return host.view(host.task(args.task_id));
          },
        }),
        { when: ({ agent }) => master(agent.session.id) },
      ),
    );
    disposers.push(
      ctx.tools.register(
        defineTool({
          name: 'emergence_repair',
          description:
            'Create one linked repair attempt for a rejected or failed contracted task, within its repair limit. No retry after cancellation or human takeover.',
          parameters: {
            task_id: { type: 'string', required: true },
            feedback: { type: 'string', required: true },
          },
          output: {
            schema: { type: 'json' },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
          },
          execute: async (args, exec) => {
            if (!master(exec.agent?.session.id)) throw new Error('只有主控可修复');
            return host.view(await host.repair(args.task_id, args.feedback));
          },
        }),
        { when: ({ agent }) => master(agent.session.id) },
      ),
    );
    disposers.push(
      ctx.tools.register(
        defineTool({
          name: 'emergence_tasks',
          description:
            'Read authoritative task states, errors, summaries and session-log references. No task is started by this tool.',
          parameters: {},
          output: {
            schema: { type: 'json' },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
          },
          execute: async (_args, exec) => {
            if (!master(exec.agent?.session.id)) throw new Error('当前会话不是主控');
            return host.state.tasks.slice(-60).map((t) => host.view(t));
          },
        }),
        { when: ({ agent }) => master(agent.session.id) },
      ),
    );
    disposers.push(
      ctx.tools.register(
        defineTool({
          name: 'emergence_wait',
          description:
            'Wait for task receipts, up to 30 seconds; returns early on user questions or terminal states. Waiting is cancellable. A timeout is not success.',
          parameters: {
            task_ids: { type: 'array', items: { type: 'string' }, required: true },
            timeout_ms: { type: 'integer' },
          },
          output: {
            schema: { type: 'json' },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
          },
          execute: async (args, exec) => {
            if (!master(exec.agent?.session.id)) throw new Error('当前会话不是主控');
            return host.wait(args.task_ids, exec.signal, args.timeout_ms);
          },
        }),
        { when: ({ agent }) => master(agent.session.id) },
      ),
    );
  }
  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'emergence_report',
        description:
          'Report the current assigned task outcome and artifact paths, then finish its turn. Runtime/tool errors remain authoritative even when outcome is success.',
        parameters: {
          outcome: { type: 'string', enum: ['success', 'failed'], required: true },
          summary: { type: 'string', required: true },
          artifacts: {
            type: 'array',
            items: { type: 'string' },
            description:
              '实际产物路径，优先用项目相对路径（如 notes.txt），不写说明或猜测绝对路径。越界路径会拒收报告，修正后重新提交；不表示任务完成。',
          },
        },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute: async (args, exec) => {
          exec.signal.throwIfAborted();
          const task = [...host.active.values()].find(
            (t) => t.targetSession === exec.agent?.session.id && !terminal.has(t.status),
          );
          if (!task) throw new Error('当前会话没有协作任务');
          if (task.assessment && !task.assessment.checks)
            throw new Error('独立审查验证必须先提交 emergence_assess 逐项证据');
          const artifacts = (args.artifacts ?? []).slice(0, 30).map((s) => bounded(s));
          const issues = host.assurance.reportArtifactIssues(task, artifacts);
          if (issues.length)
            return JSON.stringify({
              accepted: false,
              code: 'INVALID_REPORT_ARTIFACTS',
              issues,
              suggestion:
                '报告未入库，本轮未结束。请修正路径后再次报告；优先使用项目相对路径，不重做已完成的文件操作。',
            });
          host.lifecycle.recordReport(task, {
            outcome: args.outcome as 'success' | 'failed',
            summary: bounded(args.summary, 8000),
            artifacts,
          });
          await workspace.save();
          exec.signal.throwIfAborted();
          exec.concludeTurn();
          return `任务 ${task.id} 报告已记录，最终状态由轮次和工具回执决定`;
        },
      }),
      {
        when: ({ agent }) =>
          [...host.active.values()].some(
            (t) => t.targetSession === agent.session.id && !terminal.has(t.status),
          ),
      },
    ),
  );

  return disposers;
}
