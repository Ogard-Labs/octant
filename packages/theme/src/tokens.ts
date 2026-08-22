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
  // The default palette is a neutral graphite workspace: soft black grounds,
  // quiet grey hierarchy, and monochrome primary actions. The hex values flatten
  // the system sheet's light-dark() pairs and
  // translucent inks (apps/web/src/styles/octant.css) onto the surface
  // each role actually renders over, because preset tokens are opaque
  // six-digit hex by contract.
  {
    id: "app-background",
    displayName: "Application background",
    category: "foundation",
    defaultLight: "#f7f7f7",
    defaultDark: "#171717",
  },
  {
    id: "chrome",
    displayName: "Chrome",
    category: "foundation",
    contrastTarget: "app-background",
    contrastLevel: "ui",
    defaultLight: "#fafafa",
    defaultDark: "#181818",
  },
  {
    id: "sidebar",
    displayName: "Sidebar",
    category: "foundation",
    contrastTarget: "app-background",
    contrastLevel: "ui",
    defaultLight: "#f0f0f0",
    defaultDark: "#202020",
  },
  {
    id: "workspace",
    displayName: "Workspace surface",
    category: "surface",
    defaultLight: "#ffffff",
    defaultDark: "#171717",
  },
  {
    // Raised surfaces move one neutral step away from the workspace. Static
    // content remains flat; this role is for overlays and discrete objects.
    id: "floating",
    displayName: "Floating surface",
    category: "surface",
    contrastTarget: "workspace",
    contrastLevel: "ui",
    defaultLight: "#f3f3f3",
    defaultDark: "#242424",
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
    defaultLight: "#efefef",
    defaultDark: "#292929",
  },
  {
    id: "control-hover",
    displayName: "Control hover",
    category: "control",
    contrastTarget: "workspace",
    contrastLevel: "non-text",
    defaultLight: "#e7e7e7",
    defaultDark: "#303030",
  },
  {
    id: "control-pressed",
    displayName: "Control pressed",
    category: "control",
    contrastTarget: "workspace",
    contrastLevel: "non-text",
    defaultLight: "#dedede",
    defaultDark: "#383838",
  },
  {
    // The design system's border is translucent ink (13-14% of the text
    // colour); flattened over the workspace so a hairline never shifts
    // when a surface behind it changes.
    id: "border",
    displayName: "Border",
    category: "border",
    contrastTarget: "workspace",
    contrastLevel: "non-text",
    defaultLight: "#dedede",
    defaultDark: "#2d2d2d",
  },
  {
    id: "border-strong",
    displayName: "Strong border",
    category: "border",
    contrastTarget: "workspace",
    contrastLevel: "ui",
    defaultLight: "#c5c5c5",
    defaultDark: "#454545",
  },
  {
    id: "divider-strong",
    displayName: "Strong divider",
    category: "border",
    contrastTarget: "workspace",
    contrastLevel: "ui",
    defaultLight: "#8a8a8a",
    defaultDark: "#6b6b6b",
  },
  {
    id: "text-primary",
    displayName: "Primary text",
    category: "text",
    contrastTarget: "workspace",
    contrastLevel: "normal-text",
    defaultLight: "#202020",
    defaultDark: "#f2f2f2",
  },
  {
    // A step darker than the flattened 68% ink the system sheet uses:
    // that value measured 4.5:1 on the workspace but only 4.2:1 on the
    // darker light-mode card this text also sits on.
    id: "text-secondary",
    displayName: "Secondary text",
    category: "text",
    contrastTarget: "workspace",
    contrastLevel: "normal-text",
    defaultLight: "#5f5f5f",
    defaultDark: "#b5b5b5",
  },
  {
    id: "text-muted",
    displayName: "Muted text",
    category: "text",
    contrastTarget: "workspace",
    contrastLevel: "large-text",
    defaultLight: "#707070",
    defaultDark: "#8a8a8a",
  },
  {
    // Primary actions invert against the monochrome accent in each mode.
    id: "primary-foreground",
    displayName: "Primary foreground",
    category: "text",
    contrastTarget: "accent",
    contrastLevel: "normal-text",
    defaultLight: "#ffffff",
    defaultDark: "#171717",
  },
  {
    id: "focus-ring",
    displayName: "Focus ring",
    category: "focus",
    contrastTarget: "workspace",
    contrastLevel: "ui",
    defaultLight: "#202020",
    defaultDark: "#f2f2f2",
  },
  {
    id: "selection",
    displayName: "Selection",
    category: "focus",
    contrastTarget: "workspace",
    contrastLevel: "non-text",
    defaultLight: "#e7e7e7",
    defaultDark: "#303030",
  },
  {
    // Primary action fill. Expressive colour is reserved for semantic state,
    // Project View identity, and user-selected themes.
    id: "accent",
    displayName: "Accent",
    category: "accent",
    contrastTarget: "workspace",
    contrastLevel: "ui",
    defaultLight: "#202020",
    defaultDark: "#f2f2f2",
  },
  {
    id: "accent-foreground",
    displayName: "Accent foreground",
    category: "accent",
    contrastTarget: "accent",
    contrastLevel: "normal-text",
    defaultLight: "#ffffff",
    defaultDark: "#171717",
  },
  {
    // Accent as text follows the foreground-strength monochrome role and is
    // still policed at the normal-text contrast bar.
    id: "accent-text",
    displayName: "Accent text",
    category: "accent",
    contrastTarget: "workspace",
    contrastLevel: "normal-text",
    defaultLight: "#202020",
    defaultDark: "#f2f2f2",
  },
  {
    id: "success-surface",
    displayName: "Success surface",
    category: "status",
    contrastTarget: "workspace",
    contrastLevel: "non-text",
    defaultLight: "#bfd8cc",
    defaultDark: "#16281f",
  },
  {
    id: "success-text",
    displayName: "Success text",
    category: "status",
    contrastTarget: "success-surface",
    contrastLevel: "normal-text",
    defaultLight: "#0f6144",
    defaultDark: "#6bb299",
  },
  {
    id: "warning-surface",
    displayName: "Warning surface",
    category: "status",
    contrastTarget: "workspace",
    contrastLevel: "non-text",
    defaultLight: "#f0dea8",
    defaultDark: "#342b0e",
  },
  {
    id: "warning-border",
    displayName: "Warning border",
    category: "status",
    contrastTarget: "warning-surface",
    contrastLevel: "ui",
    defaultLight: "#987405",
    defaultDark: "#a3801f",
  },
  {
    id: "warning-text",
    displayName: "Warning text",
    category: "status",
    contrastTarget: "warning-surface",
    contrastLevel: "normal-text",
    defaultLight: "#6f5300",
    defaultDark: "#edbc26",
  },
  {
    // Targeted at `floating`, not `workspace`: status text sits inside
    // cards, and the card is the stricter ground in both modes — lighter
    // than the workspace in dark, darker than it in light. #a8102f
    // measures 6.7:1 on the light workspace but 6.0:1 on the card it is
    // actually read on.
    id: "danger-text",
    displayName: "Danger text",
    category: "status",
    contrastTarget: "floating",
    contrastLevel: "normal-text",
    defaultLight: "#a8102f",
    defaultDark: "#e17d96",
  },
  {
    id: "addition-text",
    displayName: "Diff addition text",
    category: "diff",
    contrastTarget: "workspace",
    contrastLevel: "normal-text",
    defaultLight: "#0f6144",
    defaultDark: "#6bb299",
  },
  {
    id: "deletion-text",
    displayName: "Diff deletion text",
    category: "diff",
    contrastTarget: "workspace",
    contrastLevel: "normal-text",
    defaultLight: "#a8102f",
    defaultDark: "#e17d96",
  },
  // The picker palette follows the design system's chart-series hues
  // (yellow IS the brass, teal/green/blue/purple/pink are series 2-6) so
  // project labels and terminal-adjacent colour read as one family with
  // the rest of the theme. Red and orange, which the series set lacks,
  // are derived from the danger and warning hues.
  {
    id: "palette-red",
    displayName: "Palette red",
    category: "palette",
    contrastTarget: "sidebar",
    contrastLevel: "ui",
    defaultLight: "#a8102f",
    defaultDark: "#d95778",
  },
  {
    id: "palette-orange",
    displayName: "Palette orange",
    category: "palette",
    contrastTarget: "sidebar",
    contrastLevel: "ui",
    defaultLight: "#9d5a12",
    defaultDark: "#e09b52",
  },
  {
    id: "palette-yellow",
    displayName: "Palette yellow",
    category: "palette",
    contrastTarget: "sidebar",
    contrastLevel: "ui",
    defaultLight: "#8a6218",
    defaultDark: "#d9a441",
  },
  {
    id: "palette-green",
    displayName: "Palette green",
    category: "palette",
    contrastTarget: "sidebar",
    contrastLevel: "ui",
    defaultLight: "#41761c",
    defaultDark: "#93cb58",
  },
  {
    id: "palette-teal",
    displayName: "Palette teal",
    category: "palette",
    contrastTarget: "sidebar",
    contrastLevel: "ui",
    defaultLight: "#0f6f68",
    defaultDark: "#45c8bc",
  },
  {
    id: "palette-blue",
    displayName: "Palette blue",
    category: "palette",
    contrastTarget: "sidebar",
    contrastLevel: "ui",
    defaultLight: "#1e5fae",
    defaultDark: "#74b0f3",
  },
  {
    id: "palette-purple",
    displayName: "Palette purple",
    category: "palette",
    contrastTarget: "sidebar",
    contrastLevel: "ui",
    defaultLight: "#5b4bb0",
    defaultDark: "#ab98f2",
  },
  {
    id: "palette-pink",
    displayName: "Palette pink",
    category: "palette",
    contrastTarget: "sidebar",
    contrastLevel: "ui",
    defaultLight: "#b3356e",
    defaultDark: "#f4809a",
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
