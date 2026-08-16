import type { ThemeSettings } from "@octant/contracts/theme";

export const THEME_PROJECTION_SCHEMA_VERSION = 1;
export const THEME_SETTINGS_KEY = "theme-settings";

export interface ProjectedThemeSettings {
  readonly settings: ThemeSettings;
  readonly aggregateVersion: number;
}

export function assertThemeProjectionSchema(version: number): void {
  if (version !== THEME_PROJECTION_SCHEMA_VERSION) {
    throw new Error("unsupported Theme projection schema version");
  }
}
