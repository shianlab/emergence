import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { safeError } from '../core/adapters/redaction.ts';
import { replaceJsonFile } from '../core/storage/safe-json-file.ts';
import { TaskEngine } from '../core/application/task-engine.ts';
import { WorkspaceInteractions } from '../core/application/workspace-interactions.ts';
import { standardPermissionModeSchema, type PermissionMode } from '../core/domain/permissions.ts';
import type { TaskRecord } from '../core/domain/task.ts';
import { storedTaskStateSchema } from '../core/storage/task-history.ts';
import { emptyTaskState } from '../core/domain/task-state.ts';
import { rolePreferenceSchema } from '../core/domain/legacy-coordination.ts';
import { Capabilities } from './capabilities.ts';
import { SessionController } from './controller.ts';
import type { LaunchConfig } from './session-config.ts';
import { Extensions } from './extensions.ts';
import { integrationSchema, type IntegrationRecord } from './integration.ts';
import {
  ancestors,
  layoutSchema,
  leaves,
  removePane,
  resizeSplit,
  splitPane,
  type Layout,
} from './layout.ts';
import { Settings } from './settings.ts';
import { readTemplate, type WorkspaceTemplate } from './templates.ts';
import { executeWorkspaceCommand } from './workspace-commands.ts';
import type { UpdateService } from './updates/service.ts';

const paneSchema = z
  .object({
    id: z.string(),
    sessionId: z.string().optional(),
    cwd: z.string(),
    modelId: z.string(),
    permissionMode: standardPermissionModeSchema.optional(),
    rolePreference: rolePreferenceSchema.optional(),
    draft: z.string().max(100000),
    scrollTop: z.number().min(0),
  })
  .strict();
const workspaceSchema = z
  .object({
    version: z.literal(1),
    focused: z.string(),
    layout: layoutSchema,
    panes: z.array(paneSchema).min(1).max(16),
    collaboration: storedTaskStateSchema.optional(),
    integrations: z.array(integrationSchema).max(100).default([]),
  })
  .strict()
  .superRefine((data, ctx) => {
    const visible = leaves(data.layout),
      ids = data.panes.map((p) => p.id),
      sessions = data.panes.flatMap((p) => (p.sessionId ? [p.sessionId] : []));
    if (
      new Set(ids).size !== ids.length ||
      new Set(visible).size !== visible.length ||
      visible.some((id) => !ids.includes(id)) ||
      !visible.includes(data.focused) ||
      new Set(sessions).size !== sessions.length ||
      visible.length > 16
    )
      ctx.addIssue({ code: 'custom', message: '布局的窗格或会话关联无效' });
  });
async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw error;
    return join(await canonicalPath(dirname(path)), basename(path));
  }
}
export interface PaneState {
  id: string;
  controller?: SessionController;
  sessionId?: string;
  cwd: string;
  modelId: string;
  permissionMode?: PermissionMode;
  draft: string;
  scrollTop: number;
  error?: string;
}

