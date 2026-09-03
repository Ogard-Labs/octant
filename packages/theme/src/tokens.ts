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
  // The default palette is a neutral graphite workspace: a near-black page
  // with a slightly lighter reading surface in dark, a white reading surface
  // on a near-white ground in light, and one scarce accent. In light the
  // sidebar shares the page's ground and a hairline separates it from the
  // workspace; a grey sidebar beside a white pane read as a heavy panel, and
  // the native host paints the sidebar at partial alpha over window
  // vibrancy, so the token has to sit a hair below white to render white. Every step of the
  // ladder is a deliberate, visible move: the earlier defaults sat two or
  // three hex points apart and the sidebar, page, cards, and hairlines read
  // as one flat plate in both modes. The renderer fallback in
  // apps/web/src/styles.css mirrors these values exactly so the first paint
  // and the applied theme are the same picture.
  {
    // The application background is the well every other surface sits in. It
    // has to be a visible step below the workspace, or panels, cards, and the
    // page all read as one flat plate.
    id: "app-background",
    displayName: "Application background",
    category: "foundation",
    defaultLight: "#fafaf9",
    defaultDark: "#151515",
  },
  {
    id: "chrome",
    displayName: "Chrome",
    category: "foundation",
    contrastTarget: "app-background",
    contrastLevel: "ui",
    defaultLight: "#fafaf9",
    defaultDark: "#151515",
  },
  {
    id: "sidebar",
    displayName: "Sidebar",
    category: "foundation",
    contrastTarget: "app-background",
    contrastLevel: "ui",
    defaultLight: "#fafaf9",
    defaultDark: "#101010",
  },
  {
    id: "workspace",
    displayName: "Workspace surface",
    category: "surface",
    defaultLight: "#ffffff",
    defaultDark: "#1a1a1a",
  },
  {
    // Raised surfaces move one neutral step away from the workspace. Static
    // content remains flat; this role is for overlays and discrete objects.
    id: "floating",
    displayName: "Floating surface",
    category: "surface",
    defaultLight: "#fdfdfc",
    defaultDark: "#232323",
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
    defaultLight: "#f0f0ef",
    defaultDark: "#2b2b2b",
  },
  {
    id: "control-hover",
    displayName: "Control hover",
    category: "control",
    contrastTarget: "workspace",
    contrastLevel: "non-text",
    defaultLight: "#e8e8e6",
    defaultDark: "#333333",
  },
  {
    id: "control-pressed",
    displayName: "Control pressed",
    category: "control",
    contrastTarget: "workspace",
    contrastLevel: "non-text",
    defaultLight: "#dfdfdd",
    defaultDark: "#3b3b3b",
  },
  {
    // Hairlines have to register on the surface they separate: the light
    // value measures about 1.3:1 on the white workspace and the dark value
    // about 1.3:1 on the reading surface, which is the point where a
    // separator is visible without reading as a rule.
    id: "border",
    displayName: "Border",
    category: "border",
    contrastTarget: "workspace",
    contrastLevel: "non-text",
    defaultLight: "#e0e0de",
    defaultDark: "#303030",
  },
  {
    id: "border-strong",
    displayName: "Strong border",
    category: "border",
    contrastTarget: "workspace",
    contrastLevel: "ui",
    defaultLight: "#bdbdbb",
    defaultDark: "#4d4d4d",
  },
  {
    id: "divider-strong",
    displayName: "Strong divider",
    category: "border",
    contrastTarget: "workspace",
    contrastLevel: "ui",
    defaultLight: "#6f6f6d",
    defaultDark: "#808080",
  },
  {
    id: "text-primary",
    displayName: "Primary text",
    category: "text",
    contrastTarget: "workspace",
    contrastLevel: "normal-text",
    defaultLight: "#1b1b1b",
    defaultDark: "#f0f0f0",
  },
  {
    // Secondary copy sits on the workspace, the sidebar, and the control
    // fill; it clears 4.5:1 on all three in both modes.
    id: "text-secondary",
    displayName: "Secondary text",
    category: "text",
    contrastTarget: "workspace",
    contrastLevel: "normal-text",
    defaultLight: "#4f4f4f",
    defaultDark: "#a9a9a9",
  },
  {
    id: "text-muted",
    displayName: "Muted text",
    category: "text",
    contrastTarget: "workspace",
    contrastLevel: "large-text",
    defaultLight: "#6b6b6b",
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
    defaultLight: "#1f6f96",
    defaultDark: "#4d9ec8",
  },
  {
    id: "selection",
    displayName: "Selection",
    category: "focus",
    contrastTarget: "workspace",
    contrastLevel: "non-text",
    defaultLight: "#ebebea",
    defaultDark: "#2c2c2c",
  },
  {
    // Primary action fill. The accent is monochrome: the primary button, the
    // send control, and an active mark are the ink colour inverted, so the
    // one hue on screen stays the keyboard focus ring. Links keep their
    // underline, which is what separates them from body text.
    id: "accent",
    displayName: "Accent",
    category: "accent",
    contrastTarget: "workspace",
    contrastLevel: "ui",
    defaultLight: "#1b1b1b",
    defaultDark: "#f0f0f0",
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
    // Accent as text carries the same hue as the fill and is still policed at
    // the normal-text contrast bar.
    id: "accent-text",
    displayName: "Accent text",
    category: "accent",
    contrastTarget: "workspace",
    contrastLevel: "normal-text",
    defaultLight: "#1b1b1b",
    defaultDark: "#f0f0f0",
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
