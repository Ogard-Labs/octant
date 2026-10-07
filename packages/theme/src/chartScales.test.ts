import { describe, expect, it } from "vitest";
import { hexToOklch } from "./color";
import {
  CHART_DIVERGING_ROLE_IDS,
  CHART_DIVERGING_STEPS,
  CHART_SEQUENTIAL_ROLE_IDS,
  CHART_SEQUENTIAL_STEPS,
  deriveChartScales,
} from "./chartScales";
import { DEFAULT_DARK_TOKENS, DEFAULT_LIGHT_TOKENS } from "./tokens";

const HUE_TOLERANCE = 4;

describe("chart scales", () => {
  it("publishes five steps for each scale", () => {
    expect(CHART_SEQUENTIAL_ROLE_IDS).toHaveLength(CHART_SEQUENTIAL_STEPS);
    expect(CHART_DIVERGING_ROLE_IDS).toHaveLength(CHART_DIVERGING_STEPS);
  });

  it("draws the sequential hue from the palette's teal family", () => {
    const scales = deriveChartScales("light", DEFAULT_LIGHT_TOKENS);
    const teal = hexToOklch(DEFAULT_LIGHT_TOKENS["palette-teal"] ?? "#000000");
    for (const hex of scales.sequential) {
      expect(Math.abs(hexToOklch(hex).h - teal.h)).toBeLessThan(HUE_TOLERANCE);
    }
  });

  it("runs the diverging scale from the red family through neutral to the blue family", () => {
    const scales = deriveChartScales("light", DEFAULT_LIGHT_TOKENS);
    const red = hexToOklch(DEFAULT_LIGHT_TOKENS["palette-red"] ?? "#000000");
    const blue = hexToOklch(DEFAULT_LIGHT_TOKENS["palette-blue"] ?? "#000000");
    const middle = Math.floor(CHART_DIVERGING_STEPS / 2);
    const first = scales.diverging[0];
    const last = scales.diverging[scales.diverging.length - 1];
    const neutral = scales.diverging[middle];
    if (first === undefined || last === undefined || neutral === undefined) {
      throw new Error("Diverging scale is missing a step.");
    }
    expect(Math.abs(hexToOklch(first).h - red.h)).toBeLessThan(HUE_TOLERANCE);
    expect(Math.abs(hexToOklch(last).h - blue.h)).toBeLessThan(HUE_TOLERANCE);
    // The midpoint is the anchor a diverging scale reads against, so it must
    // be neutral, not a third hue.
    expect(hexToOklch(neutral).c).toBeLessThan(0.001);
  });

  it("orders the sequential steps by lightness so the scale reads in greyscale", () => {
    for (const mode of ["light", "dark"] as const) {
      const palette = mode === "light" ? DEFAULT_LIGHT_TOKENS : DEFAULT_DARK_TOKENS;
      const sequential = deriveChartScales(mode, palette).sequential;
      const lightness = sequential.map((hex) => hexToOklch(hex).l);
      const ascending = lightness.every(
        (value, index) => index === 0 || value > (lightness[index - 1] ?? 0),
      );
      const descending = lightness.every(
        (value, index) => index === 0 || value < (lightness[index - 1] ?? 0),
      );
      expect(ascending || descending).toBe(true);
      expect(new Set(sequential).size).toBe(sequential.length);
    }
  });

  it("falls back to a usable scale when a palette omits the roles it draws from", () => {
    const scales = deriveChartScales("light", {});
    expect(scales.sequential).toHaveLength(CHART_SEQUENTIAL_STEPS);
    for (const hex of [...scales.sequential, ...scales.diverging]) {
      expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
