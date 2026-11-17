import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-llm-retry';
import type {} from '@deepseek-ai/dsh-session-persistence';
import type {} from '@deepseek-ai/dsh-user-questions';
import type {} from '@deepseek-ai/dsh-working-directory';
import { InteractionQueue } from './interactions.ts';
interface QuestionHost {
  readonly ctx: Context;
  owns(agent?: Agent): boolean;
  interactive: boolean;
  captureClarification(agent: Agent): ((text: string) => Promise<void>) | undefined;
}
export function mountSessionQuestions(host: QuestionHost, interactions: InteractionQueue) {
  const ctx = host.ctx;
  return ctx.on('user-questions/request', async (req, next) => {
    if (!req.agent || !host.owns(req.agent)) return next();
    if (!host.interactive) throw new Error('此任务需要人工回答，请在交互终端中运行');
    const clarify = req.questions.some((q) => q.intent?.kind === 'approval')
      ? undefined
      : host.captureClarification(req.agent);
    const answers = [];
    for (const q of req.questions) {
      const options = q.options ?? [];
      const title = [`会话 ${req.agent.session.id}`, q.question, q.detail ?? ''].join('\n');
      answers.push(
        await interactions.request(
          {
            title,
            sessionId: req.agent.session.id,
            agentId: req.agent.id,
            kind: options.length ? (q.multiSelect ? 'multiChoice' : 'singleChoice') : 'text',
            options: options.map((option, index) => ({
              id: String(index + 1),
              label: option.label,
              value: String(index + 1),
            })),
            allowCustom: q.intent?.kind !== 'approval',
          },
          (text) => {
            const indices = text.split(',').map((s) => Number(s.trim()));
            if (indices.every((n) => Number.isInteger(n) && n > 0 && n <= options.length)) {
              if (!q.multiSelect && indices.length > 1) throw new Error('该问题只接受一个选项');
              return { id: q.id, selected: [...new Set(indices.map((n) => options[n - 1].label))] };
            }
            if (q.intent?.kind === 'approval') throw new Error('请回答一个选项编号');
            return { id: q.id, selected: [], custom: text };
          },
          req.signal,
          undefined,
          (answer) =>
            answer.text !== undefined
              ? { id: q.id, selected: [] as string[], custom: answer.text }
              : { id: q.id, selected: answer.selected!.map((id) => options[Number(id) - 1].label) },
        ),
      );
    }
    req.signal?.throwIfAborted();
    await clarify?.(
      JSON.stringify({
        questions: req.questions.map(({ id, question }) => ({ id, question })),
        answers,
      }),
    );
    return { answers };
  });
}
