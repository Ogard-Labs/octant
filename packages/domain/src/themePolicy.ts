import type { ThemeSettings, ThemeTypography } from "@octant/contracts/theme";
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

export function enforceAccessibilitySettings(settings: ThemeSettings): ThemeSettings {
  if (settings.reducedTransparency && settings.translucency === "translucent") {
    return { ...settings, translucency: "opaque" };
  }
  return settings;
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
  readonly kind: "theme" | "photo" | "none";
  readonly backgroundId: string | null;
  /** The pattern drifts only while nothing has asked Octant to hold still. */
  readonly animated: boolean;
  /** 0..1, ready for the renderer. */
  readonly patternOpacity: number;
  /** A multiplier on the pattern's base drift: 0 still, 1 default, 2 twice as fast. */
  readonly patternSpeed: number;
  /** 0..1: how much of the field the pattern fills at its densest. */
  readonly patternIntensity: number;
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
  const tuning = {
    patternOpacity: background.patternOpacity / 100,
    patternSpeed: background.patternSpeed / 50,
    patternIntensity: background.patternIntensity / 100,
    photoOpacity: background.photoOpacity / 100,
    scope: background.scope,
    coversSidebar: background.scope === "everywhere" && background.coversSidebar,
  };
  if (settings.increasedContrast || background.kind === "none") {
    return { ...tuning, kind: "none", backgroundId: null, animated: false };
  }
  const animated =
    !settings.reducedMotion && !systemPrefersReducedMotion && background.patternSpeed > 0;
  if (background.kind === "photo") {
    return { ...tuning, kind: "photo", backgroundId: background.backgroundId, animated };
  }
  return { ...tuning, kind: "theme", backgroundId: null, animated };
}
