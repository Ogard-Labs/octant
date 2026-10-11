import { GLASS_TINT_DEFAULTS, type ThemeSettings } from "@octant/contracts/theme";
import { enforceSidebarBackgroundAccessibility } from "@octant/domain/theme-policy";
import { resolveEffectiveTokens } from "@octant/theme/fallback";
import { createContext, useContext, useLayoutEffect, type ReactNode } from "react";
import { getInjectedHostBridge } from "../shell/hostBridge";
import { approvalSurfacePalette } from "./approvalSurfacePalette";
import { useMediaQueryMatches } from "./useMediaQueryMatches";

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

// Roles the stylesheet repoints at their `-high-contrast` values under
// `data-octant-increased-contrast`; an inline colour would outrank that rule.
const HIGH_CONTRAST_TEXT_ROLES: ReadonlySet<string> = new Set([
  "text-primary",
  "text-secondary",
  "text-muted",
]);

const SYSTEM_INCREASED_CONTRAST = "(prefers-contrast: more)";

const IncreasedContrastContext = createContext<boolean | undefined>(undefined);

/**
 * Whether the app is drawing increased contrast: the person's setting or the
 * system's preference, whichever asks. Outside the provider only the system
 * can ask.
 */
export function useIncreasedContrast(): boolean {
  const published = useContext(IncreasedContrastContext);
  const system = useMediaQueryMatches(SYSTEM_INCREASED_CONTRAST);
  return published ?? system;
}

export function ThemeSettingsProvider(props: {
  readonly settings?: ThemeSettings;
  readonly children: ReactNode;
}) {
  const systemIncreasedContrast = useMediaQueryMatches(SYSTEM_INCREASED_CONTRAST);
  // Either trigger publishes the one attribute every high-contrast rule keys
  // off, so the in-app toggle and the system preference draw the same rules.
  // The setting alone used to set the attribute while the rules sat under the
  // media query, and the toggle changed no colours.
  const increasedContrast = systemIncreasedContrast || props.settings?.increasedContrast === true;

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.octantIncreasedContrast = String(increasedContrast);
    return () => {
      delete root.dataset.octantIncreasedContrast;
    };
  }, [increasedContrast]);

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
      if (!(increasedContrast && HIGH_CONTRAST_TEXT_ROLES.has(role))) {
        root.style.setProperty(`--octant-${role}`, color);
      }
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
    root.dataset.octantReducedMotion = String(accessible.reducedMotion);
    root.dataset.octantReducedTransparency = String(accessible.reducedTransparency);
    // Increased contrast keeps the monochrome chrome: colour as decoration is
    // the first thing that setting exists to take away.
    root.dataset.octantStyle =
      accessible.increasedContrast || accessible.style === undefined ? "default" : accessible.style;
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
      delete root.dataset.octantReducedMotion;
      delete root.dataset.octantReducedTransparency;
      delete root.dataset.octantStyle;
      root.style.removeProperty("color-scheme");
    };
  }, [props.settings, increasedContrast]);
  return (
    <IncreasedContrastContext.Provider value={increasedContrast}>
      {props.children}
    </IncreasedContrastContext.Provider>
  );
}
