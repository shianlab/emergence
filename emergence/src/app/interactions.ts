import { randomUUID } from 'node:crypto';
import type { Interaction, InteractionAnswer, InteractionSpec } from '../core/domain/interaction.ts';
export type { Interaction, InteractionAnswer, InteractionSpec } from '../core/domain/interaction.ts';

/** One queue per owning controller. Never parse a response before checking its identity. */
export class InteractionQueue {
  private entries: Array<{ request: Interaction; answer(value: InteractionAnswer): void; cancel(): void }> =
    [];
  constructor(private changed: () => void) {}
  get pending() {
    return this.entries[0]?.request;
  }
  get all() {
    return this.entries.map((e) => e.request);
  }
  answer(id: string, version: number, value: InteractionAnswer) {
    const entry = this.entries[0];
    if (
      !entry ||
      entry.request.id !== id ||
      entry.request.version !== version ||
      entry.request.status !== 'pending'
    )
      throw new Error('确认请求已过期或不属于当前待处理请求');
    entry.answer(value);
  }
  cancelAll() {
    for (const entry of [...this.entries]) entry.cancel();
  }
  cancelPermissions() {
    for (const entry of [...this.entries]) if (entry.request.kind === 'permission') entry.cancel();
  }
  cancelWhere(predicate: (request: Interaction) => boolean) {
    for (const entry of [...this.entries]) if (predicate(entry.request)) entry.cancel();
  }
  request<T>(
    spec: InteractionSpec,
    parse: (text: string) => T,
    signal?: AbortSignal,
    onCancel?: () => T,
    parseAnswer?: (answer: Exclude<InteractionAnswer, { action: 'cancel' }>) => T,
    isCurrent: () => boolean = () => true,
  ): Promise<T> {
    spec = structuredClone(spec);
    return new Promise((resolve, reject) => {
      let status: Interaction['status'] = 'pending';
      const finish = (next: Interaction['status']) => {
        status = next;
        this.entries = this.entries.filter((item) => item !== entry);
        signal?.removeEventListener('abort', cancel);
        this.changed();
      };
      const cancel = () => {
        if (status !== 'pending') return;
        finish('cancelled');
        try {
          if (onCancel) resolve(onCancel());
          else reject(new Error('交互已取消'));
        } catch (error) {
          reject(error);
        }
      };
      const respond = (text: string) => {
        if (status !== 'pending' || this.entries[0] !== entry)
          throw new Error('确认请求已过期或尚未轮到处理');
        validate();
        const result = parse(text); // Invalid input leaves the same request available.
        finish('resolved');
        resolve(result);
      };
      const submit = (answer: Exclude<InteractionAnswer, { action: 'cancel' }>, legacy: string) => {
        validate();
        if (!parseAnswer) {
          respond(legacy);
          return;
        }
        const result = parseAnswer(answer);
        finish('resolved');
        resolve(result);
      };
      const validate = () => {
        let current = false;
        try {
          current = isCurrent();
        } catch {
          /* Unverifiable lifetime fails closed. */
        }
        if (current) return;
        cancel();
        throw new Error('确认请求的执行归属、参数或权限已变化，已取消旧请求');
      };
      const request: Interaction = {
        ...spec,
        options: spec.options.map((option) => ({ ...option })),
        id: spec.binding?.nativeId ?? randomUUID(),
        version: 1,
        get status() {
          return status;
        },
        respond,
      };
      for (const option of request.options) Object.freeze(option);
      Object.freeze(request.options);
      if (request.binding) Object.freeze(request.binding);
      Object.freeze(request);
      const entry = {
        request,
        cancel,
        answer: (answer: InteractionAnswer) => {
          if (answer.action === 'cancel') {
            cancel();
            return;
          }
          if (answer.text !== undefined) {
            if (!spec.allowCustom || answer.selected?.length || !answer.text.trim())
              throw new Error('请输入有效回答');
            submit(answer, answer.text);
            return;
          }
          const ids = answer.selected ?? [];
          if (
            !ids.length ||
            new Set(ids).size !== ids.length ||
            (spec.kind !== 'multiChoice' && ids.length !== 1)
          )
            throw new Error('请选择有效选项');
          const options = ids.map((id) => spec.options.find((option) => option.id === id));
          if (options.some((option) => !option)) throw new Error('选项已失效');
          submit(answer, options.map((option) => option!.value).join(','));
        },
      };
      if (signal?.aborted) {
        cancel();
        return;
      }
      this.entries.push(entry);
      signal?.addEventListener('abort', cancel, { once: true });
      this.changed();
    });
  }
}
