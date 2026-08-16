export interface ImportedTokenColor {
  readonly scope: ReadonlyArray<string>;
  readonly foreground?: string;
  readonly background?: string;
  readonly fontStyle?: string;
}

export interface ImportedTheme {
  readonly name?: string;
  readonly type?: "light" | "dark";
  readonly colors: Readonly<Record<string, string>>;
  readonly tokenColors: ReadonlyArray<ImportedTokenColor>;
}

import {
  DEFAULT_THEME_SETTINGS,
  decodeThemeSettings,
  type ThemeSettings,
} from "@octant/contracts/theme";
import { isKnownThemeTokenRole } from "./tokens";

export class ThemeImportError extends Error {
  override readonly name = "ThemeImportError";
  constructor(message: string) {
    super(message);
  }
}

function fail(message: string): never {
  throw new ThemeImportError(message);
}

const MAX_NAME_LENGTH = 128;
const MAX_COLORS = 512;
const MAX_TOKEN_COLORS = 256;
const MAX_KEY_LENGTH = 256;
const MAX_SCOPE_LENGTH = 256;
const MAX_SCOPES = 16;
const MAX_FONT_STYLE_LENGTH = 64;
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;
const ALLOWED_FONT_STYLES = new Set(["normal", "italic", "bold", "underline", "strikethrough"]);
const TOP_LEVEL_KEYS = new Set(["name", "type", "colors", "tokenColors"]);
const TOKEN_COLOR_KEYS = new Set(["scope", "settings"]);
const TOKEN_SETTINGS_KEYS = new Set(["foreground", "background", "fontStyle"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isUnsafeString(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    lower.includes("url(") ||
    lower.includes("@import") ||
    lower.includes("http://") ||
    lower.includes("https://") ||
    lower.includes("://") ||
    lower.includes("<script") ||
    lower.includes("javascript:") ||
    lower.includes("<") ||
    lower.includes(">")
  );
}

function validateBoundedString(value: unknown, maxLength: number, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    fail(`Invalid ${field}: must be a non-empty string of at most ${maxLength} characters.`);
  }
  if (isUnsafeString(value)) fail(`Invalid ${field}: contains unsafe content.`);
  return value;
}

function validateHexColor(value: unknown, field: string): string {
  if (typeof value !== "string" || !HEX_COLOR_PATTERN.test(value)) {
    fail(`Invalid ${field}: must be a #RRGGBB or #RRGGBBAA hex color.`);
  }
  return value;
}

function validateFontStyle(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_FONT_STYLE_LENGTH) {
    fail("Invalid fontStyle: must be a bounded string.");
  }
  if (isUnsafeString(value)) fail("Invalid fontStyle: contains unsafe content.");
  const tokens = value.split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0) return undefined;
  for (const token of tokens) {
    if (!ALLOWED_FONT_STYLES.has(token)) {
      fail(`Invalid fontStyle token: ${token}`);
    }
  }
  return tokens.join(" ");
}

function validateScope(scope: unknown): ReadonlyArray<string> {
  if (typeof scope === "string") {
    return [validateBoundedString(scope, MAX_SCOPE_LENGTH, "scope")];
  }
  if (Array.isArray(scope)) {
    if (scope.length === 0 || scope.length > MAX_SCOPES) {
      fail("Invalid scope: must contain between 1 and 16 entries.");
    }
    return scope.map((entry) => validateBoundedString(entry, MAX_SCOPE_LENGTH, "scope"));
  }
  fail("Invalid scope: must be a string or array of strings.");
}

function validateColors(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!isPlainObject(value)) fail("Invalid colors: must be an object.");
  const entries = Object.entries(value);
  if (entries.length > MAX_COLORS) fail(`Invalid colors: at most ${MAX_COLORS} entries allowed.`);
  const result: Record<string, string> = {};
  for (const [key, color] of entries) {
    if (key.length === 0 || key.length > MAX_KEY_LENGTH) {
      fail("Invalid color key: must be a bounded string.");
    }
    result[key] = validateHexColor(color, "color value");
  }
  return result;
}

