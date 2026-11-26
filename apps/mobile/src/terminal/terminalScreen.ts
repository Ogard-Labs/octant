/**
 * The phone's own terminal: the screen a shell draws on, worked out from the
 * raw output the host relays (`read-output`), escape sequences included. It is
 * written here rather than taken from a terminal library: the Swift one builds
 * through a package plugin every app build would have to trust, and the
 * Android one is compiled by a newer Kotlin than the app's (checked
 * 2026-11-26). One model serves iOS, Android and the development mock, and the
 * screens draw it with the system's own text.
 *
 * It covers what a login shell and the common full-screen programs use: the
 * C0 controls, cursor movement and erasing, insert and delete, scroll regions,
 * the alternate screen, 16, 256 and true colours with bold, dim, italic,
 * underline and inverse, wide and combining characters, tab stops, and the
 * status and attribute reports a program may ask for. Titles, links and other
 * operating-system commands are read and dropped.
 */

export type TerminalColour =
  | { readonly kind: "palette"; readonly index: number }
  | { readonly kind: "rgb"; readonly hex: string };

export interface TerminalStyle {
  readonly fg?: TerminalColour;
  readonly bg?: TerminalColour;
  readonly bold?: boolean;
  readonly dim?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly inverse?: boolean;
}

const PLAIN: TerminalStyle = {};

interface Cell {
  /** The character with any combining marks; empty after a wide character. */
  text: string;
  /** 0 is the second half of a wide character. */
  width: 0 | 1 | 2;
  style: TerminalStyle;
}

interface Line {
  readonly id: number;
  cells: Cell[];
  /** Raised on every change, so a drawn row knows to draw again. */
  version: number;
}

/** One drawn row: runs of text that share a style. */
export interface TerminalRun {
  readonly text: string;
  readonly style: TerminalStyle;
}

export interface TerminalRow {
  readonly id: number;
  readonly version: number;
  readonly runs: ReadonlyArray<TerminalRun>;
}

/** What the keys on the phone send, which a program can switch (`DECCKM`, bracketed paste). */
export interface TerminalInputModes {
  readonly applicationCursorKeys: boolean;
  readonly bracketedPaste: boolean;
}

export interface TerminalSnapshot {
  /** Scrollback first, then the screen; the screen is the last `rows` rows. */
  readonly rows: ReadonlyArray<TerminalRow>;
  /** The cursor as a row index into `rows` and a column, when it is shown. */
  readonly cursor?: { readonly row: number; readonly column: number };
  readonly modes: TerminalInputModes;
}

/** How much a shell may scroll off the top before the oldest lines go. */
export const TERMINAL_SCROLLBACK_LINES = 2_000;

/** Bounds a parameter a stray sequence could set to millions. */
const MAX_PARAMETER = 10_000;

type ParserState =
  | "ground"
  | "escape"
  | "csi"
  | "osc"
  | "osc-escape"
  | "charset"
  | "dcs"
  | "dcs-escape";

let nextLineId = 1;

function blankCell(style: TerminalStyle): Cell {
  // Erased cells keep only the background, as terminals do.
  return { text: " ", width: 1, style: style.bg === undefined ? PLAIN : { bg: style.bg } };
}

function blankLine(columns: number, style: TerminalStyle = PLAIN): Line {
  return {
    id: nextLineId++,
    cells: Array.from({ length: columns }, () => blankCell(style)),
    version: 0,
  };
}

function isCombining(code: number): boolean {
  return (
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x1dc0 && code <= 0x1dff) ||
    (code >= 0x20d0 && code <= 0x20ff) ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    (code >= 0xfe20 && code <= 0xfe2f) ||
    code === 0x200d ||
    (code >= 0xe0100 && code <= 0xe01ef)
  );
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

function sameColour(a: TerminalColour | undefined, b: TerminalColour | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.kind === "palette") return b.kind === "palette" && a.index === b.index;
  return b.kind === "rgb" && a.hex === b.hex;
}

function sameStyle(a: TerminalStyle, b: TerminalStyle): boolean {
  return (
    a === b ||
    (sameColour(a.fg, b.fg) &&
      sameColour(a.bg, b.bg) &&
      a.bold === b.bold &&
      a.dim === b.dim &&
      a.italic === b.italic &&
      a.underline === b.underline &&
      a.inverse === b.inverse)
  );
}

