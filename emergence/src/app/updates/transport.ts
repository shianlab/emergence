import { stableURL } from './manifest.ts';

/** Metadata only. Archive transfer reuses the standalone installer transport. */
export async function fetchManifest(signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<unknown> {
  const response = await fetcher(stableURL, {
    signal,
    redirect: 'manual',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok || response.status >= 300 || !response.body) {
    await response.body?.cancel();
    throw Error('暂时无法获取官方版本清单，可稍后重试');
  }
  if (Number(response.headers.get('content-length')) > 65536) {
    await response.body.cancel();
    throw Error('版本清单过大');
  }
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 65536) throw Error('版本清单过大');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
