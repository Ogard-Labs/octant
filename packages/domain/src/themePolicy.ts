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
  readonly kind: "builtin" | "photo" | "none";
  readonly backgroundId: string | null;
  /** Public asset used by a first-party built-in, or null for other grounds. */
  readonly backgroundUrl: string | null;
  /** Still asset for previews and reduced-motion fallback. */
  readonly backgroundStillUrl: string | null;
  /** Whether the selected built-in asset is allowed to animate. */
  readonly backgroundAnimated: boolean;
  /** How the picture is printed: as it is, pixelated, or dithered. */
  readonly effect: {
    readonly kind: AppBackgroundEffect;
    readonly cell: number;
    readonly levels: number;
  };
  /** 0..1, ready for the renderer. */
  readonly photoOpacity: number;
  readonly scope: "welcome" | "everywhere";
  readonly coversSidebar: boolean;
}

// The ground is a picture, printed plain or through one still effect, or
// nothing. It used to carry a drawn dot pattern that could drift, roll in
// waves, or pulse; that read as noise behind the work and is gone. Rows that
// chose the pattern ("theme") still decode and resolve to the plain page, and
// their pattern and motion dials are read by nothing.
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
        cell: background.effectCell,
        levels: background.effectTones,
      };
  const tuning = {
    effect,
    photoOpacity: background.photoOpacity / 100,
    scope: background.scope,
    coversSidebar: background.scope === "everywhere" && background.coversSidebar,
  };
  if (settings.increasedContrast || background.kind === "none" || background.kind === "theme") {
    return {
      ...tuning,
      effect: { ...effect, kind: "none" },
      kind: "none",
      backgroundId: null,
      backgroundUrl: null,
      backgroundStillUrl: null,
      backgroundAnimated: false,
    };
  }
  const motionAllowed = !settings.reducedMotion && !systemPrefersReducedMotion;
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
    };
  }
  return {
    ...tuning,
    kind: "photo",
    backgroundId: background.backgroundId,
    backgroundUrl: null,
    backgroundStillUrl: null,
    backgroundAnimated: false,
  };
}