function hexByte(value: number): string {
  return Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0");
}

/** The 256-colour cube and grey ramp past the 16 the theme names. */
export function xterm256Hex(index: number): string {
  if (index >= 232) {
    const level = 8 + (index - 232) * 10;
    return `#${hexByte(level)}${hexByte(level)}${hexByte(level)}`;
  }
  const cube = index - 16;
  const step = (value: number) => (value === 0 ? 0 : 55 + value * 40);
  return `#${hexByte(step(Math.floor(cube / 36)))}${hexByte(step(Math.floor(cube / 6) % 6))}${hexByte(step(cube % 6))}`;
}

export class TerminalScreen {
  #columns: number;
  #rows: number;
  #normal: Line[];
  #alternate: Line[] | undefined;
  #scrollback: Line[] = [];
  #x = 0;
  #y = 0;
  /** Set after writing the last column: the next character wraps first. */
  #pendingWrap = false;
  #style: TerminalStyle = PLAIN;
  #saved: { x: number; y: number; style: TerminalStyle } | undefined;
  #savedNormal: { x: number; y: number; style: TerminalStyle } | undefined;
  /**
   * The shell screen's cursor row while a program has the alternate screen,
   * however it got there, so a resize meanwhile keeps the prompt's line.
   */
  #normalCursorY = 0;
  #top = 0;
  #bottom: number;
  #tabStops = new Set<number>();
  #autowrap = true;
  #originMode = false;
  #insertMode = false;
  #cursorVisible = true;
  #applicationCursorKeys = false;
  #bracketedPaste = false;
  #state: ParserState = "ground";
  #parameters = "";
  #intermediates = "";
  #private = "";
  readonly #reply: (data: string) => void;
  readonly #drawnRows = new WeakMap<Line, TerminalRow>();

  constructor(columns: number, rows: number, reply: (data: string) => void = () => undefined) {
    this.#columns = Math.max(2, columns);
    this.#rows = Math.max(2, rows);
    this.#bottom = this.#rows - 1;
    this.#normal = Array.from({ length: this.#rows }, () => blankLine(this.#columns));
    this.#resetTabStops();
    this.#reply = reply;
  }

  get columns(): number {
    return this.#columns;
  }

  get rows(): number {
    return this.#rows;
  }

