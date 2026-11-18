import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NATIVE_TRAFFIC_LIGHT_LEADING_WIDTH } from "@octant/contracts/shell";
import { describe, expect, it } from "vitest";

const shellStyles = readFileSync(resolve(process.cwd(), "src/styles/shell.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);
const workspaceStyles = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

function cssRule(source: string, selector: string): string {
  const match = [...source.matchAll(/([^{}]+)\{([^{}]*)\}/gs)].find((candidate) =>
    candidate[1]
      ?.split(",")
      .map((value) => value.trim())
      .includes(selector),
  );
  expect(match, `missing CSS rule for ${selector}`).toBeDefined();
  return match?.[2] ?? "";
}

describe("native titlebar hit-test boundary", () => {
  it("keeps Electron drag on the blank strip and no-drag on title-row controls", () => {
    expect(cssRule(shellStyles, ".window-drag-region")).toContain("-webkit-app-region: drag;");
    expect(cssRule(shellStyles, ".window-no-drag")).toContain("-webkit-app-region: no-drag;");
    expect(cssRule(shellStyles, ".shell-frame > .window-chrome")).toContain(
      "pointer-events: none;",
    );
    expect(cssRule(shellStyles, ".window-chrome__leading")).toContain("pointer-events: auto;");
    expect(cssRule(shellStyles, ".window-chrome__trailing")).toContain("pointer-events: auto;");
    expect(shellStyles).not.toContain("window-chrome__environment-action");
    expect(cssRule(shellStyles, ".window-chrome__open-in-action")).toContain(
      "pointer-events: auto;",
    );
    expect(cssRule(shellStyles, ".window-chrome__drag-space")).toContain("pointer-events: none;");
  });

  it("keeps window chrome above the pane header so stacking cannot cover controls", () => {
    // One rank serves both hosts: the workspace column spans this row under
    // every host, so a native-only rank left the browser chrome losing the
    // band to whatever the column painted there.
    const chrome = cssRule(shellStyles, ".shell-frame > .window-chrome");
    const header = cssRule(
      workspaceStyles,
      'html[data-octant-native-host="true"] .workspace-pane__header',
    );
    const chromeLayer = Number(/z-index:\s*(\d+)/.exec(chrome)?.[1] ?? "0");
    const headerLayer = Number(/z-index:\s*(\d+)/.exec(header)?.[1] ?? "0");
    expect(chromeLayer).toBeGreaterThan(headerLayer);
    // The compact row lines up with AppKit's default hiddenInset lights, so
    // the chrome takes no downward shift of its own.
    expect(chrome).toContain("top: 0;");
  });

  it("uses one traffic-light reserve so collapsed recovery lines up with Hide sidebar", () => {
    const leading = cssRule(shellStyles, ".window-chrome__traffic-light-space");
    const sidebar = cssRule(shellStyles, ".sidebar__traffic-light-space");
    expect(leading).toContain(
      `flex: 0 0 var(--octant-native-traffic-light-leading-width, ${NATIVE_TRAFFIC_LIGHT_LEADING_WIDTH}px);`,
    );
    expect(sidebar).toContain(
      `flex: 0 0 var(--octant-native-traffic-light-leading-width, ${NATIVE_TRAFFIC_LIGHT_LEADING_WIDTH}px);`,
    );
  });

  it("covers the whole title band with one drag layer instead of partial strips", () => {
    const layer = cssRule(
      shellStyles,
      'html[data-octant-native-host="true"] .shell-frame__title-band-drag',
    );
    expect(layer).toContain("position: fixed;");
    expect(layer).toContain("top: 0;");
    expect(layer).toContain("right: 0;");
    expect(layer).toContain("left: 0;");
    expect(layer).toContain("height: var(--oct-title-rail-h);");
    expect(shellStyles).not.toContain("native-drag-strip");
    expect(workspaceStyles).not.toContain("native-drag-strip");
  });

  it("leaves no wide container over the band marked no-drag, so every empty pixel drags", () => {
    const files = [
      "src/shell/ShellSidebar.tsx",
      "src/shell/SidebarRail.tsx",
      "src/shell/RightUtilityDock.tsx",
      "src/shell/RightUtilityDockSurface.tsx",
      "src/shell/WindowChrome.tsx",
    ];
    const wide = [
      "sidebar__content",
      "sidebar__projects-pane",
      "sidebar-rail__column",
      "sidebar__primary",
      "sidebar__native-leading",
      "right-utility-dock",
    ];
    for (const file of files) {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      // Nothing after the band's drag layer may be a drag region over the band.
      expect(source, `${file} adds a drag region`).not.toContain("window-drag-region");
      for (const line of source.split("\n").filter((row) => row.includes("window-no-drag"))) {
        for (const name of wide) {
          expect(line, `${name} in ${file} is no-drag`).not.toContain(name);
        }
      }
    }
    // The chrome root is not no-drag either; only its clusters and controls are.
    expect(shellStyles).not.toMatch(/\.window-chrome\s*\{[^}]*app-region/u);
  });
});
