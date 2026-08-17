import type { ContrastLevel } from "./contrast";

export type ThemeTokenCategory =
  | "foundation"
  | "surface"
  | "control"
  | "border"
  | "text"
  | "focus"
  | "accent"
  | "status"
  | "diff"
  | "palette";

export interface ThemeTokenRoleDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly category: ThemeTokenCategory;
  readonly contrastTarget?: string;
  readonly contrastLevel?: ContrastLevel;
  readonly defaultLight: string;
  readonly defaultDark: string;
}

export const THEME_TOKEN_ROLES: ReadonlyArray<ThemeTokenRoleDefinition> = [
  {
    id: "app-background",
    displayName: "Application background",
    category: "foundation",
    defaultLight: "#f1f2f3",
    defaultDark: "#161616",
  },
  {
    id: "chrome",
    displayName: "Chrome",
    category: "foundation",
    contrastTarget: "app-background",
    contrastLevel: "ui",
    defaultLight: "#e9eaec",
    defaultDark: "#1a1a1a",
  },
  {
    id: "sidebar",
    displayName: "Sidebar",
    category: "foundation",
    contrastTarget: "app-background",
    contrastLevel: "ui",
    defaultLight: "#eef0f1",
    defaultDark: "#191919",
  },
  {
    id: "workspace",
    displayName: "Workspace surface",
    category: "surface",
    defaultLight: "#fafafb",
    defaultDark: "#1e1e1e",
  },
  {
    id: "floating",
    displayName: "Floating surface",
    category: "surface",
    contrastTarget: "workspace",
    contrastLevel: "ui",
    defaultLight: "#ffffff",
    defaultDark: "#282828",
  },
  {
    id: "scrim",
    displayName: "Scrim",
    category: "foundation",
    defaultLight: "#000000",
    defaultDark: "#000000",
  },
  {
    id: "control",
    displayName: "Control",
    category: "control",
    contrastTarget: "workspace",
    contrastLevel: "non-text",
    defaultLight: "#eff0f2",
    defaultDark: "#2a2a2a",
  },
  {
    id: "control-hover",
    displayName: "Control hover",
    category: "control",
    contrastTarget: "workspace",
    contrastLevel: "non-text",
    defaultLight: "#e7e9eb",
    defaultDark: "#313131",
  },
  {
    id: "control-pressed",
    displayName: "Control pressed",
    category: "control",
    contrastTarget: "workspace",
    contrastLevel: "non-text",
    defaultLight: "#dfe1e4",
    defaultDark: "#393939",
  },
  {
    id: "border",
    displayName: "Border",
    category: "border",
    contrastTarget: "workspace",
    contrastLevel: "non-text",
    defaultLight: "#e4e6e9",
    defaultDark: "#323232",
  },
  {
    id: "border-strong",
    displayName: "Strong border",
    category: "border",
    contrastTarget: "workspace",
    contrastLevel: "ui",
    defaultLight: "#d4d7db",
    defaultDark: "#414141",
  },
  {
    id: "divider-strong",
    displayName: "Strong divider",
    category: "border",
    contrastTarget: "workspace",
    contrastLevel: "ui",
    defaultLight: "#85888e",
    defaultDark: "#6f6f6f",
  },
  {
    id: "text-primary",
    displayName: "Primary text",
    category: "text",
    contrastTarget: "workspace",
    contrastLevel: "normal-text",
    defaultLight: "#1f2124",
    defaultDark: "#ededed",
  },
  {
    id: "text-secondary",
    displayName: "Secondary text",
    category: "text",
    contrastTarget: "workspace",
    contrastLevel: "normal-text",
    defaultLight: "#5c5f66",
    defaultDark: "#a8a8a8",
  },
  {
    id: "text-muted",
    displayName: "Muted text",
    category: "text",
    contrastTarget: "workspace",
    contrastLevel: "large-text",
    defaultLight: "#7c7f86",
    defaultDark: "#8b8b8b",
  },
  {
    id: "primary-foreground",
    displayName: "Primary foreground",
    category: "text",
    contrastTarget: "accent",
    contrastLevel: "normal-text",
    defaultLight: "#ffffff",
    defaultDark: "#06111c",
  },
  {
    id: "focus-ring",
    displayName: "Focus ring",
    category: "focus",
    contrastTarget: "workspace",
    contrastLevel: "ui",
    defaultLight: "#0285ff",
    defaultDark: "#7ec0ff",
  },
  {
    id: "selection",
    displayName: "Selection",
    category: "focus",
    contrastTarget: "workspace",
    contrastLevel: "non-text",
    defaultLight: "#e7e9eb",
    defaultDark: "#323232",
  },
  {
    id: "accent",
    displayName: "Accent",
    category: "accent",
    contrastTarget: "workspace",
    contrastLevel: "ui",
    defaultLight: "#0170dd",
    defaultDark: "#3d9aff",
  },
  {
    id: "accent-foreground",
    displayName: "Accent foreground",
    category: "accent",
    contrastTarget: "accent",
    contrastLevel: "normal-text",
    defaultLight: "#ffffff",
    defaultDark: "#06111c",
  },
  {
    id: "success-surface",
    displayName: "Success surface",
    category: "status",
    contrastTarget: "workspace",
    contrastLevel: "non-text",
    defaultLight: "#e8f5ed",
    defaultDark: "#233229",
  },
  {
    id: "success-text",
    displayName: "Success text",
    category: "status",
    contrastTarget: "success-surface",
    contrastLevel: "normal-text",
    defaultLight: "#157a3d",
    defaultDark: "#8fd8ab",
  },
  {
    id: "warning-surface",
    displayName: "Warning surface",
    category: "status",
    contrastTarget: "workspace",
    contrastLevel: "non-text",
    defaultLight: "#fdf1e5",
    defaultDark: "#372d1d",
  },
  {
    id: "warning-border",
    displayName: "Warning border",
    category: "status",
    contrastTarget: "warning-surface",
    contrastLevel: "ui",
    defaultLight: "#b0791f",
    defaultDark: "#a98443",
  },
  {
    id: "warning-text",
    displayName: "Warning text",
    category: "status",
    contrastTarget: "warning-surface",
    contrastLevel: "normal-text",
    defaultLight: "#8a5310",
    defaultDark: "#f0c383",
  },
  {
    id: "danger-text",
    displayName: "Danger text",
    category: "status",
    contrastTarget: "workspace",
    contrastLevel: "normal-text",
    defaultLight: "#c62f34",
    defaultDark: "#ee5c61",
  },
  {
    id: "addition-text",
    displayName: "Diff addition text",
    category: "diff",
    contrastTarget: "workspace",
    contrastLevel: "normal-text",
    defaultLight: "#157a3d",
    defaultDark: "#8fd8ab",
  },
  {
    id: "deletion-text",
    displayName: "Diff deletion text",
    category: "diff",
    contrastTarget: "workspace",
    contrastLevel: "normal-text",
    defaultLight: "#c62f34",
    defaultDark: "#ee5c61",
  },
  {
    id: "palette-red",
    displayName: "Palette red",
    category: "palette",
    contrastTarget: "sidebar",
    contrastLevel: "ui",
    defaultLight: "#c62f34",
    defaultDark: "#ee5c61",
  },
  {
    id: "palette-orange",
    displayName: "Palette orange",
    category: "palette",
    contrastTarget: "sidebar",
    contrastLevel: "ui",
    defaultLight: "#a75613",
    defaultDark: "#f0954a",
  },
  {
    id: "palette-yellow",
    displayName: "Palette yellow",
    category: "palette",
    contrastTarget: "sidebar",
    contrastLevel: "ui",
    defaultLight: "#7a6a00",
    defaultDark: "#f0c383",
  },
  {
    id: "palette-green",
    displayName: "Palette green",
    category: "palette",
    contrastTarget: "sidebar",
    contrastLevel: "ui",
    defaultLight: "#157a3d",
    defaultDark: "#8fd8ab",
  },
  {
    id: "palette-teal",
    displayName: "Palette teal",
    category: "palette",
    contrastTarget: "sidebar",
    contrastLevel: "ui",
    defaultLight: "#0d7772",
    defaultDark: "#5ccfc9",
  },
  {
    id: "palette-blue",
    displayName: "Palette blue",
    category: "palette",
    contrastTarget: "sidebar",
    contrastLevel: "ui",
    defaultLight: "#0170dd",
    defaultDark: "#3d9aff",
  },
  {
    id: "palette-purple",
    displayName: "Palette purple",
    category: "palette",
    contrastTarget: "sidebar",
    contrastLevel: "ui",
    defaultLight: "#6f42d0",
    defaultDark: "#b48cf2",
  },
  {
    id: "palette-pink",
    displayName: "Palette pink",
    category: "palette",
    contrastTarget: "sidebar",
    contrastLevel: "ui",
    defaultLight: "#b32e83",
    defaultDark: "#f08ac0",
  },
];

