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
}

export function resolveEditorColorProjection(
  resolved: Pick<ResolvedTheme, "mode" | "tokens">,
): EditorColorProjection {
  const role = (id: string): string => resolved.tokens[id] ?? getDefaultToken(id, resolved.mode);
  return {
    mode: resolved.mode,
    background: role("workspace"),
    foreground: role("text-primary"),
    mutedForeground: role("text-muted"),
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
  };
}

/** What the renderer stylesheet paints before any theme is applied: dark. */
export const DEFAULT_EDITOR_COLORS: EditorColorProjection = resolveEditorColorProjection({
  mode: "dark",
  tokens: DEFAULT_DARK_TOKENS,
});
