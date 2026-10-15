import { describe, expect, it } from "vitest";
import { generate } from "lean-qr";
import { renderTerminalQr } from "./terminalQr";

const CODE = `octant-pair-1.${"eyJvcmlnaW4iOiJodHRwczovLzEwMC4xMDEuMTAyLjEwMzo4NDQzIn0"}`;

/** Reads the half-block lines back into module rows: each glyph is two rows of one column. */
function modulesOf(rendered: string): ReadonlyArray<ReadonlyArray<boolean>> {
  const rows: boolean[][] = [];
  for (const line of rendered
    // oxlint-disable-next-line no-control-regex -- strips the colour escapes the renderer writes.
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\n$/, "")
    .split("\n")) {
    const top: boolean[] = [];
    const bottom: boolean[] = [];
    for (const glyph of line) {
      top.push(glyph === "█" || glyph === "▀");
      bottom.push(glyph === "█" || glyph === "▄");
    }
    rows.push(top, bottom);
  }
  return rows;
}

describe("renderTerminalQr", () => {
  it("draws exactly the symbol for the text inside a four-module quiet zone", () => {
    const symbol = generate(CODE);
    const extent = symbol.size + 8;
    const rows = modulesOf(renderTerminalQr(CODE, { color: false }));
    expect(rows.length).toBe(extent + (extent % 2));
    for (let y = 0; y < rows.length; y += 1) {
      const row = rows[y] ?? [];
      expect(row.length).toBe(extent);
      for (let x = 0; x < extent; x += 1) {
        const inside = x >= 4 && y >= 4 && x < symbol.size + 4 && y < symbol.size + 4;
        expect(row[x]).toBe(inside && symbol.get(x - 4, y - 4));
      }
    }
  });

  it("sets black on white on every line only when asked to colour", () => {
    const plain = renderTerminalQr(CODE, { color: false });
    const coloured = renderTerminalQr(CODE, { color: true });
    expect(plain).not.toContain("\u001b[");
    const lines = coloured.replace(/\n$/, "").split("\n");
    for (const line of lines) {
      expect(line.startsWith("\u001b[30;107m")).toBe(true);
      expect(line.endsWith("\u001b[0m")).toBe(true);
    }
    expect(modulesOf(coloured)).toEqual(modulesOf(plain));
  });
});
