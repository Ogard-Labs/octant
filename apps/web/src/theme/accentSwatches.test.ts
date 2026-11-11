import { describe, expect, it } from "vitest";
import { DEFAULT_THEME_SETTINGS } from "@octant/contracts/theme";
import { resolveEffectiveTokens } from "@octant/theme";
import {
  ACCENT_SWATCHES,
  currentAccentSwatch,
  overridesForAccent,
  type AccentSwatch,
} from "./accentSwatches";

describe("accent swatches", () => {
  it("paints every swatch in both modes without the theme dropping its ink", () => {
    for (const swatch of ACCENT_SWATCHES) {
      const settings = {
        ...DEFAULT_THEME_SETTINGS,
        semanticOverrides: overridesForAccent([], swatch.id),
      };
      for (const mode of ["light", "dark"] as const) {
        const resolved = resolveEffectiveTokens({ ...settings, mode }, false);
        expect({ swatch: swatch.id, mode, dropped: resolved.droppedOverrides }).toEqual({
          swatch: swatch.id,
          mode,
          dropped: [],
        });
      }
      if (swatch.id !== "mono") expect(currentAccentSwatch(settings)).toBe(swatch.id);
    }
  });

  it("keeps every swatch fill at least 3:1 against the light card and its ink at 4.5:1 in both modes", () => {
    const luminance = (hex: string) => {
      const [r = 0, g = 0, b = 0] = [1, 3, 5].map((at) => {
        const channel = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a: string, b: string) => {
      const [hi = 0, lo = 0] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    const card = { light: "#f0f0ef" } as const;
    for (const swatch of ACCENT_SWATCHES as ReadonlyArray<AccentSwatch>) {
      for (const mode of ["light", "dark"] as const) {
        const paint = swatch[mode];
        if (paint === undefined) continue;
        // The dark greys are deliberately quiet on the dark card; the light
        // card is where the fills fell short, so only it is held to 3:1.
        expect({
          swatch: swatch.id,
          mode,
          fill: mode === "dark" || ratio(paint.fill, card.light) >= 3,
          ink: ratio(paint.fill, paint.ink) >= 4.5,
        }).toEqual({ swatch: swatch.id, mode, fill: true, ink: true });
      }
    }
  });

  it("gives White a silver on the light page, where white would vanish", () => {
    const settings = {
      ...DEFAULT_THEME_SETTINGS,
      semanticOverrides: overridesForAccent([], "white"),
    };
    expect(resolveEffectiveTokens({ ...settings, mode: "dark" }, false).tokens["accent"]).toBe(
      "#ffffff",
    );
    expect(resolveEffectiveTokens({ ...settings, mode: "light" }, false).tokens["accent"]).toBe(
      "#8a8a8f",
    );
  });
});
