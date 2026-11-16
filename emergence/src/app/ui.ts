import {
  BoxRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  TextareaRenderable,
  createCliRenderer,
  type CliRenderer,
} from '@opentui/core';
import { safeError } from '../core/adapters/redaction.ts';
import type { SessionController } from './controller.ts';

export function mountSessionUI(renderer: CliRenderer, controller: SessionController, exit: () => void) {
  const page = new BoxRenderable(renderer, {
    width: '100%',
    height: '100%',
    flexDirection: 'column',
    padding: 1,
  });
  const header = new TextRenderable(renderer, { height: 2, fg: '#67e8f9', content: '涌现 · Emergence' });
  const scroll = new ScrollBoxRenderable(renderer, {
    flexGrow: 1,
    stickyScroll: true,
    stickyStart: 'bottom',
    scrollY: true,
  });
  const transcript = new TextRenderable(renderer, { content: '' });
  scroll.add(transcript);
  const notice = new TextRenderable(renderer, { content: '', fg: '#fbbf24', maxHeight: 7 });
  const input = new TextareaRenderable(renderer, {
    height: 4,
    minHeight: 3,
    backgroundColor: '#162238',
    placeholder: '输入任务 · Enter 发送 · Shift+Enter 换行',
    keyBindings: [
      { name: 'return', action: 'submit' },
      { name: 'return', shift: true, action: 'newline' },
    ],
    onSubmit() {
      const text = input.plainText.trim();
      if (!text) return;
      input.setText('');
      void controller.send(text).catch((error) => {
        input.setText(text);
        controller.notice = safeError(error);
        controller.changed();
      });
    },
  });
  const footer = new TextRenderable(renderer, {
    height: 1,
    content: 'Enter 发送 | Shift+Enter 换行 | Esc 停止 | Ctrl+C 退出 | /help',
  });
  [header, scroll, notice, input, footer].forEach((child) => page.add(child));
  renderer.root.add(page);
  const refresh = () => {
    header.content = `涌现 · Emergence   ${controller.busy ? '● 工作中' : '○ 就绪'}   ${controller.model.provider}/${controller.model.model}\n${controller.cwd}   会话 ${controller.id ?? ''}`;
    transcript.content = controller.pending
      ? safeError(controller.pending.title)
      : controller
          .transcript()
          .slice(-200)
          .map((line) => line.slice(0, 16000))
          .join('\n\n') + (controller.live ? `\n\n涌现 › ${safeError(controller.live.slice(-16000))}` : '');
    notice.content = controller.pending
      ? '等待回答 · PgUp/PgDn 查看完整内容 · Esc 取消'
      : safeError(controller.notice);
  };
  controller.on('change', refresh);
  controller.on('exit', exit);
  renderer.keyInput.on('keypress', (key) => {
    if (key.ctrl && key.name === 'c') {
      key.preventDefault();
      exit();
    }
    if (key.name === 'escape') {
      key.preventDefault();
      void controller.cancel().catch((error) => {
        controller.notice = safeError(error);
        controller.changed();
      });
    }
    if (key.name === 'pageup') {
      key.preventDefault();
      scroll.scrollBy(-8);
    }
    if (key.name === 'pagedown') {
      key.preventDefault();
      scroll.scrollBy(8);
    }
  });
  input.focus();
  refresh();
  return {
    input,
    refresh,
    dispose() {
      controller.off('change', refresh);
      controller.off('exit', exit);
    },
  };
}

export async function startUI(controller: SessionController, exit: () => void) {
  const renderer = await createCliRenderer({ exitOnCtrlC: false, useMouse: true });
  const view = mountSessionUI(renderer, controller, exit);
  return {
    dispose() {
      view.dispose();
      renderer.destroy();
    },
  };
}
