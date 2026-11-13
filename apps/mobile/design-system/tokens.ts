import { getDefaultToken } from "@octant/theme/tokens";

/**
 * Octant mobile tokens, aligned to the desktop/web palette.
 * Neutral greys, hairline borders, the theme's blue accent; status colours map to the
 * web palette roles so the phone reads as the same product as the desktop.
 * Owned Octant roles — not a third-party clone.
 */

export type ThemeScheme = "light" | "dark";

export type ThemeColors = {
  /** Workspace canvas (light) / app ground (dark). */
  canvas: string;
  canvasSoft: string;
  /** Primary ink. */
  ink: string;
  body: string;
  bodyStrong: string;
  muted: string;
  mutedSoft: string;
  hairline: string;
  hairlineSoft: string;
  hairlineStrong: string;
  /** Brand accent: the desktop's colour-style accent. The phone has no Mono choice yet. */
  primary: string;
  primaryActive: string;
  primarySoft: string;
  /** Timeline pastels (status stages). */
  stageThinking: string;
  stageReading: string;
  stageEditing: string;
  stageGrepping: string;
  stageDone: string;
  /** Soft atmospheric washes. */
  atmospherePrimary: string;
  atmosphereSecondary: string;
  /** Glass fills for liquid-glass. */
  glassFillThin: string;
  glassFillRegular: string;
  glassFillThick: string;
  glassFillChrome: string;
  glassStroke: string;
  glassStrokeStrong: string;
  glassHighlight: string;
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  send: string;
  sendLabel: string;
  userBubble: string;
  userBubbleText: string;
  /** Overlays drawn on the user bubble follow the bubble text, not the canvas. */
  onBubbleMuted: string;
  onBubbleFill: string;
  onBubbleStroke: string;
  assistantBubble: string;
  /** Control fills: a secondary button, a segmented track, a person's message. */
  control: string;
  controlHover: string;
  controlPressed: string;
  /** Ink on a solid palette face (a count tile in the light theme). */
  primaryForeground: string;
  /** The colour a raised control casts its shadow in. */
  shadow: string;
  /** Palette hues for the places that name something: count tiles, marks. */
  paletteBlue: string;
  paletteOrange: string;
  palettePurple: string;
  paletteGreen: string;
  paletteTeal: string;
  accent: string;
  accentMuted: string;
  danger: string;
  success: string;
  warning: string;
  merged: string;
  attention: string;
  backdrop: string;
  /** Legacy aliases */
  background: string;
  surface: string;
  surfaceElevated: string;
  border: string;
  separator: string;
  surfaceSolid: string;
  surfaceElevatedSolid: string;
  /** Custom wallpaper scrim + gradient stops. */
  customDim: string;
  customScrimTop: string;
  customScrimMid: string;
  customScrimBottom: string;
  /** Default canvas gradient mid stop. */
  canvasMid: string;
  atmosphereGradientStart: string;
  atmosphereGradientEnd: string;
  atmosphereScrimStart: string;
  atmosphereScrimEnd: string;
};

function shared(role: string, scheme: ThemeScheme): string {
  return getDefaultToken(role, scheme);
}

