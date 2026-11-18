import type {
  AppBackgroundEffect,
  AppBackgroundScene,
  ThemeSettings,
  ThemeTypography,
} from "@octant/contracts/theme";
import { getZenBuiltinBackground } from "@octant/contracts/zen";
import { resolveTypographyProjection } from "@octant/theme/typography";
import { asciiCell } from "./asciiPrint";

/** The character field's default cells: letters and digits. */
export const DEFAULT_CHARACTER_SET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
export const DEFAULT_CHARACTER_LEVEL = 50;
const MAX_CHARACTER_SET = 64;
// The same pattern as the contract's character set, applied to one code point.
const UNSUPPORTED_CHARACTER = /[\p{C}\p{Z}\p{M}\s\p{Extended_Pictographic}]/u;

export type CharacterSetResult =
  | { readonly status: "ok"; readonly characterSet: string }
  | { readonly status: "refused"; readonly reason: "empty" | "too-long" | "unsupported" };

/**
 * Cleans what a person typed into the character field's cells: whitespace and
 * repeated characters are dropped, and anything the field cannot draw as one
 * plain glyph (controls, bidi marks, combining marks, emoji) refuses the text.
 */
export function cleanCharacterSet(text: string): CharacterSetResult {
  const seen = new Set<string>();
  for (const character of Array.from(text)) {
    if (/^\s$/u.test(character)) continue;
    if (UNSUPPORTED_CHARACTER.test(character)) return { status: "refused", reason: "unsupported" };
    seen.add(character);
  }
  if (seen.size === 0) return { status: "refused", reason: "empty" };
  if (seen.size > MAX_CHARACTER_SET) return { status: "refused", reason: "too-long" };
  return { status: "ok", characterSet: Array.from(seen).join("") };
}

export type EffectiveThemeMode = "light" | "dark";

export function resolveEffectiveThemeMode(
  settings: ThemeSettings,
  systemPrefersDark: boolean,
): EffectiveThemeMode {
  if (settings.mode === "system") return systemPrefersDark ? "dark" : "light";
  return settings.mode;
}

export function resolveTypographyFallback(
  typography: ThemeTypography,
  availableFonts: ReadonlyArray<string>,
): ThemeTypography {
  return resolveTypographyProjection(typography, availableFonts).typography;
}

import type { SidebarBackground } from "@octant/contracts/theme";
import {
  resolveSidebarBackground,
  type ResolvedSidebarBackground,
} from "@octant/theme/backgrounds";

const INCREASED_CONTRAST_OVERLAY_FLOOR = 80;

export function enforceSidebarBackgroundAccessibility(settings: ThemeSettings): ThemeSettings {
  const bg = settings.sidebarBackground;
  if (settings.reducedTransparency) {
    const disabled: SidebarBackground = {
      kind: "none",
      overlayColor: bg.overlayColor,
      overlayOpacity: 100,
      vibrancyMode: "off",
    };
    return { ...settings, sidebarBackground: disabled };
  }
  if (settings.increasedContrast && bg.overlayOpacity < INCREASED_CONTRAST_OVERLAY_FLOOR) {
    return {
      ...settings,
      sidebarBackground: { ...bg, overlayOpacity: INCREASED_CONTRAST_OVERLAY_FLOOR },
    };
  }
  return settings;
}

export function resolveVibrancyOverlayAdjustment(
  vibrancyMode: "off" | "subtle" | "strong",
  baseOverlayOpacity: number,
): number {
  const reduction = vibrancyMode === "strong" ? 30 : vibrancyMode === "subtle" ? 15 : 0;
  return Math.max(0, baseOverlayOpacity - reduction);
}

export function resolveEffectiveSidebarBackground(
  settings: ThemeSettings,
  systemPrefersDark: boolean,
): ResolvedSidebarBackground {
  const enforced = enforceSidebarBackgroundAccessibility(settings);
  const mode = resolveEffectiveThemeMode(enforced, systemPrefersDark);
  const base = resolveSidebarBackground(enforced, mode);
  const adjustedOpacity = resolveVibrancyOverlayAdjustment(base.vibrancyMode, base.overlayOpacity);
  // Increased-contrast floor wins over vibrancy reduction: re-clamp.
  const finalOpacity = enforced.increasedContrast
    ? Math.max(INCREASED_CONTRAST_OVERLAY_FLOOR, adjustedOpacity)
    : adjustedOpacity;
  return { ...base, overlayOpacity: finalOpacity };
}

export interface ResolvedAppBackground {
  readonly kind: "builtin" | "photo" | "characters" | "pixels" | "flowing" | "none";
  readonly backgroundId: string | null;
  /** Public asset used by a first-party built-in, or null for other grounds. */
  readonly backgroundUrl: string | null;
  /** Still asset for previews and reduced-motion fallback. */
  readonly backgroundStillUrl: string | null;
  /** The built-in's light-theme picture, or null when it has one picture for both. */
  readonly backgroundLightUrl: string | null;
  /** Whether the selected built-in asset, the character field, or Flowing is allowed to move. */
  readonly backgroundAnimated: boolean;
  /** How the picture is printed: as it is, pixelated, dithered, or in characters. */
  readonly effect: {
    readonly kind: AppBackgroundEffect;
    readonly cell: number;
    readonly levels: number;
  };
  /** What the pixel ground draws; absent for every other ground. */
  readonly scene?: AppBackgroundScene;
  /** 0..1, ready for the renderer. */
  readonly photoOpacity: number;
  readonly scope: "welcome" | "everywhere";
  readonly coversSidebar: boolean;
  /** What the character field draws; present on the character ground only. */
  readonly characters?: {
    readonly characterSet: string;
    /** 0..100, 50 is the default field. */
    readonly density: number;
    /** 0..100, 50 is the default pace, 0 holds one frame. */
    readonly speed: number;
  };
}

