import { describe, expect, it } from "vitest";
import type { SidebarBackground, ThemeSettings } from "@octant/contracts/theme";
import { decodeThemeSettings, decodeSidebarBackground } from "@octant/contracts/theme";
import {
  SIDEBAR_BACKGROUND_PRESETS,
  ThemePresetError,
  getSidebarBackgroundPreset,
  resolveSidebarBackground,
  validatePresetCssBackground,
} from "./backgrounds";

describe("preset css background validator", () => {
  it("accepts a simple linear gradient", () => {
    expect(validatePresetCssBackground("linear-gradient(135deg, #1a1a1c, #2a2a2e)")).toBe(
      "linear-gradient(135deg, #1a1a1c, #2a2a2e)",
    );
  });

  it("accepts a radial gradient with position", () => {
    expect(
      validatePresetCssBackground("radial-gradient(circle at 50% 50%, #8b5cf6, #1a1a1c)"),
    ).toBe("radial-gradient(circle at 50% 50%, #8b5cf6, #1a1a1c)");
  });

  it("accepts a conic gradient", () => {
    expect(
      validatePresetCssBackground("conic-gradient(from 0deg, #1a1a1c, #8b5cf6, #1a1a1c)"),
    ).toBe("conic-gradient(from 0deg, #1a1a1c, #8b5cf6, #1a1a1c)");
  });

  it("accepts rgba colors", () => {
    expect(
      validatePresetCssBackground("linear-gradient(90deg, rgba(26,26,28,0.8), rgba(43,43,47,0.6))"),
    ).toBe("linear-gradient(90deg, rgba(26,26,28,0.8), rgba(43,43,47,0.6))");
  });

  it("accepts repeating gradients", () => {
    expect(
      validatePresetCssBackground("repeating-linear-gradient(45deg, #1a1a1c 0px, #2a2a2e 10px)"),
    ).toBe("repeating-linear-gradient(45deg, #1a1a1c 0px, #2a2a2e 10px)");
  });

  it("accepts eight-digit hex with alpha", () => {
    expect(validatePresetCssBackground("linear-gradient(#1a1a1c80, #2a2a2e80)")).toBe(
      "linear-gradient(#1a1a1c80, #2a2a2e80)",
    );
  });

  it.each([
    "url(https://evil.example/font.woff)",
    "@import 'evil.css';",
    "https://evil.example/bg.png",
    "var(--octant-sidebar)",
    "calc(100% - 10px)",
    "attr(data-bg)",
    "expression(alert(1))",
    "javascript:alert(1)",
    "linear-gradient(#1a1a1c, #2a2a2e); body{display:none}",
    "linear-gradient(#1a1a1c, #2a2a2e)<script>",
    "linear-gradient(#1a1a1c, #2a2a2e)\\",
  ])("rejects unsafe input %s", (input) => {
    expect(() => validatePresetCssBackground(input)).toThrow(ThemePresetError);
  });

  it.each(["white", "#fff", "#GGGGGG", "hsl(0,0%,0%)"])("rejects invalid color %s", (color) => {
    expect(() => validatePresetCssBackground(`linear-gradient(${color}, #000000)`)).toThrow(
      ThemePresetError,
    );
  });

  it("accepts rgb() color stops", () => {
    expect(() =>
      validatePresetCssBackground("linear-gradient(90deg, rgb(26,26,28), rgb(43,43,47))"),
    ).not.toThrow();
  });

  it("rejects unknown functions", () => {
    expect(() => validatePresetCssBackground("cubic-bezier(0,0,1,1)")).toThrow(ThemePresetError);
    expect(() => validatePresetCssBackground("translateX(10px)")).toThrow(ThemePresetError);
  });

  it("rejects oversized input", () => {
    const stops = Array.from({ length: 10 }, (_, i) => `#${i.toString(16).padStart(6, "0")}`).join(
      ", ",
    );
    expect(() => validatePresetCssBackground(`linear-gradient(${stops})`)).toThrow(
      ThemePresetError,
    );
  });

  it("accepts layered gradients with a base color", () => {
    expect(() =>
      validatePresetCssBackground(
        "radial-gradient(circle at 20% 30%, #2a2a2e 2px, transparent 3px), radial-gradient(circle at 80% 70%, #2a2a2e 2px, transparent 3px), #0d0d0f",
      ),
    ).not.toThrow();
  });

  it("rejects empty input", () => {
    expect(() => validatePresetCssBackground("")).toThrow(ThemePresetError);
    expect(() => validatePresetCssBackground("   ")).toThrow(ThemePresetError);
  });
});

