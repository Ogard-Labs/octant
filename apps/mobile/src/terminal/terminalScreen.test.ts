import { describe, expect, it } from "vitest";
import { TERMINAL_SCROLLBACK_LINES, TerminalScreen, xterm256Hex } from "./terminalScreen";

const ESC = "\u001b";

function screen(columns = 10, rows = 4) {
  const replies: string[] = [];
  const terminal = new TerminalScreen(columns, rows, (data) => replies.push(data));
  return { terminal, replies };
}

describe("the phone's terminal screen", () => {
  it("draws a shell's lines, wraps at the edge and keeps what scrolled off the top", () => {
    const { terminal } = screen(5, 2);
    terminal.write("$ ls\r\nabcdefg\r\nend");
    expect(terminal.screenText()).toEqual(["fg", "end"]);
    const rows = terminal.snapshot().rows.map((row) => row.runs.map((run) => run.text).join(""));
    expect(rows).toEqual(["$ ls", "abcde", "fg", "end"]);
  });

  it("keeps an escape sequence split across two reads", () => {
    const { terminal } = screen();
    terminal.write(`${ESC}[3`);
    terminal.write("1mred");
    const [run] = terminal.snapshot().rows.at(-4)?.runs ?? [];
    expect(run).toEqual({ text: "red", style: { fg: { kind: "palette", index: 1 } } });
  });

  it("reads 16, 256 and true colours with bold and inverse", () => {
    const { terminal } = screen(20, 2);
    terminal.write(`${ESC}[1;38;5;208mA${ESC}[0;48;2;1;2;3mB${ESC}[7;94mC${ESC}[mD`);
    expect(terminal.snapshot().rows[0]?.runs).toEqual([
      { text: "A", style: { bold: true, fg: { kind: "rgb", hex: xterm256Hex(208) } } },
      { text: "B", style: { bg: { kind: "rgb", hex: "#010203" } } },
      {
        text: "C",
        style: {
          bg: { kind: "rgb", hex: "#010203" },
          inverse: true,
          fg: { kind: "palette", index: 12 },
        },
      },
      { text: "D", style: {} },
    ]);
  });

  it("clears the screen and moves the cursor as `clear` asks", () => {
    const { terminal } = screen();
    terminal.write("one\r\ntwo");
    terminal.write(`${ESC}[H${ESC}[2Jtop${ESC}[3;4Hx`);
    expect(terminal.screenText()).toEqual(["top", "", "   x", ""]);
    expect(terminal.snapshot().cursor).toEqual({ row: 2, column: 4 });
  });

  it("erases to the end of a line and deletes and inserts characters", () => {
    const { terminal } = screen();
    terminal.write(`abcdef${ESC}[3G${ESC}[K`);
    expect(terminal.screenText()[0]).toBe("ab");
    terminal.write(`\rabcdef\r${ESC}[2P`);
    expect(terminal.screenText()[0]).toBe("cdef");
    terminal.write(`${ESC}[2@`);
    expect(terminal.screenText()[0]).toBe("  cdef");
  });

  it("gives the shell its screen back when a full-screen program leaves the alternate screen", () => {
    const { terminal } = screen();
    terminal.write("$ vim");
    terminal.write(`${ESC}[?1049h${ESC}[Hediting${ESC}[?25l`);
    expect(terminal.screenText()[0]).toBe("editing");
    expect(terminal.snapshot().cursor).toBeUndefined();
    terminal.write(`${ESC}[?1049l${ESC}[?25h`);
    expect(terminal.screenText()[0]).toBe("$ vim");
    expect(terminal.snapshot().cursor).toEqual({ row: 0, column: 5 });
  });

  it("answers a program that asks where the cursor is", () => {
    const { terminal, replies } = screen();
    terminal.write(`ab\r\nc${ESC}[6n${ESC}[c`);
    expect(replies).toEqual([`${ESC}[2;2R`, `${ESC}[?1;2c`]);
  });

  it("scrolls only inside a scroll region and keeps the lines outside it", () => {
    const { terminal } = screen(6, 4);
    terminal.write(`head\r\na\r\nb\r\nfoot${ESC}[2;3r${ESC}[3;1H\nc`);
    expect(terminal.screenText()).toEqual(["head", "b", "c", "foot"]);
    terminal.write(`${ESC}[2;1H${ESC}M`);
    expect(terminal.screenText()).toEqual(["head", "", "b", "foot"]);
  });

  it("gives a wide character two columns and joins a combining mark to its letter", () => {
    const { terminal } = screen(6, 2);
    terminal.write("界x");
    expect(terminal.snapshot().cursor).toEqual({ row: 0, column: 3 });
    terminal.write("\r\né!");
    expect(terminal.screenText()).toEqual(["界x", "é!"]);
  });

  it("follows the application cursor key and bracketed paste modes a program sets", () => {
    const { terminal } = screen();
    terminal.write(`${ESC}[?1h${ESC}[?2004h`);
    expect(terminal.snapshot().modes).toEqual({
      applicationCursorKeys: true,
      bracketedPaste: true,
    });
    terminal.write(`${ESC}[?1l${ESC}[?2004l`);
    expect(terminal.snapshot().modes).toEqual({
      applicationCursorKeys: false,
      bracketedPaste: false,
    });
  });

  it("keeps the cursor's line on screen when the screen gets shorter or narrower", () => {
    const { terminal } = screen(8, 4);
    terminal.write("1\r\n2\r\n3\r\n$ prompt");
    terminal.resize(4, 2);
    expect(terminal.screenText()).toEqual(["3", "$ pr"]);
    expect(terminal.snapshot().cursor?.row).toBe(terminal.snapshot().rows.length - 1);
    terminal.resize(8, 3);
    expect(terminal.screenText()).toEqual(["3", "$ pr", ""]);
  });

  it("drops titles and other operating-system commands instead of printing them", () => {
    const { terminal } = screen(12, 2);
    terminal.write(`${ESC}]0;my title\u0007ok${ESC}]8;;https://x.test${ESC}\\link`);
    expect(terminal.screenText()[0]).toBe("oklink");
  });

  it("keeps at most the scrollback limit", () => {
    const { terminal } = screen(4, 2);
    terminal.write("x\r\n".repeat(TERMINAL_SCROLLBACK_LINES + 50));
    expect(terminal.snapshot().rows.length).toBe(TERMINAL_SCROLLBACK_LINES + 2);
  });

  it("starts over on reset, as when the host's kept output no longer reaches back far enough", () => {
    const { terminal } = screen();
    terminal.write(`${ESC}[31mold\r\nlines`);
    terminal.reset();
    terminal.write("new");
    expect(terminal.screenText()).toEqual(["new", "", "", ""]);
    expect(terminal.snapshot().rows[0]?.runs).toEqual([{ text: "new", style: {} }]);
  });

  it("keeps a wide character a program redraws in place", () => {
    const { terminal } = screen(8, 2);
    terminal.write("中\r中x");
    expect(terminal.screenText()[0]).toBe("中x");
  });

  it("leaves no half of a wide character behind when part of it is erased or deleted", () => {
    const deleted = screen(8, 2).terminal;
    deleted.write(`a中b${ESC}[3G${ESC}[P`);
    expect(deleted.screenText()[0]).toBe("a b");
    const erased = screen(8, 2).terminal;
    erased.write(`中${ESC}[2G${ESC}[K`);
    expect(erased.screenText()[0]).toBe("");
  });

  it("carries out a control character inside a sequence and drops a sequence cut by a new one", () => {
    const { terminal } = screen(12, 2);
    terminal.write(`abc${ESC}[\r2CX`);
    expect(terminal.screenText()[0]).toBe("abX");
    terminal.write(`\r\n${ESC}[1${ESC}[31mY`);
    expect(terminal.screenText()[1]).toBe("Y");
    expect(terminal.snapshot().rows.at(-1)?.runs[0]?.style.fg).toEqual({
      kind: "palette",
      index: 1,
    });
  });

  it("reads colon sub-parameters for underline and colours", () => {
    const { terminal } = screen(12, 2);
    terminal.write(`${ESC}[4mA${ESC}[4:0mB${ESC}[38:2::1:2:3mC`);
    expect(terminal.snapshot().rows[0]?.runs).toEqual([
      { text: "A", style: { underline: true } },
      { text: "B", style: {} },
      { text: "C", style: { fg: { kind: "rgb", hex: "#010203" } } },
    ]);
  });

  it("keeps the cursor on a narrowed screen when a full-screen program leaves", () => {
    const { terminal } = screen(80, 10);
    terminal.write(`${ESC}[5;70H${ESC}[?1049h`);
    terminal.resize(40, 10);
    terminal.write(`${ESC}[?1049lXYZ`);
    const { rows, cursor } = terminal.snapshot();
    expect(
      rows.every((row) => row.runs.reduce((width, run) => width + run.text.length, 0) <= 40),
    ).toBe(true);
    expect(cursor?.column).toBeLessThan(40);
  });
});
