import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  NATIVE_HIDDEN_INSET_TITLEBAR_HEIGHT,
  NATIVE_TRAFFIC_LIGHT_LEADING_WIDTH,
} from "@octant/contracts/shell";
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

interface HitRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

function overlaps(a: HitRect, b: HitRect): boolean {
  return (
    a.left < b.left + b.width &&
    a.left + a.width > b.left &&
    a.top < b.top + b.height &&
    a.top + a.height > b.top
  );
}

/**
 * Renderer-side native title-row regions. Electron collects `-webkit-app-region:
 * drag` boxes and subtracts `no-drag`; a drag strip that still overlaps a
 * control wins the native hit test even when CSS z-index puts the control on top.
 */
function nativeTitlebarHitRegions(input: {
  readonly windowWidth: number;
  readonly sidebarCollapsed: boolean;
  readonly leadingWidth: number;
  readonly trailingWidth: number;
}): {
  readonly dragStrip: HitRect;
  readonly trailing: HitRect;
  readonly leading: HitRect | undefined;
} {
  const dragLeft = input.sidebarCollapsed ? input.leadingWidth : 112;
  const trailingLeft = input.windowWidth - input.trailingWidth;
  return {
    dragStrip: {
      left: dragLeft,
      top: 0,
      width: Math.max(0, trailingLeft - dragLeft),
      height: NATIVE_HIDDEN_INSET_TITLEBAR_HEIGHT,
    },
    trailing: {
      left: trailingLeft,
      top: 0,
      width: input.trailingWidth,
      height: 34,
    },
    leading: input.sidebarCollapsed
      ? { left: 0, top: 0, width: input.leadingWidth, height: 34 }
      : undefined,
  };
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
    const chrome = cssRule(
      shellStyles,
      'html[data-octant-native-host="true"] .shell-frame > .window-chrome',
    );
    const header = cssRule(
      workspaceStyles,
      'html[data-octant-native-host="true"] .workspace-pane__header',
    );
    const chromeLayer = Number(/z-index:\s*(\d+)/.exec(chrome)?.[1] ?? "0");
    const headerLayer = Number(/z-index:\s*(\d+)/.exec(header)?.[1] ?? "0");
    expect(chromeLayer).toBeGreaterThan(headerLayer);
    expect(chrome).not.toContain("top:");
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

  it("does not let the native drag strip cover collapsed-sidebar recovery or trailing controls", () => {
    const expanded = nativeTitlebarHitRegions({
      windowWidth: 1280,
      sidebarCollapsed: false,
      leadingWidth: 148,
      trailingWidth: 148,
    });
    expect(overlaps(expanded.dragStrip, expanded.trailing)).toBe(false);
    expect(expanded.leading).toBeUndefined();

    const collapsed = nativeTitlebarHitRegions({
      windowWidth: 1280,
      sidebarCollapsed: true,
      leadingWidth: 148,
      trailingWidth: 148,
    });
    expect(collapsed.leading).toBeDefined();
    const leading = collapsed.leading;
    if (leading === undefined) throw new Error("collapsed leading region missing");
    expect(overlaps(collapsed.dragStrip, leading)).toBe(false);
    expect(overlaps(collapsed.dragStrip, collapsed.trailing)).toBe(false);
    expect(collapsed.dragStrip.left).toBe(148);
    expect(
      cssRule(
        shellStyles,
        'html[data-octant-native-host="true"] .shell--sidebar-collapsed .shell-frame__native-drag-strip',
      ),
    ).toContain("left: var(--octant-window-chrome-leading-width, 148px);");
  });

  it("ends the drag strip where the open right dock begins so its tabs take clicks", () => {
    const rule = cssRule(
      shellStyles,
      'html[data-octant-native-host="true"] .shell--wide-context-open .shell-frame__native-drag-strip',
    );
    // The strip has to stop at whichever is wider, so naming either width
    // alone would still let the dock's tabs sit under the drag region.
    expect(rule).toContain("right: max(");
    expect(rule).toContain("var(--octant-window-chrome-reserved-width, 148px)");
    expect(rule).toContain("var(--octant-context-sidebar-width, 0px)");
  });

  it("would cover Show sidebar if the drag strip kept the expanded 112px origin after collapse", () => {
    const leading = { left: 0, top: 0, width: 148, height: 34 };
    const staleDrag = {
      left: 112,
      top: 0,
      width: 200,
      height: NATIVE_HIDDEN_INSET_TITLEBAR_HEIGHT,
    };
    expect(overlaps(staleDrag, leading)).toBe(true);
  });
});
