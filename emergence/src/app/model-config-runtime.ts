import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-credentials';
import type {} from '@deepseek-ai/dsh-settings';
import type { AppConfig } from '../core/domain/configuration.ts';
import type { LaunchConfig } from './controller.ts';
import { assertModelHistory } from './controller.ts';
import type { ModelConfigurationHost } from './model-configuration.ts';
import { modelWireConfig } from './model-endpoint.ts';
import type { WorkspaceController } from './workspace.ts';

/**
 * Harness freezes its launch environment. Decorate its public resolver for Emergence's
 * model refs so DPAPI edits reach the next request without writing its plaintext store.
 * Other refs and all record/OAuth methods remain owned by the existing provider.
 */
export function mountModelCredentialResolution(ctx: Context, config: AppConfig) {
  const credentials = ctx.credentials,
    original = credentials.resolve;
  const resolve: typeof original = async (ref) => {
    if (config.models.some((model) => model.apiKeyEnv === ref) && process.env[ref])
      return { value: process.env[ref]!, source: 'emergence-process' };
    return original.call(credentials, ref);
  };
  credentials.resolve = resolve;
  return () => {
    if (credentials.resolve === resolve) credentials.resolve = original;
  };
}

/** The CLI and live updater must declare identical provider routes. */
export function modelProviders(config: AppConfig) {
  return Object.fromEntries(
    config.models.map((model) => [
      model.id,
      {
        ...modelWireConfig(model),
        apiKeyEnv: model.apiKeyEnv,
        displayName: model.provider,
        // dsh-base mounts the durable request retry executor. pi-ai's HTTP retries stay off.
        // These attempts remain in the same turn and share its existing clocks and cancellation.
        // Malformed responses have not committed tool calls; retry only that request, never its task.
        retryPolicy: {
          mode: 'normal' as const,
          maxRetries: 2,
          retryableCodes: ['RATE_LIMIT', 'SERVER', 'TRANSPORT', 'STREAM_CLOSED', 'MALFORMED_RESPONSE'],
          backoff: { initialDelayMs: 500, maxDelayMs: 2000, jitterRatio: 0.1 },
        },
        models: [
          {
            id: model.model,
            name: model.model,
            contextWindow: model.contextWindow,
            maxTokens: model.maxTokens,
            ...(model.capabilities?.vision !== undefined
              ? { input: model.capabilities.vision ? ['text', 'image'] : ['text'] }
              : {}),
          },
        ],
      },
    ]),
  );
}

export function configurationHost(
  ctx: Context,
  launch: LaunchConfig,
  workspace: () => WorkspaceController | undefined,
  onChange: () => void,
): ModelConfigurationHost {
  return {
    windows() {
      const w = workspace();
      if (!w) return [];
      return [...w.panes.values()].map((pane, index) => {
        const ownedRunning =
          pane.controller &&
          ctx.agents.list().some((agent) => pane.controller!.owns(agent) && agent.status === 'running');
        let mutable =
          w.available(pane.id) &&
          Boolean(pane.controller) &&
          !pane.controller?.busy &&
          !pane.controller?.pending &&
          !ownedRunning &&
          !pane.controller?.permissionTransitioning;
        try {
          w.collaboration.assertMutable(pane.id);
        } catch {
          mutable = false;
        }
        return {
          id: pane.id,
          number: index + 1,
          role: w.panes.size === 1 ? '单窗口' : '独立窗口',
          modelId: pane.modelId,
          cwd: pane.cwd,
          mutable,
          status:
            (pane.error
              ? '恢复失败'
              : pane.controller?.pending
                ? '待确认'
                : pane.controller?.busy || ownedRunning
                  ? '运行中'
                  : mutable
                    ? '空闲'
                    : '任务关联中') + (w.visible().includes(pane.id) ? '' : ' · 后台'),
        };
      });
    },
    beginChange() {
      return workspace()?.beginConfigurationChange() ?? (() => {});
    },
    validate(config) {
      for (const pane of workspace()?.panes.values() ?? []) {
        const model = config.models.find((model) => model.id === pane.modelId);
        if (!model) throw new Error(`窗口 ${pane.id} 仍在使用要删除的模型`);
        if (pane.controller)
          assertModelHistory(model, pane.controller.agent.session.snapshotEvents(), [
            ...pane.controller.agent.inbox.nextStep,
            ...pane.controller.agent.inbox.nextTurn,
          ]);
      }
    },
    async apply(config) {
      const previous = structuredClone(launch.appConfig),
        w = workspace();
      const routesChanged = JSON.stringify(previous.models) !== JSON.stringify(config.models);
      try {
        if (routesChanged) {
          await ctx.settings.replace('llm-pi-ai', { providers: modelProviders(config) });
          for (const pane of w?.panes.values() ?? []) {
            const model = config.models.find((model) => model.id === pane.modelId)!;
            if (pane.controller) await ctx.llm.resolveModelInfo(model.id, model.model);
          }
        }
      } catch (error) {
        await ctx.settings.replace('llm-pi-ai', { providers: modelProviders(previous) });
        throw error;
      }
      const update = (target: AppConfig) => {
        target.models = structuredClone(config.models);
        target.defaultModel = config.defaultModel;
        target.windowModels = structuredClone(config.windowModels);
      };
      update(launch.appConfig);
      if (!w && !launch.explicitModel) launch.modelId = config.windowModels.single ?? config.defaultModel;
      if (!config.models.some((m) => m.id === launch.modelId))
        launch.modelId = config.windowModels.single ?? config.defaultModel;
      if (w) {
        update(w.launch.appConfig);
        for (const pane of w.panes.values())
          if (pane.controller) {
            update(pane.controller.launch.appConfig);
            const model = config.models.find((model) => model.id === pane.modelId)!;
            if (routesChanged) pane.controller.agent.model.select({ provider: model.id, model: model.model });
            pane.controller.changed();
          }
        w.notice = '模型配置已从可视化工具更新';
        w.changed();
      }
      onChange();
    },
    async assign(id, modelId) {
      const w = workspace();
      if (!w) throw new Error('当前仍在首页，请先开始会话');
      const pane = w.panes.get(id);
      if (!pane?.controller) throw new Error('窗口不存在或会话不可用');
      if (!w.available(id) || pane.controller.busy || pane.controller.pending)
        throw new Error('请先等待此窗口空闲并完成确认');
      if (
        pane.controller.permissionTransitioning ||
        ctx.agents.list().some((agent) => pane.controller!.owns(agent) && agent.status === 'running')
      )
        throw new Error('请先等待此窗口的子代理和工具执行结束');
      await w.send(id, `/model ${modelId}`);
      await w.save();
    },
  };
}
