import { Schema } from "effect";
import { AggregateVersion, UtcTimestamp } from "./events";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const brandedString = <B extends string>(brand: B) =>
  Schema.NonEmptyTrimmedString.pipe(Schema.brand(brand));
const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));

export const ThemeMode = Schema.Literal("system", "light", "dark");
export type ThemeMode = typeof ThemeMode.Type;

export const ThemeDensity = Schema.Literal("comfortable", "compact");
export type ThemeDensity = typeof ThemeDensity.Type;

export const ThemeTranslucency = Schema.Literal("translucent", "opaque");
export type ThemeTranslucency = typeof ThemeTranslucency.Type;

export const ThemeTimestampFormat = Schema.Literal("12h", "24h");
export type ThemeTimestampFormat = typeof ThemeTimestampFormat.Type;

export const ThemeFontSmoothing = Schema.Literal("auto", "on", "off");
export type ThemeFontSmoothing = typeof ThemeFontSmoothing.Type;

export const ThemePresetId = brandedString("ThemePresetId").pipe(Schema.maxLength(128));
export type ThemePresetId = typeof ThemePresetId.Type;

export const ThemeTokenRole = brandedString("ThemeTokenRole").pipe(Schema.maxLength(64));
export type ThemeTokenRole = typeof ThemeTokenRole.Type;

export const ThemeHexColor = Schema.String.pipe(
  Schema.pattern(/^#[0-9a-fA-F]{6}$/),
  Schema.brand("ThemeHexColor"),
);
export type ThemeHexColor = typeof ThemeHexColor.Type;

export const ThemeFontFamily = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(128),
  Schema.filter((value) => {
    const lower = value.toLowerCase();
    if (
      lower.includes("url(") ||
      lower.includes("@import") ||
      lower.includes("http:") ||
      lower.includes("https:") ||
      lower.includes("://") ||
      lower.includes("<") ||
      lower.includes(">") ||
      lower.includes(";") ||
      lower.includes("\\") ||
      lower.includes("\n") ||
      lower.includes("\r") ||
      lower.includes("\t")
    ) {
      return false;
    }
    return true;
  }),
);
export type ThemeFontFamily = typeof ThemeFontFamily.Type;

export const ThemeFontSize = Schema.Int.pipe(Schema.between(8, 32));
export type ThemeFontSize = typeof ThemeFontSize.Type;

export const ThemeFontWeight = Schema.Int.pipe(Schema.between(300, 700));
export type ThemeFontWeight = typeof ThemeFontWeight.Type;

export const ThemeLineHeight = Schema.Number.pipe(Schema.between(1, 2.5));
export type ThemeLineHeight = typeof ThemeLineHeight.Type;

export const TypographyUi = Schema.Struct({
  family: ThemeFontFamily,
  size: ThemeFontSize,
  weight: Schema.optionalWith(ThemeFontWeight, { default: () => 400 }),
}).annotations(strict);
export type TypographyUi = typeof TypographyUi.Type;

export const TypographyEditor = Schema.Struct({
  family: ThemeFontFamily,
  size: ThemeFontSize,
  weight: Schema.optionalWith(ThemeFontWeight, { default: () => 400 }),
  lineHeight: ThemeLineHeight,
  ligatures: Schema.Boolean,
}).annotations(strict);
export type TypographyEditor = typeof TypographyEditor.Type;

export const TypographyTerminal = Schema.Struct({
  family: ThemeFontFamily,
  size: ThemeFontSize,
  weight: Schema.optionalWith(ThemeFontWeight, { default: () => 400 }),
  lineHeight: ThemeLineHeight,
  ligatures: Schema.Boolean,
}).annotations(strict);
export type TypographyTerminal = typeof TypographyTerminal.Type;

export const ThemeTypography = Schema.Struct({
  ui: TypographyUi,
  editor: TypographyEditor,
  terminal: TypographyTerminal,
}).annotations(strict);
export type ThemeTypography = typeof ThemeTypography.Type;

export const ThemeSemanticOverrideEntry = Schema.Struct({
  role: ThemeTokenRole,
  color: ThemeHexColor,
}).annotations(strict);
export type ThemeSemanticOverrideEntry = typeof ThemeSemanticOverrideEntry.Type;

