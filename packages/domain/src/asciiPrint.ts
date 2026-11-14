/**
 * The ASCII print of a picture ground, shared by the desktop canvas and the
 * phone's shader so both draw the same characters. Each cell's luminance picks
 * a character from a ramp, and the character is drawn as a 5×5 bitmap: a GL
 * shader has no font, and a bitmap keeps the two platforms identical where a
 * system font would not.
 */

/** Characters from empty to dense; a cell's luminance picks one. */
export const ASCII_RAMP = " .:-=+*#%@";

/** Bitmap pixels per glyph edge. */
export const ASCII_GLYPH_SIZE = 5;

/**
 * Below six points a 5×5 glyph is narrower than the pixels that draw it and
 * the print reads as noise, so an ASCII cell is never smaller than this.
 */
export const ASCII_MIN_CELL = 6;

/** The cell an ASCII print starts at when the saved cell is too small to read. */
export const ASCII_DEFAULT_CELL = 8;

/** How much of the cell's colour the ground between strokes keeps. */
export const ASCII_GROUND_SHADE = 0.12;

/**
 * One row per entry, top first; bit 4 is the leftmost pixel. Every glyph lights
 * at least as many pixels as the one before it, so the ramp reads darker to
 * brighter.
 */
export const ASCII_GLYPH_ROWS: ReadonlyArray<readonly [number, number, number, number, number]> = [
  [0b00000, 0b00000, 0b00000, 0b00000, 0b00000],
  [0b00000, 0b00000, 0b00000, 0b00000, 0b00100],
  [0b00000, 0b00100, 0b00000, 0b00100, 0b00000],
  [0b00000, 0b00000, 0b01110, 0b00000, 0b00000],
  [0b00000, 0b01110, 0b00000, 0b01110, 0b00000],
  [0b00100, 0b00100, 0b11111, 0b00100, 0b00100],
  [0b00000, 0b10101, 0b01110, 0b10101, 0b00000],
  [0b01010, 0b11111, 0b01010, 0b11111, 0b01010],
  [0b11001, 0b11011, 0b00110, 0b11011, 0b10011],
  [0b01110, 0b10011, 0b10111, 0b10110, 0b01111],
];

/** The ramp index for a luminance in [0, 1]. */
export function asciiLevel(luminance: number): number {
  const clamped = Number.isFinite(luminance) ? Math.min(1, Math.max(0, luminance)) : 0;
  return Math.min(ASCII_RAMP.length - 1, Math.floor(clamped * ASCII_RAMP.length));
}

/** Rec. 709 luma of channels in [0, 1]. */
export function asciiLuminance(red: number, green: number, blue: number): number {
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** Whether glyph `level` lights its pixel at column `x`, row `y` (top-left origin). */
export function asciiGlyphLit(level: number, x: number, y: number): boolean {
  const rows = ASCII_GLYPH_ROWS[level];
  const row = rows?.[y];
  if (row === undefined || x < 0 || x >= ASCII_GLYPH_SIZE) return false;
  return ((row >> (ASCII_GLYPH_SIZE - 1 - x)) & 1) === 1;
}

/** The cell size an ASCII print draws at, never below `ASCII_MIN_CELL`. */
export function asciiCell(cell: number): number {
  return Math.max(ASCII_MIN_CELL, cell);
}

/**
 * Prints RGBA cells (one pixel per cell) as glyphs: the result is
 * `columns × 5` by `rows × 5` RGBA pixels, each glyph stroke in its cell's
 * colour over that colour darkened to `ASCII_GROUND_SHADE`.
 */
export function printAsciiCells(
  cells: Uint8ClampedArray,
  columns: number,
  rows: number,
): Uint8ClampedArray {
  const size = ASCII_GLYPH_SIZE;
  const width = columns * size;
  const out = new Uint8ClampedArray(width * rows * size * 4);
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const from = (row * columns + column) * 4;
      const red = cells[from] ?? 0;
      const green = cells[from + 1] ?? 0;
      const blue = cells[from + 2] ?? 0;
      const alpha = cells[from + 3] ?? 255;
      const level = asciiLevel(asciiLuminance(red / 255, green / 255, blue / 255));
      for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
          const shade = asciiGlyphLit(level, x, y) ? 1 : ASCII_GROUND_SHADE;
          const at = ((row * size + y) * width + column * size + x) * 4;
          out[at] = Math.round(red * shade);
          out[at + 1] = Math.round(green * shade);
          out[at + 2] = Math.round(blue * shade);
          out[at + 3] = alpha;
        }
      }
    }
  }
  return out;
}
