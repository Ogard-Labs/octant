import { describe, expect, it } from "vitest";
import { bayerThreshold, ditherPixels } from "./appBackdropPhoto";

describe("welcome photo dither", () => {
  it("spreads a flat mid-grey across neighbouring levels instead of one flat tone", () => {
    const width = 8;
    const height = 8;
    const pixels = new Uint8ClampedArray(width * height * 4).fill(128);
    ditherPixels(pixels, width, height);

    const levels = new Set<number>();
    let sum = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      const value = pixels[index] ?? -1;
      levels.add(value);
      sum += value;
      // Alpha is left alone: the photo stays opaque where it was.
      expect(pixels[index + 3]).toBe(128);
    }
    // Four levels per channel is the print: nothing lands between them.
    for (const level of levels) expect([0, 85, 170, 255]).toContain(level);
    expect(levels.size).toBeGreaterThan(1);
    // The pattern keeps the average tone, which is what makes it read as grey.
    expect(sum / (width * height)).toBeGreaterThan(110);
    expect(sum / (width * height)).toBeLessThan(146);
  });

  it("uses an ordered threshold that repeats every eight cells and covers the full range", () => {
    const seen = new Set<number>();
    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < 8; x += 1) {
        const threshold = bayerThreshold(x, y);
        expect(threshold).toBeGreaterThan(0);
        expect(threshold).toBeLessThan(1);
        expect(bayerThreshold(x + 8, y + 16)).toBe(threshold);
        seen.add(Math.round(threshold * 64 - 0.5));
      }
    }
    expect(seen.size).toBe(64);
  });
});
