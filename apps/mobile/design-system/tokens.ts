import { getDefaultToken } from "@octant/theme/tokens";

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
  userBubble: shared("accent", "light"),
  userBubbleText: shared("accent-foreground", "light"),
  onBubbleMuted: "rgba(255, 255, 255, 0.72)",
  onBubbleFill: "rgba(255, 255, 255, 0.12)",
  onBubbleStroke: "rgba(255, 255, 255, 0.18)",
  assistantBubble: "rgba(255, 255, 255, 0.68)",
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
  userBubble: shared("accent", "dark"),
  userBubbleText: shared("accent-foreground", "dark"),
  onBubbleMuted: "rgba(23, 23, 23, 0.66)",
  onBubbleFill: "rgba(23, 23, 23, 0.08)",
  onBubbleStroke: "rgba(23, 23, 23, 0.16)",
  assistantBubble: "rgba(35, 35, 35, 0.70)",
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
