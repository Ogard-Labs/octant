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

  it("draws a person's message and a glass card near opaque with no blur in the desktop app, and the composer only while Glass is off", () => {
    const css = read("styles/octant.css");
    const rule =
      /html\[data-octant-native-host="true"\]\s*:is\([\s\S]*?\)\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toContain("color-mix(in srgb, var(--octant-float) 96%, transparent)");
    expect(rule).toContain("backdrop-filter: none;");
    const selectors =
      /html\[data-octant-native-host="true"\]\s*:is\(([\s\S]*?)\)\s*\{/.exec(css)?.[1] ?? "";
    for (const surface of [".turn-user .bubble", '[data-variant="glass"]']) {
      expect(selectors).toContain(surface);
    }
    // The composer is dense only on a window with no Glass; under Glass it is an
    // ink wash on the coat that follows the glass level.
    expect(selectors).toMatch(
      /\.shell--app-backdrop:not\(\.shell--material-translucent\)\s*:is\(\.thread-composer__surface/,
    );
    expect(selectors).not.toMatch(/\.shell--app-backdrop\s*:is\(\.thread-composer__surface/);
    const wash =
      /\.shell--material-translucent\s*:is\(\.thread-composer__surface, \.composer:not\(\.composer--carded\)\) \{([^}]*)\}/.exec(
        css,
      )?.[1] ?? "";
    expect(wash).toContain("background: var(--octant-control);");
    expect(read("styles/octant-bridge.css")).toMatch(
      /--octant-control: color-mix\(in srgb, var\(--octant-text-primary\) 7%, transparent\);/,
    );
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

  it("leaves the window behind Settings untouched and blurs it only behind a dialog in the desktop app", () => {
    const css = read("styles/components.css");
    const dialogFade =
      /html\[data-octant-native-host="true"\]:not\([\s\S]*?\):has\(\.octant-dialog__popup\[data-open\]\)\s*\.shell-frame\s*>\s*:is\(([^)]*)\)\s*\{([^}]*)\}/.exec(
        css,
      );
    // Behind a dialog the content layers blur past reading; the ground and frame stay.
    for (const layer of [".sidebar-rail", ".sidebar", ".window-chrome", ".workspace-layer"]) {
      expect(dialogFade?.[1]).toContain(layer);
    }
    expect(Number(/blur\((\d+)px\)/.exec(dialogFade?.[2] ?? "")?.[1])).toBeGreaterThanOrEqual(4);
    expect(dialogFade?.[2]).not.toMatch(/visibility|display|pointer-events/);
    // Settings is a sheet a person watches the window through: no rule blurs or
    // dims the content layers for it, and the sheet itself is dense, so nothing
    // reads through the sheet while everything beside it stays visible.
    expect(css).not.toMatch(/:has\([^)]*\.octant-sheet__popup\[data-open\][^)]*\)\s*\.shell-frame/);
    expect(css).toMatch(
      /\.octant-sheet__popup \{\s*background: color-mix\(in srgb, var\(--octant-float\) 96%, transparent\);/,
    );
  });

  it("keeps the ground under every content layer, the sheet and its scrim, and out of a modal's text", () => {
    const surface = read("styles/surface.css");
    const shell = read("styles/shell.css");
    const components = read("styles/components.css");
    const dock = read("styles/dock.css");
    // The ground is a negative level inside a frame that holds its own
    // stacking context, so it can lie neither over a pane nor behind the frame.
    expect(/\.app-backdrop\[data-placement="welcome"\]\s*\{[^}]*z-index:\s*-1;/.test(surface)).toBe(
      true,
    );
    expect(/\.shell\.shell-frame\s*\{[^}]*isolation:\s*isolate;/.test(shell)).toBe(true);
    // The sheet and its scrim live outside the frame at a floating level.
    for (const layer of ["octant-sheet__backdrop", "octant-sheet__viewport"]) {
      const rule = new RegExp(`\\.${layer}\\s*\\{([^}]*)\\}`).exec(dock)?.[1] ?? "";
      expect(rule, layer).toContain("position: fixed;");
      expect(rule, layer).toContain("z-index: var(--oct-z-floating);");
    }
    // Where a ground is drawn a modal is the dense float, so the ground does not
    // run across its rows and swatches; the glass coat alone keeps the lighter fill.
    const dense =
      /:has\(\.shell-frame > \.app-backdrop\)\s*:is\(\.octant-sheet__popup, \.octant-dialog__popup\)\s*\{([^}]*)\}/.exec(
        components,
      )?.[1] ?? "";
    expect(dense).toContain("color-mix(in srgb, var(--octant-float) 96%, transparent)");
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

  it("lets the ground show softly through the sidebar fill and keeps it whole under reduced transparency and increased contrast", () => {
    const shell = read("styles/shell.css");
    expect(shell).toContain("--octant-sidebar-keep: 82%;");
    expect(shell).toMatch(/var\(--octant-sidebar-keep\),\s*transparent/);
    expect(shell).toMatch(
      /html:is\(\[data-octant-reduced-transparency="true"\], \[data-octant-increased-contrast="true"\]\)\s*:is\(\.shell, \.shell\[data-octant-sidebar-vibrancy\]\) \{[^}]*--octant-sidebar-keep: 100%;/,
    );
    expect(shell).toMatch(
      /@media \(prefers-reduced-transparency: reduce\) \{\s*:is\(\.shell, [^)]*\) \{[^}]*--octant-sidebar-keep: 100%;/,
    );
  });

  it("runs a start screen's one ground under the sidebar only where the sidebar's fill is translucent", () => {
    const surface = read("styles/surface.css");
    // One layer in the frame, shown only while a start screen is open, never a second copy.
    expect(surface).not.toContain('data-placement="sidebar"');
    expect(surface).toMatch(
      /\.shell-frame:has\(main\.workspace\[data-octant-start-only\]:not\(\[hidden\]\)\)\s*> \.app-backdrop\[data-placement="welcome"\] \{[^}]*display: block;/,
    );
    expect(surface).toMatch(
      /\.shell-frame:not\(\.shell--sidebar-collapsed, \.shell--material-translucent\)\s*> \.app-backdrop\[data-placement="welcome"\] \{[^}]*--oct-ground-under: var\(--octant-rendered-sidebar-width\);[^}]*--oct-ground-under-share: 33%;/,
    );
    expect(surface).toMatch(
      /html:is\(\[data-octant-reduced-transparency="true"\], \[data-octant-increased-contrast="true"\]\)\s*\.shell-frame\s*> \.app-backdrop\[data-placement="welcome"\] \{[^}]*--oct-ground-under: 0px;/,
    );
  });

  it("fades a start screen's ground from full strength at 55% of the stage to nothing at its foot, on dark and light alike", () => {
    const surface = read("styles/surface.css");
    const rule = /\.app-backdrop\[data-placement="welcome"\] \{([^}]*?)display: none;/.exec(
      surface,
    );
    const fade =
      /--oct-ground-fade: linear-gradient\(([\s\S]*?)\);/.exec(rule?.[1] ?? "")?.[1] ?? "";
    expect(fade).toMatch(/to bottom,\s*currentColor 55%/);
    expect(fade).toMatch(/transparent 100%\s*$/);
    // One ramp for both pages: no light-mode override that ends the fade sooner.
    expect(surface).not.toMatch(
      /data-octant-theme-mode="light"\] \.app-backdrop\[data-placement="welcome"\]/,
    );
  });
});
