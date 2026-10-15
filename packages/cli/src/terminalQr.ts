import { generate } from "lean-qr";

/** The quiet zone the QR specification asks for around the symbol, in modules. */
const QUIET_ZONE = 4;
/** Black glyphs on a white ground, so a dark terminal theme does not invert the symbol. */
const DARK_ON_LIGHT = "\u001b[30;107m";
const RESET = "\u001b[0m";

/**
 * Draws `text` as a QR symbol with half-block characters, two module rows per
 * line, so it fits an 80-column terminal. A dark module is the glyph's
 * foreground. With `color`, each line sets black on white itself, because a
 * scanner reads an inverted symbol unreliably; without it (output piped to a
 * file), the lines are plain and assume dark text on a light page.
 */
export function renderTerminalQr(text: string, options: { readonly color: boolean }): string {
  const symbol = generate(text);
  const extent = symbol.size + QUIET_ZONE * 2;
  const dark = (x: number, y: number): boolean => {
    const column = x - QUIET_ZONE;
    const row = y - QUIET_ZONE;
    return (
      column >= 0 &&
      row >= 0 &&
      column < symbol.size &&
      row < symbol.size &&
      symbol.get(column, row)
    );
  };
  const lines: string[] = [];
  for (let y = 0; y < extent; y += 2) {
    let line = "";
    for (let x = 0; x < extent; x += 1) {
      const top = dark(x, y);
      const bottom = dark(x, y + 1);
      line += top ? (bottom ? "█" : "▀") : bottom ? "▄" : " ";
    }
    lines.push(options.color ? `${DARK_ON_LIGHT}${line}${RESET}` : line);
  }
  return `${lines.join("\n")}\n`;
}
