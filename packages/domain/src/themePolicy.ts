import type { AppBackgroundEffect, ThemeSettings, ThemeTypography } from "@octant/contracts/theme";
import { getZenBuiltinBackground } from "@octant/contracts/zen";
import { resolveTypographyProjection } from "@octant/theme/typography";

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
  readonly kind: "theme" | "builtin" | "photo" | "none";
  readonly backgroundId: string | null;
  /** Public asset used by a first-party built-in, or null for other grounds. */
  readonly backgroundUrl: string | null;
  /** Still asset for previews and reduced-motion fallback. */
  readonly backgroundStillUrl: string | null;
  /** Whether the selected built-in asset is allowed to animate. */
  readonly backgroundAnimated: boolean;
  /** Whether the pattern layer is drawn, independent of its opacity dial. */
  readonly patternEnabled: boolean;
  /** How a picture ground is printed; always `none` for the pattern and the plain page. */
  readonly effect: {
    readonly kind: AppBackgroundEffect;
    readonly cell: number;
    readonly levels: number;
  };
  /** Whether the picture breathes slowly; false whenever motion is held still. */
  readonly pulse: boolean;
  /** The pattern drifts only while nothing has asked Octant to hold still. */
  readonly animated: boolean;
  /** 0..1, ready for the renderer. */
  readonly patternOpacity: number;
  /** A multiplier on the pattern's base drift: 0 still, 1 default, 2 twice as fast. */
  readonly patternSpeed: number;
  /** 0..1: how much of the field the pattern fills at its densest. */
  readonly patternIntensity: number;
  /** Whether the photo keeps the ordered-dither print treatment. */
  readonly photoDithered: boolean;
  /** 0..1, ready for the renderer. */
  readonly photoOpacity: number;
  readonly scope: "welcome" | "everywhere";
  readonly coversSidebar: boolean;
}

// Increased contrast turns the ground off: a dithered field behind the page
// is exactly the low-contrast texture that setting exists to remove.
// Reduced motion keeps the ground but freezes the pattern; a still frame
// carries the same picture as a drifting one, so nothing is lost.
export function resolveAppBackground(
  settings: ThemeSettings,
  systemPrefersReducedMotion = false,
): ResolvedAppBackground {
  const background = settings.appBackground;
  const picture = background.kind === "builtin" || background.kind === "photo";
  // Rows written before the effect and motion choices existed read their
  // older switches: a dithered photo keeps its original two-pixel, four-tone
  // print, and a ground that drew the pattern keeps drawing it.
  const legacyPhotoDither =
    background.effect === undefined && background.kind === "photo" && background.photoDithered;
  const effect = !picture
    ? { kind: "none" as const, cell: background.effectCell, levels: background.effectTones }
    : legacyPhotoDither
      ? { kind: "dither" as const, cell: 2, levels: 4 }
      : {
          kind: background.effect ?? ("none" as const),
          cell: background.effectCell,
          levels: background.effectTones,
        };
  const motion = background.motion ?? (background.patternEnabled ? "wave" : "still");
  // The theme pattern is the picture itself, so it is drawn whatever moves;
  // over a photo or a built-in it is the Wave motion.
  const patternDrawn =
    background.kind === "theme"
      ? background.motion !== undefined || background.patternEnabled
      : motion === "wave";
  const tuning = {
    patternEnabled: patternDrawn,
    effect,
    patternOpacity: background.patternOpacity / 100,
    patternSpeed: background.patternSpeed / 50,
    patternIntensity: background.patternIntensity / 100,
    photoDithered: effect.kind === "dither",
    photoOpacity: background.photoOpacity / 100,
    scope: background.scope,
    coversSidebar: background.scope === "everywhere" && background.coversSidebar,
  };
  if (settings.increasedContrast || background.kind === "none") {
    return {
      ...tuning,
      kind: "none",
      backgroundId: null,
      backgroundUrl: null,
      backgroundStillUrl: null,
      backgroundAnimated: false,
      animated: false,
      pulse: false,
    };
  }
  const motionAllowed = !settings.reducedMotion && !systemPrefersReducedMotion;
  // Still and Pulse hold the theme pattern's frame; only Wave drifts it.
  const animated =
    patternDrawn &&
    motionAllowed &&
    background.patternSpeed > 0 &&
    (background.kind !== "theme" || background.motion === undefined || motion === "wave");
  const pulse = motion === "pulse" && motionAllowed;
  if (background.kind === "builtin") {
    const preset = getZenBuiltinBackground(background.presetId);
    const stillUrl = "stillSrc" in preset ? preset.stillSrc : preset.src;
    const backgroundAnimated = motionAllowed && preset.motion === "animated";
    return {
      ...tuning,
      kind: "builtin",
      backgroundId: background.presetId,
      backgroundUrl: backgroundAnimated ? preset.src : stillUrl,
      backgroundStillUrl: stillUrl,
      backgroundAnimated,
      animated,
      pulse,
    };
  }
  if (background.kind === "photo") {
    return {
      ...tuning,
      kind: "photo",
      backgroundId: background.backgroundId,
      backgroundUrl: null,
      backgroundStillUrl: null,
      backgroundAnimated: false,
      animated,
      pulse,
    };
  }
  return {
    ...tuning,
    kind: "theme",
    backgroundId: null,
    backgroundUrl: null,
    backgroundStillUrl: null,
    backgroundAnimated: false,
    animated,
    pulse,
  };
}