export const lightColors: ThemeColors = {
  canvas: shared("workspace", "light"),
  canvasSoft: shared("app-background", "light"),
  ink: shared("text-primary", "light"),
  body: shared("text-secondary", "light"),
  bodyStrong: shared("text-primary", "light"),
  muted: shared("text-muted", "light"),
  mutedSoft: "#8F8F8D",
  hairline: shared("border", "light"),
  hairlineSoft: "#E8E8E6",
  hairlineStrong: shared("border-strong", "light"),
  primary: shared("accent", "light"),
  primaryActive: "#3A3A3A",
  primarySoft: "rgba(27, 27, 27, 0.08)",
  stageThinking: shared("palette-blue", "light"),
  stageReading: shared("palette-green", "light"),
  stageEditing: shared("palette-yellow", "light"),
  stageGrepping: shared("palette-purple", "light"),
  stageDone: shared("success-text", "light"),
  atmospherePrimary: "rgba(27, 27, 27, 0.03)",
  atmosphereSecondary: "rgba(27, 27, 27, 0.02)",
  /** Translucent glass keeps a quiet neutral read over the canvas. */
  glassFillThin: "rgba(255, 255, 255, 0.55)",
  glassFillRegular: "rgba(255, 255, 255, 0.68)",
  glassFillThick: "rgba(253, 253, 252, 0.82)",
  glassFillChrome: "rgba(250, 250, 249, 0.76)",
  glassStroke: shared("border", "light"),
  glassStrokeStrong: shared("border-strong", "light"),
  glassHighlight: "rgba(255, 255, 255, 0.65)",
  textPrimary: shared("text-primary", "light"),
  textSecondary: shared("text-secondary", "light"),
  textTertiary: shared("text-muted", "light"),
  send: shared("accent", "light"),
  sendLabel: shared("accent-foreground", "light"),
  userBubble: shared("control", "light"),
  userBubbleText: shared("text-primary", "light"),
  onBubbleMuted: shared("text-secondary", "light"),
  onBubbleFill: "rgba(20, 20, 20, 0.06)",
  onBubbleStroke: "rgba(20, 20, 20, 0.10)",
  assistantBubble: "rgba(255, 255, 255, 0.68)",
  control: shared("control", "light"),
  controlHover: shared("control-hover", "light"),
  controlPressed: shared("control-pressed", "light"),
  primaryForeground: shared("primary-foreground", "light"),
  shadow: "#000000",
  paletteBlue: shared("palette-blue", "light"),
  paletteOrange: shared("palette-orange", "light"),
  palettePurple: shared("palette-purple", "light"),
  paletteGreen: shared("palette-green", "light"),
  paletteTeal: shared("palette-teal", "light"),
  accent: shared("accent", "light"),
  accentMuted: shared("text-secondary", "light"),
  danger: shared("danger-text", "light"),
  success: shared("success-text", "light"),
  warning: shared("warning-text", "light"),
  merged: shared("palette-purple", "light"),
  attention: shared("palette-blue", "light"),
  backdrop: "rgba(0, 0, 0, 0.30)",
  background: shared("workspace", "light"),
  surface: "rgba(255, 255, 255, 0.68)",
  surfaceElevated: "rgba(253, 253, 252, 0.82)",
  border: shared("border", "light"),
  separator: shared("border-strong", "light"),
  surfaceSolid: shared("workspace", "light"),
  surfaceElevatedSolid: shared("floating", "light"),
  customDim: "rgba(255, 255, 255, 0.60)",
  customScrimTop: "rgba(255,255,255,0.74)",
  customScrimMid: "rgba(255,255,255,0.36)",
  customScrimBottom: "rgba(255,255,255,0.84)",
  canvasMid: "#F2F2F1",
  atmosphereGradientStart: "rgba(27,27,27,0.04)",
  atmosphereGradientEnd: "rgba(27,27,27,0.02)",
  atmosphereScrimStart: "rgba(255,255,255,0.30)",
  atmosphereScrimEnd: "rgba(255,255,255,0.44)",
};

/** Neutral Octant dark — mirrors the desktop workspace greys. */
export const darkColors: ThemeColors = {
  canvas: shared("workspace", "dark"),
  canvasSoft: shared("app-background", "dark"),
  ink: shared("text-primary", "dark"),
  body: shared("text-secondary", "dark"),
  bodyStrong: shared("text-primary", "dark"),
  muted: shared("text-muted", "dark"),
  mutedSoft: "#707070",
  hairline: shared("border", "dark"),
  hairlineSoft: "#282828",
  hairlineStrong: shared("border-strong", "dark"),
  primary: shared("accent", "dark"),
  primaryActive: "#D0D0D0",
  primarySoft: "rgba(240, 240, 240, 0.10)",
  stageThinking: shared("palette-blue", "dark"),
  stageReading: shared("palette-green", "dark"),
  stageEditing: shared("palette-yellow", "dark"),
  stageGrepping: shared("palette-purple", "dark"),
  stageDone: shared("success-text", "dark"),
  atmospherePrimary: "rgba(240, 240, 240, 0.03)",
  atmosphereSecondary: "rgba(240, 240, 240, 0.02)",
  /** Neutral dark glass over the application ground. */
  glassFillThin: "rgba(35, 35, 35, 0.55)",
  glassFillRegular: "rgba(35, 35, 35, 0.70)",
  glassFillThick: "rgba(43, 43, 43, 0.82)",
  glassFillChrome: "rgba(43, 43, 43, 0.76)",
  glassStroke: shared("border", "dark"),
  glassStrokeStrong: shared("border-strong", "dark"),
  glassHighlight: "rgba(255, 255, 255, 0.07)",
  textPrimary: shared("text-primary", "dark"),
  textSecondary: shared("text-secondary", "dark"),
  textTertiary: shared("text-muted", "dark"),
  send: shared("accent", "dark"),
  sendLabel: shared("accent-foreground", "dark"),
  userBubble: shared("control", "dark"),
  userBubbleText: shared("text-primary", "dark"),
  onBubbleMuted: shared("text-secondary", "dark"),
  onBubbleFill: "rgba(245, 245, 247, 0.07)",
  onBubbleStroke: "rgba(245, 245, 247, 0.12)",
  assistantBubble: "rgba(35, 35, 35, 0.70)",
  control: shared("control", "dark"),
  controlHover: shared("control-hover", "dark"),
  controlPressed: shared("control-pressed", "dark"),
  primaryForeground: shared("primary-foreground", "dark"),
  shadow: "#000000",
  paletteBlue: shared("palette-blue", "dark"),
  paletteOrange: shared("palette-orange", "dark"),
  palettePurple: shared("palette-purple", "dark"),
  paletteGreen: shared("palette-green", "dark"),
  paletteTeal: shared("palette-teal", "dark"),
  accent: shared("accent", "dark"),
  accentMuted: shared("text-secondary", "dark"),
  danger: shared("danger-text", "dark"),
  success: shared("success-text", "dark"),
  warning: shared("warning-text", "dark"),
  merged: shared("palette-purple", "dark"),
  attention: shared("palette-blue", "dark"),
  backdrop: "rgba(0, 0, 0, 0.55)",
  background: shared("workspace", "dark"),
  surface: "rgba(35, 35, 35, 0.70)",
  surfaceElevated: "rgba(43, 43, 43, 0.82)",
  border: shared("border", "dark"),
  separator: shared("border-strong", "dark"),
  surfaceSolid: shared("floating", "dark"),
  surfaceElevatedSolid: shared("control", "dark"),
  customDim: "rgba(26, 26, 26, 0.64)",
  customScrimTop: "rgba(26,26,26,0.80)",
  customScrimMid: "rgba(26,26,26,0.42)",
  customScrimBottom: "rgba(26,26,26,0.88)",
  canvasMid: "#1F1F1F",
  atmosphereGradientStart: "rgba(240,240,240,0.04)",
  atmosphereGradientEnd: "rgba(240,240,240,0.02)",
  atmosphereScrimStart: "rgba(26,26,26,0.55)",
  atmosphereScrimEnd: "rgba(26,26,26,0.70)",
};

