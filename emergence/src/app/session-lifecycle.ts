import type { Context } from '@deepseek-ai/cordis';
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent';
import { SessionId } from '@deepseek-ai/dsh-session';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { safeError } from '../core/adapters/redaction.ts';
import { acquireLease, canonicalDirectory } from '../core/storage/lease.ts';
import { replaceJsonFile } from '../core/storage/safe-json-file.ts';
import type { LaunchConfig } from './session-config.ts';
import { assertModelHistory } from './session-model.ts';

interface SessionBindingHooks {
  beforeSwitch(): void;
  resetAccess(): void;
  bind(agent: Agent): Promise<void>;
  bindChild(agent: Agent): void;
  resetDisplay(): void;
  stopping(active: boolean): void;
  cancelling(): void;
  cancelInteractions(): void;
  notice(text: string): void;
  error(error: unknown): void;
  changed(): void;
}

/** Owns the root handle, descendant leases and transition/close barriers. */
export class SessionLifecycle {
  private handle?: AgentHandle;
  private releaseSession?: () => Promise<void>;
  private readonly childLeases = new Map<Agent, () => Promise<void>>();
  private readonly childJobs = new Set<Promise<void>>();
  private readonly disposers: Array<() => void>;
  private opening?: Promise<void>;
  private closing?: Promise<void>;
  private cancellation?: Promise<void>;
  private ended = false;

