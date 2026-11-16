import { createServer } from 'node:http';

export async function phase4ModelServer() {
  const calls: Array<{ model: string; scenario: string; tools: string[] }> = [];
  let cancelled = 0;
  const server = createServer(async (req, res) => {
    try {
      let body = '';
      for await (const chunk of req) body += chunk;
      const value = JSON.parse(body) as {
        model: string;
        messages: Array<{ role: string; content?: unknown }>;
        tools?: Array<{ function: { name: string } }>;
      };
      const messages = value.messages.map((m) => ({
        role: m.role,
        text:
          typeof m.content === 'string'
            ? m.content
            : Array.isArray(m.content)
              ? m.content.map((b) => b.text ?? '').join('\n')
              : (JSON.stringify(m.content) ?? ''),
      }));
      const masterIndex = messages.findLastIndex((m) => m.role === 'user' && /^phase4:master:/.test(m.text));
      const taskIndex = messages.findLastIndex(
        (m) => m.role === 'user' && m.text.startsWith('[Emergence task '),
      );
      const manual = messages.findLastIndex((m) => m.role === 'user' && m.text === 'manual');
      const isMaster = value.model === 'fixture-master';
      const scenario = isMaster
        ? (messages[masterIndex]?.text.split(':')[2] ?? 'receipt')
        : manual > taskIndex
          ? 'manual'
          : (messages[taskIndex]?.text.match(
              /phase4:worker:(write|tool-error|question|slow|shell-fail|network)/,
            )?.[1] ?? 'manual');
      calls.push({ model: value.model, scenario, tools: value.tools?.map((t) => t.function.name) ?? [] });
      if (scenario === 'network') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: { message: 'deliberate authentication failure', type: 'authentication_error' },
          }),
        );
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const data = (delta: object, finish_reason: string | null = null) =>
        res.write(
          `data: ${JSON.stringify({ id: 'phase4', object: 'chat.completion.chunk', created: 1, model: value.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
        );
      if (scenario === 'slow') {
        data({ role: 'assistant', content: 'TASK_STREAMING ' });
        const timer = setInterval(() => data({ content: 'working ' }), 100);
        res.on('close', () => {
          clearInterval(timer);
          cancelled++;
        });
        return;
      }
      let tool: { name: string; args: object } | undefined;
      let text = 'MANUAL_OK';
      if (isMaster) {
        const count = messages.slice(masterIndex + 1).filter((m) => m.role === 'tool').length;
        const context = messages.map((m) => m.text).join('\n');
        const workers = [...context.matchAll(/^([a-f0-9]{8}): .+ · .+$/gm)].map((m) => m[1]);
        const targets = [...new Set(workers)];
        const dispatchCount = scenario === 'success' ? 3 : 2;
        const workerIndex = scenario === 'success' ? (count < 2 ? 0 : 1) : count;
        if (masterIndex >= 0 && count < dispatchCount)
          tool = {
            name: 'emergence_dispatch',
            args: {
              target: targets[workerIndex],
              request_key: `${scenario}-${workerIndex}`,
              objective:
                scenario === 'success'
                  ? `phase4:worker:write:${workerIndex === 0 ? 'A' : 'B'}`
                  : count === 0
                    ? 'phase4:worker:tool-error'
                    : 'phase4:worker:question',
            },
          };
        const receipts = messages
          .flatMap((m) => {
            try {
              const parsed =
                m.role === 'tool'
                  ? JSON.parse(m.text)
                  : m.text.startsWith('任务实际回执：')
                    ? JSON.parse(m.text.slice('任务实际回执：'.length).split('\n')[0])
                    : undefined;
              return parsed ? (Array.isArray(parsed) ? parsed : [parsed]) : [];
            } catch {
              return [];
            }
          })
          .filter((r) => typeof r.id === 'string' && typeof r.status === 'string');
        const relevant = [
          ...new Map(
            receipts.filter((r) => r.requestKey?.startsWith(scenario + '-')).map((r) => [r.id, r]),
          ).values(),
        ];
        if (masterIndex >= 0 && count === dispatchCount && !tool)
          tool = { name: 'emergence_wait', args: { task_ids: relevant.map((r) => r.id), timeout_ms: 10000 } };
        text = 'MASTER_RESULTS ' + relevant.map((r) => r.status).join(' ');
      } else if (scenario !== 'manual') {
        const count = messages.slice(taskIndex + 1).filter((m) => m.role === 'tool').length;
        const label = messages[taskIndex]?.text.match(/phase4:worker:write:([A-Z])/)?.[1] ?? 'X';
        if (count === 0) {
          if (scenario === 'write')
            tool = {
              name: 'write',
              args: { file_path: `phase4-${label}.txt`, content: `${value.model}:${label}` },
            };
          if (scenario === 'tool-error')
            tool = { name: 'read', args: { file_path: 'deliberately-missing.txt' } };
          if (scenario === 'question')
            tool = {
              name: 'ask_user_question',
              args: {
                questions: [
                  {
                    id: 'proof',
                    question: '协作任务需要用户选择',
                    options: [{ label: '蓝色' }, { label: '绿色' }],
                  },
                ],
              },
            };
          if (scenario === 'shell-fail')
            tool = {
              name: 'pwsh',
              args: { command: 'exit 7', description: 'Deliberate failing command', timeout_ms: 10000 },
            };
        } else
          tool = {
            name: 'emergence_report',
            args: {
              outcome: 'success',
              summary: `MODEL_CLAIMS_SUCCESS_${scenario}`,
              artifacts: scenario === 'write' ? [`phase4-${label}.txt`] : [],
            },
          };
      }
      if (tool) {
        data({
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: `phase4-call-${calls.length}`,
              type: 'function',
              function: { name: tool.name, arguments: JSON.stringify(tool.args) },
            },
          ],
        });
        data({}, 'tool_calls');
      } else {
        data({ role: 'assistant', content: text });
        data({}, 'stop');
      }
      res.end('data: [DONE]\n\n');
    } catch (error) {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error));
    }
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    calls,
    get cancelled() {
      return cancelled;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
    },
  };
}
