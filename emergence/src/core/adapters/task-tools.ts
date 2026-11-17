import { defineTool } from '@deepseek-ai/dsh-tools';
import type { TaskEngine } from '../application/task-engine.ts';
import { settledTaskStatuses as terminal } from '../domain/task.ts';
import { safeError } from './redaction.ts';
const bounded = (value: unknown, length = 1000) => safeError(value).slice(0, length);
type Host = Pick<TaskEngine, 'lifecycle' | 'active' | 'assurance' | 'workspace'>;
export function mountTaskTools(host: Host): Array<() => void> {
  const workspace = host.workspace,
    ctx = workspace.ctx;
  const disposers: Array<() => void> = [];
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
          if (!task) throw new Error('当前会话没有执行任务');
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