const UniqueThemeSemanticOverrides = Schema.Array(ThemeSemanticOverrideEntry).pipe(
  Schema.filter((overrides) => {
    const seen = new Set<string>();
    for (const entry of overrides) {
      if (seen.has(entry.role)) return false;
      seen.add(entry.role);
    }
    return true;
  }),
);
export const ThemeSemanticOverrides = UniqueThemeSemanticOverrides;
export type ThemeSemanticOverrides = typeof ThemeSemanticOverrides.Type;

export const SidebarBackgroundPresetId = brandedString("SidebarBackgroundPresetId").pipe(
  Schema.maxLength(64),
);
export type SidebarBackgroundPresetId = typeof SidebarBackgroundPresetId.Type;

export const SidebarBackgroundId = brandedUuid("SidebarBackgroundId");
export type SidebarBackgroundId = typeof SidebarBackgroundId.Type;

export const SidebarBackgroundKind = Schema.Literal("preset", "custom", "none");
export type SidebarBackgroundKind = typeof SidebarBackgroundKind.Type;

export const SidebarOverlayOpacity = Schema.Int.pipe(Schema.between(0, 100));
export type SidebarOverlayOpacity = typeof SidebarOverlayOpacity.Type;

export const SidebarVibrancyMode = Schema.Literal("off", "subtle", "strong");
export type SidebarVibrancyMode = typeof SidebarVibrancyMode.Type;

const PresetSidebarBackground = Schema.Struct({
  kind: Schema.Literal("preset"),
  presetId: SidebarBackgroundPresetId,
  overlayColor: ThemeHexColor,
  overlayOpacity: SidebarOverlayOpacity,
  vibrancyMode: SidebarVibrancyMode,
}).annotations(strict);

const CustomSidebarBackground = Schema.Struct({
  kind: Schema.Literal("custom"),
  backgroundId: SidebarBackgroundId,
  overlayColor: ThemeHexColor,
  overlayOpacity: SidebarOverlayOpacity,
  vibrancyMode: SidebarVibrancyMode,
}).annotations(strict);

const NoneSidebarBackground = Schema.Struct({
  kind: Schema.Literal("none"),
  overlayColor: ThemeHexColor,
  overlayOpacity: SidebarOverlayOpacity,
  vibrancyMode: SidebarVibrancyMode,
}).annotations(strict);

export const SidebarBackground = Schema.Union(
  PresetSidebarBackground,
  CustomSidebarBackground,
  NoneSidebarBackground,
);
export type SidebarBackground = typeof SidebarBackground.Type;

export const DEFAULT_SIDEBAR_BACKGROUND: SidebarBackground = Schema.decodeSync(SidebarBackground)({
  kind: "none",
  overlayColor: "#1a1a1c",
  overlayOpacity: 100,
  vibrancyMode: "subtle",
});

export const ThemeSettings = Schema.Struct({
  mode: ThemeMode,
  lightPresetId: Schema.optional(ThemePresetId),
  darkPresetId: Schema.optional(ThemePresetId),
  density: ThemeDensity,
  translucency: ThemeTranslucency,
  fontSmoothing: ThemeFontSmoothing,
  timestampFormat: ThemeTimestampFormat,
  typography: ThemeTypography,
  semanticOverrides: ThemeSemanticOverrides,
  sidebarBackground: SidebarBackground,
  increasedContrast: Schema.Boolean,
  reducedMotion: Schema.Boolean,
  reducedTransparency: Schema.Boolean,
}).annotations(strict);
export type ThemeSettings = typeof ThemeSettings.Type;

