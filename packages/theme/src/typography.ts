import { DEFAULT_THEME_SETTINGS, type ThemeTypography } from "@octant/contracts/theme";

export const DEFAULT_UI_TYPOGRAPHY: UiTypographyProjection = {
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
  fontSize: 13,
  fontWeight: 400,
};

export const DEFAULT_EDITOR_TYPOGRAPHY: EditorTypographyProjection = {
  fontFamily: "'JetBrains Mono', 'SF Mono', Menlo, monospace",
  fontSize: 13,
  fontWeight: 400,
  lineHeight: 1.5,
  fontLigatures: true,
};

export const DEFAULT_TERMINAL_TYPOGRAPHY: TerminalTypographyProjection = {
  fontFamily: DEFAULT_THEME_SETTINGS.typography.terminal.family,
  fontSize: 12,
  fontWeight: 400,
  lineHeight: 1.4,
  fontLigatures: false,
};

export interface UiTypographyProjection {
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly fontWeight: number;
}

export interface EditorTypographyProjection extends UiTypographyProjection {
  readonly lineHeight: number;
  readonly fontLigatures: boolean;
}

export type TerminalTypographyProjection = EditorTypographyProjection;

export interface ResolvedTypographyProjection {
  readonly typography: ThemeTypography;
  readonly ui: UiTypographyProjection;
  readonly editor: EditorTypographyProjection;
  readonly terminal: TerminalTypographyProjection;
}

const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 32;
const MIN_LINE_HEIGHT = 1;
const MAX_LINE_HEIGHT = 2.5;
const MIN_FONT_WEIGHT = 300;
const MAX_FONT_WEIGHT = 700;
const GENERIC_FONT_KEYWORDS = new Set([
  "cursive",
  "emoji",
  "fantasy",
  "fangsong",
  "math",
  "monospace",
  "serif",
  "sans-serif",
  "system-ui",
  "ui-monospace",
  "ui-rounded",
  "ui-sans-serif",
  "ui-serif",
]);

export function resolveTypographyProjection(
  input: ThemeTypography,
  availableFonts: ReadonlyArray<string>,
): ResolvedTypographyProjection {
  const source = asRecord(input);
  const sourceUi = asRecord(source.ui);
  const sourceEditor = asRecord(source.editor);
  const sourceTerminal = asRecord(source.terminal);
  const defaults = DEFAULT_THEME_SETTINGS.typography;

  const uiFamily = resolveFamily(sourceUi.family, availableFonts, DEFAULT_UI_TYPOGRAPHY.fontFamily);
  const editorFamily = resolveFamily(
    sourceEditor.family,
    availableFonts,
    DEFAULT_EDITOR_TYPOGRAPHY.fontFamily,
  );
  const terminalFamily = resolveFamily(
    sourceTerminal.family,
    availableFonts,
    DEFAULT_TERMINAL_TYPOGRAPHY.fontFamily,
  );
  const uiSize = boundedInteger(sourceUi.size, MIN_FONT_SIZE, MAX_FONT_SIZE, defaults.ui.size);
  const editorSize = boundedInteger(
    sourceEditor.size,
    MIN_FONT_SIZE,
    MAX_FONT_SIZE,
    defaults.editor.size,
  );
  const terminalSize = boundedInteger(
    sourceTerminal.size,
    MIN_FONT_SIZE,
    MAX_FONT_SIZE,
    defaults.terminal.size,
  );
  const uiWeight = boundedInteger(sourceUi.weight, MIN_FONT_WEIGHT, MAX_FONT_WEIGHT, 400);
  const editorWeight = boundedInteger(sourceEditor.weight, MIN_FONT_WEIGHT, MAX_FONT_WEIGHT, 400);
  const terminalWeight = boundedInteger(
    sourceTerminal.weight,
    MIN_FONT_WEIGHT,
    MAX_FONT_WEIGHT,
    400,
  );
  const editorLineHeight = boundedNumber(
    sourceEditor.lineHeight,
    MIN_LINE_HEIGHT,
    MAX_LINE_HEIGHT,
    defaults.editor.lineHeight,
  );
  const terminalLineHeight = boundedNumber(
    sourceTerminal.lineHeight,
    MIN_LINE_HEIGHT,
    MAX_LINE_HEIGHT,
    defaults.terminal.lineHeight,
  );
  const editorLigatures =
    typeof sourceEditor.ligatures === "boolean" ? sourceEditor.ligatures : true;
  const terminalLigatures =
    typeof sourceTerminal.ligatures === "boolean" ? sourceTerminal.ligatures : false;

  const typography = {
    ui: {
      family: uiFamily,
      size: uiSize,
      weight: uiWeight,
    },
    editor: {
      family: editorFamily,
      size: editorSize,
      weight: editorWeight,
      lineHeight: editorLineHeight,
      ligatures: editorLigatures,
    },
    terminal: {
      family: terminalFamily,
      size: terminalSize,
      weight: terminalWeight,
      lineHeight: terminalLineHeight,
      ligatures: terminalLigatures,
    },
  } as ThemeTypography;

  return {
    typography,
    ui: { fontFamily: uiFamily, fontSize: uiSize, fontWeight: uiWeight },
    editor: {
      fontFamily: editorFamily,
      fontSize: editorSize,
      fontWeight: editorWeight,
      lineHeight: editorLineHeight,
      fontLigatures: editorLigatures,
    },
    terminal: {
      fontFamily: terminalFamily,
      fontSize: terminalSize,
      fontWeight: terminalWeight,
      lineHeight: terminalLineHeight,
      fontLigatures: terminalLigatures,
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function boundedNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
    ? value
    : fallback;
}

function boundedInteger(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : fallback;
}

function resolveFamily(
  value: unknown,
  availableFonts: ReadonlyArray<string>,
  fallback: string,
): string {
  if (typeof value !== "string" || !isSafeFamily(value)) return fallback;
  const available = new Set(
    availableFonts
      .filter((font): font is string => typeof font === "string")
      .map((font) => normalizeFamilyToken(font)),
  );
  const tokens = value
    .split(",")
    .map((token) => normalizeFamilyToken(token))
    .filter((token) => token.length > 0);
  return tokens.some((token) => GENERIC_FONT_KEYWORDS.has(token) || available.has(token))
    ? value
    : fallback;
}

function isSafeFamily(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    value.trim().length > 0 &&
    value.length <= 128 &&
    !/[;\\<>\n\r\t]/.test(value) &&
    !lower.includes("url(") &&
    !lower.includes("@import") &&
    !lower.includes("http:") &&
    !lower.includes("https:") &&
    !lower.includes("://")
  );
}

function normalizeFamilyToken(value: string): string {
  return value
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .toLowerCase();
}
