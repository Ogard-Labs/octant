import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  MAX_SIDEBAR_BACKGROUND_BYTES,
  SIDEBAR_BACKGROUND_MEDIA_TYPES,
  SidebarBackgroundUploadResult,
  THEME_EVENT_NAMES,
  ThemeDensity,
  ThemeFontFamily,
  ThemeFontSize,
  ThemeFontWeight,
  ThemeHexColor,
  ThemeLineHeight,
  ThemeMode,
  ThemeSemanticOverrideEntry,
  ThemeSemanticOverrides,
  ThemeTimestampFormat,
  ThemeTranslucency,
  TypographyEditor,
  TypographyTerminal,
  TypographyUi,
  DEFAULT_THEME_SETTINGS,
  decodeSidebarBackground,
  decodeAppBackground,
  DEFAULT_APP_BACKGROUND,
  decodeSidebarBackgroundListResult,
  decodeSidebarBackgroundMetadata,
  decodeThemeSettings,
  decodeThemeSettingsUpdated,
  decodeUpdateSidebarBackground,
  decodeDeleteSidebarBackground,
  decodeUpdateThemeSettings,
} from "./theme";

const validSettings = {
  mode: "system",
  density: "comfortable",
  translucency: "translucent",
  fontSmoothing: "auto",
  timestampFormat: "24h",
  increasedContrast: false,
  reducedMotion: false,
  reducedTransparency: false,
  typography: {
    ui: { family: "Inter", size: 13 },
    editor: { family: "JetBrains Mono", size: 13, lineHeight: 1.5, ligatures: true },
    terminal: { family: "JetBrains Mono", size: 12, lineHeight: 1.4, ligatures: false },
  },
  semanticOverrides: [],
} as const;

