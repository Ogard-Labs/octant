import { describe, expect, it } from "vitest";
import { contrastRatio } from "./color";
import {
  deriveFlowingPalette,
  flowingPaletteChroma,
  flowingPaletteHue,
  flowingPaletteLightness,
  flowingPaletteMeetsLightTextContrast,
  flowingPaletteRgb,
  mixFlowingPalettes,
} from "./flowingBackground";

const BLUE = "#5b9cf5";
const CLAY = "#d97757";
const LIGHT_INK = "#141414";

describe("flowing palette derivation", () => {
  it("builds a dark saturated ramp around the accent hue, not a pastel wash of the swatch", () => {
    const palette = deriveFlowingPalette(BLUE, "dark");
    expect(flowingPaletteLightness(palette.deep)).toBeLessThan(0.12);
    expect(flowingPaletteLightness(palette.mid)).toBeGreaterThan(0.2);
    expect(flowingPaletteLightness(palette.mid)).toBeLessThan(0.4);
    expect(flowingPaletteLightness(palette.mid)).toBeLessThan(flowingPaletteLightness(BLUE) - 0.2);
    expect(flowingPaletteLightness(palette.light)).toBeGreaterThan(
      flowingPaletteLightness(palette.mid),
    );
    expect(flowingPaletteLightness(palette.glow)).toBeGreaterThan(
      flowingPaletteLightness(palette.light),
    );
    expect(flowingPaletteLightness(palette.glow)).toBeLessThan(0.8);
    expect(flowingPaletteChroma(palette.mid)).toBeGreaterThan(0.08);
    expect(flowingPaletteChroma(palette.light)).toBeGreaterThan(0.1);
    expect(flowingPaletteChroma(palette.glow)).toBeGreaterThan(0.1);
    const midHue = flowingPaletteHue(palette.mid);
    expect(Math.abs(flowingPaletteHue(palette.deep) - midHue)).toBeLessThan(12);
    const glowShift = (flowingPaletteHue(palette.glow) - midHue + 360) % 360;
    expect(glowShift).toBeGreaterThan(8);
    expect(glowShift).toBeLessThan(22);
  });

  it("follows a different accent's hue so clay and blue fields do not share a ramp", () => {
    const blue = deriveFlowingPalette(BLUE, "dark");
    const clay = deriveFlowingPalette(CLAY, "dark");
    expect(flowingPaletteLightness(clay.mid)).toBeLessThan(0.4);
    expect(flowingPaletteLightness(blue.mid)).toBeLessThan(0.4);
    const hueGap = Math.abs(flowingPaletteHue(blue.glow) - flowingPaletteHue(clay.glow));
    expect(Math.min(hueGap, 360 - hueGap)).toBeGreaterThan(40);
    expect(blue.deep).not.toBe(clay.deep);
    expect(blue.mid).not.toBe(clay.mid);
    expect(blue.glow).not.toBe(clay.glow);
  });

  it("softens the light-mode ramp so primary text clears WCAG AA against every stop", () => {
    for (const accent of [BLUE, CLAY, "#3fb950", "#a37cf0", "#e3a33a"]) {
      const palette = deriveFlowingPalette(accent, "light");
      expect(flowingPaletteMeetsLightTextContrast(palette)).toBe(true);
      for (const stop of [palette.deep, palette.mid, palette.light, palette.glow]) {
        expect(flowingPaletteLightness(stop)).toBeGreaterThan(0.7);
        expect(contrastRatio(LIGHT_INK, stop)).toBeGreaterThanOrEqual(4.5);
      }
      expect(flowingPaletteLightness(palette.deep)).toBeGreaterThan(
        flowingPaletteLightness(palette.glow),
      );
    }
  });

  it("hands 0..1 RGB triples the shader can consume without further parsing", () => {
    const rgb = flowingPaletteRgb(deriveFlowingPalette(BLUE, "dark"));
    for (const stop of [rgb.deep, rgb.mid, rgb.light, rgb.glow]) {
      expect(stop).toHaveLength(3);
      for (const channel of stop) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(1);
      }
    }
    expect(rgb.mid[2] ?? 0).toBeGreaterThan(rgb.mid[0] ?? 0);
  });

  it("mixes two palettes toward the new accent so a 600ms walk lands on the target", () => {
    const from = deriveFlowingPalette(BLUE, "dark");
    const to = deriveFlowingPalette(CLAY, "dark");
    expect(mixFlowingPalettes(from, to, 0)).toEqual(from);
    expect(mixFlowingPalettes(from, to, 1)).toEqual(to);
    const halfway = mixFlowingPalettes(from, to, 0.5);
    expect(halfway.mid).not.toBe(from.mid);
    expect(halfway.mid).not.toBe(to.mid);
  });
});
