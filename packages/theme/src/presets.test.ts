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
  it("publishes System, Light, Dark, Octant, and the tinted presets", () => {
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
      "coral",
      "clay",
      "sand",
      "olive",
      "mint",
      "sky",
      "slate",
      "plum",
      "ash",
      "obsidian",
      "onyx",
      "pride",
      "norway",
    ]);
    expect(THEME_PRESETS.map((preset) => preset.id)).toEqual(BUILT_IN_THEME_PRESET_IDS);
    expect(THEME_PRESETS.map((preset) => preset.displayName)).toEqual([
      "System",
      "Light",
      "Dark",
      "Brass",
      "Moss",
      "Lagoon",
      "Harbor",
      "Iris",
      "Rose",
      "Ember",
      "Ink",
      "Coral",
      "Clay",
      "Sand",
      "Olive",
      "Mint",
      "Sky",
      "Slate",
      "Plum",
      "Ash",
      "Obsidian",
      "Onyx",
      "Pride",
      "Norway",
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
    const tinted = THEME_PRESETS.filter(
      (preset) => !["system", "light", "dark", "octant"].includes(preset.id),
    );
    expect(tinted).toHaveLength(20);
    for (const preset of tinted) {
      for (const mode of ["light", "dark"] as const) {
        const tokens = preset.tokens[mode]!;
        const accent = parseHexColor(tokens.accent!);
        const spread =
          Math.max(accent.r, accent.g, accent.b) - Math.min(accent.r, accent.g, accent.b);
        // A tinted accent has hue; a grey has none. Ash and Slate are the
        // quiet ones and carry only a little.
        expect(spread).toBeGreaterThan(["ash", "slate"].includes(preset.id) ? 8 : 40);
        expect(validateThemePreset(preset).valid).toBe(true);
      }
    }
    const system = getThemePreset("system")!;
    const grey = parseHexColor(system.tokens.dark!.accent!);
    expect(Math.max(grey.r, grey.g, grey.b) - Math.min(grey.r, grey.g, grey.b)).toBeLessThan(8);
    // The OLED presets' page is exactly black: those pixels switch off.
    for (const id of ["ink", "obsidian", "onyx"]) {
      const dark = getThemePreset(id)!.tokens.dark!;
      expect(dark["app-background"]).toBe("#000000");
      expect(dark.chrome).toBe("#000000");
      expect(dark.sidebar).toBe("#000000");
    }
    expect(getThemePreset("moss")!.tokens.dark!["app-background"]).not.toBe("#000000");
  });

  it("gives Pride and Norway their own bounded application-ground art palettes", () => {
    expect(getThemePreset("pride")?.patternPalette).toEqual([
      "#e40303",
      "#ff8c00",
      "#ffed00",
      "#008026",
      "#24408e",
      "#732982",
    ]);
    expect(getThemePreset("norway")?.patternPalette).toEqual(["#ba0c2f", "#ffffff", "#00205b"]);
  });

  it("returns undefined for an unknown id without throwing", () => {
    expect(getThemePreset("missing")).toBeUndefined();
  });
});
