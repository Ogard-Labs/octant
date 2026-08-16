/**
 * Octant Distilled mobile tokens.
 * Warm, high-contrast palette: cream canvas, warm ink, and orange primary voltage.
 * Dark mode mirrors the same warm roles on a charcoal canvas.
 * Owned Octant roles — not a third-party clone.
 */

export type ThemeScheme = "light" | "dark";

export type ThemeColors = {
  /** Warm cream (light) / charcoal (dark) canvas. */
  canvas: string;
  canvasSoft: string;
  /** Warm near-black / cream ink. */
  ink: string;
  body: string;
  bodyStrong: string;
  muted: string;
  mutedSoft: string;
  hairline: string;
  hairlineSoft: string;
  hairlineStrong: string;
  /** Brand voltage — Distilled primary. */
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
  canvas: "#F7F7F4",
  canvasSoft: "#FAFAF7",
  ink: "#26251E",
  body: "#5A5852",
  bodyStrong: "#26251E",
  muted: "#807D72",
  mutedSoft: "#A09C92",
  hairline: "#E6E5E0",
  hairlineSoft: "#EFEEE8",
  hairlineStrong: "#CFCDC4",
  primary: "#F54E00",
  primaryActive: "#D04200",
  primarySoft: "#FFE8DE",
  stageThinking: "#FFD6C9",
  stageReading: "#B8E8D4",
  stageEditing: "#BFD9FF",
  stageGrepping: "#D9CFF5",
  stageDone: "#F2DFA0",
  atmospherePrimary: "rgba(245, 78, 0, 0.10)",
  atmosphereSecondary: "rgba(38, 37, 30, 0.04)",
  /** More transparent fills so atmosphere photos read through glass. */
  glassFillThin: "rgba(255, 255, 255, 0.28)",
  glassFillRegular: "rgba(255, 255, 255, 0.42)",
  glassFillThick: "rgba(255, 255, 255, 0.58)",
  glassFillChrome: "rgba(255, 255, 255, 0.50)",
  glassStroke: "rgba(38, 37, 30, 0.10)",
  glassStrokeStrong: "rgba(38, 37, 30, 0.16)",
  glassHighlight: "rgba(255, 255, 255, 0.85)",
  textPrimary: "#26251E",
  textSecondary: "#5A5852",
  textTertiary: "#807D72",
  send: "#F54E00",
  sendLabel: "#FFFFFF",
  userBubble: "#26251E",
  userBubbleText: "#F7F7F4",
  assistantBubble: "rgba(255, 255, 255, 0.48)",
  accent: "#F54E00",
  accentMuted: "#D04200",
  danger: "#E11D48",
  success: "#16A34A",
  warning: "#CA8A04",
  merged: "#7C3AED",
  attention: "#2563EB",
  backdrop: "rgba(38, 37, 30, 0.35)",
  background: "#F7F7F4",
  surface: "rgba(255, 255, 255, 0.42)",
  surfaceElevated: "rgba(255, 255, 255, 0.58)",
  border: "#E6E5E0",
  separator: "#CFCDC4",
  surfaceSolid: "#F0EFEA",
  surfaceElevatedSolid: "#EBEAE4",
  customDim: "rgba(247, 247, 244, 0.55)",
  customScrimTop: "rgba(247,247,244,0.72)",
  customScrimMid: "rgba(247,247,244,0.35)",
  customScrimBottom: "rgba(247,247,244,0.82)",
  canvasMid: "#F3F1EA",
  atmosphereGradientStart: "rgba(245,78,0,0.12)",
  atmosphereGradientEnd: "rgba(38,37,30,0.04)",
};

