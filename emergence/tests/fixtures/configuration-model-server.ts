import { createServer } from 'node:http';
import { modelPresets } from '../../src/app/model-presets.ts';

export async function configurationModelServer() {
  const calls: Array<{ path: string; model: string; stream: boolean; authorized: boolean }> = [];
  const presetModels = new Set(modelPresets.filter((preset) => preset.baseURL).map((preset) => preset.model));
  const completions = new Set(
    [
      '/v1',
      '/v1/openai',
      '/v1beta/openai',
      '/api/paas/v4',
      '/api/coding/paas/v4',
      '/compatible-mode/v1',
      '/api/v3',
      '/v2',
      '/coding/v1',
      '/api/coding/v3',
      '/coding/v3',
      '/v2/coding',
    ].map((prefix) => prefix + '/chat/completions'),
  );
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw) as { model?: string; stream?: boolean };
    const url = new URL(request.url ?? '/', 'http://127.0.0.1'),
      path = url.pathname;
    const model = body.model ?? decodeURIComponent(path.match(/\/models\/([^:]+):/)?.[1] ?? '');
    const supplied =
      request.headers.authorization?.replace(/^Bearer /, '') ??
      request.headers['x-api-key'] ??
      request.headers['x-goog-api-key'] ??
      url.searchParams.get('key');
    const expected = model.startsWith('fixture-key-')
      ? model === 'fixture-key-new'
        ? 'initial-fixture-secret'
        : 'rotated-fixture-secret'
      : presetModels.has(model)
        ? 'preset-fixture-secret'
        : 'fixture-secret-value';
    const authorized = supplied === expected;
    calls.push({
      path,
      model,
      stream: body.stream === true || path.includes(':streamGenerateContent'),
      authorized,
    });
    if (
      request.method !== 'POST' ||
      !(
        completions.has(path) ||
        ['/v1/responses', '/v1/messages'].includes(path) ||
        /^\/v1(?:beta)?\/models\/[^:]+:(?:streamGenerateContent|generateContent)$/.test(path)
      )
    ) {
      response.writeHead(404);
      response.end('{"error":"unexpected exact wire path"}');
      return;
    }
    if (!authorized) {
      response.writeHead(401);
      response.end('{"error":"fixture credential mismatch"}');
      return;
    }
    if (model === 'unauthorized') {
      response.writeHead(401);
      response.end('{"error":"Bearer fixture-secret-value"}');
      return;
    }
    if (model === 'html') {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<html>Sign in</html>');
      return;
    }
    if (model === 'empty') {
      response.writeHead(200);
      response.end('{"choices":[]}');
      return;
    }
    if (model === 'slow') {
      const timer = setTimeout(() => response.end('{}'), 30000);
      response.once('close', () => clearTimeout(timer));
      return;
    }
    if (path.endsWith('/messages')) {
      const text = `CONFIG_REPLY:${model}`;
      if (!body.stream) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ content: [{ type: 'text', text }] }));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const emit = (event: string, data: object) =>
        response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      emit('message_start', {
        type: 'message_start',
        message: {
          id: 'msg-audit',
          type: 'message',
          role: 'assistant',
          model,
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
        delta: { type: 'text_delta', text },
      });
      emit('content_block_stop', { type: 'content_block_stop', index: 0 });
      emit('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 5 },
      });
      emit('message_stop', { type: 'message_stop' });
      response.end();
      return;
    }
    if (path.endsWith('/responses') && body.stream) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const text = `CONFIG_REPLY:${model}`,
        item = {
          id: 'msg-audit',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text, annotations: [] }],
        };
      const emit = (type: string, data: object) =>
        response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      const result = {
        id: 'resp-audit',
        object: 'response',
        created_at: 1,
        model,
        status: 'completed',
        output: [item],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      };
      emit('response.created', { response: { ...result, status: 'in_progress', output: [] } });
      emit('response.output_item.added', {
        output_index: 0,
        item: { ...item, status: 'in_progress', content: [] },
      });
      emit('response.content_part.added', {
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      });
      emit('response.output_text.delta', {
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        delta: text,
      });
      emit('response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text });
      emit('response.output_item.done', { output_index: 0, item });
      emit('response.completed', { response: result });
      response.end();
      return;
    }
    if (path.includes(':streamGenerateContent')) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(
        `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: `CONFIG_REPLY:${model}` }] }, finishReason: 'STOP', index: 0 }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 }, modelVersion: model })}\n\n`,
      );
      return;
    }
    if (body.stream) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunk = (delta: object, finish_reason: string | null = null) =>
        response.write(
          `data: ${JSON.stringify({ id: 'config-fixture', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
        );
      chunk({ role: 'assistant', content: `CONFIG_REPLY:${model}` });
      if (raw.includes('hold-for-config-test')) {
        const timer = setInterval(() => chunk({ content: '.' }), 100);
        response.once('close', () => clearInterval(timer));
        return;
      }
      chunk({}, 'stop');
      response.end('data: [DONE]\n\n');
      return;
    }
    const result = path.endsWith('/chat/completions')
      ? { choices: [{ message: { content: 'OK' } }] }
      : path.endsWith('/responses')
        ? { output: [{ content: [{ type: 'output_text', text: 'OK' }] }] }
        : path.endsWith('/messages')
          ? { content: [{ type: 'text', text: 'OK' }] }
          : { candidates: [{ content: { parts: [{ text: 'OK' }] } }] };
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(result));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture address');
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    calls,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
