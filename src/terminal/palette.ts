import type { Color } from './types';

// Common xterm-style 16-color palette followed by a 6x6x6 cube and grays.
const BASE: Array<[number, number, number]> = [
  [0, 0, 0],
  [205, 0, 0],
  [0, 205, 0],
  [205, 205, 0],
  [0, 0, 238],
  [205, 0, 205],
  [0, 205, 205],
  [229, 229, 229],
  [127, 127, 127],
  [255, 0, 0],
  [0, 255, 0],
  [255, 255, 0],
  [92, 92, 255],
  [255, 0, 255],
  [0, 255, 255],
  [255, 255, 255]
];

function buildPalette(): string[] {
  const palette = BASE.map(([r, g, b]) => rgb(r, g, b));
  const levels = [0, 95, 135, 175, 215, 255];
  for (const r of levels) {
    for (const g of levels) {
      for (const b of levels) palette.push(rgb(r, g, b));
    }
  }
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10;
    palette.push(rgb(v, v, v));
  }
  return palette;
}

function rgb(r: number, g: number, b: number): string {
  return `rgb(${r}, ${g}, ${b})`;
}

const PALETTE = buildPalette();

export function resolveColor(color: Color, fallback: string): string {
  if (color.kind === 'default') return fallback;
  if (color.kind === 'rgb') return rgb(color.value[0], color.value[1], color.value[2]);
  return PALETTE[color.index % PALETTE.length]!;
}
