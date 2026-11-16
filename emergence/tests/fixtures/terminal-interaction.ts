import { setTimeout as delay } from 'node:timers/promises';
import stringWidth from 'string-width';

/** Resolve a visible label to terminal cells; header rows move as the UI evolves. */
export function clickTerminalText(label: string, screen: () => string, write: (bytes: string) => void) {
  const lines = screen().split('\n');
  for (let row = lines.length - 1; row >= 0; row--) {
    const index = lines[row].lastIndexOf(label);
    if (index < 0) continue;
    const column = stringWidth(lines[row].slice(0, index)) + Math.floor(stringWidth(label) / 2) + 1;
    write(`\x1b[<0;${column};${row + 1}M\x1b[<0;${column};${row + 1}m`);
    return;
  }
  throw new Error(`Visible terminal label not found: ${label}`);
}

/** Drive real key events; a pasted answer is deliberately not an approval. */
export async function sendTerminalInput(text: string, screen: () => string, write: (bytes: string) => void) {
  const frame = screen();
  if (/^[yn1-9]$/i.test(text) && (frame.includes('Enter 确认') || frame.includes('Enter confirm'))) {
    write(text);
    await delay(400);
    write('\r');
    await delay(80);
    return;
  }
  const home = frame.includes('描述你要完成') || frame.includes('Describe your task');
  if (text.startsWith('/') && !home) {
    write('\x10');
    await delay(80);
  }
  write('\x01');
  write(`\x1b[200~${text}\x1b[201~`);
  await delay(100);
  write('\r');
  await delay(80);
}

/** Explicit exit command preserves chat drafts; Ctrl+C behavior has a dedicated suite. */
export async function exitTerminal(screen: () => string, write: (bytes: string) => void) {
  await sendTerminalInput('/exit', screen, write);
}
