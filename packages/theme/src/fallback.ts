import type { ThemeSemanticOverrideEntry, ThemeSettings } from "@octant/contracts/theme";
import { meetsContrast } from "./contrast";
import { parseHexColor } from "./color";
import {
  DEFAULT_DARK_TOKENS,
  DEFAULT_LIGHT_TOKENS,
  getRoleDefinition,
  isKnownThemeTokenRole,
} from "./tokens";
import { resolveThemePresetTokens } from "./presets";

export interface DroppedOverride {
  readonly role: string;
  readonly reason: "unknown-role" | "invalid-color" | "insufficient-contrast";
}

export interface ResolvedTheme {
  readonly mode: "light" | "dark";
  readonly tokens: Readonly<Record<string, string>>;
  readonly droppedOverrides: ReadonlyArray<DroppedOverride>;
}

const HEX_PATTERN = /^#[0-9a-fA-F]{6}$/;

export function resolveMode(settings: ThemeSettings, systemPrefersDark: boolean): "light" | "dark" {
  if (settings.mode === "system") return systemPrefersDark ? "dark" : "light";
  return settings.mode;
}

export function validateOverride(
  role: string,
  color: string,
  baseTokens: Readonly<Record<string, string>>,
): { ok: boolean; reason?: DroppedOverride["reason"] } {
  if (!isKnownThemeTokenRole(role)) return { ok: false, reason: "unknown-role" };
  if (typeof color !== "string" || !HEX_PATTERN.test(color)) {
    return { ok: false, reason: "invalid-color" };
  }
  try {
    parseHexColor(color);
  } catch {
    return { ok: false, reason: "invalid-color" };
  }
  const definition = getRoleDefinition(role);
  const level = definition.contrastLevel;
  if (level === "normal-text" || level === "large-text") {
    const target = definition.contrastTarget;
    if (target !== undefined) {
      const targetColor = baseTokens[target];
      if (targetColor !== undefined && !meetsContrast(color, targetColor, level)) {
        return { ok: false, reason: "insufficient-contrast" };
      }
    }
  }
  return { ok: true };
}

export function applySemanticOverrides(
  base: Readonly<Record<string, string>>,
  overrides: ReadonlyArray<ThemeSemanticOverrideEntry>,
  _mode: "light" | "dark",
): {
  tokens: Readonly<Record<string, string>>;
  droppedOverrides: ReadonlyArray<DroppedOverride>;
} {
  const tokens: Record<string, string> = { ...base };
  const dropped: DroppedOverride[] = [];
  for (const entry of overrides) {
    const result = validateOverride(entry.role, entry.color, tokens);
    if (result.ok) {
      tokens[entry.role] = entry.color;
    } else {
      dropped.push({ role: entry.role, reason: result.reason ?? "invalid-color" });
    }
  }
  return { tokens, droppedOverrides: dropped };
}

export function resolveEffectiveTokens(
  settings: ThemeSettings,
  systemPrefersDark: boolean,
): ResolvedTheme {
  const mode = resolveMode(settings, systemPrefersDark);
  const selectedPresetId = mode === "light" ? settings.lightPresetId : settings.darkPresetId;
  const base = resolveThemePresetTokens(selectedPresetId, mode);
  const { tokens, droppedOverrides } = applySemanticOverrides(
    base,
    settings.semanticOverrides,
    mode,
  );
  return { mode, tokens, droppedOverrides };
}

export function safeFallbackTheme(systemPrefersDark: boolean): ResolvedTheme {
  const mode = systemPrefersDark ? "dark" : "light";
  const base = mode === "light" ? DEFAULT_LIGHT_TOKENS : DEFAULT_DARK_TOKENS;
  return { mode, tokens: base, droppedOverrides: [] };
}