describe("theme contracts", () => {
  it("publishes the durable theme event vocabulary", () => {
    expect(THEME_EVENT_NAMES).toEqual([
      "theme.settings-updated@1",
      "theme.sidebar-background-updated@1",
    ]);
  });

  it.each(["system", "light", "dark"] as const)("decodes the %s theme mode", (mode) => {
    expect(Schema.decodeUnknownSync(ThemeMode)(mode)).toBe(mode);
  });

  it.each(["comfortable", "compact"] as const)("decodes the %s density", (density) => {
    expect(Schema.decodeUnknownSync(ThemeDensity)(density)).toBe(density);
  });

  it.each(["translucent", "opaque"] as const)("decodes the %s translucency", (value) => {
    expect(Schema.decodeUnknownSync(ThemeTranslucency)(value)).toBe(value);
  });

  it.each(["12h", "24h"] as const)("decodes the %s timestamp format", (value) => {
    expect(Schema.decodeUnknownSync(ThemeTimestampFormat)(value)).toBe(value);
  });

  it("decodes a full theme settings payload and rejects excess fields", () => {
    const settings = decodeThemeSettings(validSettings);
    expect(settings.mode).toBe("system");
    expect(settings.typography.editor.lineHeight).toBe(1.5);
    expect(() => decodeThemeSettings({ ...validSettings, secret: "token" })).toThrow();
    expect(() => decodeThemeSettings({ ...validSettings, apiKey: "x" })).toThrow();
  });

  it("accepts optional preset ids and defaults semantic overrides to empty", () => {
    const settings = decodeThemeSettings({
      ...validSettings,
      lightPresetId: "octant-light",
      darkPresetId: "octant-dark",
    });
    expect(settings.lightPresetId).toBe("octant-light");
    expect(settings.darkPresetId).toBe("octant-dark");
  });

  it("rejects unknown theme mode and density", () => {
    expect(() => decodeThemeSettings({ ...validSettings, mode: "auto" })).toThrow();
    expect(() => decodeThemeSettings({ ...validSettings, density: "dense" })).toThrow();
  });

  it.each([
    "url(https://evil.example/font.woff)",
    "@import 'evil.css';",
    "https://evil.example/font",
    "EvilFont; background:red",
    "EvilFont</style>",
    "EvilFont\n",
    "",
    "   ",
  ])("rejects unsafe or empty font family %s", (family) => {
    expect(() =>
      decodeThemeSettings({
        ...validSettings,
        typography: { ...validSettings.typography, ui: { ...validSettings.typography.ui, family } },
      }),
    ).toThrow();
    expect(() => Schema.decodeUnknownSync(ThemeFontFamily)(family)).toThrow();
  });

  it("accepts a comma-separated quoted font stack", () => {
    expect(
      Schema.decodeUnknownSync(ThemeFontFamily)('"SF Pro Display", "Helvetica Neue", sans-serif'),
    ).toBe('"SF Pro Display", "Helvetica Neue", sans-serif');
  });

  it.each([7, 33, 0, 12.5, -1])("rejects font size %s", (size) => {
    expect(() => Schema.decodeUnknownSync(ThemeFontSize)(size)).toThrow();
  });

  it.each([8, 13, 32])("accepts font size %s", (size) => {
    expect(Schema.decodeUnknownSync(ThemeFontSize)(size)).toBe(size);
  });

  it.each([300, 400, 700])("accepts font weight %s", (weight) => {
    expect(Schema.decodeUnknownSync(ThemeFontWeight)(weight)).toBe(weight);
  });

  it.each([299, 701, 400.5, Number.NaN])("rejects unsafe font weight %s", (weight) => {
    expect(() => Schema.decodeUnknownSync(ThemeFontWeight)(weight)).toThrow();
  });

  it("defaults weight when decoding a legacy typography payload", () => {
    const settings = decodeThemeSettings(validSettings);
    expect(settings.typography).toMatchObject({
      ui: { weight: 400 },
      editor: { weight: 400 },
      terminal: { weight: 400 },
    });
  });

  it.each([0.9, 2.6, 0, 3])("rejects line height %s", (value) => {
    expect(() => Schema.decodeUnknownSync(ThemeLineHeight)(value)).toThrow();
  });

  it.each([1, 1.4, 2.5])("accepts line height %s", (value) => {
    expect(Schema.decodeUnknownSync(ThemeLineHeight)(value)).toBe(value);
  });

  it.each(["#fff", "#GGGGGG", "white", "rgb(0,0,0)", "#0000003", "", "#0000000"])(
    "rejects invalid hex color %s",
    (color) => {
      expect(() => Schema.decodeUnknownSync(ThemeHexColor)(color)).toThrow();
    },
  );

  it.each(["#000000", "#FFFFFF", "#1a1a1c", "#D8D8D4"])("accepts hex color %s", (color) => {
    expect(Schema.decodeUnknownSync(ThemeHexColor)(color)).toBe(color);
  });

  it("rejects semantic overrides with duplicate roles or invalid colors", () => {
    expect(() =>
      Schema.decodeUnknownSync(ThemeSemanticOverrides)([
        { role: "accent", color: "#000000" },
        { role: "accent", color: "#ffffff" },
      ]),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ThemeSemanticOverrideEntry)({ role: "accent", color: "white" }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ThemeSemanticOverrideEntry)({ role: "", color: "#000000" }),
    ).toThrow();
  });

  it("rejects editor typography missing required fields", () => {
    expect(() =>
      Schema.decodeUnknownSync(TypographyEditor)({ family: "Inter", size: 13, lineHeight: 1.5 }),
    ).toThrow();
  });

  it("rejects terminal typography with excess fields", () => {
    expect(() =>
      Schema.decodeUnknownSync(TypographyTerminal)({
        family: "Inter",
        size: 13,
        lineHeight: 1.5,
        ligatures: false,
        shell: "zsh",
      }),
    ).toThrow();
  });

  it("rejects ui typography with excess fields", () => {
    expect(() =>
      Schema.decodeUnknownSync(TypographyUi)({ family: "Inter", size: 13, lineHeight: 1.5 }),
    ).toThrow();
  });

  it("decodes theme settings updated event and update command", () => {
    const settings = decodeThemeSettings(validSettings);
    const event = { settings, version: 1, updatedAt: "2026-07-22T10:00:00.000Z" };
    expect(decodeThemeSettingsUpdated(event)).toEqual(event);
    expect(decodeUpdateThemeSettings({ kind: "update-theme-settings", settings })).toMatchObject({
      kind: "update-theme-settings",
    });
    expect(() =>
      decodeUpdateThemeSettings({ kind: "update-theme-settings", settings, secret: "x" }),
    ).toThrow();
  });
});

