import type { ThemePresetId } from "@octant/contracts/theme";
import { meetsContrast } from "./contrast";
import { oklchToHex, parseHexColor } from "./color";
import {
  DEFAULT_DARK_TOKENS,
  DEFAULT_LIGHT_TOKENS,
  THEME_TOKEN_ROLE_IDS,
  getRoleDefinition,
} from "./tokens";

export type ThemePresetMode = "light" | "dark";

export interface ThemePreset {
  readonly id: ThemePresetId;
  readonly displayName: string;
  readonly description: string;
  readonly supportedModes: ReadonlyArray<ThemePresetMode>;
  readonly tokens: Readonly<Partial<Record<ThemePresetMode, Readonly<Record<string, string>>>>>;
}

export interface ThemePresetValidation {
  readonly valid: boolean;
  readonly errors: ReadonlyArray<string>;
}

export const BUILT_IN_THEME_PRESET_IDS = [
  "system",
  "light",
  "dark",
  "octant",
  "moss",
  "lagoon",
  "harbor",
  "iris",
  "rose",
  "ember",
  "ink",
  "coral",
  "clay",
  "sand",
  "olive",
  "mint",
  "sky",
  "slate",
  "plum",
  "ash",
  "obsidian",
  "onyx",
] as const;
export type BuiltInThemePresetId = (typeof BUILT_IN_THEME_PRESET_IDS)[number];

const LIGHT_OCTANT_TOKENS: Readonly<Record<string, string>> = {
  ...DEFAULT_LIGHT_TOKENS,
  "app-background": "#edece7",
  chrome: "#e9e8e3",
  sidebar: "#eeede8",
  workspace: "#f2f1ed",
  floating: "#e6e5e0",
  control: "#ebeae5",
  "control-hover": "#e3e2dc",
  "control-pressed": "#dbdad3",
  border: "#d5d4d0",
  "border-strong": "#bdbcb7",
  "divider-strong": "#8c8b86",
  "text-primary": "#26251e",
  "text-secondary": "#61605a",
  "text-muted": "#74726d",
  "primary-foreground": "#14130f",
  "focus-ring": "#8a6218",
  selection: "#d9d8d4",
  accent: "#d9a441",
  "accent-foreground": "#14130f",
  "accent-text": "#8a6218",
};

const DARK_OCTANT_TOKENS: Readonly<Record<string, string>> = {
  ...DEFAULT_DARK_TOKENS,
  "app-background": "#0e0d0a",
  chrome: "#12110d",
  sidebar: "#11100c",
  workspace: "#14130f",
  floating: "#1c1b16",
  control: "#232219",
  "control-hover": "#2a2920",
  "control-pressed": "#322f25",
  border: "#312f2c",
  "border-strong": "#494844",
  "divider-strong": "#787773",
  "text-primary": "#f2f1ed",
  "text-secondary": "#959490",
  "text-muted": "#787773",
  "primary-foreground": "#14130f",
  "focus-ring": "#d9a441",
  selection: "#353430",
  accent: "#d9a441",
  "accent-foreground": "#14130f",
  "accent-text": "#d9a441",
};

interface TintedPresetSpec {
  readonly id: BuiltInThemePresetId;
  readonly displayName: string;
  readonly description: string;
  /** OKLCH hue angle the whole palette is drawn from. */
  readonly hue: number;
  /** Accent chroma; most hues carry 0.13, a quieter one less. */
  readonly chroma?: number;
  /** True-black surfaces for OLED screens. */
  readonly ink?: boolean;
  /** How strongly the surfaces lean toward the hue; 1 is the usual faint tint. */
  readonly surface?: number;
}

