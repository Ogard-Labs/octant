import { describe, expect, it } from "vitest";
import { parseHexColor } from "./color";
import { DEFAULT_DARK_TOKENS, DEFAULT_LIGHT_TOKENS, THEME_TOKEN_ROLE_IDS } from "./tokens";
import {
  BUILT_IN_THEME_PRESET_IDS,
  THEME_PRESETS,
  getThemePreset,
  resolveThemePresetTokens,
  serializeThemePresetCatalog,
  validateThemePreset,
} from "./presets";

describe("built-in theme preset catalog", () => {
  it("publishes System, Light, Dark, Octant, and the seven tinted presets", () => {
    expect(BUILT_IN_THEME_PRESET_IDS).toEqual([
      "system",
      "light",
      "dark",
      "octant",
      "moss",
      "lagoon",
      "harbor",
      "iris",
      "rose",
      "ember",
      "ink",
    ]);
    expect(THEME_PRESETS.map((preset) => preset.id)).toEqual(BUILT_IN_THEME_PRESET_IDS);
    expect(THEME_PRESETS.map((preset) => preset.displayName)).toEqual([
      "System",
      "Light",
      "Dark",
      "Octant",
      "Moss",
      "Lagoon",
      "Harbor",
      "Iris",
      "Rose",
      "Ember",
      "Ink",
    ]);
  });

  it("has unique stable ids and complete semantic roles in every compatible mode", () => {
    expect(new Set(THEME_PRESETS.map((preset) => preset.id)).size).toBe(THEME_PRESETS.length);

    for (const preset of THEME_PRESETS) {
      expect(validateThemePreset(preset)).toEqual({ valid: true, errors: [] });
      for (const mode of preset.supportedModes) {
        expect(Object.keys(preset.tokens[mode] ?? {}).sort()).toEqual(
          [...THEME_TOKEN_ROLE_IDS].sort(),
        );
      }
    }
  });

  it("validates every preset's semantic contrast pairs", () => {
    for (const preset of THEME_PRESETS) {
      expect(validateThemePreset(preset).valid).toBe(true);
    }
  });

  it("resolves System and preserves light/dark compatibility", () => {
    expect(resolveThemePresetTokens("system", "light")).toEqual(DEFAULT_LIGHT_TOKENS);
    expect(resolveThemePresetTokens("system", "dark")).toEqual(DEFAULT_DARK_TOKENS);
    expect(resolveThemePresetTokens("light", "dark")).toEqual(DEFAULT_DARK_TOKENS);
    expect(resolveThemePresetTokens("dark", "light")).toEqual(DEFAULT_LIGHT_TOKENS);
  });

  it("keeps the original warm Octant palette available as an optional preset", () => {
    expect(resolveThemePresetTokens("octant", "dark")).toMatchObject({
      workspace: "#14130f",
      accent: "#d9a441",
    });
    expect(resolveThemePresetTokens("octant", "dark")).not.toEqual(DEFAULT_DARK_TOKENS);
  });

  it("fails closed to the approved defaults for unknown or invalid preset data", () => {
    expect(resolveThemePresetTokens("missing", "dark")).toEqual(DEFAULT_DARK_TOKENS);
    expect(
      validateThemePreset({ id: "broken", displayName: "Broken", supportedModes: ["dark"] }),
    ).toEqual({ valid: false, errors: ["preset.tokens is required"] });

    expect(
      validateThemePreset({
        ...THEME_PRESETS[2],
        tokens: { dark: { ...DEFAULT_DARK_TOKENS, accent: "purple" } },
      }).valid,
    ).toBe(false);
  });

  it("serializes the catalog deterministically", () => {
    expect(serializeThemePresetCatalog()).toBe(serializeThemePresetCatalog());
    expect(
      JSON.parse(serializeThemePresetCatalog()).map((preset: { id: string }) => preset.id),
    ).toEqual(BUILT_IN_THEME_PRESET_IDS);
  });

  it("colours every tinted preset's accent while the default stays monochrome", () => {
    const tinted = THEME_PRESETS.filter((preset) =>
      ["moss", "lagoon", "harbor", "iris", "rose", "ember", "ink"].includes(preset.id),
    );
    expect(tinted).toHaveLength(7);
    for (const preset of tinted) {
      for (const mode of ["light", "dark"] as const) {
        const tokens = preset.tokens[mode]!;
        const accent = parseHexColor(tokens.accent!);
        const spread =
          Math.max(accent.r, accent.g, accent.b) - Math.min(accent.r, accent.g, accent.b);
        // A tinted accent has hue; a grey has none.
        expect(spread).toBeGreaterThan(40);
        expect(validateThemePreset(preset).valid).toBe(true);
      }
    }
    const system = getThemePreset("system")!;
    const grey = parseHexColor(system.tokens.dark!.accent!);
    expect(Math.max(grey.r, grey.g, grey.b) - Math.min(grey.r, grey.g, grey.b)).toBeLessThan(8);
    // Ink is the true-black one: its page is darker than every other dark page.
    expect(parseHexColor(getThemePreset("ink")!.tokens.dark!["app-background"]!).r).toBeLessThan(
      parseHexColor(getThemePreset("moss")!.tokens.dark!["app-background"]!).r,
    );
  });

  it("returns undefined for an unknown id without throwing", () => {
    expect(getThemePreset("missing")).toBeUndefined();
  });
});