export class WorkspaceController extends EventEmitter {
  readonly panes = new Map<string, PaneState>();
  layout!: Layout;
  focused = '';
  maximized = false;
  notice = '';
  overlay = '';
  taskPanel = false;
  openModelConfiguration?: () => Promise<void>;
  updates?: UpdateService;
  readonly taskEngine: TaskEngine;
  readonly interactions = new WorkspaceInteractions(this);
  readonly capabilities: Capabilities;
  readonly extensions: Extensions;
  readonly settings: Settings;
  applyingTemplate = false;
  configurationChange = false;
  integrations: IntegrationRecord[] = [];
  closed = false;
  private creating = 0;
  private closing?: Promise<void>;
  private initialization?: Promise<void>;
  private readonly operations = new Set<Promise<unknown>>();
  readonly mutating = new Set<string>();
  private readonly closingPanes = new Set<string>();
  readonly resuming = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private writes: Promise<void> = Promise.resolve();
  private readonly disposers: Array<() => void> = [];
  private readonly editing = new Map<string, { owner: string; agent: string; count: number }>();
  readonly path: string;
  constructor(
    readonly ctx: Context,
    readonly launch: LaunchConfig,
  ) {
    super();
    const key = createHash('sha256')
      .update(process.platform === 'win32' ? launch.cwd.toLowerCase() : launch.cwd)
      .digest('hex')
      .slice(0, 20);
    this.path = join(launch.home, 'workspaces', `${key}.json`);
    this.taskEngine = new TaskEngine(this);
    this.taskEngine.on('change', () => {
      if (this.taskPanel) this.overlay = this.taskEngine.describe();
    });
    this.capabilities = new Capabilities(ctx, launch.appConfig);
    this.extensions = new Extensions(this);
    this.settings = new Settings(this);
    this.disposers.push(
      ctx.on('tools/execute', async (exec, next) => {
        if (!exec.agent || !['write', 'edit'].includes(exec.name)) return next();
        const owner = [...this.panes.values()].find((p) => p.controller?.owns(exec.agent));
        if (!owner) return next();
        const args = exec.arguments;
        if (!args || typeof args !== 'object' || !('file_path' in args) || typeof args.file_path !== 'string')
          return next();
        const path = resolve(ctx.workingDirectory.get(exec.agent.session), args.file_path);
        const canonical = await canonicalPath(path);
        const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
        const active = this.editing.get(key);
        if (active && active.agent !== exec.agent.id)
          throw new Error(
            `文件正由窗格 ${active.owner} 的会话 ${active.agent} 修改，请等待后重新读取：${path}`,
          );
        const lock = active ?? { owner: owner.id, agent: exec.agent.id, count: 0 };
        lock.count++;
        this.editing.set(key, lock);
        try {
          const result = await next();
          for (const pane of this.panes.values())
            if (pane.id !== owner.id && pane.cwd === owner.cwd && pane.controller) {
              pane.controller.notice = `共享目录提醒：${owner.id} 刚操作 ${basename(path)}；修改前请重新读取`;
              pane.controller.changed();
            }
          return result;
        } finally {
          if (--lock.count === 0) this.editing.delete(key);
        }
      }),
    );
  }
  get current() {
    const pane = this.panes.get(this.focused);
    if (!pane) throw new Error('没有焦点窗格');
    return pane;
  }
  visible() {
    return leaves(this.layout);
  }
  changed() {
    if (!this.closed) {
      this.emit('change');
      this.scheduleSave();
    }
  }
  private scheduleSave() {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.save().catch((error) => {
        this.notice = '布局保存失败：' + safeError(error);
        this.emit('change');
      });
    }, 200);
  }
  private track<T>(operation: Promise<T>) {
    this.operations.add(operation);
    void operation.then(
      () => this.operations.delete(operation),
      () => this.operations.delete(operation),
    );
    return operation;
  }
  async exclusive(id: string, action: () => Promise<void>) {
    if (this.mutating.has(id)) throw new Error('该窗格正在切换或释放会话，请稍候');
    this.mutating.add(id);
    try {
      await action();
    } finally {
      this.mutating.delete(id);
      this.taskEngine.kick();
    }
  }
  available(id: string) {
    return !this.closed && !this.applyingTemplate && !this.configurationChange && !this.mutating.has(id);
  }
  beginConfigurationChange(requireIdle = true) {
    if (this.closed || this.applyingTemplate || this.configurationChange)
      throw new Error('工作台正在退出、加载模板或修改配置');
    if (requireIdle) this.assertIdle();
    this.configurationChange = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.configurationChange = false;
      this.taskEngine.kick();
    };
  }
  assertIdle() {
    if (
      this.closed ||
      this.applyingTemplate ||
      this.configurationChange ||
      this.creating ||
      this.mutating.size ||
      this.extensions.busy ||
      this.operations.size > 1 ||
      [...this.panes.values()].some(
        (p) =>
          p.controller?.busy ||
          p.controller?.pending ||
          (p.controller &&
            this.ctx.agents.list().some((a) => p.controller!.owns(a) && a.status === 'running')),
      )
    )
      throw new Error('请先等待所有窗口、子代理和扩展操作空闲，停止任务后再修改此设置');
    for (const p of this.panes.values()) this.taskEngine.assertMutable(p.id);
  }
  async applyTemplate(template: WorkspaceTemplate) {
    this.assertIdle();
    this.applyingTemplate = true;
    const staged = new Map<string, PaneState>();
    try {
      for (const entry of template.panes) {
        const pane: PaneState = { ...entry, draft: '', scrollTop: 0 };
        staged.set(pane.id, pane);
        await this.attach(pane);
      }
      if (this.closed) throw new Error('工作台正在退出');
      // Commit only after every new binding has opened; old sessions stay usable on staging failure.
      await this.save();
      try {
        const previous = await readFile(this.path, 'utf8');
        await writeFile(`${this.path}.before-template-${randomUUID()}.json`, previous, {
          flag: 'wx',
          mode: 0o600,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const previous = [...this.panes.values()];
      this.panes.clear();
      staged.forEach((p, id) => this.panes.set(id, p));
      this.layout = structuredClone(template.layout);
      this.focused = template.focused;
      this.maximized = false;
      this.overlay = '';
      this.taskPanel = false;
      this.taskEngine.state = emptyTaskState();
      this.integrations = [];
      this.changed();
      const results = await Promise.allSettled(previous.map((p) => p.controller?.close()));
      if (results.some((r) => r.status === 'rejected'))
        this.notice = '模板已加载，但旧会话释放发生错误，请检查日志';
      await this.save();
      this.changed();
    } catch (error) {
      if (![...staged.values()].some((p) => this.panes.get(p.id) === p))
        await Promise.allSettled([...staged.values()].map((p) => p.controller?.close()));
      throw error;
    } finally {
      this.applyingTemplate = false;
    }
  }
  updateView(id: string, draft: string, scrollTop: number) {
    const pane = this.panes.get(id);
    if (!pane || (pane.draft === draft && pane.scrollTop === scrollTop)) return;
    const oversized = draft.length > 100000;
    if (oversized) {
      draft = draft.slice(0, 100000);
      if (/[\uD800-\uDBFF]$/.test(draft)) draft = draft.slice(0, -1);
    }
    pane.draft = draft;
    pane.scrollTop = scrollTop;
    this.scheduleSave();
    if (oversized) {
      this.notice = '草稿超过 100000 字符，已保留前 100000 字符；长内容请保存为项目文件后引用';
      this.emit('change');
    }
  }
  async attach(pane: PaneState, resume?: string, explicitModel = false) {
    if (!(await stat(pane.cwd)).isDirectory()) throw new Error('项目目录无效');
    if (!this.launch.appConfig.models.some((m) => m.id === pane.modelId))
      throw new Error(`模型配置不存在：${pane.modelId}`);
    const controller = new SessionController(this.ctx, {
      ...this.launch,
      prompt: undefined,
      resume: undefined,
      cwd: pane.cwd,
      modelId: pane.modelId,
      permissionMode: pane.permissionMode ?? this.launch.permissionMode,
      explicitModel: !resume || explicitModel,
      appConfig: structuredClone(this.launch.appConfig),
      approvedCommands: [],
    });
    const childTasks = new WeakMap<Agent, TaskRecord>();
    controller.approvalScope = (agent) => {
      const task = childTasks.get(agent) ?? this.taskEngine.current(pane.id);
      if (!task || this.taskEngine.current(pane.id) !== task || task.cancelReason) return;
      return { taskId: task.id, runId: task.runId };
    };
    controller.memory.evidence = (task) => this.taskEngine.assurance.proof(task, pane.id);
    controller.planning.onExecute = (plan, model, signal) =>
      this.taskEngine.executePlan(pane.id, plan, model, signal);
    controller.planning.environment = () => ({
      mode: 'independent',
      currentWindow: pane.id,
      windows: [{ id: pane.id, controller, dispatchable: false }],
      mcp: this.capabilities.snapshot(),
    });
    controller.permissionConstraints = (agent) => {
      let task = agent && childTasks.get(agent);
      if (!task && agent && agent !== controller.agent) {
        const owner = this.ctx.agents
          .list()
          .find((parent) => childTasks.has(parent) && this.ctx.agents.isOwnedBy(agent.id, parent));
        if (owner) task = childTasks.get(owner);
      }
      task ??= this.taskEngine.current(pane.id);
      if (!task) return [];
      if (agent && agent !== controller.agent) childTasks.set(agent, task);
      const source = this.panes.get(task.issuer)?.controller;
      if (!source || source.id !== task.issuerSession || task.assessment || task.issuer !== task.target)
        return [{ ...controller.permissionSnapshot(), mode: 'plan', deny: ['*'] }];
      return [
        ...(task.permission ? [task.permission] : []),
        ...(task.targetPermission && (task.recoveryOf || task.repairOf) ? [task.targetPermission] : []),
        ...(task.rolePermission ? [task.rolePermission] : []),
        source.permissionSnapshot(),
      ];
    };
    try {
      await controller.open(resume);
      if (this.closed) throw new Error('工作台已退出，未保留新会话');
      if (!(await stat(controller.cwd)).isDirectory()) throw new Error('会话记录中的项目目录无效');
    } catch (error) {
      await controller.close();
      throw error;
    }
    pane.controller = controller;
    pane.sessionId = controller.id;
    pane.error = undefined;
    pane.modelId = controller.launch.modelId;
    pane.cwd = controller.cwd;
    controller.on('change', () => {
      pane.sessionId = controller.id;
      pane.cwd = controller.cwd;
      pane.modelId = controller.launch.modelId;
      pane.permissionMode = controller.permissionMode;
      this.emit('session-change', pane.id);
      this.scheduleSave();
    });
    controller.onRunTimeout = async (reason, kind) => {
      const task = this.taskEngine.current(pane.id);
      if (task) await this.taskEngine.budgets.expire(task, reason, kind);
      else await controller.cancel();
    };
    controller.on('exit', () => this.emit('exit'));
  }
  initialize() {
    if (this.initialization) return this.initialization;
    return (this.initialization = this.track(this.initializeWorkspace()));
  }
  private async initializeWorkspace() {
    if (this.closed) throw new Error('工作台正在退出');
    await this.capabilities.initialize();
    if (this.closed) throw new Error('工作台正在退出');
    await mkdir(this.launch.home, { recursive: true });
    await this.taskEngine.initializeJournal();
    const initializeExtensions = async () => {
      for (const e of this.launch.appConfig.extensions.filter((e) => e.enabled))
        try {
          await this.extensions.enable(e);
        } catch (error) {
          this.notice = `扩展 ${e.id} 加载失败：${safeError(error)}`;
        }
      if (this.capabilities.errors.size)
        this.notice += ` · ${this.capabilities.errors.size} 个 MCP 服务启动失败，/mcp 查看原因`;
    };
    if (this.launch.template) {
      // Validate before creating or restoring sessions.
      const template = await readTemplate(this.launch.home, this.launch.template);
      await this.applyTemplate(template);
      await this.taskEngine.journal.archive();
      this.taskEngine.activateJournal();
      await initializeExtensions();
      return;
    }
    if (!this.launch.fresh && !this.launch.resume) {
      let saved: z.infer<typeof workspaceSchema> | undefined;
      try {
        const raw = await readFile(this.path, 'utf8');
        if (raw.length > 32_000_000) throw new Error('布局文件过大');
        saved = workspaceSchema.parse(JSON.parse(raw));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          throw new Error(`无法读取布局：${safeError(error)}。可用 --fresh 重新开始，历史会话仍保留。`);
      }
      if (!saved && this.taskEngine.hasJournalHistory)
        throw new Error(
          '执行台账仍有历史任务，但布局缺失；请还原布局备份，或明确使用 --fresh 归档旧图后重新开始',
        );
      if (saved) {
        this.layout = saved.layout;
        this.focused = saved.focused;
        for (const entry of saved.panes) {
          const pane: PaneState = { ...entry };
          this.panes.set(pane.id, pane);
          const overrideModel = pane.id === saved.focused && this.launch.explicitModel === true;
          if (overrideModel) pane.modelId = this.launch.modelId;
          if (pane.id === saved.focused && this.launch.permissionMode)
            pane.permissionMode = this.launch.permissionMode;
          try {
            if (!pane.sessionId) throw new Error('该窗格没有已保存的会话，请用 /project 指定项目重新创建');
            await this.attach(pane, pane.sessionId, overrideModel);
          } catch (error) {
            pane.error = safeError(error);
          }
        }
        this.taskEngine.load(saved.collaboration);
        this.integrations = saved.integrations.map((record) =>
          record.status === 'merging'
            ? {
                ...record,
                status: 'needs_review',
                detail: '重启前的合并未确认完成，请检查 Git 状态；不会自动重试',
              }
            : record,
        );
        this.notice = '已恢复布局与会话记录，未重新执行任务';
        await initializeExtensions();
        this.changed();
        return;
      }
    }
    const pane: PaneState = {
      id: randomUUID().slice(0, 8),
      cwd: this.launch.cwd,
      modelId: this.launch.modelId,
      draft: '',
      scrollTop: 0,
    };
    await this.attach(pane, this.launch.resume);
    this.panes.set(pane.id, pane);
    this.layout = { kind: 'pane', pane: pane.id };
    this.focused = pane.id;
    await this.taskEngine.journal.archive();
    this.taskEngine.activateJournal();
    await initializeExtensions();
    this.changed();
  }
  focus(id: string) {
    if (!this.visible().includes(id)) throw new Error('该窗格已隐藏，请先 /show');
    this.focused = id;
    this.overlay = '';
    this.taskPanel = false;
    this.changed();
  }
  cycle(direction = 1) {
    const ids = this.visible();
    this.focus(ids[(ids.indexOf(this.focused) + direction + ids.length) % ids.length]);
  }
  find(value?: string) {
    const list = [...this.panes.values()];
    const pane = list.find((p) => p.id === value) ?? list[Number(value) - 1];
    if (!pane) throw new Error('窗格不存在，输入 /panes 查看');
    return pane;
  }
  split(axis: 'row' | 'column', cwd = this.current.cwd, modelId?: string, target = this.focused) {
    const defaults = this.launch.appConfig.windowModels;
    const selected =
      modelId ??
      defaults.slots[String(this.panes.size + this.creating + 1)] ??
      defaults.single ??
      this.current.modelId;
    return this.track(this.createPane(axis, cwd, selected, target));
  }
  private async createPane(axis: 'row' | 'column', cwd: string, modelId: string, target: string) {
    if (this.configurationChange) throw new Error('设置正在更新，请稍后再创建窗口');
    if (this.applyingTemplate) throw new Error('模板正在加载');
    if (this.closed) throw new Error('工作台正在退出');
    if (this.panes.size + this.creating >= 16)
      throw new Error('当前版本最多托管 16 个窗格，请先终止不需要的会话');
    this.creating++;
    const pane: PaneState = {
      id: randomUUID().slice(0, 8),
      cwd: resolve(cwd),
      modelId,
      draft: '',
      scrollTop: 0,
    };
    try {
      await this.attach(pane);
    } finally {
      this.creating--;
    }
    if (this.closed || !this.visible().includes(target)) {
      await pane.controller?.close();
      throw new Error('原窗格已隐藏或工作台已退出，请重新分屏');
    }
    this.panes.set(pane.id, pane);
    this.layout = splitPane(this.layout, target, pane.id, axis);
    this.focused = pane.id;
    this.maximized = false;
    this.changed();
    return pane;
  }
  hide(id = this.focused) {
    if (!this.visible().includes(id)) return;
    if (this.visible().length === 1) throw new Error('至少保留一个可见窗格；可先 /show 其他会话');
    this.layout = removePane(this.layout, id)!;
    if (this.focused === id) this.focused = this.visible()[0];
    this.maximized = false;
    this.changed();
  }
  show(id: string) {
    if (!this.visible().includes(id)) this.layout = splitPane(this.layout, this.focused, id, 'row');
    this.focused = id;
    this.maximized = false;
    this.overlay = '';
    this.changed();
  }
  resize(id: string, ratio: number) {
    this.layout = resizeSplit(this.layout, id, ratio);
    this.changed();
  }
  resizeFocused(axis: 'row' | 'column', delta: number) {
    const split = ancestors(this.layout, this.focused).findLast((s) => s.axis === axis);
    if (split) this.resize(split.id, split.ratio + delta);
  }
  send(id: string, text: string) {
    return this.track(this.dispatch(id, text));
  }
  closePane(id = this.focused) {
    return this.track(this.removeWindow(id));
  }
  private async removeWindow(id: string) {
    if (this.configurationChange) throw new Error('设置正在更新，请稍后再关闭窗口');
    if (this.applyingTemplate) throw new Error('模板正在加载');
    if (this.closed) throw new Error('工作台正在退出');
    const pane = this.panes.get(id);
    if (!pane || this.closingPanes.has(id)) return;
    if (this.panes.size - this.closingPanes.size <= 1)
      throw new Error('这是最后一个窗口；退出整个应用请按 Ctrl+C 或输入 /exit');
    this.closingPanes.add(id);
    try {
      await this.exclusive(id, async () => {
        this.notice = `正在关闭窗口 ${id}，停止相关任务…`;
        this.changed();
        await this.taskEngine.detach(id);
        await pane.controller?.close();
        const fallback = [...this.panes.keys()].find(
          (other) => other !== id && !this.closingPanes.has(other),
        )!;
        this.layout = removePane(this.layout, id) ?? { kind: 'pane', pane: fallback };
        this.panes.delete(id);
        if (!this.visible().includes(this.focused))
          this.focused = this.visible().find((other) => !this.closingPanes.has(other)) ?? this.visible()[0];
        this.maximized = false;
        this.overlay = '';
        this.taskPanel = false;
        this.notice = `已关闭窗口 ${id}；会话历史仍保留`;
        this.changed();
        await this.save();
      });
    } finally {
      this.closingPanes.delete(id);
    }
  }
  async cancelFocused() {
    const task = this.taskEngine.current(this.focused);
    if (task) await this.taskEngine.cancel(task.id);
    else await this.current.controller?.cancel();
  }
  private dispatch(id: string, text: string) {
    return executeWorkspaceCommand(this, id, text);
  }

  async save() {
    if (!this.layout) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    const data = {
      version: 1 as const,
      focused: this.focused,
      layout: this.layout,
      collaboration: this.taskEngine.state,
      integrations: this.integrations,
      panes: [...this.panes.values()].map((p) => {
        const mode = p.controller?.permissionMode ?? p.permissionMode;
        return {
          id: p.id,
          sessionId: p.controller?.id ?? p.sessionId,
          cwd: p.controller?.cwd ?? p.cwd,
          modelId: p.controller?.launch.modelId ?? p.modelId,
          permissionMode: mode === 'rage' ? undefined : mode,
          draft: p.draft,
          scrollTop: p.scrollTop,
        };
      }),
    };
    // Zod copies the snapshot before it enters the serialized write queue.
    const snapshot = workspaceSchema.parse(data);
    this.taskEngine.checkpoint();
    const writing = this.writes
      .catch(() => {})
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true });
        await replaceJsonFile(this.path, snapshot, {
          invalidMessage: '工作台状态路径不是普通文件，未覆盖',
          pretty: true,
          newline: true,
        });
      });
    this.writes = writing;
    await writing;
  }
  close() {
    if (this.closing) return this.closing;
    this.closed = true;
    clearTimeout(this.timer);
    this.closing = (async () => {
      await this.taskEngine.close();
      for (const pane of this.panes.values()) pane.controller?.cancelInteractions();
      const cleanup = await Promise.allSettled([this.extensions.close(), this.capabilities.close()]);
      await Promise.allSettled([...this.operations]);
      const results = await Promise.allSettled([
        this.save(),
        ...[...this.panes.values()].map((p) => p.controller?.close()),
      ]);
      this.disposers.forEach((dispose) => dispose());
      try {
        await this.ctx.sessionPersistence.flush();
      } finally {
        await this.taskEngine.journal.close();
      }
      this.removeAllListeners();
      const errors = [...results, ...cleanup].flatMap((r) => (r.status === 'rejected' ? [r.reason] : []));
      if (errors.length) throw new AggregateError(errors, '工作台保存或会话释放失败');
    })();
    return this.closing;
  }
}
