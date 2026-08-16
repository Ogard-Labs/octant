import type { ThemePresetId } from "@octant/contracts/theme";
import { meetsContrast } from "./contrast";
import { parseHexColor } from "./color";
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

export const BUILT_IN_THEME_PRESET_IDS = ["system", "light", "dark", "octant"] as const;
export type BuiltInThemePresetId = (typeof BUILT_IN_THEME_PRESET_IDS)[number];

const LIGHT_OCTANT_TOKENS: Readonly<Record<string, string>> = DEFAULT_LIGHT_TOKENS;

const DARK_OCTANT_TOKENS: Readonly<Record<string, string>> = DEFAULT_DARK_TOKENS;

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
    description: "A quiet light workspace with neutral surfaces and clear state colors.",
    supportedModes: ["light"],
    tokens: { light: DEFAULT_LIGHT_TOKENS },
  }),
  makePreset({
    id: "dark" as ThemePresetId,
    displayName: "Dark",
    description: "A dark workspace with balanced graphite surfaces and readable hierarchy.",
    supportedModes: ["dark"],
    tokens: { dark: DEFAULT_DARK_TOKENS },
  }),
  makePreset({
    id: "octant" as ThemePresetId,
    displayName: "Octant",
    description: "The crisp cool-neutral Octant workspace across light and dark surfaces.",
    supportedModes: ["light", "dark"],
    tokens: { light: LIGHT_OCTANT_TOKENS, dark: DARK_OCTANT_TOKENS },
  }),
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
