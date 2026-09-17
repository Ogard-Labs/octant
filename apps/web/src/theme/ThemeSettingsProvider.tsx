import type { ThemeSettings } from "@octant/contracts/theme";
import {
  enforceAccessibilitySettings,
  enforceSidebarBackgroundAccessibility,
} from "@octant/domain/theme-policy";
import { resolveEffectiveTokens } from "@octant/theme/fallback";
import { getThemePreset, MAX_THEME_PATTERN_INKS } from "@octant/theme";
import { useLayoutEffect, type ReactNode } from "react";
import { getInjectedHostBridge } from "../shell/hostBridge";
import { approvalSurfacePalette } from "./approvalSurfacePalette";

const VARIABLE_ALIASES: Readonly<Record<string, ReadonlyArray<string>>> = {
  sidebar: ["sidebar-opaque"],
  workspace: ["surface", "surface-canvas"],
  floating: ["surface-raised"],
  control: ["surface-muted"],
  "control-hover": ["surface-hover"],
  selection: ["surface-selected"],
  border: ["border-subtle"],
  "focus-ring": ["focus"],
  "danger-text": ["destructive"],
};

export function ThemeSettingsProvider(props: {
  readonly settings?: ThemeSettings;
  readonly children: ReactNode;
}) {
  useLayoutEffect(() => {
    const root = document.documentElement;
    const settings = props.settings;
    if (settings === undefined) return;
    const accessible = enforceSidebarBackgroundAccessibility(
      enforceAccessibilitySettings(settings),
    );
    const systemPrefersDark =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-color-scheme: dark)").matches === true;
    const resolved = resolveEffectiveTokens(accessible, systemPrefersDark);
    const selectedPresetId =
      resolved.mode === "light" ? accessible.lightPresetId : accessible.darkPresetId;
    const presetPalette =
      (selectedPresetId === undefined
        ? undefined
        : getThemePreset(String(selectedPresetId))?.patternPalette) ?? [];
    const patternPalette = [resolved.tokens.accent!, ...presetPalette.slice(1)];
    for (const [role, color] of Object.entries(resolved.tokens)) {
      root.style.setProperty(`--octant-${role}`, color);
      for (const alias of VARIABLE_ALIASES[role] ?? []) {
        root.style.setProperty(`--octant-${alias}`, color);
      }
      if (role === "sidebar" || role === "workspace") {
        const opacity =
          resolved.mode === "light"
            ? { regular: 86, subtle: 78, strong: 62 }
            : { regular: 80, subtle: 58, strong: 32 };
        root.style.setProperty(
          `--octant-${role}-translucent`,
          `color-mix(in srgb, ${color} ${opacity.regular}%, transparent)`,
        );
        root.style.setProperty(
          `--octant-${role}-translucent-subtle`,
          `color-mix(in srgb, ${color} ${opacity.subtle}%, transparent)`,
        );
        root.style.setProperty(
          `--octant-${role}-translucent-strong`,
          `color-mix(in srgb, ${color} ${opacity.strong}%, transparent)`,
        );
      }
    }
    for (let index = 0; index < MAX_THEME_PATTERN_INKS; index += 1) {
      const color = patternPalette[index];
      const property = `--octant-pattern-ink-${String(index + 1)}`;
      if (color === undefined) root.style.removeProperty(property);
      else root.style.setProperty(property, color);
    }
    root.dataset.octantPatternInkCount = String(patternPalette.length);
    root.dataset.octantThemeMode = resolved.mode;
    root.dataset.octantIncreasedContrast = String(accessible.increasedContrast);
    root.dataset.octantReducedMotion = String(accessible.reducedMotion);
    root.dataset.octantReducedTransparency = String(accessible.reducedTransparency);
    root.style.colorScheme = resolved.mode;
    // The desktop owns the approval document; a window only reports the
    // palette it resolved, and only when it has the ordinary host bridge.
    const palette = approvalSurfacePalette(resolved);
    const reportPalette = getInjectedHostBridge()?.setApprovalSurfacePalette;
    if (palette !== undefined && reportPalette !== undefined) {
      void Promise.resolve(reportPalette(palette)).catch(() => undefined);
    }
    return () => {
      for (const role of Object.keys(resolved.tokens)) {
        root.style.removeProperty(`--octant-${role}`);
        for (const alias of VARIABLE_ALIASES[role] ?? []) {
          root.style.removeProperty(`--octant-${alias}`);
        }
      }
      root.style.removeProperty("--octant-sidebar-translucent");
      root.style.removeProperty("--octant-sidebar-translucent-subtle");
      root.style.removeProperty("--octant-sidebar-translucent-strong");
      root.style.removeProperty("--octant-workspace-translucent");
      root.style.removeProperty("--octant-workspace-translucent-subtle");
      root.style.removeProperty("--octant-workspace-translucent-strong");
      for (let index = 0; index < MAX_THEME_PATTERN_INKS; index += 1) {
        root.style.removeProperty(`--octant-pattern-ink-${String(index + 1)}`);
      }
      delete root.dataset.octantPatternInkCount;
      delete root.dataset.octantThemeMode;
      delete root.dataset.octantIncreasedContrast;
      delete root.dataset.octantReducedMotion;
      delete root.dataset.octantReducedTransparency;
      root.style.removeProperty("color-scheme");
    };
  }, [props.settings]);
  return props.children;
}
