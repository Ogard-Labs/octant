import { describe, expect, it } from "vitest";
import { createRipple } from "./appBackdropCharacters";
import { cellWave, fieldLevel, parseColor, printLevel } from "./appBackdropPrint";

describe("the moving print", () => {
  it("keeps the field's brightness between dark and full", () => {
    for (let t = 0; t < 20; t += 1.7) {
      for (let cell = 0; cell < 200; cell += 13) {
        const level = fieldLevel(cell, cell * 0.6, t);
        expect(level).toBeGreaterThanOrEqual(0);
        expect(level).toBeLessThanOrEqual(1);
      }
    }
  });

  it("dithers an in-between level into a pattern of its two nearest steps", () => {
    const steps = new Set<number>();
    for (let row = 0; row < 4; row += 1) {
      for (let column = 0; column < 4; column += 1) {
        steps.add(printLevel(0.4, 3, true, column, row));
      }
    }
    expect([...steps].sort()).toEqual([0, 0.5]);
    // Plain pixels round to one step everywhere.
    expect(printLevel(0.4, 3, false, 0, 0)).toBe(0.5);
    expect(printLevel(0.4, 3, false, 3, 2)).toBe(0.5);
  });

  it("pushes a cell outward from a click while the wave passes, and leaves far cells alone", () => {
    const ripple = { ...createRipple(100, 100, 0, () => 0), heart: false, wobble: 0 };
    // At half a second the edge has travelled about 160px.
    const onEdge = cellWave([ripple], 260, 100, 0.5);
    expect(onEdge.dx).toBeGreaterThan(0);
    expect(Math.abs(onEdge.dy)).toBeLessThan(0.01);
    expect(onEdge.glow).toBeGreaterThan(0.3);
    expect(cellWave([ripple], 1000, 1000, 0.5)).toEqual({ dx: 0, dy: 0, glow: 0 });
    expect(cellWave([ripple], 105, 100, 0.5).glow).toBe(0);
  });

  it("reads the theme's colours whether computed or written as hex", () => {
    expect(parseColor("rgb(12, 34, 56)")).toEqual([12, 34, 56]);
    expect(parseColor("rgba(1, 2, 3, 0.5)")).toEqual([1, 2, 3]);
    expect(parseColor("#e3a33a")).toEqual([227, 163, 58]);
    expect(parseColor(" #fff ")).toEqual([255, 255, 255]);
    expect(parseColor("transparent")).toBeUndefined();
  });
});