describe("sidebar background contracts", () => {
  it("publishes the sidebar background event in the theme vocabulary", () => {
    expect(THEME_EVENT_NAMES).toContain("theme.sidebar-background-updated@1");
  });

  it("exports bounded background constants", () => {
    expect(MAX_SIDEBAR_BACKGROUND_BYTES).toBe(8_388_608);
    expect([...SIDEBAR_BACKGROUND_MEDIA_TYPES]).toEqual(["image/png", "image/jpeg", "image/webp"]);
  });

  it("decodes a preset background with overlay and vibrancy", () => {
    const bg = decodeSidebarBackground({
      kind: "preset",
      presetId: "gradient-aurora",
      overlayColor: "#1a1a1c",
      overlayOpacity: 60,
      vibrancyMode: "off",
    });
    expect(bg.kind).toBe("preset");
    if (bg.kind === "preset") {
      expect(bg.presetId).toBe("gradient-aurora");
    }
    expect(bg.overlayOpacity).toBe(60);
  });

  it("decodes a custom background with a background id", () => {
    const bg = decodeSidebarBackground({
      kind: "custom",
      backgroundId: "00000000-0000-4000-8000-000000000b01",
      overlayColor: "#000000",
      overlayOpacity: 40,
      vibrancyMode: "subtle",
    });
    expect(bg.kind).toBe("custom");
    if (bg.kind === "custom") {
      expect(bg.backgroundId).toBe("00000000-0000-4000-8000-000000000b01");
    }
  });

  it("decodes a none background", () => {
    const bg = decodeSidebarBackground({
      kind: "none",
      overlayColor: "#1a1a1c",
      overlayOpacity: 100,
      vibrancyMode: "off",
    });
    expect(bg.kind).toBe("none");
    if (bg.kind === "preset") {
      expect(bg.presetId).toBeUndefined();
    }
    if (bg.kind === "custom") {
      expect(bg.backgroundId).toBeUndefined();
    }
  });

  it("rejects preset without presetId", () => {
    expect(() =>
      decodeSidebarBackground({
        kind: "preset",
        overlayColor: "#000000",
        overlayOpacity: 50,
        vibrancyMode: "off",
      }),
    ).toThrow();
  });

  it("rejects custom without backgroundId", () => {
    expect(() =>
      decodeSidebarBackground({
        kind: "custom",
        overlayColor: "#000000",
        overlayOpacity: 50,
        vibrancyMode: "off",
      }),
    ).toThrow();
  });

  it("rejects preset with backgroundId", () => {
    expect(() =>
      decodeSidebarBackground({
        kind: "preset",
        presetId: "gradient-aurora",
        backgroundId: "00000000-0000-4000-8000-000000000b01",
        overlayColor: "#000000",
        overlayOpacity: 50,
        vibrancyMode: "off",
      }),
    ).toThrow();
  });

  it("rejects none with presetId or backgroundId", () => {
    expect(() =>
      decodeSidebarBackground({
        kind: "none",
        presetId: "gradient-aurora",
        overlayColor: "#000000",
        overlayOpacity: 100,
        vibrancyMode: "off",
      }),
    ).toThrow();
  });

  it("rejects overlay opacity out of range", () => {
    expect(() =>
      decodeSidebarBackground({
        kind: "none",
        overlayColor: "#000000",
        overlayOpacity: 101,
        vibrancyMode: "off",
      }),
    ).toThrow();
    expect(() =>
      decodeSidebarBackground({
        kind: "none",
        overlayColor: "#000000",
        overlayOpacity: -1,
        vibrancyMode: "off",
      }),
    ).toThrow();
  });

  it("rejects invalid vibrancy mode", () => {
    expect(() =>
      decodeSidebarBackground({
        kind: "none",
        overlayColor: "#000000",
        overlayOpacity: 100,
        vibrancyMode: "medium",
      }),
    ).toThrow();
  });

  it("rejects invalid overlay color", () => {
    expect(() =>
      decodeSidebarBackground({
        kind: "none",
        overlayColor: "white",
        overlayOpacity: 100,
        vibrancyMode: "off",
      }),
    ).toThrow();
  });

  it("rejects excess fields and secrets", () => {
    expect(() =>
      decodeSidebarBackground({
        kind: "none",
        overlayColor: "#000000",
        overlayOpacity: 100,
        vibrancyMode: "off",
        secret: "x",
      }),
    ).toThrow();
    expect(() =>
      decodeSidebarBackground({
        kind: "none",
        overlayColor: "#000000",
        overlayOpacity: 100,
        vibrancyMode: "off",
        apiKey: "x",
      }),
    ).toThrow();
  });

  it("default theme settings include a none sidebar background", () => {
    const settings = decodeThemeSettings(DEFAULT_THEME_SETTINGS);
    expect(settings.sidebarBackground.kind).toBe("none");
    expect(settings.sidebarBackground.overlayOpacity).toBe(100);
    expect(settings.sidebarBackground.vibrancyMode).toBe("subtle");
  });

  it("migrates pre-sidebar-background settings by defaulting the field", () => {
    const legacy = {
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
    };
    const settings = decodeThemeSettings(legacy);
    expect(settings.sidebarBackground.kind).toBe("none");
    expect(settings.sidebarBackground.overlayOpacity).toBe(100);
    expect(settings.sidebarBackground.vibrancyMode).toBe("subtle");
  });

  it("decodes background metadata, upload result, and list result", () => {
    const meta = decodeSidebarBackgroundMetadata({
      id: "00000000-0000-4000-8000-000000000b01",
      displayName: "My background",
      mediaType: "image/png",
      byteLength: 1024,
      width: 1920,
      height: 1080,
      uploadedAt: "2026-07-22T10:00:00.000Z",
    });
    expect(meta.mediaType).toBe("image/png");

    const upload = Schema.decodeUnknownSync(SidebarBackgroundUploadResult)({
      backgroundId: "00000000-0000-4000-8000-000000000b01",
    });
    expect(upload.backgroundId).toBe("00000000-0000-4000-8000-000000000b01");

    const list = decodeSidebarBackgroundListResult({ backgrounds: [meta] });
    expect(list.backgrounds).toHaveLength(1);
  });

  it("decodes update and delete sidebar background commands", () => {
    const bg = decodeSidebarBackground({
      kind: "none",
      overlayColor: "#000000",
      overlayOpacity: 100,
      vibrancyMode: "off",
    });
    expect(
      decodeUpdateSidebarBackground({ kind: "update-sidebar-background", background: bg }),
    ).toMatchObject({ kind: "update-sidebar-background" });
    expect(
      decodeDeleteSidebarBackground({
        kind: "delete-sidebar-background",
        backgroundId: "00000000-0000-4000-8000-000000000b01",
      }),
    ).toMatchObject({ kind: "delete-sidebar-background" });
    expect(() =>
      decodeUpdateSidebarBackground({
        kind: "update-sidebar-background",
        background: bg,
        secret: "x",
      }),
    ).toThrow();
  });
});

