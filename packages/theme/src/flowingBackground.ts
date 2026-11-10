import { contrastRatio, hexToOklch, oklchToHex, parseHexColor } from "./color";
import { DEFAULT_LIGHT_TOKENS } from "./tokens";

/**
 * The four colour stops of the Flowing application ground. They are derived
 * from the theme's accent so a change of accent recolours the field without a
 * second setting.
 */
export interface FlowingPalette {
  /** Near-black (dark) or near-paper (light), low chroma, the accent's hue. */
  readonly deep: string;
  /** The accent itself, sitting in the middle of the field. */
  readonly mid: string;
  /** Lighter and a little more chromatic than the accent. */
  readonly light: string;
  /** Brighter still, with a slight hue shift toward the glow. */
  readonly glow: string;
}

export type FlowingPaletteMode = "light" | "dark";

const GLOW_HUE_SHIFT = 14;
const PALETTE_MIX_MS = 600;

/** How long the field takes to follow a new accent, in milliseconds. */
export const FLOWING_PALETTE_MIX_MS = PALETTE_MIX_MS;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function wrapHue(hue: number): number {
  const wrapped = hue % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

function stop(l: number, c: number, h: number): string {
  return oklchToHex({ l: clamp(l, 0, 1), c: Math.max(0, c), h: wrapHue(h) });
}

/**
 * Four OKLCH stops from one accent hex. Dark mode keeps a near-black corner, the
 * accent in the middle, and a brighter, more saturated glow. Light mode inverts
 * that ramp into a pale wash so primary text still clears WCAG AA against every
 * stop, even before the reading veil sits on top.
 */
export function deriveFlowingPalette(accentHex: string, mode: FlowingPaletteMode): FlowingPalette {
  const accent = hexToOklch(accentHex);
  const hue = accent.h;
  const chroma = accent.c;
  if (mode === "light") {
    // Every stop stays light enough that #141414 (primary text) clears 4.5:1
    // against it. The accent's hue is kept; chroma is pulled back so the field
    // reads as a wash, not a saturated slab behind dark type.
    return {
      deep: stop(0.97, Math.min(0.02, chroma * 0.2), hue),
      mid: stop(0.9, clamp(chroma * 0.28, 0.03, 0.08), hue),
      light: stop(0.84, clamp(chroma * 0.38, 0.04, 0.1), hue),
      glow: stop(0.78, clamp(chroma * 0.46, 0.05, 0.12), hue + GLOW_HUE_SHIFT),
    };
  }
  return {
    deep: stop(0.09, clamp(chroma * 0.28, 0.02, 0.05), hue),
    mid: accentHex.toLowerCase(),
    light: stop(clamp(accent.l + 0.12, 0.48, 0.78), clamp(chroma * 1.22, chroma, 0.22), hue),
    glow: stop(
      clamp(accent.l + 0.26, 0.64, 0.88),
      clamp(chroma * 1.08, chroma * 0.7, 0.2),
      hue + GLOW_HUE_SHIFT,
    ),
  };
}

function hexToRgb(hex: string): { readonly r: number; readonly g: number; readonly b: number } {
  return parseHexColor(hex);
}

function rgbToHex(r: number, g: number, b: number): string {
  const channel = (value: number) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/**
 * Mix two palettes in sRGB. The renderer uses this to walk from the previous
 * accent to the next over {@link FLOWING_PALETTE_MIX_MS}; t is 0..1.
 */
export function mixFlowingPalettes(
  from: FlowingPalette,
  to: FlowingPalette,
  t: number,
): FlowingPalette {
  const amount = clamp(t, 0, 1);
  const mixHex = (a: string, b: string): string => {
    const left = hexToRgb(a);
    const right = hexToRgb(b);
    return rgbToHex(
      left.r + (right.r - left.r) * amount,
      left.g + (right.g - left.g) * amount,
      left.b + (right.b - left.b) * amount,
    );
  };
  return {
    deep: mixHex(from.deep, to.deep),
    mid: mixHex(from.mid, to.mid),
    light: mixHex(from.light, to.light),
    glow: mixHex(from.glow, to.glow),
  };
}

/** 0..1 RGB triples ready for a fragment-shader uniform. */
export function flowingPaletteRgb(palette: FlowingPalette): {
  readonly deep: readonly [number, number, number];
  readonly mid: readonly [number, number, number];
  readonly light: readonly [number, number, number];
  readonly glow: readonly [number, number, number];
} {
  const rgb = (hex: string): readonly [number, number, number] => {
    const { r, g, b } = hexToRgb(hex);
    return [r / 255, g / 255, b / 255];
  };
  return {
    deep: rgb(palette.deep),
    mid: rgb(palette.mid),
    light: rgb(palette.light),
    glow: rgb(palette.glow),
  };
}

/**
 * Whether primary light-theme text clears WCAG AA against every stop. Used by
 * tests; the renderer does not call it.
 */
export function flowingPaletteMeetsLightTextContrast(palette: FlowingPalette): boolean {
  const ink = DEFAULT_LIGHT_TOKENS["text-primary"] ?? "#141414";
  return [palette.deep, palette.mid, palette.light, palette.glow].every(
    (stopHex) => contrastRatio(ink, stopHex) >= 4.5,
  );
}

/** Hue of a palette stop, for tests that the field follows the accent. */
export function flowingPaletteHue(hex: string): number {
  return hexToOklch(hex).h;
}

export function flowingPaletteLightness(hex: string): number {
  return hexToOklch(hex).l;
}

export function flowingPaletteChroma(hex: string): number {
  return hexToOklch(hex).c;
}
