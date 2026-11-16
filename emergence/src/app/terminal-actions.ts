import { createHostClipboard, type CliRenderer, type KeyEvent, type TextareaRenderable } from '@opentui/core';

/** Shared by the home and workspace views; no confirmation or layout policy here. */
export function terminalActions(renderer: CliRenderer, notice: (message: string) => void, exit: () => void) {
  let exitDeadline = 0;
  const clipboard = createHostClipboard({ timeoutMs: 1500 });
  return {
    reset() {
      exitDeadline = 0;
    },
    copy(input?: TextareaRenderable) {
      const text = renderer.getSelection()?.getSelectedText() || input?.getSelectedText() || '';
      if (!text) return false;
      exitDeadline = 0;
      void clipboard
        .writeText(text)
        .then((result) => {
          if (result.status === 'written') notice('已复制');
          else if (renderer.copyToClipboardOSC52(text)) notice('已向终端发送复制请求');
          else notice('终端无法复制，请使用终端自带的复制快捷键');
        })
        .catch(() => notice('复制失败，请使用终端自带的复制快捷键'));
      return true;
    },
    confirmExit(key: KeyEvent) {
      if (key.eventType === 'repeat' || key.repeated) return;
      if (performance.now() < exitDeadline) {
        exitDeadline = 0;
        exit();
      } else {
        exitDeadline = performance.now() + 2000;
        notice('再次按 Ctrl+C 退出全部窗口（2 秒内），/exit 也可退出');
      }
    },
    dispose() {
      void clipboard.dispose();
    },
  };
}