describe("application background contracts", () => {
  const tuning = {
    patternOpacity: 55,
    patternSpeed: 50,
    patternIntensity: 60,
    photoOpacity: 42,
    scope: "welcome",
    coversSidebar: false,
  };

  it("decodes the theme pattern, a photo, and none, and rejects a photo without an image", () => {
    expect(decodeAppBackground({ kind: "theme" })).toEqual({ kind: "theme", ...tuning });
    expect(decodeAppBackground({ kind: "none" })).toEqual({ kind: "none", ...tuning });
    expect(
      decodeAppBackground({
        kind: "photo",
        backgroundId: "00000000-0000-4000-8000-000000000b01",
        scope: "everywhere",
        coversSidebar: true,
        patternOpacity: 30,
      }),
    ).toEqual({
      kind: "photo",
      backgroundId: "00000000-0000-4000-8000-000000000b01",
      ...tuning,
      scope: "everywhere",
      coversSidebar: true,
      patternOpacity: 30,
    });
    expect(() => decodeAppBackground({ kind: "photo" })).toThrow();
    expect(() => decodeAppBackground({ kind: "theme", backgroundId: "x" })).toThrow();
    expect(() => decodeAppBackground({ kind: "pattern" })).toThrow();
    expect(() => decodeAppBackground({ kind: "theme", patternSpeed: 140 })).toThrow();
    expect(() => decodeAppBackground({ kind: "theme", scope: "sidebar" })).toThrow();
  });

  it("replays settings written before the application background existed as the theme pattern", () => {
    expect(decodeThemeSettings(validSettings).appBackground).toEqual(DEFAULT_APP_BACKGROUND);
    const event = decodeThemeSettingsUpdated({
      settings: { ...validSettings, sidebarBackground: DEFAULT_THEME_SETTINGS.sidebarBackground },
      version: 3,
      updatedAt: "2026-09-06T10:00:00.000Z",
    });
    expect(event.settings.appBackground).toEqual({ kind: "theme", ...tuning });
    const photo = decodeThemeSettings({
      ...validSettings,
      appBackground: { kind: "photo", backgroundId: "00000000-0000-4000-8000-000000000b01" },
    });
    expect(photo.appBackground.kind).toBe("photo");
  });
});
