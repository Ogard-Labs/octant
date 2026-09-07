import { describe, expect, it } from "vitest";
import {
  DEFAULT_THEME_SETTINGS,
  decodeSidebarBackground,
  decodeThemeSettings,
  type SidebarBackground,
  type ThemeSettings,
} from "@octant/contracts/theme";
import {
  enforceAccessibilitySettings,
  enforceSidebarBackgroundAccessibility,
  resolveEffectiveSidebarBackground,
  resolveEffectiveThemeMode,
  resolveTypographyFallback,
  resolveVibrancyOverlayAdjustment,
  resolveAppBackground,
} from "./themePolicy";

const baseSettings: ThemeSettings = {
  ...DEFAULT_THEME_SETTINGS,
  mode: "system",
  density: "comfortable",
  translucency: "translucent",
  fontSmoothing: "auto",
  timestampFormat: "24h",
  typography: {
    ui: { family: "Inter", size: 13, weight: 400 },
    editor: { family: "JetBrains Mono", size: 13, weight: 400, lineHeight: 1.5, ligatures: true },
    terminal: {
      family: "JetBrains Mono",
      size: 12,
      weight: 400,
      lineHeight: 1.4,
      ligatures: false,
    },
  },
  semanticOverrides: [],
  increasedContrast: false,
  reducedMotion: false,
  reducedTransparency: false,
};

describe("theme policy", () => {
  it("resolves system mode from the system color preference", () => {
    expect(resolveEffectiveThemeMode(baseSettings, true)).toBe("dark");
    expect(resolveEffectiveThemeMode(baseSettings, false)).toBe("light");
  });

  it("resolves explicit modes regardless of system preference", () => {
    expect(resolveEffectiveThemeMode({ ...baseSettings, mode: "dark" }, false)).toBe("dark");
    expect(resolveEffectiveThemeMode({ ...baseSettings, mode: "light" }, true)).toBe("light");
  });

  it("keeps typography unchanged when every declared family is available", () => {
    const resolved = resolveTypographyFallback(baseSettings.typography, [
      "Inter",
      "JetBrains Mono",
    ]);
    expect(resolved).toEqual(baseSettings.typography);
  });

  it("falls back to a safe monospace stack when the editor font is missing", () => {
    const resolved = resolveTypographyFallback(baseSettings.typography, ["Inter"]);
    expect(resolved.editor.family).toMatch(/monospace/i);
    expect(resolved.terminal.family).toMatch(/monospace/i);
    expect(resolved.ui.family).toBe("Inter");
  });

  it("keeps a stack that ends in a generic keyword even when no named family is available", () => {
    const resolved = resolveTypographyFallback(
      {
        ...baseSettings.typography,
        ui: { ...baseSettings.typography.ui, family: "CustomFont, sans-serif" },
      },
      [],
    );
    expect(resolved.ui.family).toBe("CustomFont, sans-serif");
  });

  it("falls back to a safe ui stack when the ui font is missing and has no generic keyword", () => {
    const resolved = resolveTypographyFallback(
      {
        ...baseSettings.typography,
        ui: { ...baseSettings.typography.ui, family: "CustomFont" },
      },
      [],
    );
    expect(resolved.ui.family).toMatch(/system-ui|sans-serif/);
  });

  it("forces translucency to opaque when reduced transparency is enabled", () => {
    const enforced = enforceAccessibilitySettings({
      ...baseSettings,
      reducedTransparency: true,
    });
    expect(enforced.translucency).toBe("opaque");
  });

  it("leaves translucency unchanged when reduced transparency is disabled", () => {
    const enforced = enforceAccessibilitySettings(baseSettings);
    expect(enforced.translucency).toBe("translucent");
  });

  it("leaves an already opaque theme opaque under reduced transparency", () => {
    const enforced = enforceAccessibilitySettings({
      ...baseSettings,
      translucency: "opaque",
      reducedTransparency: true,
    });
    expect(enforced.translucency).toBe("opaque");
  });
});

