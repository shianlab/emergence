import { createServer } from 'node:http';
import { z } from 'zod';

const requestSchema = z
  .object({
    model: z.string(),
    messages: z.array(z.object({ role: z.string(), content: z.unknown().optional() }).passthrough()),
    tools: z
      .array(
        z
          .object({
            name: z.string().optional(),
            function: z.object({ name: z.string() }).passthrough().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export async function modelServer() {
  const calls: Array<{ model: string; protocol: string; tools: string[]; scenario: string }> = [];
  let cancelled = 0;
  const server = createServer(async (req, res) => {
    try {
      let body = '';
      for await (const chunk of req) body += chunk;
      const value = requestSchema.parse(JSON.parse(body));
      const allText = value.messages
        .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
        .join('\n');
      let scenario = 'chat',
        marker = -1;
      value.messages.forEach((message, index) => {
        if (message.role !== 'user') return;
        const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
        const match = text?.match(
          /phase[235]:(chain|question|cancel|error|shell|write|long|cwd|extension|subagent|child-body)/,
        );
        if (match) {
          scenario = match[1];
          marker = index;
        } else if (text === 'hello' || text?.includes('"text":"hello"')) {
          scenario = 'chat';
          marker = index;
        }
      });
      const anthropic = req.url?.includes('messages') ?? false;
      const names = (value.tools ?? []).map((t) => t.function?.name ?? t.name ?? '');
      calls.push({
        model: value.model,
        protocol: anthropic ? 'anthropic' : 'openai',
        tools: names,
        scenario,
      });
      if (scenario === 'error') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: { message: 'Unauthorized phase2-test-secret', type: 'authentication_error' },
          }),
        );
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const data = (x: object) => res.write(`data: ${JSON.stringify(x)}\n\n`);
      const openai = (delta: object, finish_reason: string | null = null) =>
        data({
          id: 'chat-test',
          object: 'chat.completion.chunk',
          created: 1,
          model: value.model,
          choices: [{ index: 0, delta, finish_reason }],
        });
      if (scenario === 'cancel') {
        openai({ role: 'assistant', content: '正在等待取消 ' });
        const timer = setInterval(() => openai({ content: '流式输出 ' }), 100);
        res.on('close', () => {
          clearInterval(timer);
          cancelled++;
        });
        return;
      }
      const rawCount = value.messages.slice(marker + 1).filter((m) => m.role === 'tool').length;
      const analyze =
        names.includes('emergence_analyze') &&
        ['chain', 'write', 'shell', 'cwd', 'subagent', 'extension'].includes(scenario);
      const count = rawCount - (analyze ? 1 : 0);
      let tool: { name: string; args: object } | undefined;
      if (scenario === 'chain') {
        const steps = [
          { name: 'write', args: { file_path: 'stage2-output.txt', content: 'first version' } },
          { name: 'read', args: { file_path: 'stage2-output.txt' } },
          {
            name: 'edit',
            args: {
              file_path: 'stage2-output.txt',
              old_string: 'first version',
              new_string: 'verified version',
            },
          },
          {
            name: 'pwsh',
            args: {
              command: "Get-Content -LiteralPath 'stage2-output.txt'",
              description: 'Verify the stage two project file',
              timeout_ms: 10000,
            },
          },
          { name: 'skill', args: { name: 'phase2-proof' } },
          { name: names.find((n) => n.includes('echo')) ?? 'MCP_NOT_AVAILABLE', args: { value: 'verified' } },
        ];
        tool = steps[count];
      }
      if (scenario === 'extension' && count === 0) tool = { name: 'ext_inspector_project_info', args: {} };
      if (scenario === 'subagent' && count === 0)
        tool = {
          name: 'subagent',
          args: { description: 'Phase five child verification', prompt: 'phase5:child-body' },
        };
      if (scenario === 'child-body')
        tool = [
          { name: 'write', args: { file_path: 'phase5-child.txt', content: 'NATIVE_SUBAGENT_PROOF' } },
          {
            name: 'pwsh',
            args: {
              command: "Write-Output 'PHASE5_CHILD_APPROVED'",
              description: 'Verify child permission ownership',
              timeout_ms: 10000,
            },
          },
        ][count];
      if (scenario === 'question' && count === 0)
        tool = {
          name: 'ask_user_question',
          args: {
            questions: [
              { id: 'choice', question: '请选择验证颜色', options: [{ label: '蓝色' }, { label: '绿色' }] },
            ],
          },
        };
      if (scenario === 'shell' && count === 0)
        tool = {
          name: 'pwsh',
          args: {
            command: "Write-Output 'SHELL_APPROVED'",
            description: 'Run the local approval test',
            timeout_ms: 10000,
          },
        };
      if (scenario === 'cwd' && count === 0)
        tool = {
          name: 'pwsh',
          args: {
            command: "Set-Content -LiteralPath 'shell-cwd.txt' -Value (Get-Location).Path",
            description: 'Verify this session shell directory',
            timeout_ms: 10000,
          },
        };
      const label = allText.match(/phase3:write:([A-D])/)?.[1] ?? 'A';
      if (scenario === 'write')
        tool =
          count === 0
            ? { name: 'write', args: { file_path: `proof-${label}.txt`, content: `${value.model}:${label}` } }
            : undefined;
      if (analyze && rawCount === 0)
        tool = {
          name: 'emergence_analyze',
          args: { objective: '完成当前测试任务', reason: '有界工具操作', route: 'focused' },
        };
      if (anthropic) {
        const emit = (event: string, payload: object) =>
          res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
        emit('message_start', {
          type: 'message_start',
          message: {
            id: 'msg-test',
            type: 'message',
            role: 'assistant',
            model: value.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        });
        emit('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        });
        emit('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'ANTHROPIC_OK' },
        });
        emit('content_block_stop', { type: 'content_block_stop', index: 0 });
        emit('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 3 },
        });
        emit('message_stop', { type: 'message_stop' });
      } else if (tool) {
        openai({
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: `call-${count}`,
              type: 'function',
              function: { name: tool.name, arguments: JSON.stringify(tool.args) },
            },
          ],
        });
        openai({}, 'tool_calls');
        data({
          id: 'chat-test',
          object: 'chat.completion.chunk',
          created: 1,
          model: value.model,
          choices: [],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        });
        res.write('data: [DONE]\n\n');
      } else {
        openai({
          role: 'assistant',
          content:
            scenario === 'extension'
              ? 'EXTENSION_COMPLETE'
              : scenario === 'subagent'
                ? 'SUBAGENT_DISPATCHED'
                : scenario === 'child-body'
                  ? 'CHILD_COMPLETE'
                  : scenario === 'long'
                    ? Array.from({ length: 100 }, (_, i) => `history ${i} ${value.model}`).join('\n')
                    : scenario === 'write'
                      ? `WRITE_COMPLETE_${label}`
                      : scenario === 'chain'
                        ? 'CHAIN_COMPLETE'
                        : scenario === 'question'
                          ? 'QUESTION_COMPLETE'
                          : 'OPENAI_OK',
        });
        openai({}, 'stop');
        res.write('data: [DONE]\n\n');
      }
      res.end();
    } catch (error) {
      res.writeHead(500);
      res.end(String(error));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server address');
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    calls,
    get cancelled() {
      return cancelled;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    },
  };
}
