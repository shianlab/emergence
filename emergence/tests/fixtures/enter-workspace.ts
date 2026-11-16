import { setTimeout as delay } from 'node:timers/promises';

/** Older feature suites exercise an opened workspace; the home route has its own suite. */
export async function enterWorkspace(
  screen: () => string,
  write: (bytes: string) => void,
  until: (label: string, predicate: () => boolean) => Promise<void>,
) {
  const frame = screen();
  if (!frame.includes('描述你要完成') && !frame.includes('Describe your task')) return;
  // A ConPTY frame can arrive in chunks: a visible composer does not mean the
  // restore button has arrived yet. Never create a workspace from that guess.
  write('\x01\x1b[200~/continue\x1b[201~');
  // /continue is deliberately absent from suggestions on a fresh home. Close
  // suggestions so Enter submits the typed command and receives a real result.
  await delay(100);
  write('\x1b');
  await delay(100);
  write('\r');
  await until(
    'continue or confirmed missing workspace',
    () =>
      screen().includes('[关闭]') ||
      screen().includes('[Close]') ||
      screen().includes('当前项目还没有保存的工作台'),
  );
  if (screen().includes('当前项目还没有保存的工作台')) {
    write('\x01\x1b[200~/new\x1b[201~');
    await delay(80);
    write('\r');
  }
  await until('open workspace from home', () => screen().includes('[关闭]') || screen().includes('[Close]'));
}
