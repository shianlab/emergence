import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { roles } from '../core/domain/orchestration.ts';
import { safeError } from '../core/adapters/redaction.ts';
import { formatCodePreview, formatCodeStatus } from './code-presentation.ts';
import { diagnose, formatDiagnosis } from './doctor.ts';
import { commandHelp, normalizeHelp, workspaceCommands } from './commands.ts';
import { performIntegration, prepareIntegration } from './integration.ts';
import { commandTokens } from './layout.ts';
import { modelConfigurationIntent } from './model-configuration.ts';
import type { PaneState, WorkspaceController } from './workspace.ts';
type CommandHost = Pick<
  WorkspaceController,
  | 'closed'
  | 'applyingTemplate'
  | 'panes'
  | 'emit'
  | 'configurationChange'
  | 'mutating'
  | 'openModelConfiguration'
  | 'notice'
  | 'changed'
  | 'listenerCount'
  | 'overlay'
  | 'taskPanel'
  | 'settings'
  | 'extensions'
  | 'launch'
  | 'taskEngine'
  | 'interactions'
  | 'find'
  | 'show'
  | 'integrations'
  | 'exclusive'
  | 'save'
  | 'split'
  | 'hide'
  | 'focus'
  | 'attach'
  | 'ctx'
  | 'visible'
  | 'maximized'
  | 'closePane'
  | 'resuming'