// A colour preset is one hue applied twice: faintly to every surface, so the
// page leans toward it, and fully to the accent, focus ring, and accent text.
// Lightness is fixed per role, so every preset clears the same text and
// control contrast bars the graphite default does; a hue the screen cannot
// show at that lightness gives up chroma rather than contrast.
function tintedTokens(mode: ThemePresetMode, spec: TintedPresetSpec): Record<string, string> {
  const chroma = spec.chroma ?? 0.13;
  const lean = spec.surface ?? 1;
  const color = (l: number, c: number) => oklchToHex({ l, c, h: spec.hue });
  if (mode === "light") {
    return {
      ...DEFAULT_LIGHT_TOKENS,
      "app-background": color(0.965, 0.006 * lean),
      chrome: color(0.965, 0.006 * lean),
      sidebar: color(0.965, 0.006 * lean),
      workspace: color(0.995, 0.003 * lean),
      floating: color(0.985, 0.005 * lean),
      control: color(0.95, 0.008 * lean),
      "control-hover": color(0.925, 0.01 * lean),
      "control-pressed": color(0.9, 0.012 * lean),
      border: color(0.9, 0.01 * lean),
      "border-strong": color(0.78, 0.012 * lean),
      "divider-strong": color(0.55, 0.015 * lean),
      "text-primary": color(0.22, 0.012),
      "text-secondary": color(0.42, 0.015),
      "text-muted": color(0.52, 0.015),
      selection: color(0.93, 0.025),
      accent: color(0.46, chroma),
      "accent-text": color(0.46, chroma),
      "focus-ring": color(0.46, chroma),
      "accent-foreground": "#ffffff",
      "primary-foreground": "#ffffff",
    };
  }
  const tint = (spec.ink === true ? 0.008 : 0.012) * lean;
  const l =
    spec.ink === true
      ? {
          app: 0.06,
          chrome: 0.08,
          sidebar: 0.05,
          workspace: 0.1,
          floating: 0.16,
          control: 0.2,
          hover: 0.24,
          pressed: 0.28,
          border: 0.22,
          borderStrong: 0.34,
          divider: 0.52,
          selection: 0.22,
        }
      : {
          app: 0.17,
          chrome: 0.18,
          sidebar: 0.155,
          workspace: 0.21,
          floating: 0.25,
          control: 0.285,
          hover: 0.315,
          pressed: 0.345,
          border: 0.3,
          borderStrong: 0.4,
          divider: 0.58,
          selection: 0.3,
        };
  return {
    ...DEFAULT_DARK_TOKENS,
    "app-background": color(l.app, tint),
    chrome: color(l.chrome, tint),
    sidebar: color(l.sidebar, tint),
    workspace: color(l.workspace, tint),
    floating: color(l.floating, tint),
    control: color(l.control, tint + 0.004),
    "control-hover": color(l.hover, tint + 0.004),
    "control-pressed": color(l.pressed, tint + 0.004),
    border: color(l.border, tint),
    "border-strong": color(l.borderStrong, tint),
    "divider-strong": color(l.divider, tint),
    "text-primary": color(0.95, 0.005),
    "text-secondary": color(0.74, 0.008),
    "text-muted": color(0.63, 0.008),
    selection: color(l.selection, 0.025),
    accent: color(0.76, chroma),
    "accent-text": color(0.76, chroma),
    "focus-ring": color(0.76, chroma),
    "accent-foreground": color(0.16, 0.02),
    "primary-foreground": color(0.16, 0.02),
  };
}

