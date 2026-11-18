import {
  DEFAULT_THEME_SETTINGS,
  decodeThemeHexColor,
  type ThemeCustomSeeds,
} from "@octant/contracts/theme";
import { describe, expect, it } from "vitest";
import { contrastRatio } from "./color";
import { CUSTOM_CONTRAST_SCALE, customThemeTokens } from "./customPreset";
import { resolveEffectiveTokens } from "./fallback";

const seeds = (patch: Partial<ThemeCustomSeeds> = {}): ThemeCustomSeeds => ({
  ground: decodeThemeHexColor("#1b1d23"),
  ink: decodeThemeHexColor("#f2f2f4"),
  accent: decodeThemeHexColor("#7aa2ff"),
  contrast: "standard",
  ...patch,
});

describe("a Custom preset built from seeds", () => {
  it("derives every role from ground, ink and accent and keeps text readable", () => {
    const result = customThemeTokens(seeds(), "dark");
    if (result.status !== "built") throw new Error(result.reason);
    expect(result.tokens["text-primary"]).toBe("#f2f2f4");
    expect(result.tokens.accent).toBe("#7aa2ff");
    expect(
      contrastRatio(result.tokens["text-primary"] ?? "", result.tokens.workspace ?? ""),
    ).toBeGreaterThan(7);
    expect(
      contrastRatio(result.tokens["text-muted"] ?? "", result.tokens.workspace ?? ""),
    ).toBeGreaterThan(4.5);
  });

  it("moves the washes one step each way with the contrast step", () => {
    const soft = customThemeTokens(seeds({ contrast: "soft" }), "dark");
    const firm = customThemeTokens(seeds({ contrast: "firm" }), "dark");
    if (soft.status !== "built" || firm.status !== "built") throw new Error("not built");
    expect(CUSTOM_CONTRAST_SCALE.soft).toBeLessThan(CUSTOM_CONTRAST_SCALE.firm);
    const ground = "#1b1d23";
    expect(contrastRatio(firm.tokens.control ?? "", ground)).toBeGreaterThan(
      contrastRatio(soft.tokens.control ?? "", ground),
    );
  });

  it("refuses seeds whose text cannot be read and names the failing role", () => {
    const result = customThemeTokens(seeds({ ink: decodeThemeHexColor("#2a2c32") }), "dark");
    expect(result.status).toBe("refused");
    if (result.status === "refused") expect(result.role).toMatch(/text|muted|secondary/);
  });

  it("resolves for the mode that has seeds and falls back to the default for one that has none", () => {
    const settings = {
      ...DEFAULT_THEME_SETTINGS,
      mode: "dark" as const,
      darkPresetId: "custom",
      customThemeDark: seeds(),
    };
    const resolved = resolveEffectiveTokens(settings as never, true);
    expect(resolved.tokens.accent).toBe("#7aa2ff");
    const without = resolveEffectiveTokens(
      { ...settings, customThemeDark: undefined } as never,
      true,
    );
    expect(without.tokens.accent).not.toBe("#7aa2ff");
  });
});
