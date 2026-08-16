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
