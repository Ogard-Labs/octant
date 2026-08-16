import type { ThemeSettings } from "@octant/contracts/theme";
import {
  enforceAccessibilitySettings,
  enforceSidebarBackgroundAccessibility,
} from "@octant/domain/theme-policy";
import { resolveEffectiveTokens } from "@octant/theme/fallback";
import { useLayoutEffect, type ReactNode } from "react";

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
    for (const [role, color] of Object.entries(resolved.tokens)) {
      root.style.setProperty(`--octant-${role}`, color);
      for (const alias of VARIABLE_ALIASES[role] ?? []) {
        root.style.setProperty(`--octant-${alias}`, color);
      }
      if (role === "sidebar") {
        const opacity =
          resolved.mode === "light"
            ? { regular: 86, subtle: 78, strong: 62 }
            : { regular: 80, subtle: 58, strong: 32 };
        root.style.setProperty(
          "--octant-sidebar-translucent",
          `color-mix(in srgb, ${color} ${opacity.regular}%, transparent)`,
        );
        root.style.setProperty(
          "--octant-sidebar-translucent-subtle",
          `color-mix(in srgb, ${color} ${opacity.subtle}%, transparent)`,
        );
        root.style.setProperty(
          "--octant-sidebar-translucent-strong",
          `color-mix(in srgb, ${color} ${opacity.strong}%, transparent)`,
        );
      }
    }
    root.dataset.ooThemeMode = resolved.mode;
    root.dataset.ooIncreasedContrast = String(accessible.increasedContrast);
    root.dataset.ooReducedMotion = String(accessible.reducedMotion);
    root.dataset.ooReducedTransparency = String(accessible.reducedTransparency);
    root.style.colorScheme = resolved.mode;
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
      delete root.dataset.ooThemeMode;
      delete root.dataset.ooIncreasedContrast;
      delete root.dataset.ooReducedMotion;
      delete root.dataset.ooReducedTransparency;
      root.style.removeProperty("color-scheme");
    };
  }, [props.settings]);
  return props.children;
}
