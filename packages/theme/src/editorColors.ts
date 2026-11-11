import type { ResolvedTheme } from "./fallback";
import { DEFAULT_DARK_TOKENS, getDefaultToken } from "./tokens";

/**
 * The colors a code editor draws with, taken from the resolved theme so the
 * editor body reads as part of the workspace it sits in. The editor body was
 * a fixed dark theme that stayed dark inside the light app (observed in
 * rendered QA). Syntax colors are left to the editor's own light or dark
 * base: the palette roles are only checked for interface contrast, which is
 * too low for body text.
 */
export interface EditorColorProjection {
  readonly mode: "light" | "dark";
  readonly background: string;
  readonly foreground: string;
  readonly mutedForeground: string;
  readonly selection: string;
  readonly lineHighlightBorder: string;
  readonly widgetBackground: string;
  readonly widgetBorder: string;
  readonly indentGuide: string;
  readonly activeIndentGuide: string;
  readonly focusBorder: string;
  readonly error: string;
  readonly inserted: string;
  readonly removed: string;
  /**
   * The editor draws its scrollbar as elements of its own, out of reach of
   * the stylesheet's one scrollbar rule, so the thumb's colour travels here:
   * the role that rule names, and the one it names for a thumb under the
   * pointer.
   */
  readonly scrollbarThumb: string;
  readonly scrollbarThumbHover: string;
}

/**
 * The ink the renderer stylesheet swaps in under increased contrast, whatever
 * the theme's own text roles say; its `--octant-text-*-high-contrast` values
 * mirror these. The editor and the terminal draw it; without it the editor
 * was the one surface that ignored the setting.
 */
export const INCREASED_CONTRAST_TEXT: Readonly<
  Record<"light" | "dark", Pick<EditorColorProjection, "foreground" | "mutedForeground">>
> = {
  light: { foreground: "#0e0f11", mutedForeground: "#565656" },
  dark: { foreground: "#ffffff", mutedForeground: "#a5a4a0" },
};

export function resolveEditorColorProjection(
  resolved: Pick<ResolvedTheme, "mode" | "tokens">,
  options: { readonly increasedContrast?: boolean } = {},
): EditorColorProjection {
  const role = (id: string): string => resolved.tokens[id] ?? getDefaultToken(id, resolved.mode);
  const ink =
    options.increasedContrast === true
      ? INCREASED_CONTRAST_TEXT[resolved.mode]
      : { foreground: role("text-primary"), mutedForeground: role("text-muted") };
  return {
    mode: resolved.mode,
    background: role("workspace"),
    ...ink,
    selection: role("selection"),
    lineHighlightBorder: role("border"),
    widgetBackground: role("floating"),
    widgetBorder: role("border"),
    indentGuide: role("border"),
    activeIndentGuide: role("border-strong"),
    focusBorder: role("focus-ring"),
    error: role("danger-text"),
    inserted: role("addition-text"),
    removed: role("deletion-text"),
    scrollbarThumb: role("border-strong"),
    scrollbarThumbHover: role("divider-strong"),
  };
}

/** What the renderer stylesheet paints before any theme is applied: dark. */
export const DEFAULT_EDITOR_COLORS: EditorColorProjection = resolveEditorColorProjection({
  mode: "dark",
  tokens: DEFAULT_DARK_TOKENS,
});
