import { describe, expect, it } from "vitest";
import {
  decodeThemeSettings,
  type ThemeSemanticOverrideEntry,
  type ThemeSettings,
} from "@octant/contracts/theme";
import { DEFAULT_DARK_TOKENS, DEFAULT_LIGHT_TOKENS } from "./tokens";
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
    expect(resolved.tokens["accent"]).toBe("#0170dd");

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
});