  get #lines(): Line[] {
    return this.#alternate ?? this.#normal;
  }

  /** Back to a fresh screen, as when the host's kept output no longer reaches back far enough. */
  reset(): void {
    this.#normal = Array.from({ length: this.#rows }, () => blankLine(this.#columns));
    this.#alternate = undefined;
    this.#scrollback = [];
    this.#x = 0;
    this.#y = 0;
    this.#pendingWrap = false;
    this.#style = PLAIN;
    this.#saved = undefined;
    this.#savedNormal = undefined;
    this.#top = 0;
    this.#bottom = this.#rows - 1;
    this.#autowrap = true;
    this.#originMode = false;
    this.#insertMode = false;
    this.#cursorVisible = true;
    this.#applicationCursorKeys = false;
    this.#bracketedPaste = false;
    this.#state = "ground";
    this.#resetTabStops();
  }

  resize(columns: number, rows: number): void {
    const width = Math.max(2, columns);
    const height = Math.max(2, rows);
    if (width === this.#columns && height === this.#rows) return;
    const onAlternate = this.#alternate !== undefined;
    const normal = this.#fit(
      this.#normal,
      width,
      height,
      onAlternate ? this.#normalCursorY : this.#y,
      true,
    );
    this.#normal = normal.lines;
    if (this.#alternate !== undefined) {
      const alternate = this.#fit(this.#alternate, width, height, this.#y, false);
      this.#alternate = alternate.lines;
      this.#y = alternate.cursorY;
      this.#normalCursorY = normal.cursorY;
      if (this.#savedNormal !== undefined) {
        this.#savedNormal = {
          ...this.#savedNormal,
          x: Math.min(this.#savedNormal.x, width - 1),
          y: normal.cursorY,
        };
      }
    } else {
      this.#y = normal.cursorY;
    }
    this.#columns = width;
    this.#rows = height;
    this.#top = 0;
    this.#bottom = height - 1;
    this.#x = Math.min(this.#x, width - 1);
    this.#y = Math.min(this.#y, height - 1);
    this.#saved = undefined;
    this.#pendingWrap = false;
    this.#resetTabStops();
  }

  /**
   * One screen at a new size. Lines are cut or padded, not rewrapped. With
   * fewer rows the rows below the cursor go first, then the top rows, into
   * scrollback on the normal screen, so the cursor's line stays on screen.
   */
  #fit(
    lines: ReadonlyArray<Line>,
    width: number,
    height: number,
    cursorY: number,
    intoScrollback: boolean,
  ): { readonly lines: Line[]; readonly cursorY: number } {
    for (const line of lines) {
      if (line.cells.length > width) {
        line.cells.length = width;
        // A wide character cut in half leaves a blank.
        if (line.cells[width - 1]?.width === 2) line.cells[width - 1] = blankCell(PLAIN);
      }
      while (line.cells.length < width) line.cells.push(blankCell(PLAIN));
      line.version += 1;
    }
    const fitted = [...lines];
    // The rows below the cursor go first; a shell has drawn nothing there.
    if (fitted.length > height) fitted.length = Math.max(height, cursorY + 1);
    let y = cursorY;
    while (fitted.length > height) {
      const removed = fitted.shift();
      if (removed !== undefined && intoScrollback) this.#pushScrollback(removed);
      y -= 1;
    }
    while (fitted.length < height) fitted.push(blankLine(width));
    return { lines: fitted, cursorY: Math.min(y, height - 1) };
  }

  write(data: string): void {
    for (const character of data) {
      const code = character.codePointAt(0) ?? 0;
      switch (this.#state) {
        case "ground":
          this.#ground(character, code);
          break;
        case "escape":
          this.#escape(character);
          break;
        case "csi":
          this.#csi(character, code);
          break;
        case "osc":
          if (code === 0x07) this.#state = "ground";
          else if (code === 0x1b) this.#state = "osc-escape";
          break;
        case "osc-escape":
          // ESC \ ends it; anything else was a new sequence.
          this.#state = character === "\\" ? "ground" : "escape";
          if (this.#state === "escape") this.#escape(character);
          break;
        case "dcs":
          if (code === 0x1b) this.#state = "dcs-escape";
          break;
        case "dcs-escape":
          this.#state = character === "\\" ? "ground" : "dcs";
          break;
        case "charset":
          // Line drawing and national sets are not drawn differently here.
          this.#state = "ground";
          break;
      }
    }
  }

  /** What the shell scrolled away and the screen, as rows of styled runs. */
  snapshot(): TerminalSnapshot {
    const lines =
      this.#alternate === undefined ? [...this.#scrollback, ...this.#normal] : this.#alternate;
    const screenStart = lines.length - this.#rows;
    return {
      rows: lines.map((line) => this.#row(line)),
      ...(this.#cursorVisible ? { cursor: { row: screenStart + this.#y, column: this.#x } } : {}),
      modes: {
        applicationCursorKeys: this.#applicationCursorKeys,
        bracketedPaste: this.#bracketedPaste,
      },
    };
  }

  /** A line's drawn row, rebuilt only when the line changed since it was last drawn. */
  #row(line: Line): TerminalRow {
    const cached = this.#drawnRows.get(line);
    if (cached !== undefined && cached.version === line.version) return cached;
    const row = { id: line.id, version: line.version, runs: lineRuns(line) };
    this.#drawnRows.set(line, row);
    return row;
  }

  /** The screen's text, one string per row with trailing spaces dropped. For tests and VoiceOver. */
  screenText(): ReadonlyArray<string> {
    return this.#lines.map((line) =>
      line.cells
        .map((cell) => cell.text)
        .join("")
        .replace(/\s+$/, ""),
    );
  }

  #resetTabStops(): void {
    this.#tabStops = new Set();
    for (let column = 8; column < this.#columns; column += 8) this.#tabStops.add(column);
  }

  #ground(character: string, code: number): void {
    if (code === 0x1b) {
      this.#state = "escape";
      return;
    }
    if (code < 0x20 || code === 0x7f) {
      this.#control(code);
      return;
    }
    if (code >= 0x80 && code < 0xa0) return;
    this.#print(character, code);
  }

  #control(code: number): void {
    switch (code) {
      case 0x08:
        this.#pendingWrap = false;
        this.#x = Math.max(0, this.#x - 1);
        break;
      case 0x09: {
        this.#pendingWrap = false;
        let column = this.#x + 1;
        while (column < this.#columns - 1 && !this.#tabStops.has(column)) column += 1;
        this.#x = Math.min(column, this.#columns - 1);
        break;
      }
      case 0x0a:
      case 0x0b:
      case 0x0c:
        this.#lineFeed();
        break;
      case 0x0d:
        this.#pendingWrap = false;
        this.#x = 0;
        break;
      default:
        // BEL, SO, SI and the rest have nothing to draw.
        break;
    }
  }

  #print(character: string, code: number): void {
    const line = this.#lines[this.#y];
    if (line === undefined) return;
    if (isCombining(code)) {
      // A mark joins the character before it.
      const column = this.#pendingWrap ? this.#x : this.#x - 1;
      let target = line.cells[column];
      if (target !== undefined && target.width === 0) target = line.cells[column - 1];
      if (target !== undefined) {
        target.text += character;
        line.version += 1;
      }
      return;
    }
    const width = isWide(code) ? 2 : 1;
    if (this.#pendingWrap) {
      this.#pendingWrap = false;
      if (this.#autowrap) {
        this.#x = 0;
        this.#lineFeed();
      }
    }
    if (width === 2 && this.#x === this.#columns - 1) {
      // No room for both halves: wrap first, as a terminal does.
      this.#writeCell(this.#x, { text: " ", width: 1, style: this.#style });
      const edge = this.#lines[this.#y];
      if (edge !== undefined) repairWide(edge, this.#x, this.#x + 1);
      if (!this.#autowrap) return;
      this.#x = 0;
      this.#lineFeed();
    }
    const target = this.#lines[this.#y];
    if (target === undefined) return;
    if (this.#insertMode) {
      target.cells.splice(this.#x, 0, ...Array.from({ length: width }, () => blankCell(PLAIN)));
      target.cells.length = this.#columns;
      repairWide(target, 0, this.#columns);
    }
    this.#writeCell(this.#x, { text: character, width, style: this.#style });
    if (width === 2 && this.#x + 1 < this.#columns) {
      this.#writeCell(this.#x + 1, { text: "", width: 0, style: this.#style });
    }
    repairWide(target, this.#x, this.#x + width);
    if (this.#x + width >= this.#columns) {
      this.#x = this.#columns - 1;
      this.#pendingWrap = true;
    } else {
      this.#x += width;
    }
  }

  /** Sets one cell; the caller repairs any wide character it cut in half (`repairWide`). */
  #writeCell(column: number, cell: Cell): void {
    const line = this.#lines[this.#y];
    if (line === undefined) return;
    line.cells[column] = cell;
    line.version += 1;
  }

  #lineFeed(): void {
    this.#pendingWrap = false;
    if (this.#y === this.#bottom) this.#scrollUp(1);
    else if (this.#y < this.#rows - 1) this.#y += 1;
  }

  #pushScrollback(line: Line): void {
    this.#scrollback.push(line);
    if (this.#scrollback.length > TERMINAL_SCROLLBACK_LINES) this.#scrollback.shift();
  }

  #scrollUp(count: number): void {
    const lines = this.#lines;
    for (let step = 0; step < Math.min(count, this.#bottom - this.#top + 1); step += 1) {
      const [removed] = lines.splice(this.#top, 1);
      // Only a whole-screen scroll on the normal screen keeps what left the top.
      if (removed !== undefined && this.#alternate === undefined && this.#top === 0) {
        this.#pushScrollback(removed);
      }
      lines.splice(this.#bottom, 0, blankLine(this.#columns, this.#style));
    }
  }

  #scrollDown(count: number): void {
    const lines = this.#lines;
    for (let step = 0; step < Math.min(count, this.#bottom - this.#top + 1); step += 1) {
      lines.splice(this.#bottom, 1);
      lines.splice(this.#top, 0, blankLine(this.#columns, this.#style));
    }
  }

  #escape(character: string): void {
    this.#state = "ground";
    switch (character) {
      case "[":
        this.#state = "csi";
        this.#parameters = "";
        this.#intermediates = "";
        this.#private = "";
        break;
      case "]":
        this.#state = "osc";
        break;
      case "P":
      case "X":
      case "^":
      case "_":
        this.#state = "dcs";
        break;
      case "(":
      case ")":
      case "*":
      case "+":
        this.#state = "charset";
        break;
      case "7":
        this.#saveCursor();
        break;
      case "8":
        this.#restoreCursor();
        break;
      case "D":
        this.#lineFeed();
        break;
      case "E":
        this.#x = 0;
        this.#lineFeed();
        break;
      case "M":
        this.#pendingWrap = false;
        if (this.#y === this.#top) this.#scrollDown(1);
        else this.#y = Math.max(0, this.#y - 1);
        break;
      case "H":
        this.#tabStops.add(this.#x);
        break;
      case "c":
        this.reset();
        break;
      case "=":
      case ">":
        // Keypad modes change nothing the phone's keys send.
        break;
      default:
        break;
    }
  }

  #csi(character: string, code: number): void {
    // A new escape abandons the sequence; a control character inside one is
    // carried out and the sequence goes on, as terminals do.
    if (code === 0x1b) {
      this.#state = "escape";
      return;
    }
    if (code < 0x20) {
      this.#control(code);
      return;
    }
    if (code >= 0x30 && code <= 0x3f) {
      if (this.#parameters.length === 0 && "?>=<".includes(character)) this.#private = character;
      else if (this.#parameters.length < 64) this.#parameters += character;
      return;
    }
    if (code >= 0x20 && code <= 0x2f) {
      this.#intermediates += character;
      return;
    }
    this.#state = "ground";
    if (code < 0x40 || code > 0x7e) return;
    this.#dispatch(character);
  }

  /** Each parameter with its colon sub-parameters (`4:3`, `38:2::r:g:b`); an empty one is 0. */
  #groups(): number[][] {
    if (this.#parameters.length === 0) return [];
    return this.#parameters.split(";").map((part) =>
      part.split(":").map((piece) => {
        const value = Number.parseInt(piece, 10);
        return Number.isFinite(value) ? Math.min(value, MAX_PARAMETER) : 0;
      }),
    );
  }

  #numbers(): number[] {
    return this.#groups().map((group) => group[0] ?? 0);
  }

  #dispatch(final: string): void {
    const numbers = this.#numbers();
    const first = (fallback: number) => {
      const value = numbers[0];
      return value === undefined || value === 0 ? fallback : value;
    };
    if (this.#intermediates.length > 0) {
      // DECSCUSR (cursor shape) and the like change nothing drawn here.
      return;
    }
    if (this.#private === "?") {
      if (final === "h" || final === "l") this.#privateMode(numbers, final === "h");
      return;
    }
    if (this.#private === ">" || this.#private === "=") {
      if (final === "c") this.#reply("\u001b[>0;0;0c");
      return;
    }
    switch (final) {
      case "@":
        this.#insertBlanks(first(1));
        break;
      case "A":
        this.#moveTo(this.#x, Math.max(this.#y - first(1), this.#y >= this.#top ? this.#top : 0));
        break;
      case "B":
      case "e":
        this.#moveTo(
          this.#x,
          Math.min(this.#y + first(1), this.#y <= this.#bottom ? this.#bottom : this.#rows - 1),
        );
        break;
      case "C":
      case "a":
        this.#moveTo(this.#x + first(1), this.#y);
        break;
      case "D":
        this.#moveTo(this.#x - first(1), this.#y);
        break;
      case "E":
        this.#moveTo(0, Math.min(this.#y + first(1), this.#bottom));
        break;
      case "F":
        this.#moveTo(0, Math.max(this.#y - first(1), this.#top));
        break;
      case "G":
      case "`":
        this.#moveTo(first(1) - 1, this.#y);
        break;
      case "H":
      case "f": {
        const row = first(1) - 1;
        const column = (numbers[1] === undefined || numbers[1] === 0 ? 1 : numbers[1]) - 1;
        this.#moveTo(column, this.#originMode ? row + this.#top : row);
        break;
      }
      case "d":
        this.#moveTo(this.#x, (this.#originMode ? this.#top : 0) + first(1) - 1);
        break;
      case "I":
        for (let tab = 0; tab < first(1); tab += 1) this.#control(0x09);
        break;
      case "J":
        this.#eraseDisplay(numbers[0] ?? 0);
        break;
      case "K":
        this.#eraseLine(numbers[0] ?? 0);
        break;
      case "L":
        this.#insertLines(first(1));
        break;
      case "M":
        this.#deleteLines(first(1));
        break;
      case "P":
        this.#deleteCharacters(first(1));
        break;
      case "X":
        this.#eraseCharacters(first(1));
        break;
      case "S":
        this.#scrollUp(first(1));
        break;
      case "T":
        this.#scrollDown(first(1));
        break;
      case "g":
        if ((numbers[0] ?? 0) === 3) this.#tabStops.clear();
        else this.#tabStops.delete(this.#x);
        break;
      case "h":
      case "l":
        if (numbers.includes(4)) this.#insertMode = final === "h";
        break;
      case "m":
        this.#selectGraphicRendition(this.#groups());
        break;
      case "n":
        if (numbers[0] === 5) this.#reply("\u001b[0n");
        if (numbers[0] === 6) {
          const row = this.#originMode ? this.#y - this.#top : this.#y;
          this.#reply(`\u001b[${String(row + 1)};${String(this.#x + 1)}R`);
        }
        break;
      case "c":
        this.#reply("\u001b[?1;2c");
        break;
      case "r": {
        const top = first(1) - 1;
        const bottom = (numbers[1] === undefined || numbers[1] === 0 ? this.#rows : numbers[1]) - 1;
        if (top < bottom && bottom < this.#rows) {
          this.#top = top;
          this.#bottom = bottom;
          this.#moveTo(0, this.#originMode ? top : 0);
        }
        break;
      }
      case "s":
        this.#saveCursor();
        break;
      case "u":
        this.#restoreCursor();
        break;
      case "t":
        // Window reports and moves have no window to act on.
        break;
      default:
        break;
    }
  }

  #privateMode(numbers: ReadonlyArray<number>, on: boolean): void {
    for (const mode of numbers) {
      switch (mode) {
        case 1:
          this.#applicationCursorKeys = on;
          break;
        case 6:
          this.#originMode = on;
          this.#moveTo(0, on ? this.#top : 0);
          break;
        case 7:
          this.#autowrap = on;
          break;
        case 25:
          this.#cursorVisible = on;
          break;
        case 47:
        case 1047:
        case 1049:
          this.#alternateScreen(on, mode === 1049);
          break;
        case 1048:
          if (on) this.#saveCursor();
          else this.#restoreCursor();
          break;
        case 2004:
          this.#bracketedPaste = on;
          break;
        default:
          break;
      }
    }
  }

  #alternateScreen(on: boolean, saveCursor: boolean): void {
    if (on === (this.#alternate !== undefined)) return;
    if (on) {
      this.#normalCursorY = this.#y;
      this.#savedNormal = saveCursor ? { x: this.#x, y: this.#y, style: this.#style } : undefined;
      this.#alternate = Array.from({ length: this.#rows }, () => blankLine(this.#columns));
    } else {
      this.#alternate = undefined;
      for (const line of this.#normal) line.version += 1;
      if (saveCursor && this.#savedNormal !== undefined) {
        this.#x = this.#savedNormal.x;
        this.#y = this.#savedNormal.y;
        this.#style = this.#savedNormal.style;
      }
      this.#savedNormal = undefined;
      // The screen may have changed size since the cursor was kept.
      this.#x = Math.min(this.#x, this.#columns - 1);
      this.#y = Math.min(this.#y, this.#rows - 1);
    }
    this.#top = 0;
    this.#bottom = this.#rows - 1;
    this.#pendingWrap = false;
  }

  #moveTo(x: number, y: number): void {
    this.#pendingWrap = false;
    this.#x = Math.max(0, Math.min(this.#columns - 1, x));
    const lowest = this.#originMode ? this.#top : 0;
    const highest = this.#originMode ? this.#bottom : this.#rows - 1;
    this.#y = Math.max(lowest, Math.min(highest, y));
  }

  #saveCursor(): void {
    this.#saved = { x: this.#x, y: this.#y, style: this.#style };
  }

  #restoreCursor(): void {
    if (this.#saved === undefined) {
      this.#moveTo(0, 0);
      return;
    }
    this.#x = Math.min(this.#saved.x, this.#columns - 1);
    this.#y = Math.min(this.#saved.y, this.#rows - 1);
    this.#style = this.#saved.style;
    this.#pendingWrap = false;
  }

  #eraseCells(line: Line | undefined, from: number, to: number): void {
    if (line === undefined) return;
    for (let column = Math.max(0, from); column < Math.min(to, this.#columns); column += 1) {
      line.cells[column] = blankCell(this.#style);
    }
    repairWide(line, from, to);
    line.version += 1;
  }

  #eraseDisplay(mode: number): void {
    const lines = this.#lines;
    if (mode === 0) {
      this.#eraseCells(lines[this.#y], this.#x, this.#columns);
      for (let row = this.#y + 1; row < this.#rows; row += 1)
        this.#eraseCells(lines[row], 0, this.#columns);
    } else if (mode === 1) {
      this.#eraseCells(lines[this.#y], 0, this.#x + 1);
      for (let row = 0; row < this.#y; row += 1) this.#eraseCells(lines[row], 0, this.#columns);
    } else if (mode === 2) {
      for (const line of lines) this.#eraseCells(line, 0, this.#columns);
    } else if (mode === 3 && this.#alternate === undefined) {
      this.#scrollback = [];
    }
  }

  #eraseLine(mode: number): void {
    const line = this.#lines[this.#y];
    if (mode === 0) this.#eraseCells(line, this.#x, this.#columns);
    else if (mode === 1) this.#eraseCells(line, 0, this.#x + 1);
    else if (mode === 2) this.#eraseCells(line, 0, this.#columns);
  }

  #eraseCharacters(count: number): void {
    this.#eraseCells(this.#lines[this.#y], this.#x, this.#x + count);
  }

  #insertBlanks(count: number): void {
    const line = this.#lines[this.#y];
    if (line === undefined) return;
    line.cells.splice(
      this.#x,
      0,
      ...Array.from({ length: Math.min(count, this.#columns) }, () => blankCell(this.#style)),
    );
    line.cells.length = this.#columns;
    repairWide(line, 0, this.#columns);
    line.version += 1;
  }

  #deleteCharacters(count: number): void {
    const line = this.#lines[this.#y];
    if (line === undefined) return;
    const removed = Math.min(count, this.#columns - this.#x);
    line.cells.splice(this.#x, removed);
    for (let step = 0; step < removed; step += 1) line.cells.push(blankCell(this.#style));
    repairWide(line, 0, this.#columns);
    line.version += 1;
  }

  #insertLines(count: number): void {
    if (this.#y < this.#top || this.#y > this.#bottom) return;
    const lines = this.#lines;
    for (let step = 0; step < Math.min(count, this.#bottom - this.#y + 1); step += 1) {
      lines.splice(this.#bottom, 1);
      lines.splice(this.#y, 0, blankLine(this.#columns, this.#style));
    }
    this.#x = 0;
  }

  #deleteLines(count: number): void {
    if (this.#y < this.#top || this.#y > this.#bottom) return;
    const lines = this.#lines;
    for (let step = 0; step < Math.min(count, this.#bottom - this.#y + 1); step += 1) {
      lines.splice(this.#y, 1);
      lines.splice(this.#bottom, 0, blankLine(this.#columns, this.#style));
    }
    this.#x = 0;
  }

  #selectGraphicRendition(groups: ReadonlyArray<ReadonlyArray<number>>): void {
    if (groups.length === 0) {
      this.#style = PLAIN;
      return;
    }
    let style: { -readonly [K in keyof TerminalStyle]: TerminalStyle[K] } = { ...this.#style };
    for (let at = 0; at < groups.length; at += 1) {
      const group = groups[at] ?? [0];
      const value = group[0] ?? 0;
      if (value === 0) style = {};
      else if (value === 1) style.bold = true;
      else if (value === 2) style.dim = true;
      else if (value === 3) style.italic = true;
      else if (value === 4) {
        // `4:0` is underline off; `4:n` picks a kind of underline, all drawn alike.
        if (group.length > 1 && group[1] === 0) delete style.underline;
        else style.underline = true;
      } else if (value === 7) style.inverse = true;
      else if (value === 22) {
        delete style.bold;
        delete style.dim;
      } else if (value === 23) delete style.italic;
      else if (value === 24) delete style.underline;
      else if (value === 27) delete style.inverse;
      else if (value >= 30 && value <= 37) style.fg = { kind: "palette", index: value - 30 };
      else if (value === 39) delete style.fg;
      else if (value >= 40 && value <= 47) style.bg = { kind: "palette", index: value - 40 };
      else if (value === 49) delete style.bg;
      else if (value >= 90 && value <= 97) style.fg = { kind: "palette", index: value - 90 + 8 };
      else if (value >= 100 && value <= 107) style.bg = { kind: "palette", index: value - 100 + 8 };
      else if (value === 38 || value === 48) {
        let colour: TerminalColour | undefined;
        if (group.length > 1) {
          // Colon form, in one parameter: `38:5:n`, `38:2:r:g:b` or `38:2::r:g:b`.
          colour = extendedColour(
            group[1],
            group.slice(group[1] === 2 && group.length >= 6 ? 3 : 2),
          );
        } else {
          const mode = groups[at + 1]?.[0];
          const count = mode === 5 ? 1 : mode === 2 ? 3 : 0;
          const values = groups.slice(at + 2, at + 2 + count).map((entry) => entry[0] ?? 0);
          colour = extendedColour(mode, values);
          at += 1 + count;
        }
        if (colour !== undefined) {
          if (value === 38) style.fg = colour;
          else style.bg = colour;
        }
      }
    }
    this.#style = Object.keys(style).length === 0 ? PLAIN : style;
  }
}

/** A 256-colour index (`5`) or red, green and blue (`2`) as a colour; anything else is none. */
function extendedColour(
  mode: number | undefined,
  values: ReadonlyArray<number>,
): TerminalColour | undefined {
  if (mode === 5) {
    const index = Math.min(values[0] ?? 0, 255);
    return index < 16 ? { kind: "palette", index } : { kind: "rgb", hex: xterm256Hex(index) };
  }
  if (mode === 2) {
    return {
      kind: "rgb",
      hex: `#${hexByte(values[0] ?? 0)}${hexByte(values[1] ?? 0)}${hexByte(values[2] ?? 0)}`,
    };
  }
  return undefined;
}

/**
 * Blanks any half of a wide character left without its other half between
 * `from` and `to` (and the cells either side): a lead whose tail was
 * overwritten, erased, shifted or cut off at the edge, or a tail whose lead
 * was. Without it the drawn text and the cursor drift apart.
 */
function repairWide(line: Line, from: number, to: number): void {
  const { cells } = line;
  const last = Math.min(cells.length - 1, to + 1);
  for (let column = Math.max(0, from - 1); column <= last; column += 1) {
    const cell = cells[column];
    if (cell === undefined) continue;
    if (cell.width === 2 && cells[column + 1]?.width !== 0) {
      cells[column] = blankCell(PLAIN);
    } else if (cell.width === 0 && cells[column - 1]?.width !== 2) {
      cells[column] = blankCell(PLAIN);
    }
  }
}

/** A line's cells as runs that share a style, with the plain blanks at its end left off. */
function lineRuns(line: Line): ReadonlyArray<TerminalRun> {
  let end = line.cells.length;
  while (end > 0) {
    const cell = line.cells[end - 1];
    if (
      cell === undefined ||
      cell.text !== " " ||
      cell.style.bg !== undefined ||
      cell.style.inverse === true
    )
      break;
    end -= 1;
  }
  const runs: TerminalRun[] = [];
  let text = "";
  let style: TerminalStyle | undefined;
  for (let column = 0; column < end; column += 1) {
    const cell = line.cells[column];
    if (cell === undefined || cell.width === 0) continue;
    if (style !== undefined && sameStyle(style, cell.style)) {
      text += cell.text;
    } else {
      if (style !== undefined) runs.push({ text, style });
      text = cell.text;
      style = cell.style;
    }
  }
  if (style !== undefined) runs.push({ text, style });
  return runs;
}
