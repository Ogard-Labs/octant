import { MINIMUM_CONTRAST } from "./contrast";
import { INCREASED_CONTRAST_TEXT } from "./editorColors";
import type { ResolvedTheme } from "./fallback";
import { DEFAULT_DARK_TOKENS, getDefaultToken } from "./tokens";

/** The cell colours a terminal draws with, keyed the way terminal engines name them. */
export interface TerminalPalette {
  readonly background: string;
  readonly foreground: string;
  readonly cursor: string;
  readonly cursorAccent: string;
  readonly selectionBackground: string;
  readonly black: string;
  readonly red: string;
  readonly green: string;
  readonly yellow: string;
  readonly blue: string;
  readonly magenta: string;
  readonly cyan: string;
  readonly white: string;
  readonly brightBlack: string;
  readonly brightRed: string;
  readonly brightGreen: string;
  readonly brightYellow: string;
  readonly brightBlue: string;
  readonly brightMagenta: string;
  readonly brightCyan: string;
  readonly brightWhite: string;
}

/**
 * The colours a terminal draws with, taken from the resolved theme so its
 * output reads as part of the workspace and follows a live theme or contrast
 * change. The terminal used to read the stylesheet once at mount, so an open
 * terminal kept the old mode's colours after a switch (observed in rendered
 * QA).
 *
 * `minimumContrastRatio` is the floor every cell's ink is lifted to against
 * the background it is actually drawn on. The palette roles are accepted at
 * 3:1 as interface marks, but terminal output is body text, and programs
 * also print 256-colour and true-colour ink no palette can vouch for; the
 * terminal engine checks each cell at paint time, including on the Glass
 * plate and under reverse video, and gives dim text half the floor.
 */
export interface TerminalColorProjection {
  readonly palette: TerminalPalette;
  readonly minimumContrastRatio: number;
}

/** WCAG's enhanced (AAA) ratio for body text, the floor increased contrast asks for. */
const INCREASED_CONTRAST_TEXT_RATIO = 7;

export function resolveTerminalColorProjection(
  resolved: Pick<ResolvedTheme, "mode" | "tokens">,
  options: { readonly increasedContrast?: boolean } = {},
): TerminalColorProjection {
  const role = (id: string): string => resolved.tokens[id] ?? getDefaultToken(id, resolved.mode);
  const increased = options.increasedContrast === true;
  // The same ink the stylesheet swaps in for the rest of the window.
  const ink = increased ? INCREASED_CONTRAST_TEXT[resolved.mode].foreground : role("text-primary");
  const muted = increased
    ? INCREASED_CONTRAST_TEXT[resolved.mode].mutedForeground
    : role("text-muted");
  const ground = role("workspace");
  // Resolved roles flip with the mode, but ANSI black must stay dark and
  // white light in either mode, so the pair maps to whichever of ink and
  // page is which under the resolved mode.
  const page = role("app-background");
  const black = resolved.mode === "dark" ? page : ink;
  const white = resolved.mode === "dark" ? ink : page;
  const red = role("palette-red");
  const green = role("palette-green");
  const yellow = role("palette-yellow");
  const blue = role("palette-blue");
  const magenta = role("palette-purple");
  const cyan = role("palette-teal");
  return {
    palette: {
      background: ground,
      foreground: ink,
      cursor: ink,
      cursorAccent: ground,
      selectionBackground: role("selection"),
      black,
      red,
      green,
      yellow,
      blue,
      magenta,
      cyan,
      white,
      // The theme publishes one hue per family and no bright set, so the
      // bright variants reuse the same roles; bright black is the muted ink
      // so dim output stays readable instead of vanishing into the ground.
      brightBlack: muted,
      brightRed: red,
      brightGreen: green,
      brightYellow: yellow,
      brightBlue: blue,
      brightMagenta: magenta,
      brightCyan: cyan,
      brightWhite: white,
    },
    minimumContrastRatio: increased
      ? INCREASED_CONTRAST_TEXT_RATIO
      : MINIMUM_CONTRAST["normal-text"],
  };
}

/** What the renderer stylesheet paints before any theme is applied: dark. */
export const DEFAULT_TERMINAL_COLORS: TerminalColorProjection = resolveTerminalColorProjection({
  mode: "dark",
  tokens: DEFAULT_DARK_TOKENS,
});
