import { type ContentBlock, type UserMessage } from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-llm-retry';
import { type SessionEvent } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-session-persistence';
import type {} from '@deepseek-ai/dsh-user-questions';
import type {} from '@deepseek-ai/dsh-working-directory';
import { type ModelConfig } from '../core/domain/configuration.ts';
export function assertModelHistory(
  model: ModelConfig,
  events: readonly SessionEvent[],
  pending: readonly UserMessage[] = [],
) {
  if (
    model.capabilities?.tools === false &&
    events.some((e) => e.type === 'tool/call' || e.type === 'tool/result')
  )
    throw new Error('此模型声明不支持工具，当前历史含工具记录；请先 /new，再 /model 切换。原历史会保留');
  const images = (content: readonly ContentBlock[]) =>
    content.some((b) => b.type === 'image' && !b.offloaded);
  if (
    model.capabilities?.vision === false &&
    (events.some((e) =>
      images(
        e.type === 'user/message'
          ? e.data.content
          : e.type === 'assistant/message' || e.type === 'tool/result'
            ? e.data.message.content
            : [],
      ),
    ) ||
      pending.some((m) => images(m.content)))
  )
    throw new Error('此模型声明不支持图像，当前历史或待处理上下文含图像；请先 /new，再 /model 切换');
}
