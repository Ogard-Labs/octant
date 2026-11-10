import { describe, expect, it } from "vitest";
import {
  decodeThemeSettings,
  type ThemeSemanticOverrideEntry,
  type ThemeSettings,
} from "@octant/contracts/theme";
import { meetsContrast } from "./contrast";
import { DEFAULT_DARK_TOKENS, DEFAULT_LIGHT_TOKENS, MONO_STYLE_TOKENS } from "./tokens";
import {
  applySemanticOverrides,
  resolveEffectiveTokens,
  safeFallbackTheme,
  validateOverride,
} from "./fallback";

const plainBase = {
  mode: "system",
  density: "comfortable",
  translucency: "translucent",
  fontSmoothing: "auto",
  timestampFormat: "24h",
  typography: {
    ui: { family: "Inter", size: 13 },
    editor: { family: "JetBrains Mono", size: 13, lineHeight: 1.5, ligatures: true },
    terminal: { family: "JetBrains Mono", size: 12, lineHeight: 1.4, ligatures: false },
  },
  semanticOverrides: [],
  increasedContrast: false,
  reducedMotion: false,
  reducedTransparency: false,
} as const;

function makeSettings(overrides: Record<string, unknown>): ThemeSettings {
  return decodeThemeSettings({ ...plainBase, ...overrides });
}

