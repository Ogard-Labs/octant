import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const styles = join(process.cwd(), "src");
const read = (name: string): string => readFileSync(join(styles, name), "utf8");

describe("window glass", () => {
  it("lays one coat on the window and leaves the panes clear", () => {
    const shell = read("styles/shell.css");
    const rule = /\.shell\.shell--material-translucent \{([^}]*)\}/.exec(shell)?.[1] ?? "";
    expect(rule).toContain("--octant-window-surface: var(--octant-workspace-translucent);");
    for (const surface of ["sheet", "stage", "panel"]) {
      expect(rule).toContain(`--octant-${surface}-surface: transparent;`);
    }
  });

  it("draws a float on host glass dense and without a backdrop filter", () => {
    const css = read("styles.css");
    const rule =
      /html\[data-octant-host-vibrancy="active"\]:not\([^)]*\)\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toContain("var(--octant-float) 96%, transparent");
    expect(rule).toContain("--octant-float-blur: none;");
  });

  it("draws a float dense and without a backdrop filter in the desktop app whether Glass is on or off", () => {
    const css = read("styles.css");
    const rule =
      /html\[data-octant-native-host="true"\]:not\(\[data-octant-host-vibrancy="active"\]\)\s*\{([^}]*)\}/.exec(
        css,
      )?.[1] ?? "";
    expect(rule).toContain("var(--octant-float) 96%, transparent");
    expect(rule).toContain("--octant-float-blur: none;");
  });

  it("draws the composer, a person's message and a glass card near opaque with no blur in the desktop app", () => {
    const css = read("styles/octant.css");
    const rule =
      /html\[data-octant-native-host="true"\]\s*:is\([\s\S]*?\)\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toContain("color-mix(in srgb, var(--octant-float) 96%, transparent)");
    expect(rule).toContain("backdrop-filter: none;");
    const selectors =
      /html\[data-octant-native-host="true"\]\s*:is\(([\s\S]*?)\)\s*\{/.exec(css)?.[1] ?? "";
    for (const surface of [
      ".thread-composer__surface",
      ".turn-user .bubble",
      '[data-variant="glass"]',
    ]) {
      expect(selectors).toContain(surface);
    }
  });

  it("draws a card over the ground at least 92% opaque under Glass in the desktop app", () => {
    const shell = read("styles/shell.css");
    const rule =
      /html\[data-octant-native-host="true"\]:not\([\s\S]*?\)\s*\.shell\.shell--app-backdrop\.shell--material-translucent \{([^}]*)\}/.exec(
        shell,
      )?.[1] ?? "";
    const alpha = /\)\s+(\d+)%,\s*transparent\s*\)/.exec(rule)?.[1];
    expect(Number(alpha)).toBeGreaterThanOrEqual(92);
  });

  it("puts no blur under the translucent shell", () => {
    for (const name of ["styles/octant.css", "styles/settings.css"]) {
      const css = read(name);
      const rules = css.match(/[^{}]*\.shell--material-translucent[^{}]*\{[^}]*\}/g) ?? [];
      for (const rule of rules) {
        // The opaque-window branch keeps its blur by naming the glass out.
        if (rule.includes(":not(.shell--material-translucent)")) continue;
        const filter = /backdrop-filter:\s*([^;]+);/.exec(rule)?.[1];
        if (filter !== undefined) expect(filter.trim(), rule).toBe("none");
      }
    }
  });

  it("resolves every surface opaque under reduced transparency and increased contrast", () => {
    const shell = read("styles/shell.css");
    expect(shell).toMatch(
      /html:is\(\[data-octant-reduced-transparency="true"\], \[data-octant-increased-contrast="true"\]\)\s*:is\(\.shell, \.shell\[data-octant-sidebar-vibrancy\]\) \{[^}]*--octant-panel-surface: var\(--octant-panel-opaque\);/,
    );
    expect(read("styles/octant-bridge.css")).toContain(
      'html:not([data-octant-reduced-transparency="true"], [data-octant-increased-contrast="true"])',
    );
  });
});
