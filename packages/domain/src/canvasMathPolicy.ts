/**
 * What a Canvas formula may say, and how every surface draws it.
 *
 * A formula is drawn, never run. KaTeX is the typesetter on the renderer and
 * in export, and the options below are the one place its behaviour is set:
 * `trust` off, so it refuses links, embedded images, and raw HTML attributes;
 * `strict` as an error, so non-standard input is refused rather than guessed
 * at; a bounded macro expansion; a fresh macro table per formula, so one
 * formula cannot leave a definition behind for the next; and a ceiling on
 * explicit sizes, so a rule or a space cannot cover the page.
 *
 * The scan below is for the author. KaTeX with `trust` off would already draw
 * a link as inert text, but a formula that needs one, defines a macro, or
 * picks its own colour would read wrong or step outside the theme, so it is
 * refused with the command named and the agent can rewrite it. Colour is
 * refused because a formula inherits the reading ink: a colour picked for a
 * light page disappears on a dark one, and forced colours would discard it.
 */

/** Commands a Canvas formula refuses, with what each would have done. */
const REFUSED_MATH_COMMANDS: ReadonlyMap<string, string> = new Map([
  // Definitions outlive the expression that made them and expand without the
  // reader seeing what they stand for.
  ...[
    "def",
    "gdef",
    "edef",
    "xdef",
    "let",
    "futurelet",
    "global",
    "long",
    "newcommand",
    "renewcommand",
    "providecommand",
  ].map((name) => [name, "defines a macro"] as const),
  // `trust` gates these; a formula has no business linking out or embedding.
  ...["href", "url", "includegraphics", "htmlClass", "htmlId", "htmlStyle", "htmlData"].map(
    (name) => [name, "links, embeds, or writes markup"] as const,
  ),
  ...["color", "textcolor", "colorbox", "fcolorbox"].map(
    (name) => [name, "sets its own colour"] as const,
  ),
]);

/**
 * Why a formula source is refused, or undefined when it may be drawn.
 *
 * Reads control sequences the way TeX tokenises them: a backslash followed by
 * letters names a command, and a backslash followed by anything else is a
 * one-character control symbol (`\\`, `\{`, `\%`) that never starts a name.
 * So `\\def` is a line break followed by the letters "def", not a definition.
 * A name holding `@` is an internal command a document author does not write.
 */
export function canvasMathSourceRefusal(source: string): string | undefined {
  let index = 0;
  while (index < source.length) {
    if (source[index] !== "\\") {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < source.length && /[A-Za-z@]/.test(source[end] ?? "")) end += 1;
    if (end === index + 1) {
      index += 2;
      continue;
    }
    const name = source.slice(index + 1, end);
    if (name.includes("@")) return `uses the internal command \\${name}.`;
    const reason = REFUSED_MATH_COMMANDS.get(name);
    if (reason !== undefined) return `uses \\${name}, which ${reason}.`;
    index = end;
  }
  return undefined;
}

/** How a surface draws a formula: interactive HTML with MathML, or MathML alone for export. */
export type CanvasMathOutput = "htmlAndMathml" | "mathml";

export interface CanvasMathRenderOptions {
  readonly displayMode: boolean;
  readonly output: CanvasMathOutput;
  readonly throwOnError: true;
  readonly trust: false;
  readonly strict: "error";
  readonly maxSize: number;
  readonly maxExpand: number;
  readonly macros: Record<string, string>;
}

// Explicit sizes are in em; twenty is several lines of display math and well
// past any real fraction or matrix.
const CANVAS_MATH_MAX_SIZE_EM = 20;
// Built-in macros expand a handful of times each; a formula that needs more
// than this many expansions is either broken or built to blow up.
const CANVAS_MATH_MAX_EXPAND = 200;

/**
 * The typesetter options every surface passes. A new object each call, so the
 * macro table KaTeX writes into can never carry a definition between formulas.
 * Errors throw so the caller draws its own fallback with the source as text,
 * rather than KaTeX's inline error colour.
 */
export function canvasMathRenderOptions(
  displayMode: boolean,
  output: CanvasMathOutput,
): CanvasMathRenderOptions {
  return {
    displayMode,
    output,
    throwOnError: true,
    trust: false,
    strict: "error",
    maxSize: CANVAS_MATH_MAX_SIZE_EM,
    maxExpand: CANVAS_MATH_MAX_EXPAND,
    macros: {},
  };
}
