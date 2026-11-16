import {
  BoxRenderable,
  TextRenderable,
  TextareaRenderable,
  type CliRenderer,
  type KeyEvent,
} from '@opentui/core';
import { safeError } from '../core/adapters/redaction.ts';
import type { Palette } from '../core/domain/ui-preferences.ts';
import type { Interaction, InteractionAnswer } from './interactions.ts';
import { sizeEditor } from './tui/composer.ts';

/** A pane-local selector. Its editor is deliberately separate from the chat draft. */
export function mountInteractionUI(
  renderer: CliRenderer,
  respond: (request: Interaction, answer: InteractionAnswer) => void,
  report: (error: unknown) => void,
) {
  const box = new BoxRenderable(renderer, { visible: false, flexDirection: 'column', flexShrink: 0 });
  const choices = new TextRenderable(renderer, { content: '', selectable: false });
  const hint = new TextRenderable(renderer, { content: '', height: 1, wrapMode: 'none', truncate: true });
  const answer = new TextareaRenderable(renderer, {
    height: 3,
    minHeight: 2,
    visible: false,
    placeholder: '输入回答 · Enter 提交 · Esc 返回',
    keyBindings: [
      { name: 'return', action: 'submit' },
      { name: 'return', shift: true, action: 'newline' },
      { name: 'a', ctrl: true, action: 'select-all' },
    ],
    onSubmit() {
      submit();
    },
  });
  box.add(choices);
  box.add(answer);
  box.add(hint);
  let request: Interaction | undefined,
    focused = false,
    selected = 0,
    custom = false;
  let chosen = new Set<string>(),
    respondedAt = -Infinity,
    armedAt = 0;
  let english = false;
  const send = (value: InteractionAnswer) => {
    if (!request) return;
    try {
      respondedAt = performance.now();
      respond(request, value);
    } catch (error) {
      report(error);
    }
  };
  const submit = () => {
    if (!request || performance.now() < armedAt) return;
    if (custom || request.kind === 'text') {
      send({ action: 'submit', text: answer.plainText });
      return;
    }
    if (selected === request.options.length && request.allowCustom) {
      custom = true;
      render();
      return;
    }
    send({
      action: 'submit',
      selected: request.kind === 'multiChoice' ? [...chosen] : [request.options[selected].id],
    });
  };
  const render = () => {
    box.visible = Boolean(request);
    if (!request) {
      answer.blur();
      return;
    }
    const editing = custom || request.kind === 'text';
    answer.visible = editing;
    choices.visible = !editing;
    if (editing) {
      sizeEditor(answer, renderer.height, 5);
      if (focused) answer.focus();
      else answer.blur();
      hint.content = english
        ? 'Enter submit · Shift+Enter newline · Esc back/cancel'
        : 'Enter 提交 · Shift+Enter 换行 · Esc 返回/取消';
    } else {
      answer.blur();
      const current = request;
      const labels = current.options.map(
        (option, i) =>
          `${selected === i ? '›' : ' '} ${current.kind === 'multiChoice' ? (chosen.has(option.id) ? '[x]' : '[ ]') : `${i + 1}.`} ${safeError(
            english && current.kind === 'permission'
              ? option.id === 'confirm'
                ? 'Checked, confirm this operation'
                : option.id === 'cancel'
                  ? 'Cancel'
                  : option.id === 'allow'
                    ? 'Allow once'
                    : option.id === 'session'
                      ? 'Allow identical operation for this session (same agent, directory and arguments)'
                      : 'Reject'
              : option.label,
          )
            .replaceAll('\n', ' ')
            .slice(0, 160)}`,
      );
      if (request.allowCustom)
        labels.push(
          `${selected === request.options.length ? '›' : ' '} ${english ? 'Custom answer…' : '自定义回答…'}`,
        );
      const start = Math.max(0, Math.min(selected - 2, labels.length - 4));
      choices.content = labels.slice(start, start + 4).join('\n');
      choices.height = Math.min(4, labels.length);
      hint.content = english
        ? `↑↓ select · Enter confirm${request.kind === 'multiChoice' ? ' · Space toggle' : ''} · Esc cancel`
        : `↑↓ 选择 · Enter 确认${request.kind === 'multiChoice' ? ' · Space 多选' : ''} · Esc 取消`;
    }
  };
  return {
    box,
    answer,
    get editing() {
      return Boolean(request && (custom || request.kind === 'text'));
    },
    get blocksSubmit() {
      return performance.now() < respondedAt + 350;
    },
    releaseSubmitGuard() {
      respondedAt = -Infinity;
    },
    sync(next: Interaction | undefined, active: boolean, colors: Palette, en: boolean) {
      if (request?.id !== next?.id) {
        request = next;
        selected = 0;
        chosen = new Set();
        custom = false;
        answer.setText('');
        // Raw terminals cannot report key-repeat. Also swallow a rapid second Enter
        // crossing request boundaries; Kitty repeat events are rejected below.
        armedAt = Math.max(performance.now() + 100, respondedAt + 350);
      }
      focused = active;
      english = en;
      choices.fg = colors.foreground;
      hint.fg = colors.muted;
      answer.backgroundColor = colors.input;
      answer.focusedBackgroundColor = colors.input;
      answer.textColor = colors.foreground;
      answer.focusedTextColor = colors.foreground;
      render();
    },
    handleKey(key: KeyEvent): boolean {
      if (!request || !focused) return false;
      const consume = () => {
        key.preventDefault();
        key.stopPropagation();
        return true;
      };
      if (key.name === 'escape') {
        consume();
        if (custom) {
          custom = false;
          render();
        } else send({ action: 'cancel' });
        return true;
      }
      if (key.name === 'return' && !(key.shift && (custom || request.kind === 'text'))) {
        consume();
        if (key.eventType !== 'repeat' && !key.repeated) submit();
        return true;
      }
      if (custom || request.kind === 'text') return false;
      if (!key.ctrl && !key.meta && !key.option) {
        const count = request.options.length + Number(request.allowCustom);
        if (['up', 'down', 'left', 'right'].includes(key.name)) {
          selected = (selected + (['up', 'left'].includes(key.name) ? count - 1 : 1)) % count;
          render();
          return consume();
        }
        if (key.name === 'space' && request.kind === 'multiChoice' && selected < request.options.length) {
          const id = request.options[selected].id;
          if (chosen.has(id)) chosen.delete(id);
          else chosen.add(id);
          render();
          return consume();
        }
        if (request.kind === 'permission' && ['y', 'n'].includes(key.name.toLowerCase())) {
          const index = request.options.findIndex((option) => option.value === key.name.toLowerCase());
          if (index >= 0) selected = index;
          render();
          return consume();
        }
        if (/^[1-9]$/.test(key.name) && Number(key.name) <= request.options.length) {
          selected = Number(key.name) - 1;
          render();
          return consume();
        }
        // Printable input/paste cannot fall through into the hidden chat editor.
        if (key.name.length === 1 || ['space', 'backspace', 'delete'].includes(key.name)) return consume();
      }
      return false;
    },
  };
}
