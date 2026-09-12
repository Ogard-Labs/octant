/**
 * Octant mobile tokens, aligned to the desktop/web palette.
 * Neutral greys, hairline borders, monochrome accent; status colours map to the
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
  /** Brand accent — desktop-consistent neutral. */
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
};

export const lightColors: ThemeColors = {
  canvas: "#FFFFFF",
  canvasSoft: "#FAFAF9",
  ink: "#1B1B1B",
  body: "#4F4F4F",
  bodyStrong: "#1B1B1B",
  muted: "#666666",
  mutedSoft: "#8F8F8D",
  hairline: "#E0E0DE",
  hairlineSoft: "#E8E8E6",
  hairlineStrong: "#BDBDBB",
  primary: "#1B1B1B",
  primaryActive: "#3A3A3A",
  primarySoft: "rgba(27, 27, 27, 0.08)",
  stageThinking: "#1E5FAE",
  stageReading: "#41761C",
  stageEditing: "#8A6218",
  stageGrepping: "#5B4BB0",
  stageDone: "#0F6144",
  atmospherePrimary: "rgba(27, 27, 27, 0.03)",
  atmosphereSecondary: "rgba(27, 27, 27, 0.02)",
  /** Translucent glass keeps a quiet neutral read over the canvas. */
  glassFillThin: "rgba(255, 255, 255, 0.55)",
  glassFillRegular: "rgba(255, 255, 255, 0.68)",
  glassFillThick: "rgba(253, 253, 252, 0.82)",
  glassFillChrome: "rgba(250, 250, 249, 0.76)",
  glassStroke: "#E0E0DE",
  glassStrokeStrong: "#BDBDBB",
  glassHighlight: "rgba(255, 255, 255, 0.65)",
  textPrimary: "#1B1B1B",
  textSecondary: "#4F4F4F",
  textTertiary: "#666666",
  send: "#1B1B1B",
  sendLabel: "#FFFFFF",
  userBubble: "#1B1B1B",
  userBubbleText: "#FFFFFF",
  onBubbleMuted: "rgba(255, 255, 255, 0.72)",
  onBubbleFill: "rgba(255, 255, 255, 0.12)",
  onBubbleStroke: "rgba(255, 255, 255, 0.18)",
  assistantBubble: "rgba(255, 255, 255, 0.68)",
  accent: "#1B1B1B",
  accentMuted: "#4F4F4F",
  danger: "#A8102F",
  success: "#0F6144",
  warning: "#6F5300",
  merged: "#5B4BB0",
  attention: "#1E5FAE",
  backdrop: "rgba(0, 0, 0, 0.30)",
  background: "#FFFFFF",
  surface: "rgba(255, 255, 255, 0.68)",
  surfaceElevated: "rgba(253, 253, 252, 0.82)",
  border: "#E0E0DE",
  separator: "#BDBDBB",
  surfaceSolid: "#FFFFFF",
  surfaceElevatedSolid: "#FDFDFC",
  customDim: "rgba(255, 255, 255, 0.60)",
  customScrimTop: "rgba(255,255,255,0.74)",
  customScrimMid: "rgba(255,255,255,0.36)",
  customScrimBottom: "rgba(255,255,255,0.84)",
  canvasMid: "#F2F2F1",
  atmosphereGradientStart: "rgba(27,27,27,0.04)",
  atmosphereGradientEnd: "rgba(27,27,27,0.02)",
};

/** Neutral Octant dark — mirrors the desktop workspace greys. */
export const darkColors: ThemeColors = {
  canvas: "#1A1A1A",
  canvasSoft: "#151515",
  ink: "#F0F0F0",
  body: "#A9A9A9",
  bodyStrong: "#F0F0F0",
  muted: "#949494",
  mutedSoft: "#707070",
  hairline: "#303030",
  hairlineSoft: "#282828",
  hairlineStrong: "#4D4D4D",
  primary: "#F0F0F0",
  primaryActive: "#D0D0D0",
  primarySoft: "rgba(240, 240, 240, 0.10)",
  stageThinking: "#74B0F3",
  stageReading: "#93CB58",
  stageEditing: "#D9A441",
  stageGrepping: "#AB98F2",
  stageDone: "#6BB299",
  atmospherePrimary: "rgba(240, 240, 240, 0.03)",
  atmosphereSecondary: "rgba(240, 240, 240, 0.02)",
  /** Neutral dark glass over the application ground. */
  glassFillThin: "rgba(35, 35, 35, 0.55)",
  glassFillRegular: "rgba(35, 35, 35, 0.70)",
  glassFillThick: "rgba(43, 43, 43, 0.82)",
  glassFillChrome: "rgba(43, 43, 43, 0.76)",
  glassStroke: "#303030",
  glassStrokeStrong: "#4D4D4D",
  glassHighlight: "rgba(255, 255, 255, 0.07)",
  textPrimary: "#F0F0F0",
  textSecondary: "#A9A9A9",
  textTertiary: "#949494",
  send: "#F0F0F0",
  sendLabel: "#171717",
  userBubble: "#F0F0F0",
  userBubbleText: "#171717",
  onBubbleMuted: "rgba(23, 23, 23, 0.66)",
  onBubbleFill: "rgba(23, 23, 23, 0.08)",
  onBubbleStroke: "rgba(23, 23, 23, 0.16)",
  assistantBubble: "rgba(35, 35, 35, 0.70)",
  accent: "#F0F0F0",
  accentMuted: "#A9A9A9",
  danger: "#E17D96",
  success: "#6BB299",
  warning: "#EDBC26",
  merged: "#AB98F2",
  attention: "#74B0F3",
  backdrop: "rgba(0, 0, 0, 0.55)",
  background: "#1A1A1A",
  surface: "rgba(35, 35, 35, 0.70)",
  surfaceElevated: "rgba(43, 43, 43, 0.82)",
  border: "#303030",
  separator: "#4D4D4D",
  surfaceSolid: "#232323",
  surfaceElevatedSolid: "#2B2B2B",
  customDim: "rgba(26, 26, 26, 0.64)",
  customScrimTop: "rgba(26,26,26,0.80)",
  customScrimMid: "rgba(26,26,26,0.42)",
  customScrimBottom: "rgba(26,26,26,0.88)",
  canvasMid: "#1F1F1F",
  atmosphereGradientStart: "rgba(240,240,240,0.04)",
  atmosphereGradientEnd: "rgba(240,240,240,0.02)",
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

export const spacing = space;

export const radii = {
  sm: 10,
  md: 22,
  lg: 26,
  composer: 30,
  bubble: 22,
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

export const typography = {
  hero: {
    fontSize: 28,
    fontWeight: "500" as const,
    letterSpacing: -0.7,
  },
  brand: {
    fontSize: 17,
    fontWeight: "500" as const,
    letterSpacing: -0.2,
  },
  title: {
    fontSize: 20,
    fontWeight: "600" as const,
    letterSpacing: -0.5,
  },
  body: {
    fontSize: 14,
    fontWeight: "400" as const,
  },
  caption: {
    fontSize: 13,
    fontWeight: "400" as const,
  },
  section: {
    fontSize: 14,
    fontWeight: "500" as const,
    letterSpacing: -0.1,
  },
  mono: {
    fontSize: 13,
    fontWeight: "400" as const,
    letterSpacing: 0.2,
    fontFamily: fonts.mono,
  },
} as const;

export const motion = {
  pressScale: 0.98,
  fadeFastMs: 160,
  fadeMs: 240,
} as const;

export type GlassMaterial = "ultraThin" | "thin" | "regular" | "thick" | "chrome";
