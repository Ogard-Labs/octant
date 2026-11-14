import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(relative: string): string {
  return readFileSync(join(webRoot, relative), "utf8");
}

function rule(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `${selector} is declared`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start) + 1);
}

const octant = read("styles/octant.css");
const surface = read("styles/surface.css");

/** Apple's published SF Pro tracking, in points at each size. */
const PLATFORM_TRACKING_POINTS: ReadonlyArray<readonly [size: number, points: number]> = [
  [11, 0.06],
  [12, 0],
  [13, -0.08],
  [14, -0.15],
  [15, -0.2],
  [16, -0.31],
  [17, -0.43],
  [20, -0.45],
  [24, 0.07],
];

describe("native feel", () => {
  it("sets every size's tracking to the platform face's own, within a hundredth of a point", () => {
    for (const [size, points] of PLATFORM_TRACKING_POINTS) {
      const match = octant.match(
        new RegExp(`--oct-tracking-sf-${String(size)}:\\s*(-?[\\d.]+)em;`),
      );
      expect(match, `a tracking token for ${String(size)}px`).not.toBeNull();
      const drawn = Number(match?.[1]) * size;
      expect(Math.abs(drawn - points)).toBeLessThan(0.1);
    }
  });

  it("gives the body the 13px tracking and each interface role its own size's tracking", () => {
    expect(rule(octant, "body")).toContain("letter-spacing: var(--oct-tracking-sf-13);");
    expect(rule(surface, ".oct-nav-name")).toContain("var(--oct-tracking-sf-13)");
    expect(rule(surface, ".oct-nav-group")).toContain("var(--oct-tracking-sf-12)");
    expect(rule(surface, ".oct-menu-option")).toContain("var(--oct-tracking-sf-13)");
    expect(rule(surface, ".oct-row-label")).toContain("var(--oct-tracking-sf-14)");
    expect(rule(surface, ".oct-meta")).toContain("var(--oct-tracking-sf-12)");
    expect(rule(surface, ".oct-page-title")).toContain("var(--oct-tracking-sf-24)");
  });

  it("keeps code and the terminal off the body's tracking so their columns stay whole", () => {
    expect(octant).toMatch(
      /:where\(code, pre, kbd, samp, \.xterm, \.monaco-editor\) \{\s*letter-spacing: normal;/,
    );
  });

  it("draws a line of chrome at the native 16px, and keeps reading text airier", () => {
    expect(octant).toMatch(/--oct-line-chrome:\s*round\(calc\(1\.23 \* 1em\), 1px\);/);
    expect(octant).toMatch(/--oct-line-chrome-sm:\s*round\(calc\(1\.2 \* 1em\), 1px\);/);
    for (const role of [".oct-nav-name", ".oct-menu-option", ".oct-row-label"]) {
      expect(rule(surface, role)).toContain("line-height: var(--oct-line-chrome);");
    }
    expect(rule(surface, ".oct-nav-group")).toContain("line-height: var(--oct-line-chrome-sm);");
    expect(octant).toMatch(
      /:where\(button, \[role="button"\], \[role="menuitem"\], \[role="option"\], \[role="tab"\]\) \{\s*line-height: var\(--oct-line-chrome\);/,
    );
    expect(read("styles/octant.css")).toMatch(/--oct-leading-reading:\s*1\.6;/);
  });

  it("makes chrome unselectable with an arrow cursor, and lets only reading matter select", () => {
    expect(octant).toMatch(
      /html \{\s*cursor: default;\s*user-select: none;\s*-webkit-user-select: none;\s*-webkit-tap-highlight-color: transparent;\s*\}/,
    );
    expect(octant).toMatch(
      /:where\(button, \[role="button"\], \[role="option"\], \[role="menuitem"\], \[role="tab"\]\) \{\s*user-select: none;/,
    );
    expect(octant).toMatch(/:where\(a\[href\]\) \{\s*cursor: pointer;/);
    expect(octant).toMatch(/:where\(img, svg, a\) \{\s*-webkit-user-drag: none;/);
    for (const reading of [".chat-transcript", "pre", "textarea", "input"]) {
      expect(octant).toContain(reading);
    }
  });

  it("underlines nothing in chrome on pointer hover", () => {
    for (const file of ["styles.css", "styles/automation.css"]) {
      expect(read(file)).not.toMatch(/__card-open:hover[^{]*\{[^}]*text-decoration: underline/);
      expect(read(file)).not.toMatch(/__open:hover[^{]*\{[^}]*text-decoration: underline/);
    }
  });

  it("makes the title band exactly as tall as the rail is wide, and slim", () => {
    expect(octant).toMatch(/--oct-title-rail-h:\s*38px;/);
    expect(read("styles/shell.css")).toMatch(
      /\.shell\.shell-frame\.shell--sidebar-rail \{\s*--octant-rendered-sidebar-width: var\(--oct-title-rail-h\);/,
    );
    expect(read("styles/shell.css")).toMatch(
      /\.shell\.shell-frame\.shell--rail-beside \{\s*--octant-rail-offset: var\(--oct-title-rail-h\);/,
    );
  });

  it("puts a dragged sidebar width on a whole pixel", () => {
    expect(read("shell/ShellFrame.tsx")).toContain("Math.round(props.sidebarWidth)");
    expect(read("shell/ShellFrame.tsx")).toContain("Math.round(props.contextSidebarWidth)");
  });
});
