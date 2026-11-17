import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { safeError } from '../../core/adapters/redaction.ts';
import { intentAnalysisSchema } from '../../core/domain/intent.ts';

export interface TextMessage {
  kind: 'user' | 'assistant' | 'context';
  id: string;
  seq: number;
  time: number;
  text: string;
  label?: string;
  summary?: string;
  background?: boolean;
  interrupted?: boolean;
  revision: number;
}
export interface ToolMessage {
  kind: 'tool';
  id: string;
  seq: number;
  time: number;
  callId: string;
  name: string;
  arguments: string;
  result: string;
  status: 'running' | 'done' | 'error';
  error?: string;
  exitCode?: number;
  revision: number;
}
export type DisplayMessage = TextMessage | ToolMessage;

function contentText(content: readonly ContentBlock[]) {
  return safeError(
    content
      .flatMap((block) =>
        block.type === 'text' ? [block.text] : block.type === 'image' ? ['[图片 / image]'] : [],
      )
      .join('\n'),
  );
}

/** Bounded UI projection; Session remains the complete, authoritative history. */
export class MessageProjection {
  readonly items: DisplayMessage[] = [];
  private readonly tools = new Map<string, ToolMessage>();
  private lastSeq = -1;
  revision = 0;
  omitted = 0;
  constructor(
    readonly sessionId: string,
    readonly limit = 200,
  ) {}
  append(event: SessionEvent) {
    if (event.seq <= this.lastSeq) return;
    this.lastSeq = event.seq;
    const base = {
      id: `${this.sessionId}:${event.seq}`,
      seq: Number(event.seq),
      time: event.time,
      revision: 0,
    };
    let item: DisplayMessage | undefined;
    if (event.type === 'user/message') {
      const source = event.data.source as unknown as Record<string, unknown>;
      const kind = source.kind === 'user' ? 'user' : 'context';
      const label =
        source.kind === 'runtime-context'
          ? '运行上下文'
          : source.kind === 'emergence-instructions'
            ? '项目指引'
            : source.kind === 'skill-catalog'
              ? '技能目录'
              : source.kind === 'skill-invocation'
                ? `技能 ${source.name}`
                : source.kind === 'emergence-context'
                  ? `上下文 ${source.label}`
                  : ['emergence-task', 'emergence-note', 'emergence-receipt'].includes(String(source.kind))
                    ? `协作 ${source.taskId}`
                    : String(source.kind);
      const summary =
        source.form === 'notice' && typeof source.summary === 'string'
          ? source.summary
          : source.kind === 'runtime-context'
            ? '工作目录与运行约束 · 展开查看'
            : source.kind === 'emergence-instructions'
              ? '项目与个人指引 · 展开查看'
              : source.kind === 'skill-catalog'
                ? '可用技能清单 · 展开查看'
                : undefined;
      item = {
        ...base,
        kind,
        text: contentText(event.data.content),
        label: safeError(label),
        summary: summary ? safeError(summary) : undefined,
        ...(['runtime-context', 'emergence-instructions', 'skill-catalog'].includes(String(source.kind))
          ? { background: true }
          : {}),
      };
    } else if (event.type === 'assistant/message') {
      const text = contentText(event.data.message.content);
      if (text || event.data.interrupted)
        item = { ...base, kind: 'assistant', text, interrupted: event.data.interrupted };
    } else if (event.type === 'tool/call') {
      item = {
        ...base,
        kind: 'tool',
        callId: event.data.callId,
        name: safeError(event.data.name),
        arguments: safeError(event.data.arguments),
        result: '',
        status: 'running',
      };
      this.tools.set(item.callId, item);
    } else if (event.type === 'tool/result') {
      const callId = event.data.message.source.callId;
      let tool = this.tools.get(callId);
      if (!tool) {
        tool = { ...base, kind: 'tool', callId, name: 'tool', arguments: '', result: '', status: 'running' };
        this.tools.set(callId, tool);
        item = tool;
      }
      tool.result = contentText(event.data.message.content);
      tool.status = event.data.message.isError ? 'error' : 'done';
      tool.error = event.data.error ? safeError(event.data.error.reason ?? event.data.error.name) : undefined;
      const meta = event.data.meta;
      if (meta && typeof meta === 'object' && !Array.isArray(meta) && typeof meta.exitCode === 'number')
        tool.exitCode = meta.exitCode;
      tool.revision++;
      this.revision++;
    }
    if (!item) return;
    this.items.push(item);
    this.revision++;
    while (this.items.length > this.limit) {
      const removed = this.items.shift()!;
      this.omitted++;
      if (removed.kind === 'tool') this.tools.delete(removed.callId);
    }
  }
  load(events: readonly SessionEvent[]) {
    for (const event of events) this.append(event);
    return this;
  }
}

export function toolSummary(item: Pick<ToolMessage, 'arguments'>) {
  try {
    const args: unknown = JSON.parse(item.arguments);
    if (args && typeof args === 'object') {
      for (const key of ['command', 'file_path', 'path', 'query', 'url', 'pattern', 'task']) {
        const value = (args as Record<string, unknown>)[key];
        if (typeof value === 'string') return value.replace(/\s+/g, ' ').slice(0, 180);
      }
    }
  } catch {
    /* Malformed arguments are still available verbatim in details. */
  }
  return item.arguments.replace(/\s+/g, ' ').slice(0, 180);
}

/** Present only successful host-recorded analysis as an interpreted requirement. */
export function intentSummary(item: ToolMessage) {
  if (item.name !== 'emergence_analyze' || item.status !== 'done') return;
  try {
    const value = intentAnalysisSchema.parse(JSON.parse(item.result).analysis);
    const short = (s: string) => safeError(s).replace(/\s+/g, ' ').slice(0, 220);
    const list = (items: string[] | undefined, empty: string) =>
      items?.length ? items.slice(0, 4).map(short).join('；') + (items.length > 4 ? '…' : '') : empty;
    return `目标：${short(value.objective)}\n约束：${list(value.constraints, '未单独列出')}\n验收：${list(value.acceptance, '未单独列出')}\n待确认：${list(value.questions, value.questions ? '无阻塞问题' : '未单独列出')}\n处理：${value.intent === 'discuss' ? '先讨论，不执行' : value.intent === 'clarify' || value.questions?.length ? '等你补充后再实施' : value.intent === 'execute' ? '按需求继续，仍遵循权限审批' : '按当前任务权限继续'}`;
  } catch {
    return;
  }
}
