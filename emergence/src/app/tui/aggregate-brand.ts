import { StyledText, bg, fg } from '@opentui/core';

export type AggregateState = 'idle' | 'thinking' | 'tool' | 'done' | 'error';
const blend = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);
const smoothUnion = (a: number, b: number) => {
  const h = Math.max(0.18 - Math.abs(a - b), 0) / 0.18;
  return Math.min(a, b) - h * h * 0.18 * 0.25;
};

/** Three fused lobes and one independent satellite; fixed 8-column / 3-row bounds. */
export function aggregatePixels(state: AggregateState, tick: number, background: string, monochrome = false) {
  const back = [1, 3, 5].map((at) => parseInt(background.slice(at, at + 2), 16));
  const light = back.reduce((a, b) => a + b, 0) > 450;
  const body = light ? 48 : 230;
  const phase = ((tick % 20) * Math.PI) / 10;
  const motion = monochrome ? 0 : state === 'thinking' ? Math.sin(phase) * 0.035 : 0;
  const glow = monochrome
    ? body
    : state === 'idle'
      ? blend(light ? 70 : 185, body, (1 + Math.cos(phase)) / 2)
      : state === 'thinking'
        ? blend(light ? 85 : 160, body, (1 + Math.cos(phase * 2)) / 2)
        : body;
  const satellite =
    !monochrome && state === 'error'
      ? [196, 122, 111]
      : !monochrome && state === 'tool'
        ? [light ? 125 : 211, light ? 104 : 193, light ? 65 : 158]
        : [glow, glow, glow];
  return Array.from({ length: 6 }, (_, y) =>
    Array.from({ length: 16 }, (_, x) => {
      const px = (x + 0.5 - 2) / 12,
        py = (y + 0.5) / 6;
      const circle = (cx: number, cy: number, r: number) => Math.hypot(px - cx, py - cy) - r;
      const solid =
        smoothUnion(
          smoothUnion(circle(0.25, 0.25, 0.24), circle(0.25, 0.75, 0.24)),
          circle(0.75, 0.75, 0.24),
        ) <= 0;
      const dot = circle(0.76 + motion, 0.2 - Math.abs(motion), 0.195) <= 0;
      const color = solid ? [body, body, body] : dot ? satellite : back;
      return '#' + color.map((value) => Math.round(value).toString(16).padStart(2, '0')).join('');
    }),
  );
}

export function aggregateFrame(state: AggregateState, tick: number, background: string, monochrome = false) {
  const pixels = aggregatePixels(state, tick, background, monochrome),
    chunks = [];
  const blocks = ' ▘▝▀▖▌▞▛▗▚▐▜▄▙▟█';
  for (let y = 0; y < 6; y += 2) {
    for (let x = 0; x < 16; x += 2) {
      const group = [pixels[y][x], pixels[y][x + 1], pixels[y + 1][x], pixels[y + 1][x + 1]];
      const mask = group.reduce((value, color, index) => value | (color !== background ? 1 << index : 0), 0);
      const color = group.find((color) => color !== background) ?? background;
      chunks.push(fg(color)(bg(background)(blocks[mask])));
    }
    if (y < 4) chunks.push(fg(background)(bg(background)('\n')));
  }
  return new StyledText(chunks);
}
