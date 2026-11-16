import { createServer } from 'node:http';

/** Deterministic wire adapter only; all tools, Python computation and files are real. */
export async function installationModelServer() {
  const steps: Array<[string, Record<string, unknown>]> = [
    [
      'emergence_analyze',
      { objective: '核对独立安装的编程和数据能力', reason: '单项目的本地验收', route: 'focused' },
    ],
    ['emergence_code_work', { action: 'begin', objective: '修改已读取的文本文件' }],
    ['read', { file_path: 'answer.txt' }],
    ['write', { file_path: 'answer.txt', content: 'verified installed code\n' }],
    ['emergence_code_work', { action: 'status' }],
    ['emergence_data_profile', { file_path: 'sales.csv' }],
    [
      'emergence_data_query',
      { file_path: 'sales.csv', sql: 'SELECT sum(CAST(amount AS DECIMAL(20,2))) AS total FROM data' },
    ],
    ['emergence_data_analyze', { file_path: 'sales.csv', method: 'clean', params_json: '{}' }],
  ];
  const receipts: Array<{ name: string; output: string }> = [];
  const server = createServer(async (request, response) => {
    try {
      let raw = '';
      for await (const chunk of request) {
        raw += chunk;
        if (raw.length > 4000000) throw new Error('Fixture request too large');
      }
      const body = JSON.parse(raw);
      const done = body.messages.filter((message: { role: string }) => message.role === 'tool');
      for (let i = receipts.length; i < done.length; i++)
        receipts.push({ name: steps[i]?.[0] ?? 'extra', output: JSON.stringify(done[i].content) });
      const step = steps[done.length];
      if (step && !body.tools.some((tool: { function: { name: string } }) => tool.function.name === step[0]))
        throw new Error('Installed tool missing: ' + step[0]);
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(
        'data: ' +
          JSON.stringify({
            id: 'installation',
            object: 'chat.completion.chunk',
            created: 1,
            model: body.model,
            choices: [
              {
                index: 0,
                delta: step
                  ? {
                      role: 'assistant',
                      tool_calls: [
                        {
                          index: 0,
                          id: 'install-' + done.length,
                          type: 'function',
                          function: { name: step[0], arguments: JSON.stringify(step[1]) },
                        },
                      ],
                    }
                  : { role: 'assistant', content: 'INSTALLATION_TOOL_SEQUENCE_FINISHED' },
                finish_reason: step ? 'tool_calls' : 'stop',
              },
            ],
          }) +
          '\n\n',
      );
      response.end('data: [DONE]\n\n');
    } catch (error) {
      response.statusCode = 500;
      response.end(String(error));
    }
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture address missing');
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    receipts,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}
