import { GLASS_TINT_DEFAULTS, type ThemeSettings } from "@octant/contracts/theme";
import { enforceSidebarBackgroundAccessibility } from "@octant/domain/theme-policy";
import { resolveEffectiveTokens } from "@octant/theme/fallback";
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
    const accessible = enforceSidebarBackgroundAccessibility(settings);
    const systemPrefersDark =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-color-scheme: dark)").matches === true;
    const resolved = resolveEffectiveTokens(accessible, systemPrefersDark);
    for (const [role, color] of Object.entries(resolved.tokens)) {
      root.style.setProperty(`--octant-${role}`, color);
      for (const alias of VARIABLE_ALIASES[role] ?? []) {
        root.style.setProperty(`--octant-${alias}`, color);
      }
      if (role === "sidebar" || role === "workspace") {
        const defaults = GLASS_TINT_DEFAULTS[resolved.mode];
        // A tint the person set replaces every level's for the sidebar and
        // the gutters it shares a back with; glass cards keep their own.
        // Increased contrast keeps enough of the colour under sidebar text.
        const chosen = role === "sidebar" ? accessible.glassTint : undefined;
        const tint =
          chosen === undefined
            ? undefined
            : accessible.increasedContrast
              ? Math.max(chosen, 80)
              : chosen;
        const opacity =
          tint !== undefined
            ? { regular: tint, subtle: tint, strong: tint }
            : resolved.mode === "light"
              ? { regular: 86, ...defaults }
              : { regular: 80, ...defaults };
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
      delete root.dataset.octantThemeMode;
      delete root.dataset.octantIncreasedContrast;
      delete root.dataset.octantReducedMotion;
      delete root.dataset.octantReducedTransparency;
      root.style.removeProperty("color-scheme");
    };
  }, [props.settings]);
  return props.children;
}
