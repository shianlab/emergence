import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { richReply } from './tui-rich-content.ts';
export async function richModelServer() {
  const requests: unknown[] = [];
  const server = createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const data of req) raw += data;
      const body = JSON.parse(raw);
      requests.push(body);
      const text = (message: { content: unknown }) =>
        typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
      const marker = body.messages.findLastIndex(
        (message: { role: string; content: unknown }) =>
          message.role === 'user' && text(message).includes('tui-rich:'),
      );
      const tool = text(body.messages[marker]).includes('tui-rich:tool');
      const result = body.messages
        .slice(marker + 1)
        .some((message: { role: string }) => message.role === 'tool');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const emit = (delta: object, finish_reason: string | null = null) =>
        res.write(
          `data: ${JSON.stringify({
            id: 'rich-fixture',
            object: 'chat.completion.chunk',
            created: 1,
            model: body.model,
            choices: [{ index: 0, delta, finish_reason }],
          })}\n\n`,
        );
      if (tool && !result)
        emit(
          {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'rich-read-call',
                type: 'function',
                function: { name: 'read', arguments: '{"file_path":"literal.md"}' },
              },
            ],
          },
          'tool_calls',
        );
      else {
        const response = tool
          ? '### 工具检查结束\n\n**工具结果已保留原文**。\n\nPHASE2_TOOL_COMPLETE'
          : richReply;
        for (let offset = 0; offset < response.length; offset += 95) {
          emit({ content: response.slice(offset, offset + 95) });
          await delay(25);
        }
        emit({}, 'stop');
      }
      res.end('data: [DONE]\n\n');
    } catch (error) {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error));
    }
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  return {
    requests,
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}
