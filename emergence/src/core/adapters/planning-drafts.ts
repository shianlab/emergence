import type { Agent } from '@deepseek-ai/dsh-agent';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { CorePlanning } from '../application/planning-service.ts';
import {
  draftStepInputSchema,
  draftRemoveInputSchema,
  draftCommitInputSchema,
} from '../domain/work-draft.ts';
import { schemaParameters } from './tool-protocol.ts';

export function registerDraftTools(host: CorePlanning, target: Agent) {
  const when =
    (name: string) =>
    async ({ agent }: { agent: Agent }) => {
      if (agent !== target || !host.coordinatorRole(agent)) return false;
      await host.state(agent).loaded;
      return host.toolVisible(agent, name);
    };
  const output = {
    schema: { type: 'json' as const },
    render: (_: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
  };
  return [
    target.ctx.tools.register(
      defineTool({
        name: 'emergence_plan_step',
        description:
          '主控分步规划：每次仅保存一个子任务（同 id 替换）。复制分析回执的 requirementRevision 和最新 draftRevision；不要并行提交多个版本。project 用资源摘要里的绝对目录；每个 requirementId 对应 localCriteria 的本项目局部验收。scope 仅真实路径；有明确检查命令时填 verifications。依赖可引用随后提交的步骤。保存不派工；约束和总目标由宿主继承，不重复写。',
        parameters: schemaParameters(draftStepInputSchema),
        output,
        execute: (args, exec) => host.drafts.edit(exec.agent!, args, exec.signal),
      }),
      { when: when('emergence_plan_step') },
    ),
    target.ctx.tools.register(
      defineTool({
        name: 'emergence_plan_remove',
        description:
          '删除当前草稿中的一个子任务。不会删除或撤销已经派发的任务。使用最新草稿版本；删除后仍须修正依赖、补全覆盖再提交。',
        parameters: schemaParameters(draftRemoveInputSchema),
        output,
        execute: (args, exec) => host.drafts.edit(exec.agent!, args, exec.signal, true),
      }),
      { when: when('emergence_plan_remove') },
    ),
    target.ctx.tools.register(
      defineTool({
        name: 'emergence_plan_commit',
        description:
          '全部子任务保存后，一次提交草稿图。填写最新 requirementRevision/draftRevision、简短 reason 和真实成功读取 evidence callId；不重发 steps。宿主校验验收覆盖、依赖、实时项目/能力/权限并分配窗口。ready 时自动结束规划并进入原审批派发；不需要另发派工命令。',
        parameters: schemaParameters(draftCommitInputSchema),
        output,
        execute: async (args, exec) => {
          const result = await host.drafts.commit(exec.agent!, args, exec.signal);
          const s = host.state(exec.agent!).value;
          if (s.status === 'ready' && s.analysis?.intent === 'execute' && !s.analysis.questions?.length)
            exec.concludeTurn();
          return result;
        },
      }),
      { when: when('emergence_plan_commit') },
    ),
  ];
}
