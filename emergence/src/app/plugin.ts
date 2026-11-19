import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-cmdline';
import { safeError } from '../core/adapters/redaction.ts';
import { mountModelResponseHandling } from '../core/adapters/model-response.ts';
import { acquireLease, canonicalDirectory } from '../core/storage/lease.ts';
import { Capabilities } from './capabilities.ts';
import { SessionController } from './controller.ts';
import type { LaunchConfig } from './session-config.ts';
import { adoptHydratedCredentials } from './credentials.ts';
import { configurationHost, mountModelCredentialResolution } from './model-config-runtime.ts';
import { startModelConfiguration } from './model-config.ts';
import { startEntryUI } from './tui/entry.ts';
import { WorkspaceController } from './workspace.ts';

export const name = 'emergence';
export const inject = [
  'agents',
  'llm',
  'tools',
  'workingDirectory',
  'sessionPersistence',
  'approval',
  'userQuestions',
  'systemPrompt',
  'skills',
  'subagents',
  'settings',
  'credentials',
];

export async function apply(ctx: Context, config: LaunchConfig) {
  adoptHydratedCredentials(config.hydratedCredentials ?? []);
  ctx.effect(() => mountModelCredentialResolution(ctx, config.appConfig));
  ctx.effect(() => mountModelResponseHandling(ctx));
  let controller: SessionController | undefined;
  let workspace: WorkspaceController | undefined;
  let ui: { dispose(): void; refreshHome?(): void } | undefined;
  let modelConfiguration: Promise<Awaited<ReturnType<typeof startModelConfiguration>>> | undefined;
  let configurationChanging = false,
    workspaceOpening = false;
  const openModelConfiguration = async () => {
    if (closing) throw new Error('工作台正在退出');
    if (!modelConfiguration) {
      const host = configurationHost(
          ctx,
          config,
          () => workspace,
          () => ui?.refreshHome?.(),
        ),
        begin = host.beginChange;
      host.beginChange = () => {
        if (closing || workspaceOpening) throw new Error('工作台正在打开或退出，请稍后修改模型配置');
        const release = begin();
        configurationChanging = true;
        return () => {
          configurationChanging = false;
          release();
        };
      };
      modelConfiguration = startModelConfiguration(config.home, host).catch((error) => {
        modelConfiguration = undefined;
        throw error;
      });
    }
    const service = await modelConfiguration;
    if (closing) {
      await service.close();
      return;
    }
    await service.open();
  };
  let capabilities: Capabilities | undefined;
  let closing = false;
  let startup: Promise<void> | undefined;
  let closingJob: Promise<void> | undefined;
  let releaseWorkspace: (() => Promise<void>) | undefined;
  const cleanup = async () => {
    ui?.dispose();
    ui = undefined;
    if (modelConfiguration) {
      const service = await modelConfiguration;
      await service.close();
    }
    const results = await Promise.allSettled([
      workspace?.close(),
      controller?.close(),
      capabilities?.close(),
    ]);
    const errors = results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []));
    if (errors.length) throw new AggregateError(errors, '工作台资源释放失败');
  };
  const close = (code: number): Promise<void> => {
    if (closing) return closingJob ?? Promise.resolve();
    closing = true;
    closingJob = (async () => {
      try {
        // Stop in-progress activation before waiting; a second sweep covers late resources.
        const initial = await Promise.allSettled([cleanup(), startup]);
        const final = await Promise.allSettled([cleanup()]);
        const failures = [...initial, ...final].flatMap((r) => (r.status === 'rejected' ? [r.reason] : []));
        if (failures.length) throw new AggregateError(failures, '工作台资源释放失败');
      } catch (error) {
        code = 1;
        process.stderr.write(safeError(error) + '\n');
      } finally {
        await releaseWorkspace?.();
        ctx.appExit?.(code);
      }
    })();
    return closingJob;
  };
  const disconnected = () => {
    void close(1);
  };
  process.once('disconnect', disconnected);
  ctx.effect(() => () => process.off('disconnect', disconnected));
  ctx.effect(() => async () => {
    closing = true;
    const stopped = await Promise.allSettled([cleanup(), startup]);
    const results = [...stopped, ...(await Promise.allSettled([cleanup()]))];
    await releaseWorkspace?.();
    if (results.some((r) => r.status === 'rejected'))
      throw new Error('资源释放失败，请运行 emergence doctor');
  });
  if (!ctx.appReady) throw new Error('涌现需要通过 dsh profile 启动');
  ctx.effect(() =>
    ctx.appReady!.onReady(() => {
      if (process.channel && !process.connected) {
        void close(1);
        return;
      }
      startup = (async () => {
        releaseWorkspace = await acquireLease(
          `workspace:${await canonicalDirectory(config.home)}:${await canonicalDirectory(config.cwd, false)}`,
          '当前项目的工作台',
        );
        if (closing) {
          await releaseWorkspace();
          return;
        }
        if (config.prompt !== undefined) {
          capabilities = new Capabilities(ctx, config.appConfig);
          await capabilities.initialize();
          if (closing) return;
          controller = new SessionController(ctx, config);
          const planningController = controller;
          controller.planning.environment = () => ({
            mode: 'independent',
            currentWindow: 'current',
            windows: [{ id: 'current', controller: planningController, dispatchable: false }],
            mcp: capabilities?.snapshot() ?? [],
          });
          await controller.open(config.resume);
          if (closing) {
            await controller.close();
            return;
          }
          process.send?.({ type: 'emergence-ready' });
          const current = controller;
          void (async () => {
            await current.send(config.prompt!);
            await current.agent.whenIdle();
            if (closing) return;
            process.stdout.write(
              JSON.stringify({
                sessionId: current.id,
                cwd: current.cwd,
                model: current.model.id,
                transcript: current.transcript(),
                notice: current.notice,
                error: current.lastError,
              }) + '\n',
            );
            await close(current.lastError ? 1 : 0);
          })().catch((error) => {
            if (!closing) {
              process.stderr.write(safeError(error) + '\n');
              void close(1);
            }
          });
        } else {
          ui = await startEntryUI(config, {
            async open(launch) {
              if (configurationChanging) throw new Error('模型配置正在保存，请稍后开始会话');
              workspaceOpening = true;
              const current = new WorkspaceController(ctx, launch);
              workspace = current;
              current.openModelConfiguration = openModelConfiguration;
              try {
                await current.initialize();
                if (closing) throw new Error('工作台正在退出');
                return current;
              } catch (error) {
                await current.close();
                if (workspace === current) workspace = undefined;
                throw error;
              } finally {
                workspaceOpening = false;
              }
            },
            async sessions() {
              return (await ctx.sessionPersistence.list()).map((s) => ({
                id: s.header.id,
                cwd: s.header.cwd ?? config.cwd,
              }));
            },
            modelConfiguration: openModelConfiguration,
            exit() {
              void close(0);
            },
          });
          if (closing) {
            ui.dispose();
            ui = undefined;
            return;
          }
          process.send?.({ type: 'emergence-ready' });
        }
      })().catch((error) => {
        if (!closing) {
          process.stderr.write('涌现：' + safeError(error) + '\n');
          void close(1);
        }
      });
    }),
  );
}
