import { open } from 'node:fs/promises';

export async function boundedText(path: string, maxBytes: number, preserveBOM = false): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('不是普通文件');
    if (info.size > maxBytes) throw new Error(`文件超过 ${maxBytes} 字节上限`);
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length <= maxBytes) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw new Error(`文件超过 ${maxBytes} 字节上限`);
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      buffer.subarray(0, length),
    );
    return preserveBOM ? text : text.replace(/^\uFEFF/, '');
  } finally {
    await handle.close();
  }
}
