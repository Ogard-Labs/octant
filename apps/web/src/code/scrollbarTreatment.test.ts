import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SCROLLBAR_LANE_WIDTH, SCROLLBAR_THUMB_WIDTH } from "./scrollbarTreatment";

const styles = (name: string) =>
  readFileSync(resolve(import.meta.dirname, "../styles", name), "utf8");

/** An installed package's folder, wherever the workspace hoisted it. */
function installed(name: string): string {
  for (let folder = import.meta.dirname; ; folder = dirname(folder)) {
    const candidate = join(folder, "node_modules", name);
    if (existsSync(candidate)) return candidate;
    if (dirname(folder) === folder) throw new Error(`${name} is not installed.`);
  }
}

describe("the editor's and the terminal's scrollbar", () => {
  it("stands the editor's thumb 2px in from the edge, as a pane's stands", () => {
    expect(SCROLLBAR_THUMB_WIDTH).toBe(6);
    expect((SCROLLBAR_LANE_WIDTH - SCROLLBAR_THUMB_WIDTH) / 2).toBe(2);
  });

  it("rounds the thumb's ends, and cuts the terminal's to the editor's width and place, where neither library has an option", () => {
    const code = styles("code.css");
    const tokens = styles("octant.css");

    expect(code).toMatch(
      /\n\.monaco-scrollable-element > \.scrollbar > \.slider \{\s*border-radius: var\(--oct-radius-pill\);\s*\}/,
    );
    // 2px clear at the edge and nothing further than 8px from it: the same
    // 6px thumb, whatever width the engine gives its lane.
    expect(code).toMatch(
      /\n\.xterm \.xterm-scrollable-element > \.scrollbar > \.slider \{\s*clip-path: inset\(\s*0 calc\(var\(--oct-space-1\) \/ 2\) 0 calc\(100% - var\(--oct-space-2\)\) round var\(--oct-radius-pill\)\s*\);\s*\}/,
    );
    expect(tokens).toMatch(/--oct-space-1: 4px;/);
    expect(tokens).toMatch(/--oct-space-2: 8px;/);
    expect(8 - 4 / 2).toBe(SCROLLBAR_THUMB_WIDTH);
  });

  it("styles class names the installed libraries still draw their thumbs with", () => {
    // Both rules hold on names the libraries own. A release that renames one
    // would leave a square, full-width thumb with nothing failing.
    expect(
      readFileSync(
        join(installed("monaco-editor"), "esm/vs/base/browser/ui/scrollbar/media/scrollbars.css"),
        "utf8",
      ),
    ).toContain(".monaco-scrollable-element > .scrollbar > .slider {");
    expect(readFileSync(join(installed("@xterm/xterm"), "lib/xterm.mjs"), "utf8")).toContain(
      ".xterm .xterm-scrollable-element > .scrollbar > .slider {",
    );
  });
});
