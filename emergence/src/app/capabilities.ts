import type { Context } from '@deepseek-ai/cordis';
import * as MCP from '@deepseek-ai/dsh-mcp-client';
import type {} from '@deepseek-ai/dsh-skill';
import { safeError } from '../core/adapters/redaction.ts';
import { type AppConfig } from '../core/domain/configuration.ts';
import type { Capability } from '../core/domain/planning.ts';
interface ServerState {
  fiber: { dispose(): void | Promise<void> };
  phase: 'starting' | 'active' | 'stopping';
  ready: Promise<void>;
  stopping?: Promise<void>;
}

/** One owner for MCP fibers, with failure isolation and explicit shutdown. */
export class Capabilities {
  private readonly servers = new Map<string, ServerState>();
  private closed = false;
  private closing?: Promise<void>;
  readonly errors = new Map<string, string>();
  constructor(
    readonly ctx: Context,
    readonly config: AppConfig,
  ) {}
  async initialize() {
    for (const server of this.config.mcp.filter((m) => m.enabled)) {
      if (this.closed) break;
      try {
        await this.enable(server);
      } catch (error) {
        if (!this.closed) this.errors.set(server.serverName, safeError(error));
      }
    }
  }
  async enable(server: AppConfig['mcp'][number]): Promise<void> {
    if (this.closed) throw new Error('MCP 服务已关闭');
    const previous = this.servers.get(server.serverName);
    if (previous?.stopping) {
      await previous.stopping;
      return this.enable(server);
    }
    if (previous) return previous.ready;
    this.errors.delete(server.serverName);
    const { enabled: _, ...input } = server;
    const fiber = this.ctx.plugin(MCP, MCP.Config({ ...input, failOnStartupError: true }));
    const state: ServerState = { fiber, phase: 'starting', ready: Promise.resolve() };
    this.servers.set(server.serverName, state);
    state.ready = (async () => {
      try {
        await fiber;
        if (this.closed || state.phase === 'stopping') throw new Error('MCP 服务启动已停止');
        state.phase = 'active';
      } catch (error) {
        await fiber.dispose();
        if (this.servers.get(server.serverName) === state) this.servers.delete(server.serverName);
        if (!this.closed && state.phase !== 'stopping') this.errors.set(server.serverName, safeError(error));
        throw error;
      }
    })();
    return state.ready;
  }
  async disable(name: string) {
    const state = this.servers.get(name);
    if (!state) {
      this.errors.delete(name);
      return;
    }
    if (state.stopping) return state.stopping;
    state.phase = 'stopping';
    state.stopping = (async () => {
      const [disposed] = await Promise.allSettled([state.fiber.dispose(), state.ready]);
      if (disposed.status === 'rejected') {
        state.stopping = undefined;
        throw disposed.reason;
      }
      if (this.servers.get(name) === state) this.servers.delete(name);
      this.errors.delete(name);
    })();
    return state.stopping;
  }
  describe() {
    return (
      this.config.mcp
        .map(
          (s) =>
            `${s.serverName} · ${this.servers.get(s.serverName)?.phase ?? (s.enabled ? 'error' : 'disabled')}${this.errors.has(s.serverName) ? '\n' + this.errors.get(s.serverName) : ''}`,
        )
        .join('\n\n') ||
      '没有配置 MCP；在 config.json 的 mcp 中添加 stdio server，重启后可 /mcp enable|disable <名称>'
    );
  }
  snapshot(): Capability[] {
    return this.config.mcp.map((s) => ({
      id: 'mcp:' + s.serverName,
      kind: 'mcp',
      registered: true,
      connected: this.servers.get(s.serverName)?.phase === 'active',
      callable: false,
      verified: false,
      detail: `${this.servers.get(s.serverName)?.phase ?? (this.errors.has(s.serverName) ? 'error' : 'disabled')}；服务本身不是工具，请选择已注册的 mcp-tool`,
    }));
  }
  close() {
    if (this.closing) return this.closing;
    this.closed = true;
    return (this.closing = (async () => {
      const results = await Promise.allSettled([...this.servers.keys()].map((name) => this.disable(name)));
      if (results.some((r) => r.status === 'rejected')) throw new Error('MCP 断开失败');
    })());
  }
}