// The ground is a picture, printed plain or through one still effect, a field
// of pulsing characters, dithered pixels, flowing colour, or nothing. It used
// to carry a drawn dot pattern that could drift, roll in waves, or pulse; that
// read as noise behind the work and is gone. The drawn fields are opt-in,
// never the default, and stop moving under reduced motion. Rows that chose the
// pattern ("theme") still decode and resolve to the plain page, and their
// pattern and motion dials are read by nothing.
// Increased contrast turns the ground off: a printed picture behind the page
// is exactly the low-contrast texture that setting exists to remove.
export function resolveAppBackground(
  settings: ThemeSettings,
  systemPrefersReducedMotion = false,
): ResolvedAppBackground {
  const background = settings.appBackground;
  // A photo dithered before the effect choice existed keeps its original
  // two-pixel, four-tone print.
  const legacyPhotoDither =
    background.effect === undefined && background.kind === "photo" && background.photoDithered;
  const effect = legacyPhotoDither
    ? { kind: "dither" as const, cell: 2, levels: 4 }
    : {
        kind: background.effect ?? ("none" as const),
        cell:
          background.effect === "ascii" ? asciiCell(background.effectCell) : background.effectCell,
        levels: background.effectTones,
      };
  const tuning = {
    effect,
    photoOpacity: background.photoOpacity / 100,
    scope: background.scope,
    coversSidebar: background.scope === "everywhere",
  };
  if (settings.increasedContrast || background.kind === "none" || background.kind === "theme") {
    return {
      ...tuning,
      effect: { ...effect, kind: "none" },
      kind: "none",
      backgroundId: null,
      backgroundUrl: null,
      backgroundStillUrl: null,
      backgroundLightUrl: null,
      backgroundAnimated: false,
    };
  }
  const motionAllowed = !settings.reducedMotion && !systemPrefersReducedMotion;
  // A drawn field moves unless a person chose Still; a printed picture moves
  // only when a person chose Wave, since prints were still before the choice.
  const fieldMoves = motionAllowed && background.motion !== "still";
  // An ASCII print has no wave: a ring pushing through characters read as
  // the glyphs flickering, so it stays still whatever Motion says.
  const printMoves =
    motionAllowed &&
    effect.kind !== "none" &&
    effect.kind !== "ascii" &&
    (background.motion === "wave" || background.motion === "pulse");
  if (background.kind === "builtin") {
    const preset = getZenBuiltinBackground(background.presetId);
    const stillUrl = "stillSrc" in preset ? preset.stillSrc : preset.src;
    const backgroundAnimated =
      effect.kind === "none" ? motionAllowed && preset.motion === "animated" : printMoves;
    return {
      ...tuning,
      kind: "builtin",
      backgroundId: background.presetId,
      backgroundUrl: backgroundAnimated ? preset.src : stillUrl,
      backgroundStillUrl: stillUrl,
      backgroundLightUrl: "lightSrc" in preset ? preset.lightSrc : null,
      backgroundAnimated,
    };
  }
  if (background.kind === "characters") {
    // Speed 0 holds one frame, as Motion Still does.
    const characterSpeed = background.characterSpeed ?? DEFAULT_CHARACTER_LEVEL;
    return {
      ...tuning,
      effect: { ...effect, kind: "none" },
      kind: "characters",
      characters: {
        characterSet: background.characterSet ?? DEFAULT_CHARACTER_SET,
        density: background.characterDensity ?? DEFAULT_CHARACTER_LEVEL,
        speed: characterSpeed,
      },
      backgroundId: null,
      backgroundUrl: null,
      backgroundStillUrl: null,
      backgroundLightUrl: null,
      backgroundAnimated: fieldMoves && characterSpeed !== 0,
    };
  }
  if (background.kind === "pixels") {
    // A pixel ground saved before scenes existed has none and reads as Drift.
    // The Picture scene needs a photo; without one there is nothing to print,
    // so it draws Drift rather than an empty page.
    const picture = background.scene === "picture" && background.backgroundId !== undefined;
    const scene: AppBackgroundScene =
      background.scene === undefined || (background.scene === "picture" && !picture)
        ? "drift"
        : background.scene;
    return {
      ...tuning,
      effect: { ...effect, kind: effect.kind === "pixelate" ? "pixelate" : "dither" },
      scene,
      kind: "pixels",
      backgroundId: picture ? String(background.backgroundId) : null,
      backgroundUrl: null,
      backgroundStillUrl: null,
      backgroundLightUrl: null,
      backgroundAnimated: fieldMoves,
    };
  }
  if (background.kind === "flowing") {
    return {
      ...tuning,
      effect: { ...effect, kind: "none" },
      kind: "flowing",
      backgroundId: null,
      backgroundUrl: null,
      backgroundStillUrl: null,
      backgroundLightUrl: null,
      backgroundAnimated: fieldMoves,
    };
  }
  return {
    ...tuning,
    kind: "photo",
    backgroundId: background.backgroundId,
    backgroundUrl: null,
    backgroundStillUrl: null,
    backgroundLightUrl: null,
    backgroundAnimated: printMoves,
  };
}