export const DEFAULT_THEME_SETTINGS: ThemeSettings = {
  mode: "system",
  density: "comfortable",
  translucency: "translucent",
  fontSmoothing: "auto",
  timestampFormat: "24h",
  typography: {
    ui: {
      family: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
      size: 13,
      weight: 400,
    },
    editor: {
      family: "'JetBrains Mono', 'SF Mono', Menlo, monospace",
      size: 13,
      weight: 400,
      lineHeight: 1.5,
      ligatures: true,
    },
    terminal: {
      // Nerd Font families sit after the text faces so prompt glyphs (starship,
      // powerlevel10k, lsd) resolve per character on machines that have one
      // installed, without changing how ordinary text renders.
      family:
        "'JetBrains Mono', 'SF Mono', Menlo, 'Symbols Nerd Font Mono', 'MesloLGS NF', 'Hack Nerd Font Mono', monospace",
      size: 12,
      weight: 400,
      lineHeight: 1.4,
      ligatures: false,
    },
  },
  semanticOverrides: [],
  sidebarBackground: DEFAULT_SIDEBAR_BACKGROUND,
  increasedContrast: false,
  reducedMotion: false,
  reducedTransparency: false,
};

export const ThemeSettingsUpdated = Schema.Struct({
  settings: ThemeSettings,
  version: AggregateVersion,
  updatedAt: UtcTimestamp,
}).annotations(strict);
export type ThemeSettingsUpdated = typeof ThemeSettingsUpdated.Type;

export const UpdateThemeSettings = Schema.Struct({
  kind: Schema.Literal("update-theme-settings"),
  settings: ThemeSettings,
  expectedVersion: Schema.optional(AggregateVersion),
}).annotations(strict);
export type UpdateThemeSettings = typeof UpdateThemeSettings.Type;

export const ThemeBootstrap = Schema.Struct({
  settings: ThemeSettings,
  version: AggregateVersion,
}).annotations(strict);
export type ThemeBootstrap = typeof ThemeBootstrap.Type;

export const ThemeCommand = Schema.Union(UpdateThemeSettings).annotations(strict);
export type ThemeCommand = typeof ThemeCommand.Type;

export const ThemeCommandResult = Schema.Struct({
  kind: Schema.Literal("theme-settings-replaced"),
  settings: ThemeSettings,
  version: AggregateVersion,
}).annotations(strict);
export type ThemeCommandResult = typeof ThemeCommandResult.Type;

