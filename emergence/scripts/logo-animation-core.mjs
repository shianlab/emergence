// Shared by the terminal demonstration and the inline animation preview.
// The accepted half-block logo remains the single source of pixel geometry.
export const BACKGROUND = [17, 17, 17];
export const REVEAL_MS = 1500;
export const DURATION_MS = 3600;
export const MONOCHROME_PALETTE = [
  [238, 238, 238],
  [227, 227, 227],
  [215, 215, 215],
  [201, 201, 201],
  [180, 180, 180],
];

export function decodeLogo(text) {
  const lines = text.replace(/\r/g, '').replace(/\n$/, '').split('\n');
  const width = Math.max(...lines.map((line) => line.length));
  const height = lines.length * 2;
  const pixels = [];
  for (let row = 0; row < lines.length; row++) {
    for (let x = 0; x < lines[row].length; x++) {
      const char = lines[row][x];
      if (![' ', '▀', '▄', '█'].includes(char)) throw new Error('Unsupported logo character');
      if (char === '▀' || char === '█') pixels.push([x, row * 2]);
      if (char === '▄' || char === '█') pixels.push([x, row * 2 + 1]);
    }
  }
  return { width, height, pixels };
}

export function appearance(x, y, width, height, elapsed) {
  const travel = (x / width) * 0.82 + (1 - y / height) * 0.18;
  const born = 40 + travel * 390;
  const progress = Math.max(0, Math.min(1, (elapsed - born) / 900));
  return progress * progress * (3 - 2 * progress);
}

export function logoColor(x, y, width, height, elapsed) {
  // The latest design uses white-to-gray lightness with no hue tint.
  const drift = Math.sin(elapsed / 6500) * 0.035;
  const position = Math.max(0, Math.min(1, (x / width) * 0.12 + (y / height) * 0.86 + drift));
  const scaled = position * (MONOCHROME_PALETTE.length - 1);
  const index = Math.min(MONOCHROME_PALETTE.length - 2, Math.floor(scaled));
  const blend = scaled - index;
  return MONOCHROME_PALETTE[index].map((value, channel) =>
    Math.round(value + (MONOCHROME_PALETTE[index + 1][channel] - value) * blend),
  );
}

export function pixelColor(x, y, width, height, elapsed, still = false) {
  const opacity = still ? 1 : appearance(x, y, width, height, elapsed);
  const color = logoColor(x, y, width, height, elapsed);
  return color.map((value, index) => Math.round(BACKGROUND[index] + (value - BACKGROUND[index]) * opacity));
}

export function terminalFrame(logo, elapsed, still = false, indent = 0) {
  const escape = '\x1b[';
  const pixels = new Set(logo.pixels.map(([x, y]) => y * logo.width + x));
  let frame = '';
  for (let y = 0; y < logo.height; y += 2) {
    frame += escape + '0m' + ' '.repeat(indent);
    let lastForeground = '',
      lastBackground = '';
    for (let x = 0; x < logo.width; x++) {
      const upper = pixels.has(y * logo.width + x);
      const lower = pixels.has((y + 1) * logo.width + x);
      const top = upper ? pixelColor(x, y, logo.width, logo.height, elapsed, still) : BACKGROUND;
      const bottom = lower ? pixelColor(x, y + 1, logo.width, logo.height, elapsed, still) : BACKGROUND;
      // Independent foreground/background colors preserve both half-pixels.
      const foreground = top.join(';'),
        background = bottom.join(';');
      if (foreground !== lastForeground) {
        frame += escape + '38;2;' + foreground + 'm';
        lastForeground = foreground;
      }
      if (background !== lastBackground) {
        frame += escape + '48;2;' + background + 'm';
        lastBackground = background;
      }
      frame += upper || lower ? '▀' : ' ';
    }
    frame += escape + '0m\r\n';
  }
  return frame;
}