>;
/** One command execution path for keyboard, menus and slash input. */
export async function executeWorkspaceCommand(host: CommandHost, id: string, text: string) {
  if (host.closed) throw new Error('工作台正在退出');
  if (host.applyingTemplate) throw new Error('模板正在加载');
  const pane = host.panes.get(id);
  if (!pane) return;
  if (!pane.controller?.pending) text = normalizeHelp(text);
  if (text === '/exit') {
    host.emit('exit');
    return;
  }
  if (host.configurationChange && !pane.controller?.pending)
    throw new Error('设置正在更新，请稍后再提交任务');
  if (host.mutating.has(id)) throw new Error('该窗格正在切换或释放会话，请稍候');
  if (!pane.controller?.pending && (text === '/model-config' || modelConfigurationIntent(text))) {
    if (!host.openModelConfiguration)
      throw new Error('当前运行方式不支持可视化配置；请运行 emergence model-config');
    await host.openModelConfiguration();
    host.notice = '已打开模型配置窗口';
    host.changed();
    return;
  }
  if (text.startsWith('/')) {
    const [command, ...args] = commandTokens(text);
    if (
      [
        '/mode',
        '/dispatch',
        '/assign-role',
        '/team',
        '/window-role',
        '/assign',
        '/takeover',
        '/release',
      ].includes(command)
    )
      throw new Error('多窗口协同已移除；请在各窗口分别输入任务，使用 /split 分屏、/focus 切换。');
    if (command === '/approval') {
      const [requestId, version, action] = args;
      if (args.length !== 3 || !/^\d+$/.test(version) || !['allow', 'deny', 'cancel'].includes(action))
        throw new Error('用法：/approval <完整请求 ID> <版本> allow|deny|cancel；先用 /approvals 查看');
      const entry = host.interactions
        .list()
        .find((e) => e.ref.id === requestId && e.ref.version === Number(version));
      if (!entry || entry.request.kind !== 'permission') throw new Error('审批请求已过期或不是操作审批');
      const option = entry.request.options.find((o) => o.value === (action === 'allow' ? 'y' : 'n'));
      if (action !== 'cancel' && !option) throw new Error('该请求不支持此操作，请在所属窗口选择');
      host.interactions.respond(
        entry.ref,
        action === 'cancel' ? { action: 'cancel' } : { action: 'submit', selected: [option!.id] },
      );
      host.notice = `审批 ${requestId}：${action === 'allow' ? '已允许本次' : action === 'deny' ? '已拒绝' : '已取消'}`;
      host.changed();
      return;
    }
    if (command === '/approvals') {
      if (args.length) throw new Error('用法：/approvals');
      if (host.listenerCount('navigation')) host.emit('navigation', id, 'approvals', '');
      else {
        host.overlay =
          host.interactions
            .list()
            .map(
              (e) =>
                `${e.ref.id} v${e.ref.version} · 窗口 ${e.ref.pane} · ${e.ready ? '待处理' : '队列中'}\n${e.project}\n${e.request.title}`,
            )
            .join('\n\n') || '暂无待确认请求';
        host.changed();
      }
      return;
    }
    if (command === '/view') {
      if (
        !['raw', 'render', 'tools', 'more', 'latest', 'context'].includes(args[0]) ||
        args.length > 2 ||
        (args[1] !== undefined && !/^\d+$/.test(args[1]))
      )
        throw new Error('用法：/view raw|render|tools|more [消息序号] 或 /view latest|context');
      if (!host.listenerCount('message-view-command'))
        throw new Error('/view 仅适用于交互界面；自动化输出使用 --print 或 /context export');
      host.overlay = '';
      host.taskPanel = false;
      host.emit('message-view-command', id, args[0], args[1] === undefined ? undefined : Number(args[1]));
      host.changed();
      return;
    }
    if (!['/tasks', '/task', '/dispatch'].includes(command)) host.taskPanel = false;
    if (
      host.listenerCount('navigation') &&
      ['/history', '/model', '/tasks'].includes(command) &&
      (command === '/history' || !args.length)
    ) {
      if (pane.controller?.pending) throw new Error('请先完成当前确认');
      host.emit(
        'navigation',
        id,
        ({ '/history': 'history', '/model': 'models', '/tasks': 'tasks' } as Record<string, string>)[command],
        args.join(' '),
      );
      return;
    }
    if (await host.settings.handle(command, args, id)) return;
    if (await host.extensions.command(command, args, id)) return;
    if (command === '/help') {
      host.notice =
        host.launch.appConfig.ui.language === 'en'
          ? 'Help · PgUp/PgDn scroll · Esc back'
          : '使用帮助 · PgUp/PgDn 翻页 · Esc 返回';
      host.overlay = commandHelp(workspaceCommands(host, id), host.launch.appConfig.ui);
      host.changed();
      return;
    }
    switch (command) {
      case '/doctor': {
        if (args.length) throw new Error('用法：/doctor；检查当前窗口的项目与运行环境');
        const cwd = pane.cwd;
        const report = await diagnose(host.launch.home, cwd);
        if (host.closed || host.panes.get(id) !== pane || pane.cwd !== cwd) return;
        host.overlay = safeError(formatDiagnosis(report));
        host.changed();
        return;
      }
      case '/code': {
        if (!pane.controller) throw new Error('请先打开一个会话');
        if (pane.controller.pending) throw new Error('请先完成当前确认');
        if (!(
          !args.length ||
          (args.length === 1 && args[0] === 'status') ||
          (args.length === 2 && args[0] === 'preview')
        ))
          throw new Error('用法：/code [status] 或 /code preview "文件路径"');
        const controller = pane.controller;
        const agent = controller.agent;
        const cwd = pane.cwd;
        const work = await controller.codeWork.get(agent);
        const content =
          args[0] === 'preview'
            ? formatCodePreview(await work.preview(args[1]))
            : formatCodeStatus(await work.status(AbortSignal.timeout(10000)));
        if (
          host.closed ||
          host.panes.get(id)?.controller !== controller ||
          pane.cwd !== cwd ||
          controller.agent !== agent
        )
          return;
        host.overlay = safeError(content);
        host.changed();
        return;
      }
      case '/roles':
        host.overlay = JSON.stringify(roles(host.launch.appConfig.orchestration), null, 2);
        host.changed();
        return;
      case '/tasks':
        host.taskPanel = true;
        host.overlay = host.taskEngine.describe();
        host.changed();
        return;
      case '/task': {
        if (args[0] === 'show' && host.listenerCount('task-inspect')) {
          host.taskEngine.task(args[1]);
          host.taskPanel = false;
          host.overlay = '';
          host.emit('task-inspect', id, args[1]);
          host.changed();
          return;
        }
        if (args[0] === 'focus') {
          const target = host.taskEngine.task(args[1]).target;
          host.show(target);
        } else if (args[0] === 'show') {
          host.taskPanel = false;
          host.overlay = host.taskEngine.describe(args[1]);
        } else if (args[0] === 'cancel') await host.taskEngine.cancel(args[1]);
        else if (args[0] === 'accept' || args[0] === 'reject')
          await host.taskEngine.review(args[1], args[0] === 'accept', args.slice(2).join(' '));
        else if (args[0] === 'repair') await host.taskEngine.repair(args[1], args.slice(2).join(' '));
        else if (args[0] === 'note') await host.taskEngine.note(args[1], args.slice(2).join(' '));
        else throw new Error('用法：/task cancel <任务ID> 或 /task note <任务ID> "补充指令"');
        host.changed();
        return;
      }
      case '/integrations':
        host.overlay =
          host.integrations
            .map(
              (r) =>
                `${r.id} ${r.status}\n${r.sourceCwd} → ${r.targetCwd}\ncommit ${r.commit}\n${r.detail}${r.conflicts.length ? '\n冲突文件：' + r.conflicts.join(', ') : ''}`,
            )
            .join('\n\n') || '暂无成果整合记录';
        host.changed();
        return;
      case '/integrate': {
        if (!args[0]) throw new Error('用法：在目标窗口输入 /integrate <源工作树窗口编号>');
        const source = host.find(args[0]);
        host.taskEngine.assertMutable(source.id);
        host.taskEngine.assertMutable(id);
        if (source.controller?.busy || pane.controller?.busy || !source.controller || !pane.controller)
          throw new Error('源和目标窗口必须可用且空闲');
        if (host.integrations.length >= 100) throw new Error('整合记录已达上限，请使用新工作台');
        await host.exclusive(id, async () =>
          host.exclusive(source.id, async () => {
            const record = await prepareIntegration(source, pane);
            host.integrations.push(record);
            await host.save();
            await performIntegration(record);
            const latest = host.taskEngine.state.tasks.findLast(
              (t) => t.target === source.id && t.targetSession === source.controller?.id,
            );
            if (record.status === 'merged' && latest && latest.status !== 'succeeded') {
              record.status = 'needs_review';
              record.detail =
                `Git 已整合，但源任务 ${latest.id} 状态为 ${latest.status}，验证尚未通过。\n${record.detail}`.slice(
                  0,
                  8000,
                );
            }
            await host.save();
            host.notice = `成果整合 ${record.status}：${record.id}；/integrations 查看`;
            host.changed();
          }),
        );
        return;
      }
      case '/split':
        await host.split(
          args[0] === 'down' ? 'column' : 'row',
          args[1] ? resolve(pane.cwd, args[1]) : pane.cwd,
          args[2],
          id,
        );
        return;
      case '/hide':
        host.hide(args[0] ? host.find(args[0]).id : id);
        return;
      case '/show':
        host.show(host.find(args[0]).id);
        return;
      case '/focus':
        host.focus(host.find(args[0]).id);
        return;
      case '/model':
        if (!args[0]) {
          host.overlay = host.launch.appConfig.models
            .map((m) => `${m.id} · ${m.provider}/${m.model}\n${m.api} · /model ${m.id}`)
            .join('\n\n');
          host.changed();
          return;
        } else if (!pane.controller) {
          if (!host.launch.appConfig.models.some((m) => m.id === args[0]))
            throw new Error('模型配置不存在；用 /model 查看');
          await host.exclusive(id, async () => {
            pane.modelId = args[0];
            await host.attach(pane, pane.sessionId, true);
            host.changed();
          });
          return;
        }
        break;
      case '/sessions': {
        const sessions = await host.ctx.sessionPersistence.list();
        host.overlay =
          sessions.map((s) => `${s.header.id}\n${s.header.cwd ?? ''}`).join('\n\n') || '没有保存的会话';
        host.changed();
        return;
      }
      case '/tools':
        if (pane.controller) {
          host.overlay = host.ctx.tools
            .definitions(pane.controller.agent)
            .map((t) => t.name)
            .join('\n');
          host.changed();
          return;
        }
        break;
      case '/panes':
        host.overlay = [...host.panes.values()]
          .map(
            (p, i) =>
              `${i + 1}. ${p.id} ${host.visible().includes(p.id) ? '可见' : '后台'} ${p.controller?.pending ? '待确认' : p.controller?.busy ? '运行' : p.error ? '恢复失败' : '空闲'}\n${p.cwd} · ${p.modelId}${p.error ? '\n' + p.error : ''}`,
          )
          .join('\n\n');
        host.changed();
        return;
      case '/maximize':
        host.maximized = !host.maximized;
        host.changed();
        return;
      case '/project': {
        host.taskEngine.assertMutable(id);
        if (!args[0]) throw new Error('用法：/project "项目路径"');
        if (pane.controller?.busy) throw new Error('请先停止当前任务，或用 /split 打开另一个项目');
        const replacement: PaneState = {
          ...pane,
          cwd: resolve(pane.cwd, args[0]),
          controller: undefined,
          sessionId: undefined,
          draft: '',
          scrollTop: 0,
        };
        await host.exclusive(id, async () => {
          await host.attach(replacement);
          if (host.closed) {
            await replacement.controller?.close();
            throw new Error('工作台正在退出');
          }
          await pane.controller?.close();
          host.panes.set(id, replacement);
          host.changed();
        });
        return;
      }
      case '/retry':
        if (pane.error)
          await host.exclusive(id, async () => {
            await host.attach(pane, pane.sessionId);
            host.changed();
          });
        return;
      case '/close':
      case '/terminate':
        await host.closePane(args[0] ? host.find(args[0]).id : id);
        return;
      case '/worktree': {
        if (!args[0]) throw new Error('用法：/worktree "新 worktree 的目录"');
        const target = resolve(pane.cwd, args[0]);
        await promisify(execFile)('git', ['worktree', 'add', '--detach', target, 'HEAD'], {
          cwd: pane.cwd,
          windowsHide: true,
          timeout: 30000,
        });
        await host.split('row', target, pane.modelId, id);
        return;
      }
    }
  }
  if (!pane.controller) throw new Error(pane.error ?? '会话不可用；使用 /retry 或 /project 恢复');
  if (/^\/resume(?:\s|$)/.test(text)) {
    host.taskEngine.assertMutable(id);
    const resume = commandTokens(text)[1];
    if (!resume) throw new Error('用法：/resume <会话ID>');
    if (
      host.resuming.has(resume) ||
      [...host.panes.values()].some((p) => p.id !== id && p.sessionId === resume)
    )
      throw new Error('该会话已绑定其他窗格，请切换到对应窗格');
    host.resuming.add(resume);
    try {
      await host.exclusive(id, async () => {
        await pane.controller!.send(`/resume ${resume}`);
        host.changed();
      });
    } finally {
      host.resuming.delete(resume);
    }
    return;
  }
  if (/^\/(new|resume|model)(?:\s|$)/.test(text)) {
    host.taskEngine.assertMutable(id);
    await host.exclusive(id, async () => {
      await pane.controller!.send(text);
      host.changed();
    });
    return;
  }
  if (!pane.controller.pending && !text.startsWith('/') && host.taskEngine.current(id))
    throw new Error('该窗口正在执行任务；用 /task note 补充，或 /task cancel 取消');
  host.overlay = '';
  host.taskPanel = false;
  await pane.controller.send(text);
  host.changed();
}