export const ThemeFailure = Schema.Union(
  Schema.Struct({
    category: Schema.Literal("invalid"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("conflict"),
    message: Schema.NonEmptyTrimmedString,
    expectedVersion: AggregateVersion,
    actualVersion: AggregateVersion,
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("unavailable"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("recovery-required"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
);
export type ThemeFailure = typeof ThemeFailure.Type;

export const THEME_EVENT_NAMES = [
  "theme.settings-updated@1",
  "theme.sidebar-background-updated@1",
] as const;

export const MAX_SIDEBAR_BACKGROUND_BYTES = 8_388_608;
export const SIDEBAR_BACKGROUND_MAX_WIDTH = 4096;
export const SIDEBAR_BACKGROUND_MAX_HEIGHT = 4096;
export const SIDEBAR_BACKGROUND_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

export const SidebarBackgroundMetadata = Schema.Struct({
  id: SidebarBackgroundId,
  displayName: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255)),
  mediaType: Schema.Literal(...SIDEBAR_BACKGROUND_MEDIA_TYPES),
  byteLength: Schema.Int.pipe(Schema.nonNegative()),
  width: Schema.Int.pipe(Schema.positive()),
  height: Schema.Int.pipe(Schema.positive()),
  uploadedAt: UtcTimestamp,
}).annotations(strict);
export type SidebarBackgroundMetadata = typeof SidebarBackgroundMetadata.Type;

export const SidebarBackgroundUploadResult = Schema.Struct({
  backgroundId: SidebarBackgroundId,
}).annotations(strict);
export type SidebarBackgroundUploadResult = typeof SidebarBackgroundUploadResult.Type;

export const SidebarBackgroundListResult = Schema.Struct({
  backgrounds: Schema.Array(SidebarBackgroundMetadata),
}).annotations(strict);
export type SidebarBackgroundListResult = typeof SidebarBackgroundListResult.Type;

export const UpdateSidebarBackground = Schema.Struct({
  kind: Schema.Literal("update-sidebar-background"),
  background: SidebarBackground,
  expectedVersion: Schema.optional(AggregateVersion),
}).annotations(strict);
export type UpdateSidebarBackground = typeof UpdateSidebarBackground.Type;

export const DeleteSidebarBackground = Schema.Struct({
  kind: Schema.Literal("delete-sidebar-background"),
  backgroundId: SidebarBackgroundId,
}).annotations(strict);
export type DeleteSidebarBackground = typeof DeleteSidebarBackground.Type;

export const decodeThemeMode = Schema.decodeUnknownSync(ThemeMode);
export const decodeThemeDensity = Schema.decodeUnknownSync(ThemeDensity);
export const decodeThemeTranslucency = Schema.decodeUnknownSync(ThemeTranslucency);
export const decodeThemeTimestampFormat = Schema.decodeUnknownSync(ThemeTimestampFormat);
export const decodeThemeFontSmoothing = Schema.decodeUnknownSync(ThemeFontSmoothing);
export const decodeThemePresetId = Schema.decodeUnknownSync(ThemePresetId);
export const decodeThemeTokenRole = Schema.decodeUnknownSync(ThemeTokenRole);
export const decodeThemeHexColor = Schema.decodeUnknownSync(ThemeHexColor);
export const decodeThemeFontFamily = Schema.decodeUnknownSync(ThemeFontFamily);
export const decodeThemeFontSize = Schema.decodeUnknownSync(ThemeFontSize);
export const decodeThemeFontWeight = Schema.decodeUnknownSync(ThemeFontWeight);
export const decodeThemeLineHeight = Schema.decodeUnknownSync(ThemeLineHeight);
export const decodeTypographyUi = Schema.decodeUnknownSync(TypographyUi);
export const decodeTypographyEditor = Schema.decodeUnknownSync(TypographyEditor);
export const decodeTypographyTerminal = Schema.decodeUnknownSync(TypographyTerminal);
export const decodeThemeTypography = Schema.decodeUnknownSync(ThemeTypography);
export const decodeThemeSemanticOverrideEntry = Schema.decodeUnknownSync(
  ThemeSemanticOverrideEntry,
);
export const decodeThemeSemanticOverrides = Schema.decodeUnknownSync(ThemeSemanticOverrides);
const decodeThemeSettingsSchema = Schema.decodeUnknownSync(ThemeSettings);

export function decodeThemeSettings(input: unknown): ThemeSettings {
  if (
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    !("sidebarBackground" in input)
  ) {
    return decodeThemeSettingsSchema({
      ...(input as object),
      sidebarBackground: DEFAULT_SIDEBAR_BACKGROUND,
    });
  }
  return decodeThemeSettingsSchema(input);
}
export const decodeThemeSettingsUpdated = Schema.decodeUnknownSync(ThemeSettingsUpdated);
export const decodeUpdateThemeSettings = Schema.decodeUnknownSync(UpdateThemeSettings);
export const decodeThemeBootstrap = Schema.decodeUnknownSync(ThemeBootstrap);
export const decodeThemeCommand = Schema.decodeUnknownSync(ThemeCommand);
export const decodeThemeCommandResult = Schema.decodeUnknownSync(ThemeCommandResult);
export const decodeThemeFailure = Schema.decodeUnknownSync(ThemeFailure);
export const decodeSidebarBackgroundId = Schema.decodeUnknownSync(SidebarBackgroundId);
export const decodeSidebarBackgroundPresetId = Schema.decodeUnknownSync(SidebarBackgroundPresetId);
export const decodeSidebarBackground = Schema.decodeUnknownSync(SidebarBackground);
export const decodeSidebarBackgroundMetadata = Schema.decodeUnknownSync(SidebarBackgroundMetadata);
export const decodeSidebarBackgroundUploadResult = Schema.decodeUnknownSync(
  SidebarBackgroundUploadResult,
);
export const decodeSidebarBackgroundListResult = Schema.decodeUnknownSync(
  SidebarBackgroundListResult,
);
export const decodeUpdateSidebarBackground = Schema.decodeUnknownSync(UpdateSidebarBackground);
export const decodeDeleteSidebarBackground = Schema.decodeUnknownSync(DeleteSidebarBackground);
