import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useColorScheme } from "react-native";
import { materialsForScheme, type GlassMaterialRecipe } from "./materials";
import { resolveThemeScheme, type ColorSchemePreference } from "./resolveThemeScheme";
import type { SurfaceStylePreference } from "./themeTypes";
import { colorsForScheme, type GlassMaterial, type ThemeColors, type ThemeScheme } from "./tokens";

export type { ColorSchemePreference } from "./resolveThemeScheme";
export type { SurfaceStylePreference } from "./themeTypes";

export interface ThemeContextValue {
  readonly preference: ColorSchemePreference;
  readonly scheme: ThemeScheme;
  readonly surfaceStyle: SurfaceStylePreference;
  readonly colors: ThemeColors;
  readonly materials: Record<GlassMaterial, GlassMaterialRecipe>;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export { resolveThemeScheme };

export function ThemeProvider(props: {
  readonly children: ReactNode;
  readonly preference: ColorSchemePreference;
  readonly surfaceStyle?: SurfaceStylePreference;
}) {
  const systemScheme = useColorScheme();
  const surfaceStyle = props.surfaceStyle ?? "glass";
  const value = useMemo(() => {
    const scheme = resolveThemeScheme(props.preference, systemScheme);
    return {
      preference: props.preference,
      scheme,
      surfaceStyle,
      colors: colorsForScheme(scheme),
      materials: materialsForScheme(scheme),
    } satisfies ThemeContextValue;
  }, [props.preference, surfaceStyle, systemScheme]);

  return <ThemeContext.Provider value={value}>{props.children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (value === undefined) {
    throw new Error("useTheme requires ThemeProvider.");
  }
  return value;
}

/** Optional theme access for leaves that may render outside ThemeProvider in tests. */
export function useOptionalTheme(): ThemeContextValue | undefined {
  return useContext(ThemeContext);
}
