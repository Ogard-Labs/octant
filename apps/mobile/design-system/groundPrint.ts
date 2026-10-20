/**
 * The pure half of the printed ground: the same ordered threshold, effect
 * limits and cover fit the desktop uses, so a picture prints identically on
 * both. The shader in PrintedGround.tsx mirrors `bayerThreshold`.
 */

export type GroundPicture =
  | "soft-glow"
  | "soft-graphite"
  | "soft-sunset"
  | "atmosphere"
  | "custom"
  | "plain";

/** How a picture is printed: as it is, in square cells, or in dithered cells. */
export interface GroundEffect {
  readonly kind: "none" | "pixelate" | "dither";
  /** Points per cell. */
  readonly cell: number;
  /** Colour steps per channel, for dither. */
  readonly levels: number;
}

export const EFFECT_MIN = 2;
export const EFFECT_MAX = 16;

export const DEFAULT_EFFECT: GroundEffect = { kind: "none", cell: 4, levels: 4 };

function clampStep(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(EFFECT_MAX, Math.max(EFFECT_MIN, Math.round(value)));
}

/** Keeps the dials on the integer range the desktop's sliders offer. */
export function clampEffect(effect: GroundEffect): GroundEffect {
  return {
    kind: effect.kind,
    cell: clampStep(effect.cell, DEFAULT_EFFECT.cell),
    levels: clampStep(effect.levels, DEFAULT_EFFECT.levels),
  };
}

/** The 8x8 ordered threshold in (0, 1), ported from the desktop print. */
export function bayerThreshold(x: number, y: number): number {
  const xy = (x ^ y) & 7;
  const row = y & 7;
  const value =
    ((xy & 1) << 5) |
    ((row & 1) << 4) |
    ((xy & 2) << 2) |
    ((row & 2) << 1) |
    ((xy & 4) >> 1) |
    ((row & 4) >> 2);
  return (value + 0.5) / 64;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface CoverFit {
  readonly scale: number;
  /** Where the scaled picture's top-left lands in the viewport. */
  readonly offsetX: number;
  readonly offsetY: number;
}

/** Scale and offset that cover `viewport` with `picture`, centred. */
export function coverFit(viewport: Size, picture: Size): CoverFit {
  const scale = Math.max(viewport.width / picture.width, viewport.height / picture.height);
  return {
    scale,
    offsetX: (viewport.width - picture.width * scale) / 2,
    offsetY: (viewport.height - picture.height * scale) / 2,
  };
}