function validateTokenColors(value: unknown): ImportedTokenColor[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail("Invalid tokenColors: must be an array.");
  if (value.length > MAX_TOKEN_COLORS)
    fail(`Invalid tokenColors: at most ${MAX_TOKEN_COLORS} entries.`);
  const result: ImportedTokenColor[] = [];
  for (const entry of value) {
    if (!isPlainObject(entry)) fail("Invalid tokenColor entry: must be an object.");
    for (const key of Object.keys(entry)) {
      if (!TOKEN_COLOR_KEYS.has(key)) fail(`Disallowed tokenColor key: ${key}`);
    }
    const settings = entry.settings;
    if (!isPlainObject(settings)) fail("Invalid tokenColor settings: must be an object.");
    for (const key of Object.keys(settings)) {
      if (!TOKEN_SETTINGS_KEYS.has(key)) fail(`Disallowed tokenColor settings key: ${key}`);
    }
    const fontStyle = validateFontStyle(settings.fontStyle);
    const tokenColor: ImportedTokenColor = {
      scope: validateScope(entry.scope),
      ...(settings.foreground !== undefined && {
        foreground: validateHexColor(settings.foreground, "foreground"),
      }),
      ...(settings.background !== undefined && {
        background: validateHexColor(settings.background, "background"),
      }),
      ...(fontStyle !== undefined && { fontStyle }),
    };
    result.push(tokenColor);
  }
  return result;
}

export function importVsCodeTheme(input: unknown): ImportedTheme {
  if (!isPlainObject(input)) fail("Theme import must be a plain JSON object.");
  for (const key of Object.keys(input)) {
    if (!TOP_LEVEL_KEYS.has(key)) fail(`Disallowed top-level key: ${key}`);
  }
  const name =
    input.name === undefined
      ? undefined
      : validateBoundedString(input.name, MAX_NAME_LENGTH, "name");
  const type =
    input.type === undefined
      ? undefined
      : input.type === "light" || input.type === "dark"
        ? input.type
        : fail("Invalid type: must be 'light' or 'dark'.");
  const colors = validateColors(input.colors);
  const tokenColors = validateTokenColors(input.tokenColors);
  return {
    ...(name !== undefined && { name }),
    ...(type !== undefined && { type }),
    colors,
    tokenColors,
  };
}

const OCTANT_THEME_FORMAT = "octant-theme";
const OCTANT_THEME_VERSION = 1;

export function serializeOctantTheme(settings: ThemeSettings): string {
  const validated = decodeThemeSettings(settings);
  return JSON.stringify(
    { format: OCTANT_THEME_FORMAT, version: OCTANT_THEME_VERSION, settings: validated },
    null,
    2,
  );
}

export function importThemeSettings(input: unknown): ThemeSettings {
  if (isPlainObject(input) && input.format !== undefined) {
    for (const key of Object.keys(input)) {
      if (key !== "format" && key !== "version" && key !== "settings") {
        fail(`Disallowed Octant theme key: ${key}`);
      }
    }
    if (input.format !== OCTANT_THEME_FORMAT || input.version !== OCTANT_THEME_VERSION) {
      fail("Unsupported Octant theme format or version.");
    }
    try {
      return decodeThemeSettings(input.settings);
    } catch {
      fail("Octant theme settings are invalid.");
    }
  }

  const imported = importVsCodeTheme(input);
  const semanticOverrides: Array<{ readonly role: string; readonly color: string }> = [];
  for (const [key, color] of Object.entries(imported.colors)) {
    const role = key.startsWith("octant.") ? key.slice("octant.".length) : key;
    if (isKnownThemeTokenRole(role) && /^#[0-9a-fA-F]{6}$/.test(color)) {
      semanticOverrides.push({ role, color });
    }
  }
  try {
    return decodeThemeSettings({
      ...DEFAULT_THEME_SETTINGS,
      mode: imported.type ?? DEFAULT_THEME_SETTINGS.mode,
      semanticOverrides,
    });
  } catch {
    fail("VS Code theme could not be converted to safe Octant settings.");
  }
}
