import type { ThemeSettings } from "@octant/contracts/theme";
import { applySemanticOverrides, type DroppedOverride } from "./fallback";
import { resolveThemePresetTokens } from "./presets";
import { THEME_TOKEN_ROLES } from "./tokens";
import { resolveTypographyProjection } from "./typography";

export type ThemeExportFormat = "css" | "json";

export interface ThemeExportOptions {
  readonly format: ThemeExportFormat;
  /** Custom-property and JSON key prefix. Defaults to Octant's own. */
  readonly prefix?: string;
  readonly name?: string;
  readonly includeTypography?: boolean;
}

export interface ThemeExport {
  readonly format: ThemeExportFormat;
  readonly fileName: string;
  readonly mediaType: string;
  readonly content: string;
  /**
   * Overrides the theme refused, carried out with the export.
   *
   * An export that silently dropped an unreadable colour would hand a project
   * a token set that does not match the theme it was taken from, and nothing
   * downstream could tell.
   */
  readonly droppedOverrides: ReadonlyArray<DroppedOverride>;
}

const DEFAULT_PREFIX = "octant";
const PREFIX_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

export class ThemeExportError extends Error {
  override readonly name = "ThemeExportError";
  constructor(message: string) {
    super(message);
  }
}

/**
 * Hand a theme to a project outside Octant, as design tokens.
 *
 * Both modes are always written. A theme is a pair — the light reading and the
 * dark one — and exporting only whichever one happens to be showing produces a
 * file that looks complete and silently drops half the design.
 *
 * The values are the theme's own resolved tokens, overrides included, so what a
 * project consumes is what Octant renders rather than the preset it started
 * from.
 */
export function exportThemeTokens(
  settings: ThemeSettings,
  options: ThemeExportOptions,
): ThemeExport {
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  if (!PREFIX_PATTERN.test(prefix)) {
    throw new ThemeExportError(
      "A token prefix must be lowercase letters, digits, and dashes, starting with a letter.",
    );
  }
  const light = resolveForMode(settings, "light");
  const dark = resolveForMode(settings, "dark");
  const droppedOverrides = [...light.droppedOverrides, ...dark.droppedOverrides];
  const typography =
    options.includeTypography === true
      ? resolveTypographyProjection(settings.typography, [])
      : undefined;
  const name = options.name ?? "Octant theme";
  if (options.format === "json") {
    return {
      format: "json",
      fileName: "octant-theme-tokens.json",
      mediaType: "application/json",
      content: `${JSON.stringify(
        {
          name,
          prefix,
          modes: { light: light.tokens, dark: dark.tokens },
          ...(typography === undefined ? {} : { typography }),
        },
        null,
        2,
      )}\n`,
      droppedOverrides,
    };
  }
  return {
    format: "css",
    fileName: "octant-theme-tokens.css",
    mediaType: "text/css",
    content: css(name, prefix, light.tokens, dark.tokens, typography),
    droppedOverrides,
  };
}

function resolveForMode(
  settings: ThemeSettings,
  mode: "light" | "dark",
): {
  readonly tokens: Readonly<Record<string, string>>;
  readonly droppedOverrides: ReadonlyArray<DroppedOverride>;
} {
  const presetId = mode === "light" ? settings.lightPresetId : settings.darkPresetId;
  return applySemanticOverrides(
    resolveThemePresetTokens(presetId, mode),
    settings.semanticOverrides,
    mode,
  );
}

function css(
  name: string,
  prefix: string,
  light: Readonly<Record<string, string>>,
  dark: Readonly<Record<string, string>>,
  typography: ReturnType<typeof resolveTypographyProjection> | undefined,
): string {
  const lines = [
    `/* ${name} — exported from Octant. */`,
    ":root {",
    ...declarations(prefix, light),
    ...(typography === undefined ? [] : typographyDeclarations(prefix, typography)),
    "}",
    "",
    "@media (prefers-color-scheme: dark) {",
    "  :root {",
    ...declarations(prefix, dark).map((line) => `  ${line}`),
    "  }",
    "}",
    "",
    `[data-theme="light"] {`,
    ...declarations(prefix, light),
    "}",
    "",
    `[data-theme="dark"] {`,
    ...declarations(prefix, dark),
    "}",
    "",
  ];
  return lines.join("\n");
}

/**
 * Every known role, in the order the theme defines them.
 *
 * Reading the role list rather than the resolved record keeps the two modes
 * shaped identically: a preset that omitted a role would otherwise export a
 * variable in one mode and not the other, which reads as a deliberate design
 * choice rather than a gap.
 */
function declarations(
  prefix: string,
  tokens: Readonly<Record<string, string>>,
): ReadonlyArray<string> {
  return THEME_TOKEN_ROLES.flatMap((role) => {
    const value = tokens[role.id];
    return value === undefined ? [] : [`  --${prefix}-${role.id}: ${value};`];
  });
}

function typographyDeclarations(
  prefix: string,
  typography: ReturnType<typeof resolveTypographyProjection>,
): ReadonlyArray<string> {
  return [
    `  --${prefix}-font-ui: ${typography.ui.fontFamily};`,
    `  --${prefix}-font-ui-size: ${String(typography.ui.fontSize)}px;`,
    `  --${prefix}-font-editor: ${typography.editor.fontFamily};`,
    `  --${prefix}-font-editor-size: ${String(typography.editor.fontSize)}px;`,
  ];
}