const ROLE_BY_ID: ReadonlyMap<string, ThemeTokenRoleDefinition> = new Map(
  THEME_TOKEN_ROLES.map((role) => [role.id, role]),
);

export const THEME_TOKEN_ROLE_IDS: ReadonlyArray<string> = THEME_TOKEN_ROLES.map((role) => role.id);

export const DEFAULT_LIGHT_TOKENS: Readonly<Record<string, string>> = Object.fromEntries(
  THEME_TOKEN_ROLES.map((role) => [role.id, role.defaultLight]),
);

export const DEFAULT_DARK_TOKENS: Readonly<Record<string, string>> = Object.fromEntries(
  THEME_TOKEN_ROLES.map((role) => [role.id, role.defaultDark]),
);

export function isKnownThemeTokenRole(id: string): boolean {
  return ROLE_BY_ID.has(id);
}

export function getRoleDefinition(id: string): ThemeTokenRoleDefinition {
  const definition = ROLE_BY_ID.get(id);
  if (definition === undefined) {
    throw new Error(`Unknown theme token role: ${id}`);
  }
  return definition;
}

export function getDefaultToken(id: string, mode: "light" | "dark"): string {
  const definition = getRoleDefinition(id);
  return mode === "light" ? definition.defaultLight : definition.defaultDark;
}