  constructor(
    private ctx: Context,
    private launch: LaunchConfig,
    private hooks: SessionBindingHooks,
  ) {
    this.disposers = [
      ctx.on('agent/created', async ({ agent }) => {
        if (!this.current || agent === this.current || !this.owns(agent)) return;
        await this.trackChild(
          (async () => {
            const release = await acquireLease(
              `session:${await canonicalDirectory(launch.home)}:${agent.id}`,
              '该子代理会话',
            );
            if (this.closed || !this.owns(agent) || !ctx.agents.list().includes(agent)) await release();
            else {
              this.childLeases.set(agent, release);
              this.hooks.bindChild(agent);
            }
          })(),
        );
      }),
      ctx.on('agent/disposed', ({ agent }) => {
        const release = this.childLeases.get(agent);
        if (!release) return;
        this.childLeases.delete(agent);
        return this.trackChild(release());
      }),
    ];
  }
  get current() {
    return this.handle?.agent;
  }
  get closed() {
    return this.ended;
  }
  get switching() {
    return !!this.opening;
  }
  get busy() {
    // Schedulers and configuration clients must not use a partially bound session.
    return this.closed || this.switching || !!this.cancellation || this.current?.status === 'running';
  }
  get cwd() {
    return this.current ? this.ctx.workingDirectory.get(this.current.session) : this.launch.cwd;
  }
  owns(agent?: Agent): boolean {
    if (!agent || !this.current || this.closed) return false;
    const roots = [this.current],
      seen = new Set<Agent>(),
      candidates = this.ctx.agents.list();
    for (const owner of roots) {
      if (owner === agent) return true;
      if (seen.has(owner)) continue;
      seen.add(owner);
      for (const child of candidates)
        if (!seen.has(child) && this.ctx.agents.isOwnedBy(child.id, owner)) roots.push(child);
    }
    return false;
  }
  private trackChild(job: Promise<void>) {
    this.childJobs.add(job);
    void job.then(
      () => this.childJobs.delete(job),
      (error) => {
        this.childJobs.delete(job);
        this.hooks.error(error);
      },
    );
    return job;
  }
  assertReady() {
    if (this.closed) throw new Error('会话正在关闭');
    if (this.switching) throw new Error('会话正在切换，请稍后重试');
  }
  open(resume?: string): Promise<void> {
    this.assertReady();
    this.hooks.beforeSwitch();
    if (this.busy) throw new Error('请先等当前任务完成或按 Esc 停止');
    if (resume !== undefined && resume === this.current?.session.id) return Promise.resolve();
    const job = this.replace(resume);
    this.opening = job;
    void job.then(
      () => {
        this.opening = undefined;
      },
      () => {
        this.opening = undefined;
      },
    );
    return job;
  }
  private async replace(resume?: string) {
    const oldHandle = this.handle,
      oldLease = this.releaseSession,
      oldCwd = this.launch.cwd,
      oldModel = this.launch.modelId;
    const configured = this.launch.appConfig.models.find((model) => model.id === oldModel)!;
    const options = { agentOptions: { provider: configured.id, model: configured.model } };
    const id = resume ?? randomUUID();
    const release = await acquireLease(
      `session:${await canonicalDirectory(this.launch.home)}:${id}`,
      '该历史会话',
    );
    let candidate: AgentHandle | undefined;
    let adopted = false;
    try {
      if (this.closed) throw new Error('会话正在关闭');
      candidate = resume
        ? await this.ctx.agents.resume({
            resumeSessionId: SessionId(resume),
            ...options,
            setup: (_ctx, agent) => {
              for (const message of [...agent.inbox.nextTurn, ...agent.inbox.nextStep])
                if (['emergence-task', 'emergence-note', 'emergence-receipt'].includes(message.source.kind))
                  agent.inbox.remove(message.id);
            },
          })
        : await this.ctx.agents.create({ sessionId: SessionId(id), meta: { cwd: this.cwd }, ...options });
      await this.ctx.sessionPersistence.flush();
      if (this.closed) throw new Error('会话正在关闭');
      let model = configured;
      if (resume && !this.launch.explicitModel) {
        const selection = candidate.agent.model.current();
        const saved = this.launch.appConfig.models.find(
          (m) => m.id === selection?.provider && m.model === selection.model,
        );
        if (!saved) throw new Error('原会话的模型配置已不存在，请用 --model 指定配置后恢复');
        model = saved;
      }
      if (resume) {
        assertModelHistory(model, candidate.agent.session.snapshotEvents(), [
          ...candidate.agent.inbox.nextStep,
          ...candidate.agent.inbox.nextTurn,
        ]);
        if (this.launch.explicitModel)
          candidate.agent.model.select({ provider: model.id, model: model.model });
      }
      this.hooks.resetAccess();
      this.handle = candidate;
      this.launch.modelId = model.id;
      this.launch.cwd = candidate.agent.session.header.cwd ?? oldCwd;
      adopted = true;
      await this.hooks.bind(candidate.agent);
      if (this.closed) throw new Error('会话正在关闭');
      await replaceJsonFile(
        join(this.launch.home, 'last-session.json'),
        { id: this.current!.session.id, cwd: this.cwd },
        { invalidMessage: '最近会话路径不是普通文件，未覆盖' },
      );
      this.releaseSession = release;
    } catch (error) {
      const errors = [error];
      if (adopted) {
        this.handle = oldHandle;
        this.launch.cwd = oldCwd;
        this.launch.modelId = oldModel;
        this.hooks.resetAccess();
        if (oldHandle && !this.closed)
          try {
            await this.hooks.bind(oldHandle.agent);
          } catch (rebindError) {
            errors.push(rebindError);
          }
      }
      try {
        await candidate?.dispose();
      } catch (disposeError) {
        errors.push(disposeError);
      }
      try {
        await release();
      } catch (releaseError) {
        errors.push(releaseError);
      }
      this.hooks.resetDisplay();
      if (errors.length === 1) throw error;
      throw new AggregateError(errors, '会话切换失败，资源收尾存在错误');
    }
    try {
      await oldHandle?.dispose();
    } catch (error) {
      this.hooks.notice('先前会话释放失败：' + safeError(error));
    } finally {
      await oldLease?.();
    }
    this.hooks.resetDisplay();
    this.hooks.changed();
  }
  cancel(): Promise<void> {
    if (this.cancellation) return this.cancellation;
    const job = (async () => {
      this.hooks.cancelling();
      this.hooks.cancelInteractions();
      const agent = this.current;
      if (!agent) return;
      this.hooks.stopping(true);
      this.hooks.changed();
      try {
        agent.cancel({ kind: 'user' });
        await agent.whenIdle();
        this.hooks.resetDisplay();
        this.hooks.notice('已停止当前任务');
      } finally {
        this.hooks.stopping(false);
        this.hooks.changed();
      }
    })();
    this.cancellation = job;
    const settled = () => {
      this.cancellation = undefined;
      this.hooks.changed();
    };
    void job.then(settled, settled);
    return job;
  }
  close(
    resources: {
      beforeDispose: Array<() => void | Promise<void>>;
      afterDispose: Array<() => void | Promise<void>>;
    },
    disposers: Array<() => void>,
  ): Promise<void> {
    if (this.closing) return this.closing;
    this.ended = true;
    this.hooks.cancelInteractions();
    this.closing = (async () => {
      const errors: unknown[] = [];
      const attempt = async (action: () => unknown) => {
        try {
          await action();
        } catch (error) {
          errors.push(error);
        }
      };
      // An opening operation observes closed and disposes its candidate before teardown proceeds.
      await this.opening?.catch(() => {});
      await attempt(() => this.cancel());
      for (const settle of resources.beforeDispose) await attempt(settle);
      await attempt(() => this.ctx.sessionPersistence.flush());
      await attempt(() => this.handle?.dispose());
      for (const settle of resources.afterDispose) await attempt(settle);
      while (this.childJobs.size) {
        const settled = await Promise.allSettled([...this.childJobs]);
        for (const result of settled) if (result.status === 'rejected') errors.push(result.reason);
      }
      for (const release of this.childLeases.values()) await attempt(release);
      this.childLeases.clear();
      await attempt(() => this.releaseSession?.());
      this.releaseSession = undefined;
      for (const dispose of [...this.disposers, ...disposers]) await attempt(dispose);
      this.handle = undefined;
      this.hooks.cancelInteractions();
      this.hooks.resetDisplay();
      if (errors.length) throw new AggregateError(errors, '会话释放失败');
    })();
    return this.closing;
  }
}