/** @deprecated Prefer useTheme().colors — static light fallback for tests. */
export const colors = lightColors;

export function colorsForScheme(scheme: ThemeScheme): ThemeColors {
  return scheme === "dark" ? darkColors : lightColors;
}

export const space = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

// One radius per role, the product scale (DESIGN.md › Radii and Depth and material): a
// control or row 8, a card or a person's message 12, a composer or dialog 14.
// The sheet is the phone's own: it rises from the screen's rounded bottom.
export const radii = {
  sm: 8,
  md: 12,
  lg: 14,
  composer: 14,
  bubble: 12,
  sheet: 20,
  pill: 999,
  circle: 999,
} as const;

/** Octant UI type — system stack for display, Nerd Font for mono/code. */
export const fonts = {
  /** JetBrainsMono Nerd Font — code pattern + mono chrome. */
  mono: "JetBrainsMonoNerdFont",
  /** Platform UI stack for headlines and body copy. */
  sans: undefined as string | undefined,
} as const;

/**
 * The product's type roles (DESIGN.md › Scale) at phone sizes. Hierarchy is
 * size first, then weight on the one ladder: 400 reading, 500 names and
 * controls, 600 emphasis and section labels, 700 only for the large title.
 */
export const typography = {
  /** A page about one thing, such as a pairing step. */
  hero: {
    fontSize: 28,
    fontWeight: "700" as const,
    letterSpacing: -0.7,
  },
  /** The title on a screen's toolbar row. */
  pageTitle: {
    fontSize: 17,
    fontWeight: "600" as const,
    letterSpacing: -0.4,
  },
  brand: {
    fontSize: 17,
    fontWeight: "600" as const,
    letterSpacing: -0.4,
  },
  /** A card or panel title: the system's headline step, not a page heading. */
  title: {
    fontSize: 18,
    fontWeight: "600" as const,
    letterSpacing: -0.3,
  },
  /** A list row's name or a setting's label. */
  rowLabel: {
    fontSize: 15,
    fontWeight: "500" as const,
  },
  /** Reading text: the transcript and interface prose. */
  body: {
    fontSize: 15,
    fontWeight: "400" as const,
  },
  /** A row's description or detail line, in the secondary ink. */
  detail: {
    fontSize: 13,
    fontWeight: "400" as const,
  },
  caption: {
    fontSize: 13,
    fontWeight: "400" as const,
  },
  /** Timestamps, counts, and hints, in the muted ink. */
  meta: {
    fontSize: 12,
    fontWeight: "400" as const,
  },
  /** A sentence-case group heading over a list, in the secondary ink. */
  section: {
    fontSize: 13,
    fontWeight: "600" as const,
    letterSpacing: -0.1,
  },
  mono: {
    fontSize: 13,
    fontWeight: "400" as const,
    letterSpacing: 0.2,
    fontFamily: fonts.mono,
  },
} as const;

export type GlassMaterial = "ultraThin" | "thin" | "regular" | "thick" | "chrome";