describe("sidebar background preset catalog", () => {
  it("ships 20 presets across 4 categories", () => {
    expect(SIDEBAR_BACKGROUND_PRESETS).toHaveLength(20);
    const categories = new Set(SIDEBAR_BACKGROUND_PRESETS.map((p) => p.category));
    expect(categories).toEqual(new Set(["gradient", "shape", "dev-inspired", "subtle"]));
    for (const category of ["gradient", "shape", "dev-inspired", "subtle"] as const) {
      expect(SIDEBAR_BACKGROUND_PRESETS.filter((p) => p.category === category)).toHaveLength(5);
    }
  });

  it("has unique preset ids", () => {
    const ids = SIDEBAR_BACKGROUND_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every preset css passes the validator", () => {
    for (const preset of SIDEBAR_BACKGROUND_PRESETS) {
      expect(() => validatePresetCssBackground(preset.cssBackground)).not.toThrow();
    }
  });

  it("every preset has valid suggested overlay color and opacity", () => {
    for (const preset of SIDEBAR_BACKGROUND_PRESETS) {
      expect(preset.suggestedOverlayColor).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(preset.suggestedOverlayOpacity).toBeGreaterThanOrEqual(0);
      expect(preset.suggestedOverlayOpacity).toBeLessThanOrEqual(100);
    }
  });

  it("getSidebarBackgroundPreset returns the preset or throws", () => {
    expect(getSidebarBackgroundPreset("gradient-aurora").category).toBe("gradient");
    expect(() => getSidebarBackgroundPreset("nope")).toThrow(ThemePresetError);
  });
});

describe("resolveSidebarBackground", () => {
  const baseSettings = {
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

  function makeSettings(bg: SidebarBackground): ThemeSettings {
    return decodeThemeSettings({ ...baseSettings, sidebarBackground: bg });
  }

  it("resolves none to null background", () => {
    const resolved = resolveSidebarBackground(
      makeSettings(
        decodeSidebarBackground({
          kind: "none",
          overlayColor: "#000000",
          overlayOpacity: 100,
          vibrancyMode: "off",
        }),
      ),
      "dark",
    );
    expect(resolved.kind).toBe("none");
    expect(resolved.backgroundCss).toBeNull();
    expect(resolved.backgroundId).toBeNull();
  });

  it("resolves preset to its css", () => {
    const resolved = resolveSidebarBackground(
      makeSettings(
        decodeSidebarBackground({
          kind: "preset",
          presetId: "gradient-aurora",
          overlayColor: "#000000",
          overlayOpacity: 50,
          vibrancyMode: "off",
        }),
      ),
      "dark",
    );
    expect(resolved.kind).toBe("preset");
    expect(resolved.backgroundCss).toBe(
      getSidebarBackgroundPreset("gradient-aurora").cssBackground,
    );
    expect(resolved.backgroundId).toBeNull();
  });

  it("resolves custom to its background id", () => {
    const resolved = resolveSidebarBackground(
      makeSettings(
        decodeSidebarBackground({
          kind: "custom",
          backgroundId: "00000000-0000-4000-8000-000000000b01",
          overlayColor: "#000000",
          overlayOpacity: 40,
          vibrancyMode: "subtle",
        }),
      ),
      "dark",
    );
    expect(resolved.kind).toBe("custom");
    expect(resolved.backgroundCss).toBeNull();
    expect(resolved.backgroundId).toBe("00000000-0000-4000-8000-000000000b01");
  });

  it("passes through overlay color, opacity, and vibrancy mode", () => {
    const resolved = resolveSidebarBackground(
      makeSettings(
        decodeSidebarBackground({
          kind: "none",
          overlayColor: "#1a1a1c",
          overlayOpacity: 70,
          vibrancyMode: "strong",
        }),
      ),
      "dark",
    );
    expect(resolved.overlayColor).toBe("#1a1a1c");
    expect(resolved.overlayOpacity).toBe(70);
    expect(resolved.vibrancyMode).toBe("strong");
  });
});
