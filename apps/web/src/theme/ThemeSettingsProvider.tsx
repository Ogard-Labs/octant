import {
  CUSTOM_THEME_PRESET_ID,
  GLASS_TINT_DEFAULTS,
  GLASS_TINT_FLOOR,
  GLASS_TINT_SECONDARY_FLOOR,
  type ThemeSettings,
  type ThemeTimestampFormat,
} from "@octant/contracts/theme";
import { enforceSidebarBackgroundAccessibility } from "@octant/domain/theme-policy";
import {
  DEFAULT_EDITOR_COLORS,
  resolveEditorColorProjection,
  type EditorColorProjection,
} from "@octant/theme/editor-colors";
import { CUSTOM_CONTRAST_SCALE } from "@octant/theme/custom-preset";
import { resolveEffectiveTokens } from "@octant/theme/fallback";
import {
  DEFAULT_TERMINAL_COLORS,
  resolveTerminalColorProjection,
  type TerminalColorProjection,
} from "@octant/theme/terminal-colors";
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { getInjectedHostBridge } from "../shell/hostBridge";
import { approvalSurfacePalette } from "./approvalSurfacePalette";
import {
  publishIncreasedContrastSetting,
  SYSTEM_INCREASED_CONTRAST,
} from "./increasedContrastAttribute";
import { rememberThemeMode } from "./firstPaintTheme";
import { upgradeLegacyAccent } from "./accentSwatches";
import { useMediaQueryMatches } from "./useMediaQueryMatches";
import { usePluginThemes } from "./pluginThemes";

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

/**
 * The coat each glass level paints, in percent. A Tint a person chose replaces
 * both levels and is clamped at paint time to the mode's floor; the saved value
 * is untouched.
 */
function glassCoat(
  mode: "light" | "dark",
  tint: number | undefined,
): { readonly subtle: number; readonly strong: number } {
  if (tint === undefined) return GLASS_TINT_DEFAULTS[mode];
  const clamped = Math.max(tint, GLASS_TINT_FLOOR[mode]);
  return { subtle: clamped, strong: clamped };
}

/**
 * The glass levels whose coat is under the secondary-ink floor, as a
 * space-separated list the stylesheet matches with ~=. Empty when none is.
 */