/** Warm charcoal Distilled dark — same orange voltage, inverted ink/canvas roles. */
export const darkColors: ThemeColors = {
  canvas: "#141310",
  canvasSoft: "#1A1914",
  ink: "#F7F7F4",
  body: "#C4C2B8",
  bodyStrong: "#F7F7F4",
  muted: "#9A978C",
  mutedSoft: "#6E6B62",
  hairline: "#2E2C26",
  hairlineSoft: "#25231E",
  hairlineStrong: "#3D3A32",
  primary: "#F54E00",
  primaryActive: "#FF6A2A",
  primarySoft: "rgba(245, 78, 0, 0.22)",
  stageThinking: "#5C2E22",
  stageReading: "#1F4A3A",
  stageEditing: "#243B5C",
  stageGrepping: "#3A2F55",
  stageDone: "#4A4020",
  atmospherePrimary: "rgba(245, 78, 0, 0.18)",
  atmosphereSecondary: "rgba(247, 247, 244, 0.04)",
  /** Dark glass stays translucent over the aurora atmosphere. */
  glassFillThin: "rgba(38, 37, 30, 0.28)",
  glassFillRegular: "rgba(38, 37, 30, 0.40)",
  glassFillThick: "rgba(45, 43, 36, 0.55)",
  glassFillChrome: "rgba(45, 43, 36, 0.48)",
  glassStroke: "rgba(247, 247, 244, 0.14)",
  glassStrokeStrong: "rgba(247, 247, 244, 0.22)",
  glassHighlight: "rgba(255, 255, 255, 0.10)",
  textPrimary: "#F7F7F4",
  textSecondary: "#C4C2B8",
  textTertiary: "#9A978C",
  send: "#F54E00",
  sendLabel: "#FFFFFF",
  userBubble: "#F7F7F4",
  userBubbleText: "#26251E",
  assistantBubble: "rgba(38, 37, 30, 0.48)",
  accent: "#F54E00",
  accentMuted: "#FF6A2A",
  danger: "#FB7185",
  success: "#4ADE80",
  warning: "#FACC15",
  merged: "#A78BFA",
  attention: "#60A5FA",
  backdrop: "rgba(0, 0, 0, 0.55)",
  background: "#141310",
  surface: "rgba(38, 37, 30, 0.40)",
  surfaceElevated: "rgba(45, 43, 36, 0.55)",
  border: "#2E2C26",
  separator: "#3D3A32",
  surfaceSolid: "#1F1E19",
  surfaceElevatedSolid: "#25231E",
  customDim: "rgba(20, 19, 16, 0.62)",
  customScrimTop: "rgba(20,19,16,0.78)",
  customScrimMid: "rgba(20,19,16,0.40)",
  customScrimBottom: "rgba(20,19,16,0.85)",
  canvasMid: "#1C1B16",
  atmosphereGradientStart: "rgba(245,78,0,0.20)",
  atmosphereGradientEnd: "rgba(247,247,244,0.04)",
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
  xxl: 40,
} as const;

export const spacing = space;

export const radii = {
  sm: 12,
  md: 20,
  lg: 26,
  composer: 30,
  bubble: 22,
  pill: 999,
  circle: 999,
} as const;

/** Distilled UI type — system for display, Nerd Font for mono/code. */
export const fonts = {
  /** JetBrainsMono Nerd Font — code pattern + mono chrome. */
  mono: "JetBrainsMonoNerdFont",
  /** Platform UI stack for headlines and body copy. */
  sans: undefined as string | undefined,
} as const;

export const typography = {
  hero: {
    fontSize: 34,
    fontWeight: "400" as const,
    letterSpacing: -0.8,
  },
  brand: {
    fontSize: 28,
    fontWeight: "400" as const,
    letterSpacing: -0.6,
  },
  title: {
    fontSize: 17,
    fontWeight: "600" as const,
    letterSpacing: -0.2,
  },
  body: {
    fontSize: 16,
    fontWeight: "400" as const,
    letterSpacing: -0.1,
  },
  caption: {
    fontSize: 13,
    fontWeight: "400" as const,
  },
  section: {
    fontSize: 12,
    fontWeight: "600" as const,
    letterSpacing: 0.6,
    textTransform: "uppercase" as const,
  },
  mono: {
    fontSize: 11,
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
