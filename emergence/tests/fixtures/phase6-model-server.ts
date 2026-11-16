import { createServer } from 'node:http';

export async function phase6Server() {
  const calls: Array<{ scenario: string; user: string }> = [];
  let activeStreams = 0;
  const server = createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      let scenario = 'echo',
        user = '',
        marker = -1;
      body.messages.forEach((m: { role: string; content: unknown }, i: number) => {
        if (m.role !== 'user') return;
        const text =
          typeof m.content === 'string'
            ? m.content
            : Array.isArray(m.content)
              ? m.content.map((b) => b.text ?? '').join('')
              : '';
        const match = text.match(/phase6:(rate|server|disconnect|once|hang|truncated)/);
        if (match) {
          scenario = match[1];
          user = text;
          marker = i;
        } else if (!text.includes('<') && !text.includes('runtime') && !text.includes('Current')) user = text;
      });
      calls.push({ scenario, user });
      if (scenario === 'rate' || scenario === 'server') {
        res.writeHead(scenario === 'rate' ? 429 : 500, {
          'Content-Type': 'application/json',
          'Retry-After': '1',
        });
        res.end(JSON.stringify({ error: { message: 'Fixture failure phase6-test-secret' } }));
        return;
      }
      const count = body.messages.slice(marker + 1).filter((m: { role: string }) => m.role === 'tool').length;
      if (scenario === 'once' && count > 1) {
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const emit = (delta: object, finish_reason: string | null = null) =>
        res.write(
          `data: ${JSON.stringify({ id: 'phase6-fixture', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
        );
      if (scenario === 'truncated') {
        emit({ role: 'assistant', content: 'PARTIAL_RESULT' }, 'length');
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      if (scenario === 'hang') {
        activeStreams++;
        emit({ role: 'assistant', content: 'WAITING_FOR_RECOVERY' });
        const timer = setInterval(() => emit({ content: '.' }), 100);
        res.on('close', () => {
          activeStreams--;
          clearInterval(timer);
        });
        return;
      }
      if (scenario === 'disconnect') {
        emit({ role: 'assistant', content: 'PARTIAL_BEFORE_DISCONNECT' });
        setTimeout(() => res.destroy(), 30);
        return;
      }
      if (scenario === 'once')
        emit(
          {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'phase6-once-' + count,
                type: 'function',
                function:
                  count === 0
                    ? {
                        name: 'emergence_analyze',
                        arguments: JSON.stringify({
                          objective: '写入测试文件',
                          reason: '单文件操作',
                          route: 'focused',
                        }),
                      }
                    : {
                        name: 'write',
                        arguments: JSON.stringify({
                          file_path: 'phase6-once.txt',
                          content: 'written exactly once',
                        }),
                      },
              },
            ],
          },
          'tool_calls',
        );
      else emit({ role: 'assistant', content: 'ECHO_COMPLETE' }, 'stop');
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (error) {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error));
    }
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing address');
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    calls,
    get activeStreams() {
      return activeStreams;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}