describe("theme fallback policy", () => {
  it("resolves system mode to dark defaults when the system prefers dark", () => {
    const resolved = resolveEffectiveTokens(makeSettings({}), true);
    expect(resolved.mode).toBe("dark");
    expect(resolved.tokens).toEqual(DEFAULT_DARK_TOKENS);
    expect(resolved.droppedOverrides).toEqual([]);
  });

  it("resolves system mode to light defaults when the system prefers light", () => {
    const resolved = resolveEffectiveTokens(makeSettings({}), false);
    expect(resolved.mode).toBe("light");
    expect(resolved.tokens).toEqual(DEFAULT_LIGHT_TOKENS);
  });

  it("resolves explicit dark and light modes regardless of system preference", () => {
    expect(resolveEffectiveTokens(makeSettings({ mode: "dark" }), false).mode).toBe("dark");
    expect(resolveEffectiveTokens(makeSettings({ mode: "light" }), true).mode).toBe("light");
  });

  it("uses the selected compatible preset after resolving System mode", () => {
    const resolved = resolveEffectiveTokens(
      makeSettings({
        lightPresetId: "octant",
        darkPresetId: "dark",
      }),
      false,
    );
    expect(resolved.mode).toBe("light");
    expect(resolved.tokens["accent"]).toBe("#d9a441");

    const darkResolved = resolveEffectiveTokens(
      makeSettings({
        lightPresetId: "octant",
        darkPresetId: "dark",
      }),
      true,
    );
    expect(darkResolved.mode).toBe("dark");
    expect(darkResolved.tokens).toEqual(DEFAULT_DARK_TOKENS);
  });

  it("falls back to the mode default when a selected preset is incompatible", () => {
    const resolved = resolveEffectiveTokens(
      makeSettings({ mode: "dark", darkPresetId: "light" }),
      false,
    );
    expect(resolved.tokens).toEqual(DEFAULT_DARK_TOKENS);
  });

  it("applies a valid accent override onto the base token map", () => {
    const resolved = resolveEffectiveTokens(
      makeSettings({ mode: "dark", semanticOverrides: [{ role: "accent", color: "#7c3aed" }] }),
      false,
    );
    expect(resolved.tokens["accent"]).toBe("#7c3aed");
    expect(resolved.droppedOverrides).toEqual([]);
  });

  it("drops an override with an invalid hex color and falls back to the default", () => {
    const invalidColorEntry = {
      role: "accent",
      color: "purple",
    } as unknown as ThemeSemanticOverrideEntry;
    const result = applySemanticOverrides(DEFAULT_DARK_TOKENS, [invalidColorEntry], "dark");
    expect(result.tokens["accent"]).toBe(DEFAULT_DARK_TOKENS["accent"]);
    expect(result.droppedOverrides).toHaveLength(1);
    expect(result.droppedOverrides[0]?.reason).toBe("invalid-color");
  });

  it("drops an override for an unknown token role", () => {
    const resolved = resolveEffectiveTokens(
      makeSettings({
        mode: "dark",
        semanticOverrides: [{ role: "unknown-role", color: "#000000" }],
      }),
      false,
    );
    expect(resolved.droppedOverrides[0]?.reason).toBe("unknown-role");
  });

  it("drops a text override that fails contrast against its surface", () => {
    const resolved = resolveEffectiveTokens(
      makeSettings({
        mode: "dark",
        semanticOverrides: [{ role: "text-primary", color: "#1a1a1c" }],
      }),
      false,
    );
    expect(resolved.tokens["text-primary"]).toBe(DEFAULT_DARK_TOKENS["text-primary"]);
    expect(resolved.droppedOverrides[0]?.reason).toBe("insufficient-contrast");
  });

  it("applies an override scoped to one mode only in that mode", () => {
    const semanticOverrides = [
      { role: "accent", color: "#2b2b2e", mode: "light" },
      { role: "accent", color: "#ffffff", mode: "dark" },
    ] as const;
    const light = resolveEffectiveTokens(makeSettings({ mode: "light", semanticOverrides }), false);
    const dark = resolveEffectiveTokens(makeSettings({ mode: "dark", semanticOverrides }), false);
    expect(light.tokens["accent"]).toBe("#2b2b2e");
    expect(dark.tokens["accent"]).toBe("#ffffff");
  });

  it("keeps a non-text accent override even when its contrast against the workspace is low", () => {
    const resolved = resolveEffectiveTokens(
      makeSettings({ mode: "dark", semanticOverrides: [{ role: "accent", color: "#222225" }] }),
      false,
    );
    expect(resolved.tokens["accent"]).toBe("#222225");
    expect(resolved.droppedOverrides).toEqual([]);
  });

  it("validateOverride rejects unknown roles and invalid colors directly", () => {
    expect(validateOverride("unknown-role", "#000000", DEFAULT_DARK_TOKENS).ok).toBe(false);
    expect(validateOverride("accent", "purple", DEFAULT_DARK_TOKENS).ok).toBe(false);
    expect(validateOverride("accent", "#7c3aed", DEFAULT_DARK_TOKENS).ok).toBe(true);
  });

  it("applySemanticOverrides returns the base map unchanged when overrides are empty", () => {
    const result = applySemanticOverrides(DEFAULT_DARK_TOKENS, [], "dark");
    expect(result.tokens).toEqual(DEFAULT_DARK_TOKENS);
    expect(result.droppedOverrides).toEqual([]);
  });

  it("safeFallbackTheme returns the default dark theme", () => {
    const resolved = safeFallbackTheme(true);
    expect(resolved.mode).toBe("dark");
    expect(resolved.tokens).toEqual(DEFAULT_DARK_TOKENS);
  });

  describe("style", () => {
    for (const [mode, dark] of [
      ["light", false],
      ["dark", true],
    ] as const) {
      it(`resolves the default style to the colour roles in ${mode}`, () => {
        for (const style of [undefined, "default", "vivid"]) {
          const settings = makeSettings(style === undefined ? {} : { style });
          const { tokens } = resolveEffectiveTokens(settings, dark);
          expect(tokens["accent"]).toBe(
            (dark ? DEFAULT_DARK_TOKENS : DEFAULT_LIGHT_TOKENS)["accent"],
          );
          expect(tokens["accent"]).not.toBe(MONO_STYLE_TOKENS[mode]["accent"]);
          expect(tokens["warning-text"]).not.toBe(MONO_STYLE_TOKENS[mode]["warning-text"]);
        }
      });

      it(`resolves Mono and increased contrast to the grey roles in ${mode}`, () => {
        for (const extra of [{ style: "mono" }, { increasedContrast: true }]) {
          const { tokens } = resolveEffectiveTokens(makeSettings(extra), dark);
          for (const [role, value] of Object.entries(MONO_STYLE_TOKENS[mode])) {
            expect(tokens[role]).toBe(value);
          }
        }
      });

      it(`holds contrast on the colour accent and warning roles in ${mode}`, () => {
        const { tokens } = resolveEffectiveTokens(makeSettings({}), dark);
        const t = (role: string) => tokens[role]!;
        expect(meetsContrast(t("accent"), t("workspace"), "ui")).toBe(true);
        expect(meetsContrast(t("accent-text"), t("workspace"), "normal-text")).toBe(true);
        expect(meetsContrast(t("accent-foreground"), t("accent"), "normal-text")).toBe(true);
        expect(meetsContrast(t("primary-foreground"), t("accent"), "normal-text")).toBe(true);
        expect(meetsContrast(t("warning-text"), t("warning-surface"), "normal-text")).toBe(true);
        expect(meetsContrast(t("warning-border"), t("warning-surface"), "ui")).toBe(true);
      });
    }

    it("keeps a tinted preset's own accent under Mono", () => {
      const colour = resolveEffectiveTokens(
        makeSettings({ lightPresetId: "harbor", mode: "light" }),
        false,
      );
      const mono = resolveEffectiveTokens(
        makeSettings({ lightPresetId: "harbor", mode: "light", style: "mono" }),
        false,
      );
      expect(mono.tokens["accent"]).toBe(colour.tokens["accent"]);
      expect(mono.tokens["warning-text"]).toBe(MONO_STYLE_TOKENS.light["warning-text"]);
    });

    it("lets a saved accent override win in both styles", () => {
      const overrides = [{ role: "accent", color: "#a37cf0" }];
      for (const style of ["default", "mono"]) {
        const { tokens } = resolveEffectiveTokens(
          makeSettings({ style, semanticOverrides: overrides }),
          true,
        );
        expect(tokens["accent"]).toBe("#a37cf0");
      }
    });
  });
});
