import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { decodeLogo, terminalFrame, DURATION_MS } from './logo-animation-core.mjs';

export async function previewLogo({ output = process.stdout, input = process.stdin,
  variant, duration = DURATION_MS, still = false } = {}) {
  const columns = output.columns ?? 100, rows = output.rows ?? 30;
  const selected = variant ?? (columns >= 100 && rows >= 23 ? 'balanced' : 'bold');
  if (!['fine', 'balanced', 'bold'].includes(selected)) throw new Error('Unknown logo variant');
  const text = await readFile(new URL(`../assets/brand/pixel/yongxian-pixel-${selected}.txt`, import.meta.url), 'utf8');
  const logo = decodeLogo(text);
  if (output.isTTY && (columns < logo.width + 2 || rows < logo.height / 2 + 3)) {
    output.write('涌现 · Emergence\n');
    return;
  }
  const indent = Math.max(0, Math.floor((columns - logo.width) / 2));
  if (!output.isTTY || still || process.env.NO_COLOR !== undefined || process.env.TERM === 'dumb') {
    output.write(process.env.NO_COLOR !== undefined || process.env.TERM === 'dumb'
      ? text : terminalFrame(logo, 0, true, indent));
    return;
  }
  let cancelled = false;
  const cancel = () => { cancelled = true; };
  const key = data => { if (data.includes('\x03') || data.includes('\x1b')) cancel(); };
  const wasRaw = input.isRaw;
  const wasFlowing = input.readableFlowing;
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  if (input.isTTY) { input.setRawMode(true); input.resume(); input.on('data', key); }
  // Reserve our lines and restore the cursor position before each frame.
  const lineCount = logo.height / 2;
  output.write('\n'.repeat(lineCount) + `\x1b[${lineCount}A\r\x1b[?25l`);
  const started = performance.now();
  try {
    while (!cancelled && performance.now() - started < duration) {
      const elapsed = performance.now() - started;
      output.write(terminalFrame(logo, elapsed, false, indent) + `\x1b[${lineCount}A\r`);
      await delay(1000 / 24);
    }
    output.write(terminalFrame(logo, duration, true, indent));
  } finally {
    output.write('\x1b[0m\x1b[?25h');
    process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
    if (input.isTTY) { input.off('data', key); input.setRawMode(wasRaw ?? false); if (wasFlowing !== true) input.pause(); }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const variant = process.argv.find(value => value.startsWith('--variant='))?.split('=')[1];
  await previewLogo({ variant, still: process.argv.includes('--still') });
}
