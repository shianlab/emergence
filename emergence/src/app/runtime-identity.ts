import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SessionController } from './controller.ts';

export const HARNESS_NAME = 'Emergence Harness';
/** Runtime facts, recomputed for the executing agent rather than inferred from chat history. */
export function runtimeIdentity(c: SessionController, agent: Agent) {
  const model = c.executionModel(agent),
    selection = agent.model.current();
  const environment = c.planning.environment?.();
  return {
    application: 'Emergence',
    harness: HARNESS_NAME,
    model: {
      profile: model?.id ?? selection?.provider,
      provider: model?.provider,
      requestedModel: selection?.model ?? model?.model,
      meaning: '当前实际请求的模型配置 ID；供应商内部权重版本未经独立验证',
    },
    project: c.ctx.workingDirectory.get(agent.session),
    core: {
      builtIn: true,
      enabled: c.core.enabled,
      planningEnabled: c.planning.enabled,
      intake: c.planning.intake(agent),
      source: 'Meta_Kim 治理方法的 Emergence 原生实现',
      functions: ['自动任务分流', '结构化规划', '能力选择', '会话内计划执行', '原生检查与证据', '受控记忆'],
      externalServices: '外部 kim-service/Graphify 可选，未配置不影响本地核心；不代表上游全部模块已移植',
    },
    workspace: environment
      ? {
          mode: environment.mode,
          windowControl: false,
          currentWindow: environment.currentWindow,
          windows: environment.windows.map((w) => ({
            id: w.id,
            dispatchable: w.dispatchable,
            project: w.controller.cwd,
            model: w.controller.model.model,
          })),
        }
      : { mode: 'headless' },
  };
}
export function runtimeIdentityContext(c: SessionController, agent: Agent) {
  // Identity is stable model context. Full live rosters, permission snapshots and clocks
  // remain available through runtimeIdentity / capability tools, rather than repeated each step.
  const identity = runtimeIdentity(c, agent);
  const { intake, ...core } = identity.core;
  const workspace = {
    mode: identity.workspace.mode,
    windowControl: false,
    currentWindow: identity.workspace.currentWindow,
    windowCount: identity.workspace.windows?.length,
  };
  const context = { ...identity, core, workspace };
  return `你是涌现 Emergence，运行于 Emergence Harness。它是本应用的原生运行层，整合 DeepSeek 开源执行底座、Emergence TUI/调度/权限和 Meta_Kim 治理方法。模型供应商不是应用身份。以下是宿主实时事实，优先于历史回复中对自身功能的猜测：\n${JSON.stringify(context)}\n内置核心不是用户目录的 meta-theory Skill；不需要用户点名或安装 Skill 才启动。不要通过旧 Skill 的安装状态推断本应用核心是否启用。回答模型问题时使用 requestedModel，勿猜测供应商内部权重。核心关闭时如实说明。复杂任务自动使用内置分析与规划工具，不让用户代输内部调度命令；仍遵循当前权限、审批和验收约束。\n交付 PDF 或长文档时，先用现有资料分段写入源稿，再单独转换并检查产物；避免在一个 Shell 命令或工具参数中同时生成全文和转换脚本。`;
}
