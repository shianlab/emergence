import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export type Layout =
  | { kind: 'pane'; pane: string }
  | { kind: 'split'; id: string; axis: 'row' | 'column'; ratio: number; first: Layout; second: Layout };
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export const layoutSchema: z.ZodType<Layout> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('pane'), pane: z.string().min(1) }).strict(),
    z
      .object({
        kind: z.literal('split'),
        id: z.string().min(1),
        axis: z.enum(['row', 'column']),
        ratio: z.number().min(0.15).max(0.85),
        first: layoutSchema,
        second: layoutSchema,
      })
      .strict(),
  ]),
);
export function leaves(tree: Layout): string[] {
  return tree.kind === 'pane' ? [tree.pane] : [...leaves(tree.first), ...leaves(tree.second)];
}
export function splitPane(tree: Layout, target: string, pane: string, axis: 'row' | 'column'): Layout {
  if (tree.kind === 'pane')
    return tree.pane === target
      ? { kind: 'split', id: randomUUID(), axis, ratio: 0.5, first: tree, second: { kind: 'pane', pane } }
      : tree;
  return {
    ...tree,
    first: splitPane(tree.first, target, pane, axis),
    second: splitPane(tree.second, target, pane, axis),
  };
}
export function removePane(tree: Layout, pane: string): Layout | undefined {
  if (tree.kind === 'pane') return tree.pane === pane ? undefined : tree;
  const first = removePane(tree.first, pane),
    second = removePane(tree.second, pane);
  return first && second ? { ...tree, first, second } : (first ?? second);
}
export function resizeSplit(tree: Layout, id: string, ratio: number): Layout {
  if (tree.kind === 'pane') return tree;
  return {
    ...tree,
    ratio: tree.id === id ? Math.max(0.15, Math.min(0.85, ratio)) : tree.ratio,
    first: resizeSplit(tree.first, id, ratio),
    second: resizeSplit(tree.second, id, ratio),
  };
}
export function ancestors(tree: Layout, pane: string): Extract<Layout, { kind: 'split' }>[] {
  if (tree.kind === 'pane') return [];
  if (leaves(tree.first).includes(pane)) return [tree, ...ancestors(tree.first, pane)];
  if (leaves(tree.second).includes(pane)) return [tree, ...ancestors(tree.second, pane)];
  return [];
}
export function geometry(tree: Layout, bounds: Rect) {
  const panes = new Map<string, Rect>();
  const splits = new Map<string, { bounds: Rect; divider: Rect; axis: 'row' | 'column' }>();
  const visit = (node: Layout, area: Rect) => {
    if (node.kind === 'pane') {
      panes.set(node.pane, area);
      return;
    }
    const length = (node.axis === 'row' ? area.width : area.height) - 1;
    const first = Math.max(1, Math.floor(length * node.ratio)),
      second = Math.max(1, length - first);
    if (node.axis === 'row') {
      splits.set(node.id, {
        bounds: area,
        axis: node.axis,
        divider: { x: area.x + first, y: area.y, width: 1, height: area.height },
      });
      visit(node.first, { ...area, width: first });
      visit(node.second, { ...area, x: area.x + first + 1, width: second });
    } else {
      splits.set(node.id, {
        bounds: area,
        axis: node.axis,
        divider: { x: area.x, y: area.y + first, width: area.width, height: 1 },
      });
      visit(node.first, { ...area, height: first });
      visit(node.second, { ...area, y: area.y + first + 1, height: second });
    }
  };
  visit(tree, bounds);
  return { panes, splits };
}

/** Small command tokenizer: quotes protect spaces; Windows backslashes remain literal. */
export function commandTokens(text: string): string[] {
  const tokens: string[] = [];
  let value = '',
    quote = '',
    active = false;
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = '';
      else value += char;
      active = true;
    } else if (char === '"' || char === "'") {
      quote = char;
      active = true;
    } else if (/\s/.test(char)) {
      if (active) tokens.push(value);
      value = '';
      active = false;
    } else {
      value += char;
      active = true;
    }
  }
  if (quote) throw new Error('引号没有闭合');
  if (active) tokens.push(value);
  return tokens;
}
