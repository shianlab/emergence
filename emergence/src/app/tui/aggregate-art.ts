/** Approved A geometry. Coordinates match the SVG preview, including its quiet margin. */
export const aggregatePath =
  'M356 210 C438 210 504 275 504 355 C504 402 482 438 461 464 C439 491 440 525 468 544 C489 558 512 552 536 532 C567 506 601 494 642 494 C723 494 788 559 788 642 C788 725 722 790 642 790 C594 790 552 765 524 742 C508 729 488 729 472 740 C439 765 405 790 356 790 C274 790 208 724 208 642 C208 598 227 561 249 536 C272 509 269 484 249 459 C222 427 208 392 208 355 C208 275 275 210 356 210 Z';
export type AggregateState = 'idle' | 'thinking' | 'tool' | 'done' | 'error';
export const aggregateSize = 192;

// Flatten the approved Bézier outline once, then scan-convert at 2× resolution.
const numbers = aggregatePath.match(/\d+/g)!.map(Number);
const polygon: number[][] = [numbers.slice(0, 2)];
for (let i = 2; i < numbers.length; i += 6) {
  const [x, y] = polygon[polygon.length - 1];
  const [a, b, c, d, e, f] = numbers.slice(i, i + 6);
  for (let step = 1; step <= 24; step++) {
    const t = step / 24,
      u = 1 - t;
    polygon.push([
      u ** 3 * x + 3 * u * u * t * a + 3 * u * t * t * c + t ** 3 * e,
      u ** 3 * y + 3 * u * u * t * b + 3 * u * t * t * d + t ** 3 * f,
    ]);
  }
}
const sampleSize = aggregateSize * 2;
const bodyMask = new Uint8Array(sampleSize * sampleSize);
for (let row = 0; row < sampleSize; row++) {
  const y = 180 + ((row + 0.5) * 640) / sampleSize,
    intersections: number[] = [];
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i],
      b = polygon[j];
    if (a[1] > y !== b[1] > y) intersections.push(a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
  }
  intersections.sort((a, b) => a - b);
  for (let i = 0; i + 1 < intersections.length; i += 2) {
    const start = Math.max(0, Math.ceil(((intersections[i] - 180) * sampleSize) / 640 - 0.5));
    const end = Math.min(sampleSize, Math.ceil(((intersections[i + 1] - 180) * sampleSize) / 640 - 0.5));
    bodyMask.fill(1, row * sampleSize + start, row * sampleSize + end);
  }
}

/** Opaque RGBA prevents stale pixels on terminals with Sixel; only the satellite changes. */
export function aggregateRgba(state: AggregateState, tick: number, background: string, monochrome = false) {
  const back = [1, 3, 5].map((at) => parseInt(background.slice(at, at + 2), 16));
  const light = back.reduce((a, b) => a + b, 0) > 450;
  const body = light ? [48, 48, 48] : [238, 238, 236];
  const wave = state === 'thinking' ? (1 - Math.cos(((tick % 20) * Math.PI) / 10)) / 2 : 0;
  const cy = 346 - 8 * wave,
    opacity = 1 - 0.42 * wave;
  const dot = monochrome
    ? body
    : state === 'tool'
      ? light
        ? [109, 97, 65]
        : [203, 189, 157]
      : state === 'error'
        ? [197, 141, 134]
        : light
          ? body
          : state === 'done'
            ? [255, 255, 255]
            : [238, 238, 238];
  const pixels = new Uint8Array(aggregateSize * aggregateSize * 4);
  for (let y = 0; y < aggregateSize; y++)
    for (let x = 0; x < aggregateSize; x++) {
      const color = [0, 0, 0];
      for (let sy = 0; sy < 2; sy++)
        for (let sx = 0; sx < 2; sx++) {
          const xx = x * 2 + sx,
            yy = y * 2 + sy;
          const px = 180 + ((xx + 0.5) * 640) / sampleSize,
            py = 180 + ((yy + 0.5) * 640) / sampleSize;
          const solid = bodyMask[yy * sampleSize + xx];
          const satellite = (px - 656) ** 2 + (py - cy) ** 2 <= 136 ** 2;
          for (let c = 0; c < 3; c++)
            color[c] += (solid ? body[c] : satellite ? back[c] + (dot[c] - back[c]) * opacity : back[c]) / 4;
        }
      const at = (y * aggregateSize + x) * 4;
      pixels.set(color.map(Math.round), at);
      pixels[at + 3] = 255;
    }
  return pixels;
}
