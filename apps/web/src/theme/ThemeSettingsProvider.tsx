import { GLASS_TINT_DEFAULTS, type ThemeSettings } from "@octant/contracts/theme";
import { enforceSidebarBackgroundAccessibility } from "@octant/domain/theme-policy";
import { resolveEffectiveTokens } from "@octant/theme/fallback";
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { getInjectedHostBridge } from "../shell/hostBridge";
import { approvalSurfacePalette } from "./approvalSurfacePalette";
import {
  publishIncreasedContrastSetting,
  SYSTEM_INCREASED_CONTRAST,
} from "./increasedContrastAttribute";
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

const IncreasedContrastContext = createContext<boolean | undefined>(undefined);

// Settings renders its own provider inside the window's. Closing Settings used
// to delete the root's theme while the window's provider stayed mounted with
// no reason to run again, so the window fell back to the stylesheet's dark
// default until a reload. Each mounted provider registers how it paints the
// root, and when one leaves, the most recent one still mounted paints again.
const mountedPaints: Array<() => void> = [];
const mountedContrastSettings: boolean[] = [];

function leave<T>(mounted: T[], entry: T): void {
  const index = mounted.lastIndexOf(entry);
  if (index !== -1) mounted.splice(index, 1);
}

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

const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";

function systemDarkQuery(): MediaQueryList | undefined {
  return typeof window === "undefined" ? undefined : window.matchMedia?.(SYSTEM_DARK_QUERY);
}

function readSystemPrefersDark(): boolean {
  return systemDarkQuery()?.matches === true;
}

export function ThemeSettingsProvider(props: {
  readonly settings?: ThemeSettings;
  readonly children: ReactNode;
}) {
  const followsSystem = props.settings?.mode === "system";
  // Only a theme that follows the system listens, so a live light/dark switch
  // repaints without a reload while a fixed mode ignores the system entirely.
  const subscribeToSystemAppearance = useCallback(
    (onChange: () => void) => {
      const query = followsSystem ? systemDarkQuery() : undefined;
      query?.addEventListener?.("change", onChange);
      return () => query?.removeEventListener?.("change", onChange);
    },
    [followsSystem],
  );
  const systemPrefersDark = useSyncExternalStore(
    subscribeToSystemAppearance,
    readSystemPrefersDark,
    () => false,
  );

  const systemIncreasedContrast = useMediaQueryMatches(SYSTEM_INCREASED_CONTRAST);
  // Either trigger publishes the one attribute every high-contrast rule keys
  // off, so the in-app toggle and the system preference draw the same rules.
  // The setting alone used to set the attribute while the rules sat under the
  // media query, and the toggle changed no colours.
  const settingIncreasedContrast = props.settings?.increasedContrast === true;
  const increasedContrast = systemIncreasedContrast || settingIncreasedContrast;

  useLayoutEffect(() => {
    // Republishes when the system changes too, so the attribute follows it
    // even where the entry module's listener is not running.
    mountedContrastSettings.push(settingIncreasedContrast);
    publishIncreasedContrastSetting(settingIncreasedContrast);
    return () => {
      leave(mountedContrastSettings, settingIncreasedContrast);
      publishIncreasedContrastSetting(mountedContrastSettings.at(-1) ?? false);
    };
  }, [settingIncreasedContrast, increasedContrast]);

  useLayoutEffect(() => {
    const root = document.documentElement;
    const settings = props.settings;
    if (settings === undefined) return;
    const accessible = enforceSidebarBackgroundAccessibility(settings);
    const resolved = resolveEffectiveTokens(accessible, systemPrefersDark);
    const paint = () => {
      for (const [role, color] of Object.entries(resolved.tokens)) {
        if (!(increasedContrast && HIGH_CONTRAST_TEXT_ROLES.has(role))) {
          root.style.setProperty(`--octant-${role}`, color);
        }
        for (const alias of VARIABLE_ALIASES[role] ?? []) {
          root.style.setProperty(`--octant-${alias}`, color);
        }
        if (role === "sidebar" || role === "workspace") {
          const defaults = GLASS_TINT_DEFAULTS[resolved.mode];
          // A tint the person set replaces every level's, for the sidebar's
          // own picture wash and for the window surface, which is the
          // workspace colour over the whole window. Increased contrast keeps
          // enough of the colour under the text.
          const chosen = accessible.glassTint;
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
        accessible.increasedContrast || accessible.style === undefined
          ? "default"
          : accessible.style;
      root.style.colorScheme = resolved.mode;
      // The desktop owns the approval document; a window only reports the
      // palette it resolved, and only when it has the ordinary host bridge.
      const palette = approvalSurfacePalette(resolved);
      const reportPalette = getInjectedHostBridge()?.setApprovalSurfacePalette;
      if (palette !== undefined && reportPalette !== undefined) {
        void Promise.resolve(reportPalette(palette)).catch(() => undefined);
      }
    };
    paint();
    mountedPaints.push(paint);
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
      leave(mountedPaints, paint);
      mountedPaints.at(-1)?.();
    };
  }, [props.settings, increasedContrast, systemPrefersDark]);
  return (
    <IncreasedContrastContext.Provider value={increasedContrast}>
      {props.children}
    </IncreasedContrastContext.Provider>
  );
}
