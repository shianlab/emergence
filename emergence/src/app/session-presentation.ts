import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { type ContentBlock } from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-llm-retry';
import { type SessionEvent } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-session-persistence';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-user-questions';
import type {} from '@deepseek-ai/dsh-working-directory';
import { safeError } from '../core/adapters/redaction.ts';
import { outputLimitRecoveryCode } from '../core/adapters/model-response.ts';
import { RunDiagnostics } from '../core/application/run-diagnostics.ts';
import { MessageProjection } from './tui/message-model.ts';
import { SessionUsage } from './tui/session-usage.ts';
function textOf(content: readonly ContentBlock[]) {
  return content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
}
export function eventLine(event: SessionEvent): string | undefined {
  switch (event.type) {
    case 'user/message':
      return event.data.source.kind === 'user'
        ? `你 › ${textOf(event.data.content)}`
        : event.data.source.kind === 'emergence-instructions'
          ? `规则 › ${event.data.source.root} · ${event.data.source.fingerprint.slice(0, 12)} · /instructions 查看来源`
          : event.data.source.kind === 'emergence-context'
            ? `上下文 ${event.data.source.label} › ${textOf(event.data.content)}`
            : event.data.source.kind === 'skill-invocation'
              ? `技能 ${event.data.source.name} › ${textOf(event.data.content)}`
              : event.data.source.kind === 'emergence-task' ||
                  event.data.source.kind === 'emergence-note' ||
                  event.data.source.kind === 'emergence-receipt'
                ? `协作 ${event.data.source.taskId} › ${textOf(event.data.content)}`
                : `上下文 · ${event.data.source.kind}`;
    case 'assistant/message': {
      const text = textOf(event.data.message.content);
      return text || event.data.interrupted
        ? `涌现 › ${text}${event.data.interrupted ? '\n[已中止]' : ''}`
        : undefined;
    }
    case 'tool/call':
      return `┌ 工具 ${event.data.name}\n${event.data.arguments}`;
    case 'tool/result':
      return `└ ${event.data.message.isError ? '失败' : '完成'}\n${textOf(event.data.message.content)}`;
    default:
      return undefined;
  }
}
export interface SessionPresentationHost {
  readonly ctx: Context;
  readonly diagnostics: RunDiagnostics;
  current(): Agent | undefined;
  changed(): void;
  notice: string;
  lastError?: string;
}
/** Incremental display caches never own execution state or persistence. */
export class SessionPresentation {
  private readonly disposers: Array<() => void> = [];

  private usageProjection?: { session: string; value: SessionUsage };

  private activityStartedAt?: number;

  private streamPhase: 'waiting' | 'reasoning' | 'writing' = 'waiting';

  private display?: { sessionId: string; lines: string[] };

  private messages?: MessageProjection;

  live = '';

  private stopping = false;

  private readonly runningTools = new Map<string, { name: string; arguments: string }>();

  constructor(private host: SessionPresentationHost) {}