const TINTED_PRESETS: ReadonlyArray<TintedPresetSpec> = [
  {
    id: "moss",
    displayName: "Moss",
    description: "Graphite leaning green, with a moss accent.",
    hue: 145,
  },
  {
    id: "lagoon",
    displayName: "Lagoon",
    description: "Graphite leaning teal, with a lagoon accent.",
    hue: 195,
  },
  {
    id: "harbor",
    displayName: "Harbor",
    description: "Graphite leaning blue, with a harbor accent.",
    hue: 250,
  },
  {
    id: "iris",
    displayName: "Iris",
    description: "Graphite leaning violet, with an iris accent.",
    hue: 295,
  },
  {
    id: "rose",
    displayName: "Rose",
    description: "Graphite leaning rose, with a rose accent.",
    hue: 355,
  },
  {
    id: "ember",
    displayName: "Ember",
    description: "Graphite leaning warm, with an ember accent.",
    hue: 50,
  },
  {
    id: "ink",
    displayName: "Ink",
    description: "True black for OLED screens, with a cool blue accent.",
    hue: 240,
    chroma: 0.12,
    ink: true,
  },
  {
    id: "coral",
    displayName: "Coral",
    description: "Graphite leaning warm pink, with a coral accent.",
    hue: 20,
    chroma: 0.14,
  },
  {
    id: "clay",
    displayName: "Clay",
    description: "Warm earthen surfaces, with a clay accent.",
    hue: 35,
    chroma: 0.09,
    surface: 1.8,
  },
  {
    id: "sand",
    displayName: "Sand",
    description: "Warm paper-like surfaces, with a sand accent.",
    hue: 85,
    chroma: 0.11,
    surface: 1.8,
  },
  {
    id: "olive",
    displayName: "Olive",
    description: "Graphite leaning yellow-green, with an olive accent.",
    hue: 115,
    chroma: 0.1,
  },
  {
    id: "mint",
    displayName: "Mint",
    description: "Graphite leaning cool green, with a mint accent.",
    hue: 165,
    chroma: 0.12,
  },
  {
    id: "sky",
    displayName: "Sky",
    description: "Graphite leaning light blue, with a sky accent.",
    hue: 225,
    chroma: 0.13,
  },
  {
    id: "slate",
    displayName: "Slate",
    description: "Cool blue-grey surfaces, with a quiet slate accent.",
    hue: 245,
    chroma: 0.05,
    surface: 1.5,
  },
  {
    id: "plum",
    displayName: "Plum",
    description: "Graphite leaning magenta, with a plum accent.",
    hue: 320,
    chroma: 0.13,
  },
  {
    id: "ash",
    displayName: "Ash",
    description: "Warm grey surfaces, with a quiet ash accent.",
    hue: 70,
    chroma: 0.03,
    surface: 1.5,
  },
  {
    id: "obsidian",
    displayName: "Obsidian",
    description: "True black for OLED screens, with a violet accent.",
    hue: 300,
    chroma: 0.12,
    ink: true,
  },
  {
    id: "onyx",
    displayName: "Onyx",
    description: "True black for OLED screens, with a green accent.",
    hue: 160,
    chroma: 0.11,
    ink: true,
  },
];

const tintedPreset = (spec: TintedPresetSpec): ThemePreset => ({
  id: spec.id as ThemePresetId,
  displayName: spec.displayName,
  description: spec.description,
  supportedModes: ["light", "dark"],
  tokens: { light: tintedTokens("light", spec), dark: tintedTokens("dark", spec) },
});

const freezeTokens = (tokens: Readonly<Record<string, string>>) =>
  Object.freeze(Object.fromEntries(THEME_TOKEN_ROLE_IDS.map((role) => [role, tokens[role]])));

const makePreset = (preset: ThemePreset): ThemePreset =>
  Object.freeze({
    ...preset,
    supportedModes: Object.freeze([...preset.supportedModes]),
    tokens: Object.freeze(
      Object.fromEntries(
        Object.entries(preset.tokens).map(([mode, tokens]) => [mode, freezeTokens(tokens ?? {})]),
      ),
    ),
  });

export const THEME_PRESETS: ReadonlyArray<ThemePreset> = Object.freeze([
  makePreset({
    id: "system" as ThemePresetId,
    displayName: "System",
    description: "Follows the current system appearance while retaining both palettes.",
    supportedModes: ["light", "dark"],
    tokens: { light: DEFAULT_LIGHT_TOKENS, dark: DEFAULT_DARK_TOKENS },
  }),
  makePreset({
    id: "light" as ThemePresetId,
    displayName: "Light",
    description: "A quiet white workspace with graphite text and restrained neutral controls.",
    supportedModes: ["light"],
    tokens: { light: DEFAULT_LIGHT_TOKENS },
  }),
  makePreset({
    id: "dark" as ThemePresetId,
    displayName: "Dark",
    description: "A neutral graphite workspace with soft hierarchy and monochrome actions.",
    supportedModes: ["dark"],
    tokens: { dark: DEFAULT_DARK_TOKENS },
  }),
  makePreset({
    id: "octant" as ThemePresetId,
    displayName: "Octant",
    description: "The original warm charcoal-and-brass Octant palette.",
    supportedModes: ["light", "dark"],
    tokens: { light: LIGHT_OCTANT_TOKENS, dark: DARK_OCTANT_TOKENS },
  }),
  ...TINTED_PRESETS.map((spec) => makePreset(tintedPreset(spec))),
]);

