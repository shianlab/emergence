import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { z } from 'zod';
import { safeError } from '../core/adapters/redaction.ts';
import { ConfigurationWindowManager, openConfigurationWindow } from './model-config-window.ts';
import { ModelConfiguration, type ModelConfigurationHost } from './model-configuration.ts';
export { openConfigurationWindow } from './model-config-window.ts';

async function readJSON(request: IncomingMessage) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? ''))
    throw new Error('请求需要 JSON');
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 64 * 1024) throw new Error('请求内容过大');
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new Error('JSON 格式错误');
  }
}

export async function startModelConfiguration(home: string, host?: ModelConfigurationHost) {
  const configuration = new ModelConfiguration(home, host),
    token = randomBytes(32).toString('hex');
  let origin = '',
    closed = false;
  const operations = new Set<Promise<void>>(),
    tests = new Set<AbortController>(),
    reading = new Set<IncomingMessage>();
  let mutations = 0,
    testing = 0;
  const windows = new ConfigurationWindowManager(() =>
    openConfigurationWindow(`${origin}/#session=${token}`),
  );
  const json = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(value));
  };
  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );
    if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) {
      json(res, 403, { error: '仅允许从本机配置窗口访问' });
      return;
    }
    const path = req.url;
    if (path?.startsWith('/api/')) {
      const presented = req.headers.authorization ?? '',
        expected = `Bearer ${token}`;
      if (
        Buffer.byteLength(presented) !== Buffer.byteLength(expected) ||
        !timingSafeEqual(Buffer.from(presented), Buffer.from(expected))
      ) {
        json(res, 401, { error: '配置窗口会话已失效，请从涌现重新打开' });
        return;
      }
      if (closed) {
        json(res, 503, { error: '配置服务正在关闭' });
        return;
      }
      if (path === '/api/state' && req.method === 'GET') {
        json(res, 200, await configuration.state());
        return;
      }
      if (req.method !== 'POST') {
        json(res, 405, { error: '不支持的请求方式' });
        return;
      }
      const isTest = path === '/api/test';
      if (
        !isTest &&
        !['/api/models/save', '/api/models/remove', '/api/defaults', '/api/windows/assign'].includes(path)
      ) {
        json(res, 404, { error: '接口不存在' });
        return;
      }
      if (mutations || (isTest && testing)) {
        json(res, 409, { error: '另一项操作正在处理，请稍候' });
        return;
      }
      // Reserve before reading: a slow body is still an admitted operation.
      if (isTest) testing++;
      else mutations++;
      try {
        reading.add(req);
        let input: unknown;
        try {
          input = await readJSON(req);
        } finally {
          reading.delete(req);
        }
        if (closed) {
          json(res, 503, { error: '配置服务正在关闭' });
          return;
        }
        if (isTest) {
          const abort = new AbortController();
          tests.add(abort);
          const disconnect = () => {
            if (!res.writableEnded) abort.abort();
          };
          res.once('close', disconnect);
          try {
            json(res, 200, await configuration.test(input, abort.signal));
          } finally {
            tests.delete(abort);
            res.off('close', disconnect);
          }
          return;
        }
        const result =
          path === '/api/models/save'
            ? await configuration.save(input)
            : path === '/api/models/remove'
              ? await configuration.remove(input)
              : path === '/api/defaults'
                ? await configuration.defaults(input)
                : path === '/api/windows/assign'
                  ? await configuration.assign(input)
                  : undefined;
        if (result) json(res, 200, result);
        else json(res, 404, { error: '接口不存在' });
      } finally {
        if (isTest) testing--;
        else mutations--;
      }
      return;
    }
    res.writeHead(404);
    res.end();
  }
  const server = createServer((req, res) => {
    const operation = handle(req, res).catch((error) => {
      if (res.headersSent || res.destroyed) {
        res.destroy();
        return;
      }
      const message =
        error instanceof z.ZodError
          ? error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('；')
          : safeError(error);
      json(res, 400, { error: message });
    });
    operations.add(operation);
    void operation.finally(() => operations.delete(operation));
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('无法启动模型配置服务');
  origin = `http://127.0.0.1:${address.port}`;
  let closing: Promise<void> | undefined;
  return {
    origin,
    url: `${origin}/#session=${token}`,
    configuration,
    open: () => windows.open(),
    waitForWindow: () => windows.wait(),
    close() {
      if (closing) return closing;
      closed = true;
      tests.forEach((t) => t.abort());
      reading.forEach((req) => req.destroy());
      closing = (async () => {
        const drained = new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        await windows.close();
        await Promise.allSettled([...operations]);
        server.closeAllConnections();
        await drained;
      })();
      return closing;
    },
  };
}
