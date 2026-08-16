import { useMemo } from "react";
import { useTheme, type ThemeContextValue } from "./theme";

/**
 * Build StyleSheet (or style maps) from the active theme so light/dark
 * switches recompute color-dependent rules.
 */
export function useThemedStyles<T>(factory: (theme: ThemeContextValue) => T): T {
  const theme = useTheme();
  return useMemo(() => factory(theme), [theme, factory]);
}
