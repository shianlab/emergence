import { StyledText, bg, fg } from '@opentui/core';

/** Compact A: five visible pixel rows (2.5 text rows), with one padding half-row. */
export const volcanoGrid = ['   a    ', '  ahha  ', ' hrkkrh ', 'hrwkkwrh', ' arrrra ', '        '];
export const volcanoColumns = volcanoGrid[0].length;
export const volcanoRows = volcanoGrid.length / 2;
export type VolcanoState = 'idle' | 'thinking' | 'tool' | 'done' | 'error';

export function volcanoFrame(state: VolcanoState, tick: number, background: string, monochrome = false) {
  const colors: Record<string, string> = monochrome
    ? { a: '#b8b8b8', h: '#dedede', w: '#eeeeee', r: '#454545', k: '#252525', ' ': background }
    : { a: '#f49a35', h: '#ffd081', w: '#f6e7c6', r: '#303739', k: '#171c1e', ' ': background };
  if (state === 'error' && !monochrome) {
    colors.a = '#cb573e';
    colors.h = '#e88655';
  }
  const grid = volcanoGrid.map((line) => [...line]);
  // Keep every animation inside the same silhouette; no outward particle bursts.
  if (state === 'thinking' && Math.floor(tick / 3) % 2) grid[0][3] = 'h';
  if (state === 'tool') grid[0][3] = 'w';
  if (state === 'idle' && tick % 20 === 19) {
    grid[3][2] = 'k';
    grid[3][5] = 'k';
  }
  if (state === 'done') grid[0][3] = 'h';
  const chunks = [];
  for (let y = 0; y < grid.length; y += 2) {
    for (let x = 0; x < volcanoColumns; x++)
      chunks.push(fg(colors[grid[y][x]])(bg(colors[grid[y + 1][x]])('▀')));
    if (y < grid.length - 2) chunks.push(fg(background)(bg(background)('\n')));
  }
  return new StyledText(chunks);
}
