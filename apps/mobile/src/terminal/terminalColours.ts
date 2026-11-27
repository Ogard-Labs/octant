import { contrastRatio, type TerminalPalette } from "@octant/theme";
import { xterm256Hex, type TerminalColour, type TerminalStyle } from "./terminalScreen";

const PALETTE_ORDER = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

function colourHex(colour: TerminalColour, palette: TerminalPalette): string {
  if (colour.kind === "rgb") return colour.hex;
  const name = PALETTE_ORDER[colour.index];
  return name === undefined ? xterm256Hex(colour.index) : palette[name];
}

/** The ink and fill a run is drawn in; the fill is absent where the terminal's own ground shows. */
export interface TerminalRunColours {
  readonly color: string;
  readonly backgroundColor?: string;
}

/**
 * A run's colours against the palette, with inverse applied. Output is body
 * text, and a program may print a 256-colour or true colour ink no palette
 * vouches for, so ink below `minimumContrast` against what it is drawn on is
 * swapped for the palette's foreground (or background, under inverse), as
 * the desktop terminal does; dim text gets half the floor.
 */
export function terminalRunColours(
  style: TerminalStyle,
  palette: TerminalPalette,
  minimumContrast: number,
): TerminalRunColours {
  let ink = style.fg === undefined ? palette.foreground : colourHex(style.fg, palette);
  let fill = style.bg === undefined ? undefined : colourHex(style.bg, palette);
  if (style.inverse === true) {
    const swappedInk = fill ?? palette.background;
    fill = ink;
    ink = swappedInk;
  }
  const ground = fill ?? palette.background;
  const floor = style.dim === true ? minimumContrast / 2 : minimumContrast;
  const ratio = safeContrast(ink, ground);
  if (ratio !== undefined && ratio < floor) {
    const fallback = style.inverse === true ? palette.background : palette.foreground;
    ink = (safeContrast(fallback, ground) ?? 0) >= ratio ? fallback : ink;
  }
  return fill === undefined ? { color: ink } : { color: ink, backgroundColor: fill };
}

/** A token that is not a plain hex colour is drawn as given, without the floor. */
function safeContrast(foreground: string, background: string): number | undefined {
  try {
    return contrastRatio(foreground, background);
  } catch {
    return undefined;
  }
}
