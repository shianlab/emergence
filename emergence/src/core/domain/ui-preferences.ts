import { z } from 'zod';

export const actions = [
  'next',
  'previous',
  'cyclePermission',
  'splitRight',
  'splitDown',
  'tasks',
  'close',
  'maximize',
  'hide',
  'resizeLeft',
  'resizeRight',
  'resizeUp',
  'resizeDown',
  'escape',
  'pageUp',
  'pageDown',
] as const;
export type Action = (typeof actions)[number];
export const defaultKeys: Record<Action, string> = {
  next: 'Tab',
  previous: 'Ctrl+Shift+Tab',
  cyclePermission: 'Shift+Tab',
  splitRight: 'F2',
  splitDown: 'F3',
  tasks: 'F4',
  close: 'F6',
  maximize: 'F7',
  hide: 'F8',
  resizeLeft: 'Ctrl+Left',
  resizeRight: 'Ctrl+Right',
  resizeUp: 'Ctrl+Up',
  resizeDown: 'Ctrl+Down',
  escape: 'Escape',
  pageUp: 'PageUp',
  pageDown: 'PageDown',
};
export function effectiveKeys(ui: { keys: Partial<Record<Action, string>> }): Record<Action, string> {
  const keys = { ...defaultKeys, ...ui.keys };
  if (
    !ui.keys.cyclePermission &&
    Object.entries(keys).some(([action, key]) => action !== 'cyclePermission' && key === keys.cyclePermission)
  ) {
    keys.cyclePermission = [
      'F5',
      'Ctrl+F5',
      'Ctrl+Shift+F5',
      ...Array.from({ length: 12 }, (_, i) => `Ctrl+Shift+F${i + 1}`),
    ].find((key) => !Object.values(keys).includes(key))!;
  }
  return keys;
}
const names = ['Tab', 'Left', 'Right', 'Up', 'Down', 'Escape', 'PageUp', 'PageDown'];
export function normalizeKey(value: string): string {
  const parts = value.split('+'),
    raw = parts.pop() ?? '';
  const key =
    names.find((n) => n.toLowerCase() === raw.toLowerCase()) ??
    (/^f(?:[1-9]|1[0-2])$/i.test(raw) ? raw.toUpperCase() : '');
  const modifiers = parts.map((p) => p.toLowerCase());
  if (
    !key ||
    modifiers.some((p) => !['ctrl', 'shift'].includes(p)) ||
    new Set(modifiers).size !== modifiers.length
  )
    throw new Error('快捷键支持 F1–F12、Tab、方向键、Escape、PageUp/PageDown，可加 Ctrl/Shift');
  return `${modifiers.includes('ctrl') ? 'Ctrl+' : ''}${modifiers.includes('shift') ? 'Shift+' : ''}${key}`;
}
const color = z.string().regex(/^#[\da-fA-F]{6}$/);
export const paletteSchema = z
  .object({
    background: color,
    foreground: color,
    accent: color,
    border: color,
    muted: color,
    input: color,
    warning: color,
  })
  .strict();
export type Palette = z.infer<typeof paletteSchema>;
export const palettes: Record<'dark' | 'amber' | 'light', Palette> = {
  dark: {
    background: '#111111',
    foreground: '#dedede',
    accent: '#e5e5e5',
    border: '#444444',
    muted: '#a3a3a3',
    input: '#1c1c1c',
    warning: '#bbbbbb',
  },
  amber: {
    background: '#19140d',
    foreground: '#f5ead7',
    accent: '#fbbf24',
    border: '#786140',
    muted: '#c1ad8a',
    input: '#302414',
    warning: '#fb923c',
  },
  light: {
    background: '#f5f5f5',
    foreground: '#222222',
    accent: '#111111',
    border: '#aaaaaa',
    muted: '#5b5b5b',
    input: '#e8e8e8',
    warning: '#444444',
  },
};
export const uiSchema = z
  .object({
    theme: z.enum(['dark', 'amber', 'light']).default('dark'),
    colors: paletteSchema.partial().default({}),
    language: z.enum(['zh-CN', 'en']).default('zh-CN'),
    activityColor: z.enum(['amber', 'gray']).default('amber'),
    reducedMotion: z.boolean().default(false),
    keys: z.partialRecord(z.enum(actions), z.string().transform(normalizeKey)).default({}),
    statusBar: z
      .object({
        visible: z.boolean().default(true),
        fields: z
          .array(z.enum(['project', 'model', 'tasks', 'context']))
          .max(4)
          .default(['project', 'model', 'tasks']),
      })
      .strict()
      .default({ visible: true, fields: ['project', 'model', 'tasks'] }),
  })
  .strict()
  .superRefine((ui, ctx) => {
    const keys = Object.values(effectiveKeys(ui));
    if (new Set(keys).size !== keys.length)
      ctx.addIssue({ code: 'custom', message: '快捷键冲突；请先给原动作分配其他键' });
    if (new Set(ui.statusBar.fields).size !== ui.statusBar.fields.length)
      ctx.addIssue({ code: 'custom', message: '状态栏字段不能重复' });
  });
export type UIPreferences = z.infer<typeof uiSchema>;
export function palette(ui: UIPreferences): Palette {
  return { ...palettes[ui.theme], ...ui.colors };
}
export function keyAction(
  ui: UIPreferences,
  key: { name: string; ctrl?: boolean; shift?: boolean; meta?: boolean; option?: boolean },
): Action | undefined {
  if (key.meta || key.option) return;
  let name: string;
  try {
    name = normalizeKey(`${key.ctrl ? 'Ctrl+' : ''}${key.shift ? 'Shift+' : ''}${key.name}`);
  } catch {
    return;
  }
  return actions.find((action) => effectiveKeys(ui)[action] === name);
}