  mount() {
    const ctx = this.host.ctx;
    this.disposers.push(
      ctx.on('session/event', (session, event) => {
        if (session.id !== this.host.current()?.session.id) return;
        if (event.type === 'llm/retry') {
          this.host.diagnostics.model('retry');
          this.host.notice = '模型请求暂时中断，正在原预算内重试；已执行的工具不会重放';
        }
        if (this.usageProjection?.session === session.id) this.usageProjection.value.append(event);
        if (this.messages?.sessionId === session.id) this.messages.append(event);
        if (event.type === 'assistant/message') this.live = '';
        if (event.type === 'turn/end' && event.data.reason.kind === 'max-tokens') {
          this.host.lastError =
            '模型单次输出达到 Token 上限，本轮未完成。可在当前会话要求接着做、按段写入，或在 /model-config 调整模型支持的输出上限。';
          this.host.notice = this.host.lastError;
        }
        if (this.display?.sessionId === session.id) {
          const line = eventLine(event);
          if (line) {
            this.display.lines.push(this.displayLine(line));
            if (this.display.lines.length > 200) this.display.lines.shift();
          }
        }
        this.host.changed();
      }),
    );
    this.disposers.push(
      ctx.on('agent/assistant-stream', ({ agent, frame }) => {
        if (agent.session.id !== this.host.current()?.session.id) return;
        if (frame.type === 'start') {
          this.host.diagnostics.model('start');
          this.live = '';
          this.streamPhase = 'waiting';
        }
        if (frame.type === 'chunk' && frame.chunk.type === 'reasoning-delta') this.streamPhase = 'reasoning';
        if (
          frame.type === 'chunk' &&
          frame.chunk.type === 'finish' &&
          frame.chunk.reason.kind === 'error' &&
          frame.chunk.reason.failure.code === outputLimitRecoveryCode
        ) {
          this.host.notice = '模型单次输出达到上限，正在缩短本步输出后继续…';
        }
        if (
          frame.type === 'chunk' &&
          ['reasoning-delta', 'text-delta', 'tool-call-delta'].includes(frame.chunk.type)
        )
          this.host.diagnostics.model('output');
        if (frame.type === 'chunk' && frame.chunk.type === 'text-delta') {
          this.streamPhase = 'writing';
          this.live = (this.live + frame.chunk.text).slice(-16000);
        }
        if (frame.type === 'end') {
          this.host.diagnostics.model('end');
          this.live = '';
          this.streamPhase = 'waiting';
        }
        this.host.changed();
      }),
    );
    this.disposers.push(
      ctx.on('agent/status', ({ agent, status }) => {
        if (agent.session.id === this.host.current()?.session.id) {
          if (status === 'running') {
            this.activityStartedAt ??= Date.now();
            this.host.diagnostics.start();
          } else {
            this.host.diagnostics.end(this.host.lastError ? 'error' : 'ended', this.host.lastError);
            this.activityStartedAt = undefined;
            this.streamPhase = 'waiting';
          }
          if (status === 'idle' && !this.host.lastError) this.host.notice = '本轮已完成';
          this.host.changed();
        }
      }),
    );
    this.disposers.push(
      ctx.on('agent/error', ({ agent, error }) => {
        if (agent.session.id === this.host.current()?.session.id) {
          this.host.lastError = safeError(error);
          this.host.diagnostics.end('error', this.host.lastError);
          this.host.notice = '执行失败：' + this.host.lastError;
          this.host.changed();
        }
      }),
    );
    for (const event of ['agent/inbox/inserted', 'agent/inbox/claimed', 'agent/inbox/discarded'] as const) {
      this.disposers.push(
        ctx.on(event, ({ agent }: { agent: Agent }) => {
          if (agent.session.id === this.host.current()?.session.id) this.host.changed();
        }),
      );
    }
    this.disposers.push(
      ctx.on('agent/inbox/claimed', ({ agent, message }) => {
        if (agent.session.id !== this.host.current()?.session.id) return;
        this.host.diagnostics.start();
        if (message.source.kind === 'emergence-task') this.host.diagnostics.assign(message.source.taskId);
      }),
    );
    return this.disposers;
  }

  get activity() {
    return {
      stopping: this.stopping,
      startedAt: this.activityStartedAt,
      phase: this.streamPhase,
      tools: [...this.runningTools.values()],
      queued:
        this.host.current()?.inbox.nextTurn.filter((message) => message.source.kind === 'user').length ?? 0,
    };
  }

  transcript() {
    return this.host.current()
      ? this.host
          .current()!
          .session.snapshotEvents()
          .flatMap((e) => {
            const line = eventLine(e);
            return line ? [safeError(line)] : [];
          })
      : [];
  }

  displayMessages() {
    if (!this.host.current()) return undefined;
    if (this.messages?.sessionId !== this.host.current()?.session.id)
      this.messages = new MessageProjection(this.host.current()?.session.id!).load(
        this.host.current()!.session.snapshotEvents(),
      );
    return this.messages;
  }

  tokenUsage() {
    if (!this.host.current()) return undefined;
    if (!this.usageProjection || this.usageProjection.session !== this.host.current()?.session.id) {
      const value = new SessionUsage();
      for (const event of this.host.current()!.session.snapshotEvents()) value.append(event);
      this.usageProjection = { session: this.host.current()?.session.id!, value };
    }
    return this.usageProjection!.value;
  }

  private displayLine(line: string) {
    return safeError(
      line.length > 16000 ? line.slice(0, 16000) + '\n[界面截断，完整内容在会话日志中]' : line,
    );
  }

  displayTranscript(): readonly string[] {
    if (!this.host.current()) return [];
    if (!this.display || this.display.sessionId !== this.host.current()?.session.id)
      this.display = {
        sessionId: this.host.current()?.session.id!,
        lines: this.transcript()
          .slice(-200)
          .map((line) => this.displayLine(line)),
      };
    return this.display.lines;
  }

  toolActivity(exec: ToolExecution, active: boolean) {
    const key = String(exec.agent?.id) + ':' + exec.callId + ':' + exec.name;
    this.host.diagnostics.tool(key, active);
    if (active)
      this.runningTools.set(key, {
        name: safeError(exec.name),
        arguments: safeError(JSON.stringify(exec.arguments) ?? ''),
      });
    else this.runningTools.delete(key);
  }

  reset() {
    this.live = '';
    this.activityStartedAt = undefined;
    this.streamPhase = 'waiting';
    this.display = undefined;
    this.messages = undefined;
    this.usageProjection = undefined;
  }

  setStopping(stopping: boolean) {
    this.stopping = stopping;
  }
}
