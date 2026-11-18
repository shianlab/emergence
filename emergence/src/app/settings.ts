import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { renderSkillContent } from '@deepseek-ai/dsh-skill';
import type {} from '@deepseek-ai/dsh-subagent';
import { stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { safeError } from '../core/adapters/redaction.ts';
import { extensionSchema, type AppConfig } from '../core/domain/configuration.ts';
import {
  permissionModeSchema,
  permissionRuleSchema,
  standardPermissionModeSchema,
} from '../core/domain/permissions.ts';
import { actions, effectiveKeys, uiSchema } from '../core/domain/ui-preferences.ts';
import { commandHelp, workspaceCommands } from './commands.ts';
import { loadConfig, updateConfig } from './config.ts';
import { deleteTemplate, listTemplates, readTemplate, writeTemplate } from './templates.ts';
import type { WorkspaceController } from './workspace.ts';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'emergence-context': { kind: 'emergence-context'; label: string; form: 'instructions' };
  }
}

export class Settings {
  private changing = false;
  constructor(readonly workspace: WorkspaceController) {}
  private show(text: string) {
    this.workspace.taskPanel = false;
    this.workspace.overlay = safeError(text);
    this.workspace.changed();
  }
  private async update(change: (config: AppConfig) => void, policy = false) {
    const w = this.workspace,
      latest = await updateConfig(w.launch.home, change);
    // Runtime routes/skill roots remain the startup snapshot. UI and policy are safe live changes.
    w.launch.appConfig.orchestration = latest.orchestration;
    w.launch.appConfig.ui = latest.ui;
    if (policy) {
      w.launch.appConfig.toolPolicy = latest.toolPolicy;
      w.launch.appConfig.permissions = latest.permissions;
      for (const pane of w.panes.values())
        if (pane.controller) {
          pane.controller.launch.appConfig.toolPolicy = structuredClone(latest.toolPolicy);
          pane.controller.launch.appConfig.permissions = structuredClone(latest.permissions);
          pane.controller.invalidatePermissions();
        }
    }
    w.changed();
    return latest;
  }
  async handle(command: string, args: string[], paneId: string): Promise<boolean> {
    if (command === '/memory') {
      const c = this.workspace.panes.get(paneId)?.controller;
      if (!c) throw new Error('会话不可用');
      const [action = 'list', id, value, extra] = args;
      if (['list', 'status', 'search', 'show', 'history'].includes(action))
        this.show(await c.memory.describe(action, id));
      else if (action === 'propose' && id && value && extra) {
        const entry = await c.memory.propose(id, value, extra);
        this.show(
          `候选 ${entry.id} 已保存，尚未生效。\n${entry.content}\n/memory approve ${entry.id} 查看并批准`,
        );
      } else if (['approve', 'correct', 'forget', 'rollback'].includes(action) && id) {
        this.show('');
        this.show(
          await c.memory.change(
            id,
            action as 'approve' | 'correct' | 'forget' | 'rollback',
            value,
            action === 'rollback' ? Number(value) : undefined,
          ),
        );
      } else
        throw new Error(
          '用法：/memory [list|status|search "关键词"|show <ID>|history <ID>|propose session/project/personal fact/preference/policy "内容"|approve <ID>|correct <ID> "内容"|forget <ID>|rollback <ID> <版本>]',
        );
      return true;
    }
    if (command === '/audit') {
      const c = this.workspace.taskEngine,
        [action = 'list', id] = args;
      if (action === 'list')
        this.show(
          c.state.tasks
            .filter((t) => t.contract && !t.assessment)
            .slice(-40)
            .map((t) => `${t.id} · ${t.objective}\n/audit show ${t.id} · /audit history ${t.id}`)
            .join('\n\n') || '暂无可审查的契约任务',
        );
      else if (action === 'show' && id)
        this.show(
          '执行结束、审查通过、验证通过和用户验收分别记录。\n' +
            JSON.stringify(await c.assurance.status(id), null, 2),
        );
      else if (action === 'history' && id) {
        const task = c.task(id),
          owner = this.workspace.panes.get(task.target)?.controller;
        const events =
          owner?.id === task.targetSession
            ? owner.agent.session
                .snapshotEvents()
                .filter((e) => e.seq >= task.fromSeq && e.seq <= (task.result?.toSeq ?? Infinity))
                .slice(-100)
            : [];
        this.show(
          '任务关联与最近 100 条原始会话事件（只读，不重新执行）：\n' +
            JSON.stringify(
              {
                task: c.view(task),
                assessments: c.state.tasks.filter((t) => t.assessment?.subject === id).map((t) => c.view(t)),
                events,
                logSession: task.targetSession,
              },
              null,
              2,
            ),
        );
      } else throw new Error('用法：/audit [list|show <任务>|history <任务>]；跨窗口审查已移除');
      return true;
    }
    if (command === '/plan') {
      const c = this.workspace.panes.get(paneId)?.controller;
      if (!c) throw new Error('会话不可用');
      if (args[0] === 'run' && args.length === 1) {
        this.show('');
        const tasks = await c.planning.run();
        this.show(`计划已提交 ${tasks.length} 个任务；/tasks 查看实际执行与验收状态。`);
      } else if (args.length) throw new Error('用法：/plan 或 /plan run');
      else this.show(await c.planning.describe());
      return true;
    }
    if (command === '/recover') {
      const c = this.workspace.taskEngine;
      if (!args.length)
        this.show(
          c.state.tasks
            .filter((t) => ['interrupted', 'blocked'].includes(t.status) || t.recovery === 'uncertain')
            .map((t) => `${t.id} · ${t.recovery ?? '待核对'}\n${t.objective}\n/recover inspect ${t.id}`)
            .join('\n\n') || '没有需要恢复的任务',
        );
      else if (args[0] === 'inspect' && args[1])
        this.show(
          '只读事实核对；摘要相同也不能证明 Shell 或外部操作未发生。\n' +
            JSON.stringify(await c.recoveryFacts(args[1]), null, 2),
        );
      else if (args[0] === 'retry' && args[1] && args[2]) {
        this.show('');
        const task = await c.recover(args[1], paneId, args[2]);
        this.show(task ? `已创建恢复尝试 ${task.id}；/tasks 查看` : '已取消恢复，未创建新尝试');
      } else if (args[0] === 'keep' && args[1] && args[2]) {
        this.show('');
        const task = await c.recover(args[1], paneId, args[2], false);
        this.show(task ? '已记录人工核对，未自动重试或验收' : '已取消核对');
      } else if (args[0] === 'events') this.show(JSON.stringify(c.journal.events(), null, 2));
      else
        throw new Error(
          '用法：/recover [inspect <任务> | retry|keep <任务> "核对说明（至少 8 字）" | events]',
        );
      return true;
    }
    if (command === '/core') {
      const c = this.workspace.panes.get(paneId)?.controller;
      if (!c) throw new Error('会话不可用');
      if (args.length > 1)
        throw new Error('用法：/core [status|roles|workflow|coverage|events|instructions|off|observe]');
      if (args[0] === 'off' || args[0] === 'observe') {
        if (this.changing) throw new Error('设置正在更新，请稍候');
        this.changing = true;
        try {
          const mode = args[0];
          const latest = await this.update((config) => {
            config.core.mode = mode;
          });
          this.workspace.launch.appConfig.core = latest.core;
          for (const pane of this.workspace.panes.values())
            if (pane.controller) {
              pane.controller.launch.appConfig.core = structuredClone(latest.core);
              await pane.controller.core.setMode(mode);
            }
        } finally {
          this.changing = false;
        }
        this.show(c.core.describe());
      } else this.show(c.core.describe(args[0]));
      return true;
    }
    if (command === '/activity') {
      if (args.length) {
        if (
          args.length !== 2 ||
          !(
            (args[0] === 'color' && ['amber', 'gray'].includes(args[1])) ||
            (args[0] === 'motion' && ['reduced', 'normal'].includes(args[1]))
          )
        )
          throw new Error(
            '用法：/activity color amber（琥珀）或 gray（灰阶）；/activity motion reduced（减少动效）或 normal（正常）',
          );
        await this.update((c) => {
          if (args[0] === 'color') c.ui.activityColor = args[1] as 'amber' | 'gray';
          else c.ui.reducedMotion = args[1] === 'reduced';
        });
      }
      const ui = this.workspace.launch.appConfig.ui;
      this.show(
        ui.language === 'en'
          ? `Activity color: ${ui.activityColor}\nReduced motion: ${ui.reducedMotion}\n/activity color amber|gray\n/activity motion reduced|normal`
          : `状态颜色：${ui.activityColor === 'gray' ? '灰阶' : '柔和琥珀'}\n动效：${ui.reducedMotion ? '减少' : '正常'}\n\n/activity color gray：使用灰阶\n/activity color amber：使用柔和琥珀色\n/activity motion reduced：减少动效\n/activity motion normal：恢复动效\nNO_COLOR 环境变量开启时自动使用灰阶与静态提示。`,
      );
      return true;
    }
    if (command === '/instructions' || command === '/init') {
      const controller = this.workspace.panes.get(paneId)?.controller;
      if (!controller) throw new Error('会话不可用');
      const session = controller.id;
      if (command === '/init' && args[0] === 'apply') {
        this.workspace.overlay = '';
        this.workspace.taskPanel = false;
        this.workspace.changed();
      }
      const text = await controller.instructions.command(command, args);
      controller.notice =
        command === '/init'
          ? args[0] === 'apply'
            ? text
            : '草案尚未写入；/init apply 按当前权限保存，PgUp/PgDn 查看完整预览'
          : '规则来源已显示';
      controller.changed();
      if (this.workspace.focused === paneId && this.workspace.panes.get(paneId)?.controller?.id === session)
        this.show(text);
      return true;
    }
    if (command === '/permission') {
      const w = this.workspace,
        controller = w.panes.get(paneId)?.controller;
      if (!controller) throw new Error('会话不可用');
      if (!args.length) {
        w.emit('permission-menu', paneId);
        return true;
      }
      if (permissionModeSchema.safeParse(args[0]).success || ['next', 'revoke'].includes(args[0])) {
        await controller.command('/permission ' + args[0]);
        w.changed();
        return true;
      }
      if (args[0] !== 'rules') {
        const release = w.beginConfigurationChange();
        try {
          await this.update((c) => {
            if (args[0] === 'default')
              c.permissions.defaultMode = standardPermissionModeSchema.parse(args[1]);
            else if (args[0] === 'remove') {
              const n = Number(args[1]);
              if (!Number.isInteger(n) || n < 1 || n > c.permissions.rules.length)
                throw new Error('规则编号无效');
              c.permissions.rules.splice(n - 1, 1);
            } else if (args[0] === 'rule') {
              if (args.length > 5 || (args[3] && !['path', 'command'].includes(args[3])))
                throw new Error('规则范围只支持 path 或 command');
              c.permissions.rules.push(
                permissionRuleSchema.parse({
                  effect: args[1],
                  tool: args[2],
                  ...(args[3] ? { [args[3]]: args[4] } : {}),
                }),
              );
            } else
              throw new Error(
                '用法：/permission plan|ask|edit|auto|rage；rules；rule allow|ask|deny <工具> [path|command "范围"]；remove <编号>；default <常规模式>；revoke',
              );
          }, true);
        } finally {
          release();
        }
      }
      this.show(
        `默认模式：${w.launch.appConfig.permissions.defaultMode}\n` +
          w.launch.appConfig.permissions.rules.map((r, i) => `${i + 1}. ${JSON.stringify(r)}`).join('\n') +
          '\n优先级 deny > ask > 会话许可/模式默认。allow 规则仅在 auto 模式自动放行；Shell command 完全匹配。',
      );
      return true;
    }
    const commands = [
      '/settings',
      '/theme',
      '/language',
      '/bind',
      '/keys',
      '/statusbar',
      '/permissions',
      '/extensions',
      '/panel',
      '/template',
      '/capabilities',
      '/skills',
      '/skill',
      '/mcp',
      '/context',
      '/agents',
      '/models',
    ];
    if (!commands.includes(command)) return false;
    const w = this.workspace,
      pane = w.panes.get(paneId)!,
      controller = pane.controller;
    if (command === '/panel') {
      const sessionId = controller?.id,
        result = await w.extensions.panel(args[0], paneId);
      if (w.focused === paneId && w.panes.get(paneId)?.controller?.id === sessionId) this.show(result);
      return true;
    }
    if (this.changing) throw new Error('设置正在更新，请稍候');
    const disabling = command === '/extensions' && args[0] === 'disable';
    const runtimeChange =
      ((command === '/permissions' || command === '/mcp') && args.length > 0) ||
      (command === '/extensions' && args.length > 0 && args[0] !== 'list') ||
      (command === '/settings' && args[0] === 'reload');
    const release = runtimeChange ? w.beginConfigurationChange(!disabling) : undefined;
    this.changing = true;
    try {
      switch (command) {
        case '/settings': {
          if (args[0] === 'reload') {
            const latest = await loadConfig(w.launch.home);
            w.launch.appConfig.core = latest.core;
            w.launch.appConfig.orchestration = latest.orchestration;
            w.launch.appConfig.ui = latest.ui;
            w.launch.appConfig.toolPolicy = latest.toolPolicy;
            w.launch.appConfig.permissions = latest.permissions;
            for (const p of w.panes.values())
              if (p.controller) {
                p.controller.launch.appConfig.toolPolicy = structuredClone(latest.toolPolicy);
                p.controller.launch.appConfig.permissions = structuredClone(latest.permissions);
                p.controller.invalidatePermissions();
                p.controller.launch.appConfig.instructions = structuredClone(latest.instructions);
                p.controller.instructions.reconfigure();
                p.controller.launch.appConfig.core = structuredClone(latest.core);
                await p.controller.core.setMode(latest.core.mode);
              }
            w.launch.appConfig.instructions = latest.instructions;
            w.changed();
          }
          this.show(
            JSON.stringify(
              {
                ui: w.launch.appConfig.ui,
                toolPolicy: w.launch.appConfig.toolPolicy,
                instructions: w.launch.appConfig.instructions,
              },
              null,
              2,
            ) +
              '\n模型路由、Skill 目录和手动编辑的 MCP/扩展配置需重启；主题、快捷键、状态栏、语言、权限立即生效。' +
              '\n\n' +
              commandHelp(workspaceCommands(w, paneId), w.launch.appConfig.ui),
          );
          break;
        }
        case '/theme': {
          if (!args.length) {
            this.show(
              'Themes: dark · amber · light\nColors: background foreground accent border muted input warning\n' +
                JSON.stringify(w.launch.appConfig.ui, null, 2),
            );
            break;
          }
          await this.update((c) => {
            if (args[0] === 'color') {
              if (
                !['background', 'foreground', 'accent', 'border', 'muted', 'input', 'warning'].includes(
                  args[1],
                ) ||
                !args[2]
              )
                throw new Error('用法：/theme color accent #67e8f9');
              Object.assign(c.ui.colors, { [args[1]]: args[2] });
            } else if (args[0] === 'reset') {
              c.ui.theme = 'dark';
              c.ui.colors = {};
            } else {
              c.ui.theme = args[0] as AppConfig['ui']['theme'];
              c.ui.colors = {};
            }
          });
          w.notice = `Theme: ${w.launch.appConfig.ui.theme}`;
          w.changed();
          break;
        }
        case '/language':
          await this.update((c) => {
            c.ui.language = args[0] as AppConfig['ui']['language'];
          });
          w.notice = `Language: ${w.launch.appConfig.ui.language}`;
          w.changed();
          break;
        case '/bind':
        case '/keys': {
          if (args.length)
            await this.update((c) => {
              if (args[0] === 'reset') c.ui.keys = {};
              else {
                if (!actions.includes(args[0] as (typeof actions)[number]) || !args[1])
                  throw new Error('用法：/bind close F10；/bind reset 恢复默认');
                c.ui.keys[args[0] as (typeof actions)[number]] = args[1];
                c.ui = uiSchema.parse(c.ui);
              }
            });
          this.show(
            Object.entries(effectiveKeys(w.launch.appConfig.ui))
              .map(([action, key]) => `${action}: ${key}`)
              .join('\n') +
              '\nShift+Tab 默认切换权限；旧自定义绑定保留时自动使用空闲备用键。Ctrl+R 输入历史；Ctrl+P 命令；候选列表 Tab 补全。Ctrl+C 清空/停止/连按退出；Enter、Shift+Enter、Ctrl+A 保留给编辑器。',
          );
          break;
        }
        case '/statusbar':
          await this.update((c) => {
            if (args[0] === 'fields')
              c.ui.statusBar.fields = (args[1] ?? '').split(',') as AppConfig['ui']['statusBar']['fields'];
            else if (['on', 'off'].includes(args[0])) c.ui.statusBar.visible = args[0] === 'on';
            else throw new Error('用法：/statusbar on|off|fields project,model,tasks,context');
          });
          break;
        case '/permissions': {
          if (args.length) {
            await this.update((c) => {
              const policy = c.toolPolicy;
              if (args[0] === 'reset') {
                policy.deny = [];
                policy.confirm = [];
              } else if (args[0] === 'allow') {
                policy.deny = policy.deny.filter((n) => n !== args[1]);
                policy.confirm = policy.confirm.filter((n) => n !== args[1]);
              } else if (['deny', 'confirm'].includes(args[0]) && args[1]) {
                const list = policy[args[0] as 'deny' | 'confirm'];
                if (!list.includes(args[1])) list.push(args[1]);
              } else throw new Error('用法：/permissions deny|confirm|allow <工具名或前缀*>；reset');
            }, true);
          }
          this.show(
            JSON.stringify(w.launch.appConfig.toolPolicy, null, 2) +
              `\nShell mode: ${w.launch.appConfig.shellMode}\n本机命令默认需要确认，/permission 管理模式和精确许可。deny 优先于 confirm；allow 只删除同名旧规则。`,
          );
          break;
        }
        case '/extensions': {
          if (args.length && args[0] !== 'list') {
            let entry = w.launch.appConfig.extensions.find((e) => e.id === args[1]);
            if (args[0] === 'add') {
              entry = extensionSchema.parse({ id: args[1], module: args[2], enabled: false });
              if (w.launch.appConfig.extensions.some((e) => e.id === entry!.id))
                throw new Error('扩展 ID 已存在；请先停用，再编辑配置并重启');
              const item = entry;
              await this.update((c) => {
                c.extensions.push(item);
              });
              w.launch.appConfig.extensions.push(item);
            } else {
              if (!entry && args[1] === 'inspector' && args[0] === 'enable')
                entry = { id: 'inspector', module: 'builtin:inspector', enabled: false };
              if (!entry || !['enable', 'disable'].includes(args[0]))
                throw new Error('用法：/extensions enable|disable <id>；/extensions add <id> "绝对路径"');
              const item = entry,
                enabled = args[0] === 'enable';
              if (enabled) await w.extensions.enable(item);
              else await w.extensions.disable(item.id);
              try {
                await this.update((c) => {
                  const previous = c.extensions.find((e) => e.id === item.id);
                  if (previous) previous.enabled = enabled;
                  else c.extensions.push({ ...item, enabled });
                });
              } catch (error) {
                if (enabled) await w.extensions.disable(item.id);
                else await w.extensions.enable(item);
                throw error;
              }
              const previous = w.launch.appConfig.extensions.find((e) => e.id === item.id);
              if (previous) previous.enabled = enabled;
              else w.launch.appConfig.extensions.push({ ...item, enabled });
            }
          }
          this.show(w.extensions.describe());
          break;
        }
        case '/template': {
          if (!args.length || args[0] === 'list')
            this.show(
              (await listTemplates(w.launch.home)).join('\n') || '暂无模板；/template save my-workspace',
            );
          else if (args[0] === 'save') {
            await writeTemplate(w.launch.home, {
              version: 1,
              name: args[1],
              focused: w.focused,
              layout: w.layout,
              panes: [...w.panes.values()].map((p) => ({ id: p.id, cwd: p.cwd, modelId: p.modelId })),
              roles: { workers: [] },
            });
            this.show(`已保存模板 ${args[1]}：目录、模型、布局；加载时新建独立会话，保留旧历史。`);
          } else if (args[0] === 'load') {
            await w.applyTemplate(await readTemplate(w.launch.home, args[1]));
            this.show(`已载入模板 ${args[1]}，所有窗口使用新的独立会话。`);
          } else if (args[0] === 'delete') {
            await deleteTemplate(w.launch.home, args[1]);
            this.show('模板已删除，会话和项目文件不受影响');
          } else throw new Error('用法：/template list|save|load|delete <name>');
          break;
        }
        case '/capabilities':
          this.show(controller ? await controller.planning.describeCapabilities() : '会话不可用');
          break;
        case '/mcp': {
          if (args.length) {
            const server = w.launch.appConfig.mcp.find((s) => s.serverName === args[1]);
            if (!server || !['enable', 'disable'].includes(args[0]))
              throw new Error('用法：/mcp enable|disable <已配置的名称>');
            const enabled = args[0] === 'enable';
            if (enabled) await w.capabilities.enable(server);
            else await w.capabilities.disable(server.serverName);
            try {
              await this.update((c) => {
                const latest = c.mcp.find((s) => s.serverName === server.serverName);
                if (!latest) throw new Error('配置已变化，请重启');
                latest.enabled = enabled;
              });
            } catch (error) {
              if (enabled) await w.capabilities.disable(server.serverName);
              else await w.capabilities.enable(server);
              throw error;
            }
            server.enabled = enabled;
          }
          this.show(w.capabilities.describe());
          break;
        }
        case '/skills':
        case '/skill': {
          if (args[0] === 'add-dir') {
            if (!args[1]) throw new Error('请指定技能目录');
            const directory = resolve(pane.cwd, args[1]);
            if (!(await stat(directory)).isDirectory()) throw new Error('技能路径不是目录');
            await this.update((c) => {
              if (!c.skillDirs.includes(directory)) c.skillDirs.push(directory);
            });
            this.show('技能目录已保存，重启生效：' + directory);
            break;
          }
          if (!w.ctx.skills || !controller) throw new Error('当前 Harness 没有技能服务或会话不可用');
          const options = { cwd: pane.cwd, scope: controller.agent };
          if (args[0]) {
            const skill = await w.ctx.skills.get(args[0], options);
            if (!skill || !skill.invocation.userInvocable) throw new Error('技能不存在或禁止人工调用');
            if (command === '/skill') {
              controller.agent.inject(
                createUserMessage({
                  content: [{ type: 'text', text: renderSkillContent(skill) }],
                  source: { kind: 'skill-invocation', name: skill.name, form: 'instructions' },
                }),
              );
              await w.ctx.sessionPersistence.flush();
              this.show(`已为本窗口加载技能 ${skill.name}，下一次输入时使用`);
            } else this.show(`${skill.name} · ${skill.source}\n${skill.path ?? ''}\n\n${skill.content}`);
          } else
            this.show(
              (await w.ctx.skills.list(options))
                .map(
                  (s) =>
                    `${s.name} · ${s.source} · model:${s.invocation.modelInvocable} / user:${s.invocation.userInvocable}\n${s.description}\n${s.path ?? ''}`,
                )
                .join('\n\n') || '未发现技能；支持项目 .agents/skills、.deepseek/skills 和自定义目录',
            );
          break;
        }
        case '/context': {
          if (!controller) throw new Error('会话不可用');
          if (args[0] === 'note') {
            const text = args.slice(1).join(' ');
            if (!text || text.length > 32000) throw new Error('上下文补充需 1–32000 字符');
            controller.agent.inject(
              createUserMessage({
                content: [{ type: 'text', text }],
                source: { kind: 'emergence-context', label: 'user-note', form: 'instructions' },
              }),
            );
            await w.ctx.sessionPersistence.flush();
            this.show('已补充本窗口的上下文，不会自行唤醒模型');
          } else {
            const events = controller.agent.session.snapshotEvents();
            const info = {
              session: controller.id,
              model: controller.model.id,
              contextWindow: controller.model.contextWindow,
              maxTokens: controller.model.maxTokens,
              events: events.length,
              pendingContext: controller.agent.inbox.nextStep,
              pendingTurns: controller.agent.inbox.nextTurn.length,
              lastAssistant: events.findLast((e) => e.type === 'assistant/message')?.data,
              note: '窗口预算是配置声明；实际 usage 以供应商回执为准。完整历史仍由 Harness 管理。',
            };
            const text = safeError(JSON.stringify(info, null, 2));
            if (args[0] === 'export') {
              if (!args[1]) throw new Error('请指定导出文件');
              const path = resolve(pane.cwd, args[1]);
              await writeFile(
                path,
                safeError(JSON.stringify({ ...info, transcript: controller.transcript() }, null, 2)),
                { flag: 'wx', mode: 0o600 },
              );
              this.show('已导出脱敏快照：' + path);
            } else this.show(text);
          }
          break;
        }
        case '/agents': {
          if (!controller) throw new Error('会话不可用');
          const agents = w.ctx.agents.list().filter((a) => controller.owns(a));
          const runtime = w.ctx.get('subagents');
          const descendants = runtime ? await runtime.listDescendants(controller.agent.session.id) : [];
          if (args[0]) {
            const agent = agents.find((a) => a.id === args[1]);
            if (args[0] === 'stop') {
              if (!agent) throw new Error('该代理已释放，或不属于本窗口的活动代理');
              agent.cancel({ kind: 'user' });
              await agent.whenIdle();
              this.show('代理已停止：' + agent.id);
            } else if (args[0] === 'show') {
              if (agent)
                this.show(safeError(JSON.stringify(agent.session.snapshotEvents().slice(-30), null, 2)));
              else {
                if (!descendants.some((d) => d.kind === 'child' && d.id === args[1]))
                  throw new Error('只能读取本窗口子代理目录中的记录');
                const handle = await w.ctx.sessionPersistence.open(SessionId(args[1]), 'read');
                try {
                  this.show(JSON.stringify((await handle.read()).events.slice(-30), null, 2));
                } finally {
                  await handle.close();
                }
              }
            } else throw new Error('用法：/agents [show|stop <session-id>]');
          } else
            this.show(
              agents
                .map(
                  (a) =>
                    `${a.id} · ${a === controller.agent ? 'root' : 'subagent'} · ${a.status}\n${w.ctx.workingDirectory.get(a.session)}`,
                )
                .join('\n\n') +
                '\n\nsubagent catalog（已结束的代理不会重新启动）\n' +
                descendants
                  .map(
                    (d) =>
                      `${d.id} · ${d.kind === 'child' ? d.activity + ' · ' + d.mode : d.reason}\nparent: ${d.parentId} · depth: ${d.depth}`,
                  )
                  .join('\n\n'),
            );
          break;
        }
        case '/models':
          this.show(
            w.launch.appConfig.models
              .map(
                (m) =>
                  `${m.id} · ${m.provider}/${m.model}\n${m.api} · context ${m.contextWindow} · output ${m.maxTokens}\ntools: ${m.capabilities?.tools ?? 'unspecified'} · vision: ${m.capabilities?.vision ?? 'unspecified'}\nKey: ${process.env[m.apiKeyEnv] ? 'configured' : 'missing'}`,
              )
              .join('\n\n') + '\n能力为用户声明，未声明时交由适配器处理；切换保留历史，新配置路由重启生效。',
          );
          break;
      }
      return true;
    } finally {
      this.changing = false;
      release?.();
    }
  }
}