const PRESET_BY_ID: ReadonlyMap<string, ThemePreset> = new Map(
  THEME_PRESETS.map((preset) => [preset.id, preset]),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateTokenMap(tokens: unknown, mode: ThemePresetMode): string[] {
  if (!isRecord(tokens)) return [`preset.tokens.${mode} is required`];

  const errors: string[] = [];
  const expectedRoles = new Set(THEME_TOKEN_ROLE_IDS);
  for (const role of THEME_TOKEN_ROLE_IDS) {
    const color = tokens[role];
    if (typeof color !== "string") {
      errors.push(`preset.tokens.${mode}.${role} is required`);
      continue;
    }
    try {
      parseHexColor(color);
    } catch {
      errors.push(`preset.tokens.${mode}.${role} must be a six-digit hex color`);
    }
  }
  for (const role of Object.keys(tokens)) {
    if (!expectedRoles.has(role)) errors.push(`preset.tokens.${mode}.${role} is not a known role`);
  }

  if (errors.length > 0) return errors;
  const completeTokens = tokens as Record<string, string>;
  for (const roleId of THEME_TOKEN_ROLE_IDS) {
    const role = getRoleDefinition(roleId);
    // Match Phase 13A's override policy: text contrast is a hard validity
    // gate, while low-contrast borders and surfaces remain intentional.
    if (
      role.contrastTarget === undefined ||
      role.contrastLevel === undefined ||
      (role.contrastLevel !== "normal-text" && role.contrastLevel !== "large-text")
    ) {
      continue;
    }
    if (
      !meetsContrast(
        completeTokens[role.id]!,
        completeTokens[role.contrastTarget]!,
        role.contrastLevel,
      )
    ) {
      errors.push(
        `preset.tokens.${mode}.${role.id} does not meet ${role.contrastLevel} contrast against ${role.contrastTarget}`,
      );
    }
  }
  return errors;
}

export function validateThemePreset(input: unknown): ThemePresetValidation {
  if (!isRecord(input)) return { valid: false, errors: ["preset must be an object"] };
  if (typeof input.tokens !== "object" || input.tokens === null || Array.isArray(input.tokens)) {
    return { valid: false, errors: ["preset.tokens is required"] };
  }

  const errors: string[] = [];
  if (typeof input.id !== "string" || input.id.trim().length === 0) {
    errors.push("preset.id is required");
  }
  if (typeof input.displayName !== "string" || input.displayName.trim().length === 0) {
    errors.push("preset.displayName is required");
  }
  if (typeof input.description !== "string" || input.description.trim().length === 0) {
    errors.push("preset.description is required");
  }
  if (!Array.isArray(input.supportedModes) || input.supportedModes.length === 0) {
    errors.push("preset.supportedModes is required");
  }

  const modes = Array.isArray(input.supportedModes) ? input.supportedModes : [];
  for (const mode of modes) {
    if (mode !== "light" && mode !== "dark")
      errors.push(`preset.supportedModes has invalid mode: ${String(mode)}`);
  }
  if (new Set(modes).size !== modes.length) errors.push("preset.supportedModes must be unique");

  const tokens = input.tokens as Record<string, unknown>;
  for (const mode of modes) {
    if (mode === "light" || mode === "dark") errors.push(...validateTokenMap(tokens[mode], mode));
  }
  return { valid: errors.length === 0, errors };
}

export function getThemePreset(id: string): ThemePreset | undefined {
  return PRESET_BY_ID.get(id);
}

export function resolveThemePresetTokens(
  id: string | undefined,
  mode: ThemePresetMode,
): Readonly<Record<string, string>> {
  const fallback = mode === "light" ? DEFAULT_LIGHT_TOKENS : DEFAULT_DARK_TOKENS;
  const preset = id === undefined ? getThemePreset("system") : getThemePreset(id);
  if (preset === undefined || !preset.supportedModes.includes(mode)) return fallback;
  if (!validateThemePreset(preset).valid) return fallback;
  return preset.tokens[mode] ?? fallback;
}

export function serializeThemePresetCatalog(): string {
  const serializable = THEME_PRESETS.map((preset) => ({
    id: preset.id,
    displayName: preset.displayName,
    description: preset.description,
    supportedModes: [...preset.supportedModes],
    tokens: Object.fromEntries(
      (["light", "dark"] as const)
        .filter((mode) => preset.tokens[mode] !== undefined)
        .map((mode) => [
          mode,
          Object.fromEntries(
            THEME_TOKEN_ROLE_IDS.map((role) => [role, preset.tokens[mode]![role]]),
          ),
        ]),
    ),
  }));
  return JSON.stringify(serializable);
}