function thinGlassLevels(mode: "light" | "dark", tint: number | undefined): string {
  const coat = glassCoat(mode, tint);
  const floor = GLASS_TINT_SECONDARY_FLOOR[mode];
  const thin: string[] = [];
  if (coat.subtle < floor) thin.push("subtle");
  if (coat.strong < floor) thin.push("strong");
  return thin.join(" ");
}

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
  /**
   * Whether the mode is written to the app's first-paint storage key. On by
   * default; a page that is not the app (the component gallery) turns it off so
   * it cannot change what the next app window paints first.
   */
  readonly rememberMode?: boolean;
  readonly children: ReactNode;
}) {
  const rememberMode = props.rememberMode ?? true;
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

  const pluginThemes = usePluginThemes();
  const applied = useMemo(() => {
    if (props.settings === undefined) return undefined;
    // The one place stored overrides enter the renderer's painting: an accent
    // saved before the light fills were deepened is read as the same swatch.
    const accessible = enforceSidebarBackgroundAccessibility({
      ...props.settings,
      semanticOverrides: upgradeLegacyAccent(props.settings.semanticOverrides),
    });
    // The grey roles follow the combined value, so an OS that asks for
    // increased contrast gets them even while the in-app setting is off.
    return {
      accessible,
      resolved: resolveEffectiveTokens(
        { ...accessible, increasedContrast },
        systemPrefersDark,
        pluginThemes,
      ),
    };
  }, [props.settings, systemPrefersDark, increasedContrast, pluginThemes]);

  useLayoutEffect(() => {
    const root = document.documentElement;
    if (applied === undefined) return;
    const { accessible, resolved } = applied;
    const paint = () => {
      for (const [role, color] of Object.entries(resolved.tokens)) {
        if (!(increasedContrast && HIGH_CONTRAST_TEXT_ROLES.has(role))) {
          root.style.setProperty(`--octant-${role}`, color);
        }
        for (const alias of VARIABLE_ALIASES[role] ?? []) {
          root.style.setProperty(`--octant-${alias}`, color);
        }
        if (role === "sidebar" || role === "workspace") {
          const opacity = glassCoat(resolved.mode, accessible.glassTint);
          root.style.setProperty(
            `--octant-${role}-translucent`,
            `color-mix(in srgb, ${color} ${opacity.subtle}%, transparent)`,
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
      const thin = thinGlassLevels(resolved.mode, accessible.glassTint);
      if (thin === "") delete root.dataset.octantGlassThin;
      else root.dataset.octantGlassThin = thin;
      // Density, smoothing, and timestamp clock format are plain attributes the
      // stylesheets and shared time formatter read; the contrast step scales
      // the derived washes only for a Custom preset.
      root.dataset.octantDensity = accessible.density ?? "comfortable";
      root.dataset.octantFontSmoothing = accessible.fontSmoothing === "off" ? "off" : "on";
      if (accessible.timestampFormat === undefined) {
        delete root.dataset.octantTimestampFormat;
      } else {
        root.dataset.octantTimestampFormat = accessible.timestampFormat;
      }
      const customId =
        resolved.mode === "light" ? accessible.lightPresetId : accessible.darkPresetId;
      const customSeeds =
        resolved.mode === "light" ? accessible.customThemeLight : accessible.customThemeDark;
      if (customId === CUSTOM_THEME_PRESET_ID && customSeeds !== undefined) {
        root.style.setProperty(
          "--oct-contrast-scale",
          String(CUSTOM_CONTRAST_SCALE[customSeeds.contrast]),
        );
      } else {
        root.style.removeProperty("--oct-contrast-scale");
      }
      if (rememberMode) rememberThemeMode(accessible.mode);
      root.dataset.octantReducedMotion = String(accessible.reducedMotion);
      root.dataset.octantReducedTransparency = String(accessible.reducedTransparency);
      // Increased contrast keeps the monochrome chrome: colour as decoration is
      // the first thing that setting exists to take away. "default" and the
      // retired "vivid" both draw the colour look.
      root.dataset.octantStyle =
        increasedContrast || accessible.style === "mono" ? "mono" : "colour";
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
      delete root.dataset.octantGlassThin;
      delete root.dataset.octantDensity;
      delete root.dataset.octantFontSmoothing;
      delete root.dataset.octantTimestampFormat;
      root.style.removeProperty("--oct-contrast-scale");
      delete root.dataset.octantReducedMotion;
      delete root.dataset.octantReducedTransparency;
      delete root.dataset.octantStyle;
      root.style.removeProperty("color-scheme");
      leave(mountedPaints, paint);
      mountedPaints.at(-1)?.();
    };
  }, [applied, increasedContrast, rememberMode]);
  const resolved = applied?.resolved;
  const editorColors = useMemo(
    () =>
      resolved === undefined
        ? undefined
        : resolveEditorColorProjection(resolved, { increasedContrast }),
    [resolved, increasedContrast],
  );
  const terminalColors = useMemo(
    () =>
      resolved === undefined
        ? undefined
        : resolveTerminalColorProjection(resolved, { increasedContrast }),
    [resolved, increasedContrast],
  );
  const timestampFormat = applied?.accessible.timestampFormat;
  return (
    <IncreasedContrastContext.Provider value={increasedContrast}>
      <TimestampFormatContext.Provider value={timestampFormat}>
        <EditorColorContext.Provider value={editorColors}>
          <TerminalColorContext.Provider value={terminalColors}>
            {props.children}
          </TerminalColorContext.Provider>
        </EditorColorContext.Provider>
      </TimestampFormatContext.Provider>
    </IncreasedContrastContext.Provider>
  );
}

const TimestampFormatContext = createContext<ThemeTimestampFormat | undefined>(undefined);

/**
 * The theme's configured timestamp clock format (`12h` or `24h`), or
 * `undefined` to follow the locale default. Components subscribing to this
 * hook re-render immediately when the theme setting changes.
 */
export function useTimestampFormat(): ThemeTimestampFormat | undefined {
  return useContext(TimestampFormatContext);
}

const EditorColorContext = createContext<EditorColorProjection | undefined>(undefined);

/**
 * The colors a code editor draws with in the theme this window resolved, so
 * an open editor repaints when the theme or the system appearance changes.
 * Without a theme the stylesheet's own dark default is what the page shows.
 */
export function useEditorColorProjection(): EditorColorProjection {
  return useContext(EditorColorContext) ?? DEFAULT_EDITOR_COLORS;
}

const TerminalColorContext = createContext<TerminalColorProjection | undefined>(undefined);

/**
 * The colors a terminal draws with in the theme this window resolved, so an
 * open terminal repaints when the theme, contrast, or system appearance
 * changes. Without a theme the stylesheet's own dark default is what the
 * page shows.
 */
export function useTerminalColorProjection(): TerminalColorProjection {
  return useContext(TerminalColorContext) ?? DEFAULT_TERMINAL_COLORS;
}
