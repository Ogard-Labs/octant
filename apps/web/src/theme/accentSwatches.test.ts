import { describe, expect, it } from "vitest";
import { DEFAULT_THEME_SETTINGS } from "@octant/contracts/theme";
import { resolveEffectiveTokens } from "@octant/theme";
import { ACCENT_SWATCHES, currentAccentSwatch, overridesForAccent } from "./accentSwatches";

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
