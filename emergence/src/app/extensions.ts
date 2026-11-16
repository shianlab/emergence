import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { readdir, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { safeError } from '../core/adapters/redaction.ts';
import { type AppConfig } from '../core/domain/configuration.ts';
import type { WorkspaceController } from './workspace.ts';

export interface ExtensionPane {
  id: string;
  cwd: string;
  modelId: string;
  sessionId?: string;
}
export interface ExtensionAPI {
  readonly signal: AbortSignal;
  current(): ExtensionPane;
  panes(): ExtensionPane[];
  command(
    name: string,
    run: (args: string[], pane: ExtensionPane, signal: AbortSignal) => string | Promise<string>,
  ): void;
  panel(name: string, render: (pane: ExtensionPane, signal: AbortSignal) => string | Promise<string>): void;
  tool(
    name: string,
    description: string,
    parameters: ToolDefinition['parameters'],
    run: (
      args: Record<string, unknown>,
      pane: ExtensionPane,
      signal: AbortSignal,
    ) => unknown | Promise<unknown>,
  ): void;
  effect(start: () => () => void | Promise<void>): void;
}
export interface ExtensionModule {
  activate(
    api: ExtensionAPI,
  ): void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
}
interface Active {
  abort: AbortController;
  dispose: Array<() => void | Promise<void>>;
  jobs: Set<Promise<unknown>>;
  commands: string[];
  panels: string[];
  tools: string[];
  startup?: Promise<void>;
  stopping?: Promise<void>;
}
const valid = (name: string) => {
  if (!/^[a-z][a-z0-9_]{0,31}$/.test(name)) throw new Error('扩展入口名称只能使用小写字母、数字和下划线');
  return name;
};
type Handler = (args: string[], pane: ExtensionPane, signal: AbortSignal) => string | Promise<string>;

/** Explicitly trusted, process-local extensions. No automatic discovery in project directories. */
export class Extensions {
  private readonly active = new Map<string, Active>();
  private readonly commands = new Map<string, { active: Active; run: Handler }>();
  private readonly panels = new Map<
    string,
    { active: Active; render: (pane: ExtensionPane, signal: AbortSignal) => string | Promise<string> }
  >();
  readonly errors = new Map<string, string>();
  private closed = false;
  constructor(readonly workspace: WorkspaceController) {}
  get busy() {
    return [...this.active.values()].some((a) => a.jobs.size > 0);
  }
  private pane(id: string): ExtensionPane {
    const p = this.workspace.panes.get(id);
    if (!p) throw new Error('扩展的来源窗口已关闭');
    return { id: p.id, cwd: p.cwd, modelId: p.modelId, sessionId: p.controller?.id };
  }
  private caller(id: string, agent: Agent): ExtensionPane {
    const selection = agent.model.current();
    return {
      id,
      cwd: this.workspace.ctx.workingDirectory.get(agent.session),
      sessionId: agent.session.id,
      modelId: selection?.provider ?? this.pane(id).modelId,
    };
  }
  private job<T>(
    active: Active,
    run: (signal: AbortSignal) => T | Promise<T>,
    borrowed?: AbortSignal,
  ): Promise<T> {
    const signal = borrowed ? AbortSignal.any([active.abort.signal, borrowed]) : active.abort.signal;
    const job = Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return run(signal);
      })
      .then((value) => {
        signal.throwIfAborted();
        return value;
      });
    active.jobs.add(job);
    void job.then(
      () => active.jobs.delete(job),
      () => active.jobs.delete(job),
    );
    return job;
  }
  async enable(config: AppConfig['extensions'][number], supplied?: ExtensionModule) {
    if (this.closed) throw new Error('扩展服务已关闭');
    if (this.active.has(config.id)) return;
    const prefix = valid(config.id);
    const active: Active = {
      abort: new AbortController(),
      dispose: [],
      jobs: new Set(),
      commands: [],
      panels: [],
      tools: [],
    };
    this.active.set(config.id, active);
    this.errors.delete(config.id);
    const check = () => active.abort.signal.throwIfAborted();
    const api: ExtensionAPI = {
      signal: active.abort.signal,
      current: () => {
        check();
        return this.pane(this.workspace.focused);
      },
      panes: () => {
        check();
        return [...this.workspace.panes.keys()].map((id) => this.pane(id));
      },
      command: (name, run) => {
        check();
        const key = `/x_${prefix}_${valid(name)}`;
        if (this.commands.has(key)) throw new Error(`重复扩展命令：${key}`);
        this.commands.set(key, { active, run });
        active.commands.push(key);
      },
      panel: (name, render) => {
        check();
        const key = `${prefix}.${valid(name)}`;
        if (this.panels.has(key)) throw new Error(`重复扩展面板：${key}`);
        this.panels.set(key, { active, render });
        active.panels.push(key);
      },
      tool: (name, description, parameters, run) => {
        check();
        const key = `ext_${prefix}_${valid(name)}`;
        const unregister = this.workspace.ctx.tools.register(
          {
            name: key,
            description,
            parameters,
            output: {
              schema: {},
              render: (_args, value) => [{ type: 'text', text: safeError(JSON.stringify(value)) }],
            },
            execute: (args, exec) => {
              const owner = [...this.workspace.panes.values()].find((p) => p.controller?.owns(exec.agent));
              if (!owner) throw new Error('扩展工具缺少所属窗口');
              const caller = this.caller(owner.id, exec.agent!);
              return this.job(
                active,
                (signal) => run(args as Record<string, unknown>, caller, signal),
                exec.signal,
              );
            },
          },
          { when: ({ agent }) => [...this.workspace.panes.values()].some((p) => p.controller?.owns(agent)) },
        );
        active.tools.push(key);
        active.dispose.push(unregister);
      },
      effect: (start) => {
        check();
        active.dispose.push(start());
      },
    };
    active.startup = (async () => {
      if (!supplied && config.module !== 'builtin:inspector' && !isAbsolute(config.module))
        throw new Error('本地扩展 module 必须是绝对路径');
      const module: ExtensionModule =
        supplied ??
        (config.module === 'builtin:inspector' ? inspector : await import(pathToFileURL(config.module).href));
      if (typeof module.activate !== 'function') throw new Error('扩展必须导出 activate(api)');
      const cleanup = await module.activate(api);
      if (cleanup) active.dispose.push(cleanup);
      check();
    })();
    try {
      await active.startup;
    } catch (error) {
      await this.disable(config.id).catch(() => {});
      this.errors.set(config.id, safeError(error));
      throw error;
    }
  }
  async disable(id: string) {
    const active = this.active.get(id);
    if (!active) return;
    if (active.stopping) return active.stopping;
    active.abort.abort(new Error('扩展已停用'));
    active.commands.forEach((key) => this.commands.delete(key));
    active.panels.forEach((key) => this.panels.delete(key));
    active.stopping = (async () => {
      await active.startup?.catch(() => {});
      const errors: unknown[] = [];
      // Unregister tools and stop producers before awaiting cooperative in-flight jobs.
      for (const dispose of active.dispose.reverse()) {
        try {
          await dispose();
        } catch (error) {
          errors.push(error);
        }
      }
      await Promise.allSettled([...active.jobs]);
      this.active.delete(id);
      if (errors.length) {
        this.errors.set(id, safeError(errors[0]));
        throw new AggregateError(errors, '扩展资源释放失败');
      }
    })();
    return active.stopping;
  }
  async command(name: string, args: string[], pane: string) {
    const entry = this.commands.get(name);
    if (!entry) return false;
    const result = await this.job(entry.active, (signal) => entry.run(args, this.pane(pane), signal));
    if (this.workspace.focused === pane && this.workspace.panes.has(pane)) {
      this.workspace.overlay = safeError(result);
      this.workspace.changed();
    } else {
      this.workspace.notice = `扩展命令 ${name} 完成（窗口 ${pane}）：${safeError(result).slice(0, 500)}`;
      this.workspace.changed();
    }
    return true;
  }
  async panel(name: string, pane: string) {
    const entry = this.panels.get(name);
    if (!entry) throw new Error('面板不存在：' + name);
    return safeError(await this.job(entry.active, (signal) => entry.render(this.pane(pane), signal)));
  }
  commandNames() {
    return [...this.commands.keys()];
  }
  describe() {
    return (
      this.workspace.launch.appConfig.extensions
        .map(
          (e) =>
            `${e.id} · ${this.active.has(e.id) ? 'active' : 'disabled'} · ${e.module}${this.errors.has(e.id) ? '\n' + this.errors.get(e.id) : ''}`,
        )
        .join('\n\n') +
      '\n\nCommands\n' +
      [...this.commands.keys()].join('\n') +
      '\nPanels\n' +
      [...this.panels.keys()].join('\n')
    );
  }
  async close() {
    this.closed = true;
    const results = await Promise.allSettled([...this.active.keys()].map((id) => this.disable(id)));
    const errors = results.filter((r) => r.status === 'rejected');
    if (errors.length) throw new Error('部分扩展释放失败');
  }
}

/** A real small extension: same data is available through command, panel and model tool. */
export const inspector: ExtensionModule = {
  activate(api) {
    let ticks = 0;
    api.effect(() => {
      const timer = setInterval(() => ticks++, 1000);
      timer.unref();
      return () => clearInterval(timer);
    });
    const inspect = async (pane: ExtensionPane, signal: AbortSignal) => {
      const files = await readdir(pane.cwd, { withFileTypes: true });
      signal.throwIfAborted();
      const git = await stat(join(pane.cwd, '.git')).then(
        () => true,
        () => false,
      );
      signal.throwIfAborted();
      return {
        project: pane.cwd,
        model: pane.modelId,
        session: pane.sessionId,
        entries: files.length,
        git,
        uptimeSeconds: ticks,
        names: files.slice(0, 40).map((f) => f.name),
      };
    };
    api.command('project', async (_args, pane, signal) =>
      JSON.stringify(await inspect(pane, signal), null, 2),
    );
    api.panel('project', async (pane, signal) => JSON.stringify(await inspect(pane, signal), null, 2));
    api.tool(
      'project_info',
      'Inspect the calling pane project directory, model and visible file names. Reads no credentials.',
      {},
      (_args, pane, signal) => inspect(pane, signal),
    );
  },
};
