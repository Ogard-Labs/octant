import { describe, expect, it } from "vitest";
import {
  ASCII_GLYPH_ROWS,
  ASCII_GLYPH_SIZE,
  ASCII_RAMP,
  asciiCell,
  asciiGlyphLit,
  asciiLevel,
  printAsciiCells,
} from "./asciiPrint";

function litCount(level: number): number {
  let count = 0;
  for (let y = 0; y < ASCII_GLYPH_SIZE; y += 1) {
    for (let x = 0; x < ASCII_GLYPH_SIZE; x += 1) if (asciiGlyphLit(level, x, y)) count += 1;
  }
  return count;
}

describe("ASCII print", () => {
  it("has one glyph per ramp character, each at least as dense as the one before", () => {
    expect(ASCII_GLYPH_ROWS).toHaveLength(ASCII_RAMP.length);
    const counts = ASCII_RAMP.split("").map((_, level) => litCount(level));
    expect(counts[0]).toBe(0);
    for (let level = 1; level < counts.length; level += 1) {
      expect(counts[level]).toBeGreaterThanOrEqual(counts[level - 1] ?? 0);
    }
    expect(counts.at(-1)).toBeGreaterThan(counts.at(-2) ?? 0);
  });

  it("maps black to a space and white to the densest glyph", () => {
    expect(asciiLevel(0)).toBe(0);
    expect(asciiLevel(1)).toBe(ASCII_RAMP.length - 1);
    expect(asciiLevel(Number.NaN)).toBe(0);
    expect(asciiLevel(0.55)).toBe(5);
  });

  it("never prints a cell smaller than six points", () => {
    expect(asciiCell(2)).toBe(6);
    expect(asciiCell(10)).toBe(10);
  });

  it("draws a white cell's glyph strokes in its colour over a darkened ground", () => {
    const printed = printAsciiCells(new Uint8ClampedArray([250, 250, 250, 255]), 1, 1);
    expect(printed).toHaveLength(ASCII_GLYPH_SIZE * ASCII_GLYPH_SIZE * 4);
    // The "@" glyph leaves its top-left corner dark and lights the pixel beside it.
    expect(Array.from(printed.slice(0, 4))).toEqual([30, 30, 30, 255]);
    expect(Array.from(printed.slice(4, 8))).toEqual([250, 250, 250, 255]);
  });
});
