export class ThemePresetError extends Error {
  override readonly name = "ThemePresetError";
  constructor(message: string) {
    super(message);
  }
}

function fail(message: string): never {
  throw new ThemePresetError(message);
}

const MAX_CSS_LENGTH = 512;
const MAX_COLOR_STOPS = 8;
const MAX_LAYERS = 4;
const ALLOWED_GRADIENT_FUNCTIONS = new Set([
  "linear-gradient",
  "radial-gradient",
  "conic-gradient",
  "repeating-linear-gradient",
  "repeating-radial-gradient",
]);
const ALLOWED_KEYWORDS = new Set([
  "to",
  "at",
  "from",
  "circle",
  "ellipse",
  "closest-side",
  "farthest-side",
  "closest-corner",
  "farthest-corner",
  "transparent",
  "currentcolor",
]);
// Hex #RRGGBB or #RRGGBBAA.
const HEX_COLOR = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;
// Reject any character outside the bounded grammar.
const FORBIDDEN_CHARS = /[<>"';\\@]/;
const FORBIDDEN_SUBSTRINGS = [
  "url(",
  "://",
  "javascript:",
  "expression(",
  "var(",
  "calc(",
  "attr(",
  "import",
];

// Split a CSS background value into top-level layers at commas that are
// outside any function's parentheses. This prevents rgba(26,26,28,0.8)
// from being split into fragments.
function splitTopLevelCommas(value: string): string[] {
  const layers: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of value) {
    if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (char === "," && depth === 0) {
      layers.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim().length > 0) layers.push(current.trim());
  return layers;
}

// Split a function's argument string into top-level tokens at commas,
// preserving parenthesized sub-expressions (rgb(), rgba()).
function splitFunctionArgs(args: string): string[] {
  return splitTopLevelCommas(args);
}

function isValidColorToken(token: string): boolean {
  if (HEX_COLOR.test(token)) return true;
  // rgb() or rgba() with bounded content (integers, decimals, percentages, commas, spaces).
  const fnMatch = /^rgba?\(\s*[\d.,%\s]+\s*\)$/.exec(token);
  if (fnMatch !== null) return true;
  if (ALLOWED_KEYWORDS.has(token.toLowerCase())) return true;
  return false;
}

function isValidNumericToken(token: string): boolean {
  return /^-?\d+(\.\d+)?(deg|rad|turn|grad|px|%|em|rem|vh|vw)?$/.test(token);
}

function validateGradientLayer(layer: string): void {
  // A gradient layer is name(args).
  const match = /^([a-z-]+)\((.*)\)$/s.exec(layer);
  if (match === null) fail(`CSS layer is not a function call: ${layer}.`);
  const fnName = match![1]!;
  const args = match![2]!;
  if (!ALLOWED_GRADIENT_FUNCTIONS.has(fnName)) {
    fail(`Unknown or disallowed function: ${fnName}.`);
  }
  const argTokens = splitFunctionArgs(args);
  for (const token of argTokens) {
    if (isValidColorToken(token)) continue;
    if (isValidNumericToken(token)) continue;
    // Multi-word tokens like "circle at 50% 50%" or "to right" — validate each sub-word.
    const subWords = token.split(/\s+/);
    if (
      subWords.every(
        (w) =>
          isValidColorToken(w) || isValidNumericToken(w) || ALLOWED_KEYWORDS.has(w.toLowerCase()),
      )
    ) {
      continue;
    }
    fail(`Invalid CSS token: ${token}`);
  }
}

function countColorStops(css: string): number {
  const hexMatches = css.match(/#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?/g);
  const rgbaMatches = css.match(/rgba?\(/g);
  return (hexMatches?.length ?? 0) + (rgbaMatches?.length ?? 0);
}

export function validatePresetCssBackground(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail("CSS background must be a non-empty string.");
  }
  if (value.length > MAX_CSS_LENGTH) {
    fail(`CSS background must be at most ${MAX_CSS_LENGTH} characters.`);
  }
  const lower = value.toLowerCase();
  for (const forbidden of FORBIDDEN_SUBSTRINGS) {
    if (lower.includes(forbidden)) fail(`CSS background contains forbidden token: ${forbidden}.`);
  }
  if (FORBIDDEN_CHARS.test(value)) {
    fail("CSS background contains forbidden characters.");
  }
  const trimmed = value.trim();
  const layers = splitTopLevelCommas(trimmed);
  if (layers.length > MAX_LAYERS) {
    fail(`CSS background must have at most ${MAX_LAYERS} layers.`);
  }
  if (countColorStops(value) > MAX_COLOR_STOPS) {
    fail(`CSS background must have at most ${MAX_COLOR_STOPS} color stops.`);
  }
  // Each layer must be either a gradient function call or a base color.
  for (const layer of layers) {
    if (isValidColorToken(layer)) continue;
    validateGradientLayer(layer);
  }
  return trimmed;
}

import type { SidebarBackground, ThemeSettings } from "@octant/contracts/theme";

export type SidebarBackgroundCategory = "gradient" | "shape" | "dev-inspired" | "subtle";

export interface SidebarBackgroundPreset {
  readonly id: string;
  readonly displayName: string;
  readonly category: SidebarBackgroundCategory;
  readonly cssBackground: string;
  readonly suggestedOverlayColor: string;
  readonly suggestedOverlayOpacity: number;
}

function makePreset(
  id: string,
  displayName: string,
  category: SidebarBackgroundCategory,
  cssBackground: string,
  suggestedOverlayColor: string,
  suggestedOverlayOpacity: number,
): SidebarBackgroundPreset {
  return {
    id,
    displayName,
    category,
    cssBackground: validatePresetCssBackground(cssBackground),
    suggestedOverlayColor,
    suggestedOverlayOpacity,
  };
}

export const SIDEBAR_BACKGROUND_PRESETS: ReadonlyArray<SidebarBackgroundPreset> = [
  // Gradients (5)
  makePreset(
    "gradient-aurora",
    "Aurora",
    "gradient",
    "linear-gradient(135deg, #1a1a2e, #16213e, #0f3460)",
    "#0d0d0f",
    55,
  ),
  makePreset(
    "graphite-fade",
    "Graphite Fade",
    "gradient",
    "linear-gradient(180deg, #1a1a1c, #0d0d0f)",
    "#0d0d0f",
    60,
  ),
  makePreset(
    "dusk-ramp",
    "Dusk Ramp",
    "gradient",
    "linear-gradient(160deg, #2d1b3d, #1a1a2e, #0d0d0f)",
    "#0d0d0f",
    55,
  ),
  makePreset(
    "violet-haze",
    "Violet Haze",
    "gradient",
    "radial-gradient(circle at 30% 20%, #4c1d95, #1a1a1c)",
    "#0d0d0f",
    60,
  ),
  makePreset(
    "ember-glow",
    "Ember Glow",
    "gradient",
    "radial-gradient(circle at 70% 80%, #7c2d12, #1a1a1c)",
    "#0d0d0f",
    60,
  ),
  // Shapes (5)
  makePreset(
    "shape-circuit",
    "Circuit",
    "shape",
    "radial-gradient(circle at 20% 30%, #2a2a2e 2px, transparent 3px), radial-gradient(circle at 80% 70%, #2a2a2e 2px, transparent 3px), #0d0d0f",
    "#0d0d0f",
    65,
  ),
  makePreset(
    "dot-matrix",
    "Dot Matrix",
    "shape",
    "radial-gradient(circle, #2a2a2e 1px, transparent 2px)",
    "#0d0d0f",
    70,
  ),
  makePreset(
    "ring-field",
    "Ring Field",
    "shape",
    "conic-gradient(from 0deg at 50% 50%, #1a1a1c, #2a2a2e, #1a1a1c)",
    "#0d0d0f",
    70,
  ),
  makePreset(
    "grid-wire",
    "Grid Wire",
    "shape",
    "repeating-linear-gradient(0deg, transparent, transparent 24px, #2a2a2e 25px), repeating-linear-gradient(90deg, transparent, transparent 24px, #2a2a2e 25px), #0d0d0f",
    "#0d0d0f",
    65,
  ),
  makePreset(
    "stripe-stack",
    "Stripe Stack",
    "shape",
    "repeating-linear-gradient(45deg, #1a1a1c, #1a1a1c 12px, #222225 13px, #222225 24px)",
    "#0d0d0f",
    65,
  ),
  // Dev-inspired (5)
  makePreset(
    "dev-gutter",
    "Line Gutter",
    "dev-inspired",
    "linear-gradient(90deg, #16161a 48px, #0d0d0f 49px)",
    "#0d0d0f",
    55,
  ),
  makePreset(
    "dev-syntax",
    "Syntax Blocks",
    "dev-inspired",
    "linear-gradient(180deg, #1e1e2e, #0d0d0f 40%, #2d1b3d)",
    "#0d0d0f",
    60,
  ),
  makePreset(
    "dev-scanline",
    "Scanlines",
    "dev-inspired",
    "repeating-linear-gradient(0deg, rgba(26,26,28,0.9), rgba(26,26,28,0.9) 2px, rgba(13,13,15,0.9) 3px, rgba(13,13,15,0.9) 4px)",
    "#0d0d0f",
    50,
  ),
  makePreset(
    "dev-commit-graph",
    "Commit Graph",
    "dev-inspired",
    "radial-gradient(circle at 50% 50%, #2a2a2e 3px, transparent 4px), radial-gradient(circle at 50% 100%, #2a2a2e 2px, transparent 3px), #0d0d0f",
    "#0d0d0f",
    65,
  ),
  makePreset(
    "dev-brackets",
    "Brackets",
    "dev-inspired",
    "conic-gradient(from 45deg at 50% 50%, #1a1a1c, #2a2a2e, #1a1a1c, #2a2a2e, #1a1a1c)",
    "#0d0d0f",
    70,
  ),
  // Subtle/ambient (5)
  makePreset(
    "ambient-mist",
    "Ambient Mist",
    "subtle",
    "linear-gradient(180deg, #1c1c1e, #1a1a1c)",
    "#1a1a1c",
    80,
  ),
  makePreset(
    "quiet-paper",
    "Quiet Paper",
    "subtle",
    "linear-gradient(180deg, #1e1d1b, #1a1a1c)",
    "#1a1a1c",
    80,
  ),
  makePreset(
    "soft-graphite",
    "Soft Graphite",
    "subtle",
    "radial-gradient(circle at 50% 0%, #202022, #1a1a1c)",
    "#1a1a1c",
    80,
  ),
  makePreset(
    "calm-slate",
    "Calm Slate",
    "subtle",
    "linear-gradient(160deg, #1b1d1e, #1a1a1c)",
    "#1a1a1c",
    80,
  ),
  makePreset(
    "neutral-linen",
    "Neutral Linen",
    "subtle",
    "repeating-linear-gradient(0deg, rgba(26,26,28,0.95), rgba(26,26,28,0.95) 1px, rgba(28,28,30,0.95) 2px)",
    "#1a1a1c",
    80,
  ),
];

const PRESET_BY_ID: ReadonlyMap<string, SidebarBackgroundPreset> = new Map(
  SIDEBAR_BACKGROUND_PRESETS.map((p) => [p.id, p]),
);

export function getSidebarBackgroundPreset(id: string): SidebarBackgroundPreset {
  const preset = PRESET_BY_ID.get(id);
  if (preset === undefined) throw new ThemePresetError(`Unknown sidebar background preset: ${id}`);
  return preset;
}

export interface ResolvedSidebarBackground {
  readonly kind: "none" | "preset" | "custom";
  readonly backgroundCss: string | null;
  readonly backgroundId: string | null;
  readonly overlayColor: string;
  readonly overlayOpacity: number;
  readonly vibrancyMode: "off" | "subtle" | "strong";
}

export function resolveSidebarBackground(
  settings: ThemeSettings,
  _mode: "light" | "dark",
): ResolvedSidebarBackground {
  const bg = settings.sidebarBackground;
  if (bg.kind === "preset") {
    const preset = getSidebarBackgroundPreset(bg.presetId);
    return {
      kind: "preset",
      backgroundCss: preset.cssBackground,
      backgroundId: null,
      overlayColor: bg.overlayColor,
      overlayOpacity: bg.overlayOpacity,
      vibrancyMode: bg.vibrancyMode,
    };
  }
  if (bg.kind === "custom") {
    return {
      kind: "custom",
      backgroundCss: null,
      backgroundId: bg.backgroundId,
      overlayColor: bg.overlayColor,
      overlayOpacity: bg.overlayOpacity,
      vibrancyMode: bg.vibrancyMode,
    };
  }
  return {
    kind: "none",
    backgroundCss: null,
    backgroundId: null,
    overlayColor: bg.overlayColor,
    overlayOpacity: bg.overlayOpacity,
    vibrancyMode: bg.vibrancyMode,
  };
}
