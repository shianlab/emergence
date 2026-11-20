import type { Context } from '@deepseek-ai/cordis';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { loadConfig } from '../../src/app/config.ts';
import { configurationHost, mountModelCredentialResolution } from '../../src/app/model-config-runtime.ts';
import { startModelConfiguration } from '../../src/app/model-config.ts';
import { modelPresets } from '../../src/app/model-presets.ts';
import { WorkspaceController } from '../../src/app/workspace.ts';

export const name = 'model-config-fixture';
export const inject = [
  'llm',
  'agents',
  'tools',
  'settings',
  'credentials',
  'workingDirectory',
  'sessionPersistence',
  'systemPrompt',
  'skills',
  'subagents',
];
export function apply(
  ctx: Context,
  options: { home: string; cwd: string; preview: boolean; audit?: boolean; native?: boolean },
) {
  if (!ctx.appReady) throw new Error('Missing appReady');
  ctx.effect(() =>
    ctx.appReady!.onReady(() => {
      void (async () => {
        const config = await loadConfig(options.home),
          launch = {
            home: options.home,
            cwd: options.cwd,
            modelId: config.defaultModel,
            appConfig: config,
            fresh: true,
          };
        ctx.effect(() => mountModelCredentialResolution(ctx, options.home, config));
        const workspace = new WorkspaceController(ctx, launch);
        await workspace.initialize();
        const host = configurationHost(
            ctx,
            launch,
            () => workspace,
            () => {},
          ),
          service = await startModelConfiguration(options.home, host);
        ctx.effect(() => async () => {
          await service.close();
          await workspace.close();
        });
        const first = workspace.current;
        let opened = 0;
        workspace.openModelConfiguration = async () => {
          opened++;
        };
        const beforeOpen = first.controller!.agent.session.snapshotEvents().length;
        await workspace.send(first.id, '模型怎么配置啊');
        await workspace.send(first.id, '/model-config');
        assert.equal(opened, 2);
        assert.equal(first.controller!.agent.session.snapshotEvents().length, beforeOpen);
        await workspace.send(first.id, 'hello');
        await first.controller!.agent.whenIdle();
        const history = first.controller!.agent.session.snapshotEvents().length,
          session = first.sessionId;
        let state = await service.configuration.state();
        state = await service.configuration.save({
          revision: state.revision,
          model: { ...config.models[0], id: 'second', provider: '第二模型', model: 'fixture-second' },
        });
        await service.configuration.assign({
          revision: state.revision,
          windowId: first.id,
          modelId: 'second',
        });
        assert.equal(first.sessionId, session);
        assert.ok(first.controller!.agent.session.snapshotEvents().length >= history);
        await workspace.send(first.id, 'hello after assignment');
        await first.controller!.agent.whenIdle();
        assert.ok(first.controller!.transcript().join('\n').includes('CONFIG_REPLY:fixture-second'));
        state = await service.configuration.save({
          revision: state.revision,
          model: { ...config.models[0], id: 'second', provider: '第二模型', model: 'fixture-updated' },
        });
        await workspace.send(first.id, 'hello after edit');
        await first.controller!.agent.whenIdle();
        assert.ok(first.controller!.transcript().join('\n').includes('CONFIG_REPLY:fixture-updated'));
        if (!options.preview && process.platform === 'win32') {
          state = await service.configuration.save({
            revision: state.revision,
            model: {
              ...config.models[0],
              id: 'key-test',
              model: 'fixture-key-new',
              apiKeyEnv: 'MODEL_CONFIGURATION_NEW_KEY',
            },
            secret: 'initial-fixture-secret',
          });
          await service.configuration.assign({
            revision: state.revision,
            windowId: first.id,
            modelId: 'key-test',
          });
          await workspace.send(first.id, 'hello with new key');
          await first.controller!.agent.whenIdle();
          assert.ok(first.controller!.transcript().join('\n').includes('CONFIG_REPLY:fixture-key-new'));
          state = await service.configuration.save({
            revision: state.revision,
            model: {
              ...config.models[0],
              id: 'key-test',
              model: 'fixture-key-rotated',
              apiKeyEnv: 'MODEL_CONFIGURATION_NEW_KEY',
            },
            secret: 'rotated-fixture-secret',
          });
          await workspace.send(first.id, 'hello with rotated key');
          await first.controller!.agent.whenIdle();
          assert.ok(first.controller!.transcript().join('\n').includes('CONFIG_REPLY:fixture-key-rotated'));
          const inventory = await first.controller!.planning.inventory();
          assert.equal(inventory.capabilities.find((item) => item.id === 'model:key-test')?.callable, true);
          assert.equal(process.env.MODEL_CONFIGURATION_NEW_KEY, undefined);
          await service.configuration.assign({
            revision: state.revision,
            windowId: first.id,
            modelId: 'second',
          });
        }
        state = await service.configuration.defaults({
          revision: state.revision,
          defaultModel: config.defaultModel,
          windowModels: {
            single: 'second',
            master: 'second',
            worker: 'second',
            slots: { '3': 'deepseek' },
          },
        });
        const second = await workspace.split('row');
        assert.equal(second.modelId, 'second');
        const third = await workspace.split('column');
        assert.equal(third.modelId, 'deepseek');
        assert.equal(first.modelId, 'second');
        assert.equal('master' in workspace.taskEngine.state, false);
        workspace.hide(third.id);
        assert.equal(host.windows().length, 3);
        assert.ok(host.windows().some((w) => w.id === first.id && w.role === '独立窗口'));
        assert.ok(host.windows().some((w) => w.id === second.id && w.role === '独立窗口'));
        await workspace.send(second.id, 'hello second window');
        await second.controller!.agent.whenIdle();
        assert.ok(second.controller!.transcript().join('\n').includes('CONFIG_REPLY:fixture-updated'));
        if (options.audit) {
          const token = new URLSearchParams(new URL(service.url).hash.slice(1)).get('session')!;
          const post = async (path: string, value: unknown) => {
            const response = await fetch(service.origin + path, {
              method: 'POST',
              headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify(value),
            });
            const payload: unknown = await response.json();
            assert.equal(response.status, 200, JSON.stringify(payload));
            return payload;
          };
          const checks: Array<{ id: string; test: boolean; actualRequest: boolean }> = [];
          for (const api of ['anthropic-messages', 'openai-responses', 'google-generative-ai'] as const) {
            const model = {
              ...config.models[0],
              id: `protocol-${api.split('-')[0]}`,
              api,
              model: `fixture-${api}`,
              baseURL: config.models[0].baseURL,
            };
            state = await service.configuration.state();
            await post('/api/models/save', { revision: state.revision, model });
            state = await service.configuration.state();
            const tested = z
              .object({ ok: z.boolean(), message: z.string() })
              .parse(await post('/api/test', { model }));
            assert.ok(tested.ok, `${api}: ${tested.message}`);
            await post('/api/windows/assign', {
              revision: state.revision,
              windowId: first.id,
              modelId: model.id,
            });
            await workspace.send(first.id, 'hello protocol audit');
            await first.controller!.agent.whenIdle();
            assert.equal(first.controller!.lastError, undefined, `${api}: ${first.controller!.lastError}`);
            assert.ok(first.controller!.transcript().join('\n').includes(`CONFIG_REPLY:${model.model}`));
            checks.push({ id: api, test: tested.ok, actualRequest: true });
          }
          for (const preset of modelPresets.filter((preset) => preset.group.startsWith('国内'))) {
            const model = {
              ...config.models[0],
              id: `audit-${preset.id}`,
              provider: preset.provider,
              api: preset.api,
              model: preset.model,
              apiKeyEnv: `AUDIT_${preset.apiKeyEnv}`,
              baseURL: new URL(config.models[0].baseURL).origin + new URL(preset.baseURL).pathname,
            };
            state = await service.configuration.state();
            await post('/api/models/save', {
              revision: state.revision,
              model,
              secret: 'preset-fixture-secret',
            });
            state = await service.configuration.state();
            const tested = z
              .object({ ok: z.boolean(), message: z.string() })
              .parse(await post('/api/test', { model }));
            assert.ok(tested.ok, `${preset.id}: ${tested.message}`);
            await post('/api/windows/assign', {
              revision: state.revision,
              windowId: first.id,
              modelId: model.id,
            });
            await workspace.send(first.id, 'hello preset audit');
            await first.controller!.agent.whenIdle();
            assert.equal(
              first.controller!.lastError,
              undefined,
              `${preset.id}: ${first.controller!.lastError}`,
            );
            assert.ok(first.controller!.transcript().join('\n').includes(`CONFIG_REPLY:${preset.model}`));
            assert.ok(!JSON.stringify(state).includes('preset-fixture-secret'));
            checks.push({ id: preset.id, test: tested.ok, actualRequest: true });
          }
          state = await service.configuration.state();
          await post('/api/windows/assign', {
            revision: state.revision,
            windowId: first.id,
            modelId: 'second',
          });
          await writeFile(
            join(options.home, 'audit-result.json'),
            JSON.stringify(
              {
                checks,
                sessionPreserved: first.sessionId === session,
                historyEvents: first.controller!.agent.session.snapshotEvents().length,
              },
              null,
              2,
            ),
          );
          console.log('MODEL_CONFIG_AUDIT ' + checks.length);
        }
        if (!options.preview) {
          await workspace.send(second.id, 'hold-for-config-test');
          assert.equal(host.windows().find((window) => window.id === second.id)?.mutable, false);
          await assert.rejects(
            service.configuration.assign({
              revision: state.revision,
              windowId: second.id,
              modelId: 'deepseek',
            }),
            /空闲|子代理/,
          );
          await assert.rejects(
            service.configuration.save({
              revision: state.revision,
              model: { ...config.models[0], id: 'second', model: 'blocked-edit' },
            }),
            /空闲/,
          );
          await second.controller!.cancel();
          await second.controller!.agent.whenIdle();
        }
        if (options.preview) {
          if (options.native) await service.open();
          console.log('MODEL_CONFIG_PREVIEW ' + service.url);
          console.log('MODEL_CONFIG_PREVIEW_HOME ' + options.home);
          let handled = '',
            active = false;
          const requestSchema = z.object({ nonce: z.string(), pane: z.string() }).strict();
          const timer = setInterval(() => {
            if (active) return;
            active = true;
            void (async () => {
              let raw: string;
              try {
                raw = await readFile(join(options.home, 'ui-audit-request.json'), 'utf8');
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
                throw error;
              }
              const request = requestSchema.parse(JSON.parse(raw));
              if (handled === request.nonce) return;
              handled = request.nonce;
              const pane = workspace.panes.get(request.pane);
              if (!pane?.controller) throw new Error('Audit pane missing');
              await workspace.send(pane.id, 'hello UI audit');
              await pane.controller.agent.whenIdle();
              const result = {
                nonce: request.nonce,
                modelId: pane.modelId,
                model: pane.controller.model.model,
                session: pane.sessionId,
                ok:
                  !pane.controller.lastError &&
                  pane.controller
                    .transcript()
                    .join('\n')
                    .includes(`CONFIG_REPLY:${pane.controller.model.model}`),
                error: pane.controller.lastError,
              };
              await writeFile(join(options.home, 'ui-audit-result.json'), JSON.stringify(result, null, 2));
            })()
              .catch((error) => console.error(error))
              .finally(() => {
                active = false;
              });
          }, 200);
          ctx.effect(() => () => clearInterval(timer));
          process.on('SIGTERM', () => {
            void (async () => {
              await service.close();
              await workspace.close();
              ctx.appExit?.(0);
            })();
          });
        } else {
          await service.close();
          await workspace.close();
          console.log('MODEL_CONFIG_RUNTIME_OK');
          ctx.appExit?.(0);
        }
      })().catch((error) => {
        console.error(error);
        ctx.appExit?.(1);
      });
    }),
  );
}
