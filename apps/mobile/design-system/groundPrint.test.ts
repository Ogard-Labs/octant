import { describe, expect, it } from "vitest";
import { bayerThreshold, clampEffect, coverFit } from "./groundPrint";

/** The desktop's own function, copied as the oracle for the port. */
function desktopBayerThreshold(x: number, y: number): number {
  const xy = (x ^ y) & 7;
  const row = y & 7;
  const value =
    ((xy & 1) << 5) |
    ((row & 1) << 4) |
    ((xy & 2) << 2) |
    ((row & 2) << 1) |
    ((xy & 4) >> 1) |
    ((row & 4) >> 2);
  return (value + 0.5) / 64;
}

describe("ground print", () => {
  it("orders the first cells of the threshold matrix like the desktop", () => {
    expect(bayerThreshold(0, 0)).toBe(0.5 / 64);
    expect(bayerThreshold(1, 0)).toBe(32.5 / 64);
    expect(bayerThreshold(0, 1)).toBe(48.5 / 64);
    expect(bayerThreshold(1, 1)).toBe(16.5 / 64);
    expect(bayerThreshold(2, 0)).toBe(8.5 / 64);
  });

  it("matches the desktop threshold on every cell of the repeating tile", () => {
    for (let y = 0; y < 16; y += 1) {
      for (let x = 0; x < 16; x += 1) {
        expect(bayerThreshold(x, y)).toBe(desktopBayerThreshold(x, y));
      }
    }
  });

  it("uses every threshold level once per 8x8 tile", () => {
    const seen = new Set<number>();
    for (let y = 0; y < 8; y += 1) for (let x = 0; x < 8; x += 1) seen.add(bayerThreshold(x, y));
    expect(seen.size).toBe(64);
  });

  it("keeps the dials on whole numbers from 2 to 16", () => {
    expect(clampEffect({ kind: "dither", cell: 1, levels: 99 })).toEqual({
      kind: "dither",
      cell: 2,
      levels: 16,
    });
    expect(clampEffect({ kind: "pixelate", cell: 5.6, levels: 3.2 })).toEqual({
      kind: "pixelate",
      cell: 6,
      levels: 3,
    });
    expect(clampEffect({ kind: "none", cell: Number.NaN, levels: Number.NaN })).toEqual({
      kind: "none",
      cell: 4,
      levels: 4,
    });
  });

  it("covers a tall viewport with a wide picture and centres the overflow", () => {
    const fit = coverFit({ width: 100, height: 200 }, { width: 400, height: 200 });
    expect(fit.scale).toBe(1);
    expect(fit.offsetX).toBe(-150);
    expect(fit.offsetY).toBe(0);
  });

  it("covers a wide viewport with a tall picture and centres the overflow", () => {
    const fit = coverFit({ width: 200, height: 100 }, { width: 100, height: 400 });
    expect(fit.scale).toBe(2);
    expect(fit.offsetX).toBe(0);
    expect(fit.offsetY).toBe(-350);
  });
});