interface MakeBgInput {
  readonly kind?: "preset" | "custom" | "none";
  readonly presetId?: string;
  readonly backgroundId?: string;
  readonly overlayColor?: string;
  readonly overlayOpacity?: number;
  readonly vibrancyMode?: "off" | "subtle" | "strong";
}

describe("sidebar background accessibility policy", () => {
  const bgBaseSettings = {
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

  function makeSettings(bg: MakeBgInput): ReturnType<typeof decodeThemeSettings> {
    const kind = bg.kind ?? "none";
    const input: Record<string, unknown> = {
      kind,
      overlayColor: bg.overlayColor ?? "#1a1a1c",
      overlayOpacity: bg.overlayOpacity ?? 60,
      vibrancyMode: bg.vibrancyMode ?? "off",
    };
    if (kind === "preset") input.presetId = bg.presetId ?? "gradient-aurora";
    if (kind === "custom")
      input.backgroundId = bg.backgroundId ?? "00000000-0000-4000-8000-000000000b01";
    const sidebarBackground: SidebarBackground = decodeSidebarBackground(input);
    return decodeThemeSettings({ ...bgBaseSettings, sidebarBackground });
  }

  it("reduced transparency disables background and vibrancy", () => {
    const enforced = enforceSidebarBackgroundAccessibility({
      ...makeSettings({ kind: "preset", presetId: "gradient-aurora", vibrancyMode: "strong" }),
      reducedTransparency: true,
    });
    expect(enforced.sidebarBackground.kind).toBe("none");
    expect(enforced.sidebarBackground.vibrancyMode).toBe("off");
    expect(enforced.sidebarBackground.overlayOpacity).toBe(100);
  });

  it("increased contrast clamps overlay opacity to at least 80", () => {
    const enforced = enforceSidebarBackgroundAccessibility({
      ...makeSettings({ kind: "preset", overlayOpacity: 40 }),
      increasedContrast: true,
    });
    expect(enforced.sidebarBackground.kind).toBe("preset");
    expect(enforced.sidebarBackground.overlayOpacity).toBe(80);
  });

  it("increased contrast leaves high opacity unchanged", () => {
    const enforced = enforceSidebarBackgroundAccessibility({
      ...makeSettings({ kind: "preset", overlayOpacity: 90 }),
      increasedContrast: true,
    });
    expect(enforced.sidebarBackground.overlayOpacity).toBe(90);
  });

  it("reduced motion is a no-op for static V1 presets", () => {
    const settings = makeSettings({ kind: "preset", presetId: "gradient-aurora" });
    const enforced = enforceSidebarBackgroundAccessibility({ ...settings, reducedMotion: true });
    expect(enforced.sidebarBackground).toEqual(settings.sidebarBackground);
  });

  it("no accessibility flags leaves settings unchanged", () => {
    const settings = makeSettings({ kind: "preset", overlayOpacity: 50, vibrancyMode: "subtle" });
    expect(enforceSidebarBackgroundAccessibility(settings).sidebarBackground).toEqual(
      settings.sidebarBackground,
    );
  });
});

describe("resolveVibrancyOverlayAdjustment", () => {
  it("off makes no adjustment", () => {
    expect(resolveVibrancyOverlayAdjustment("off", 60)).toBe(60);
  });

  it("subtle reduces opacity by 15", () => {
    expect(resolveVibrancyOverlayAdjustment("subtle", 60)).toBe(45);
  });

  it("strong reduces opacity by 30", () => {
    expect(resolveVibrancyOverlayAdjustment("strong", 60)).toBe(30);
  });

  it("clamps to zero", () => {
    expect(resolveVibrancyOverlayAdjustment("strong", 10)).toBe(0);
    expect(resolveVibrancyOverlayAdjustment("subtle", 5)).toBe(0);
  });
});

describe("resolveEffectiveSidebarBackground", () => {
  const bgBaseSettings = {
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

  function makeSettings(bg: MakeBgInput): ReturnType<typeof decodeThemeSettings> {
    const kind = bg.kind ?? "none";
    const input: Record<string, unknown> = {
      kind,
      overlayColor: bg.overlayColor ?? "#1a1a1c",
      overlayOpacity: bg.overlayOpacity ?? 60,
      vibrancyMode: bg.vibrancyMode ?? "off",
    };
    if (kind === "preset") input.presetId = bg.presetId ?? "gradient-aurora";
    if (kind === "custom")
      input.backgroundId = bg.backgroundId ?? "00000000-0000-4000-8000-000000000b01";
    const sidebarBackground: SidebarBackground = decodeSidebarBackground(input);
    return decodeThemeSettings({ ...bgBaseSettings, sidebarBackground });
  }

  it("applies vibrancy overlay adjustment after accessibility", () => {
    const settings = makeSettings({
      kind: "preset",
      presetId: "gradient-aurora",
      overlayOpacity: 60,
      vibrancyMode: "strong",
    });
    const resolved = resolveEffectiveSidebarBackground(settings, true);
    expect(resolved.overlayOpacity).toBe(30);
    expect(resolved.backgroundCss).toBeTruthy();
  });

  it("increased contrast floor wins over vibrancy reduction", () => {
    const settings = {
      ...makeSettings({ kind: "preset", overlayOpacity: 85, vibrancyMode: "strong" }),
      increasedContrast: true,
    };
    const resolved = resolveEffectiveSidebarBackground(settings, true);
    // 85 (already >= 80), then strong reduces by 30 -> 55, then re-clamped to >= 80 -> 80.
    // The increased-contrast floor always wins over vibrancy reduction.
    expect(resolved.overlayOpacity).toBe(80);
  });
});

describe("application background policy", () => {
  const resolvedDefaults = {
    patternOpacity: 0.55,
    patternSpeed: 1,
    patternIntensity: 0.6,
    photoOpacity: 0.42,
    scope: "welcome",
    coversSidebar: false,
  };

  it("animates the theme pattern until reduced motion or a zero speed asks it to hold still", () => {
    expect(resolveAppBackground(baseSettings)).toEqual({
      ...resolvedDefaults,
      kind: "theme",
      backgroundId: null,
      animated: true,
    });
    expect(resolveAppBackground({ ...baseSettings, reducedMotion: true }).animated).toBe(false);
    expect(resolveAppBackground(baseSettings, true).animated).toBe(false);
    expect(
      resolveAppBackground({
        ...baseSettings,
        appBackground: { ...baseSettings.appBackground, patternSpeed: 0 },
      }).animated,
    ).toBe(false);
  });

  it("keeps a photo under reduced motion and hands its image id and dials to the renderer", () => {
    const settings: ThemeSettings = {
      ...baseSettings,
      reducedMotion: true,
      appBackground: {
        ...baseSettings.appBackground,
        kind: "photo",
        backgroundId: "00000000-0000-4000-8000-000000000b01" as never,
        photoOpacity: 70,
        patternSpeed: 100,
      },
    };
    expect(resolveAppBackground(settings)).toEqual({
      ...resolvedDefaults,
      kind: "photo",
      backgroundId: "00000000-0000-4000-8000-000000000b01",
      animated: false,
      photoOpacity: 0.7,
      patternSpeed: 2,
    });
  });

  it("runs under the sidebar only when the ground is everywhere and a person asked for it", () => {
    const everywhere = resolveAppBackground({
      ...baseSettings,
      appBackground: { ...baseSettings.appBackground, scope: "everywhere", coversSidebar: true },
    });
    expect(everywhere.scope).toBe("everywhere");
    expect(everywhere.coversSidebar).toBe(true);
    const welcomeOnly = resolveAppBackground({
      ...baseSettings,
      appBackground: { ...baseSettings.appBackground, scope: "welcome", coversSidebar: true },
    });
    expect(welcomeOnly.coversSidebar).toBe(false);
  });

  it("turns the ground off under increased contrast and when a person chose none", () => {
    expect(resolveAppBackground({ ...baseSettings, increasedContrast: true })).toEqual({
      ...resolvedDefaults,
      kind: "none",
      backgroundId: null,
      animated: false,
    });
    expect(
      resolveAppBackground({
        ...baseSettings,
        appBackground: { ...baseSettings.appBackground, kind: "none" },
      }).kind,
    ).toBe("none");
  });
});
