import type { ColorSchemePreference } from "./themeTypes";
import type { ThemeScheme } from "./tokens";

export type { ColorSchemePreference } from "./themeTypes";

export function resolveThemeScheme(
  preference: ColorSchemePreference,
  systemScheme: string | null | undefined,
): ThemeScheme {
  if (preference === "light" || preference === "dark") return preference;
  return systemScheme === "dark" ? "dark" : "light";
}
