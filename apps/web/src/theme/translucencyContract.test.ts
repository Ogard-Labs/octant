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

  it("leaves the window behind Settings untouched, draws the sheet solid, and blurs the window only behind a dialog in the desktop app", () => {
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
    // dims the content layers for it, and the sheet itself is solid: under Glass
    // the apps behind the window show through, and no blur in the page reaches them.
    expect(css).not.toMatch(/:has\([^)]*\.octant-sheet__popup\[data-open\][^)]*\)\s*\.shell-frame/);
    const sheet = /\.octant-sheet__popup\.octant-sheet__popup \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(sheet).toContain("background: var(--octant-float);");
    expect(sheet).toContain("backdrop-filter: none;");
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
    // A surface that holds running text keeps 94% of its own colour over the
    // ground (82% and 80% let a photo run through the letters), one variable
    // for the sidebar and the reading veil; the empty areas keep the ground whole.
    const keep = /--octant-reading-surface-keep:\s*(\d+)%;/.exec(shell)?.[1];
    expect(Number(keep)).toBeGreaterThanOrEqual(94);
    expect(shell).toContain("--octant-sidebar-keep: var(--octant-reading-surface-keep);");
    expect(read("styles/surface.css")).toMatch(
      /--octant-thread-veil: color-mix\(\s*in srgb,\s*var\(--octant-veil-surface, var\(--octant-sheet-surface\)\)\s*var\(--octant-reading-surface-keep, 94%\),\s*transparent\s*\);/,
    );
    expect(shell).toMatch(
      /html:is\(\[data-octant-reduced-transparency="true"\], \[data-octant-increased-contrast="true"\]\)\s*:is\(\.shell, \.shell\[data-octant-sidebar-vibrancy\]\) \{[^}]*--octant-reading-surface-keep: 100%;/,
    );
    expect(shell).toMatch(/var\(--octant-sidebar-keep\),\s*transparent/);
    expect(shell).toMatch(
      /html:is\(\[data-octant-reduced-transparency="true"\], \[data-octant-increased-contrast="true"\]\)\s*:is\(\.shell, \.shell\[data-octant-sidebar-vibrancy\]\) \{[^}]*--octant-sidebar-keep: 100%;/,
    );
    expect(shell).toMatch(
      /@media \(prefers-reduced-transparency: reduce\) \{\s*:is\(\.shell, [^)]*\) \{[^}]*--octant-sidebar-keep: 100%;/,
    );
  });

  it("gives a dock pane the text surface while a start screen shows the ground, and clears only the stage", () => {
    const surface = read("styles/surface.css");
    const start = ".shell-frame:has(main.workspace[data-octant-start-only]:not([hidden]))";
    // The stage's own fill is the one thing a start screen clears.
    expect(surface).toContain(`${start} > .workspace-layer::before {\n  background: transparent;`);
    // Every pane that holds text reads the shell's pane fill, which a start
    // screen lays at 94% of its colour (the workspace colour under Glass).
    const opaque = new RegExp(
      `${start.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{\\s*--octant-panel-surface: color-mix\\(\\s*in srgb,\\s*var\\(--octant-panel-opaque\\) var\\(--octant-reading-surface-keep, 94%\\),\\s*transparent`,
    );
    expect(surface).toMatch(opaque);
    expect(surface).toMatch(
      /\.shell--material-translucent:has\([\s\S]{0,120}?\)\s*\{\s*--octant-panel-surface: color-mix\(\s*in srgb,\s*var\(--octant-workspace\) var\(--octant-reading-surface-keep, 94%\),\s*transparent/,
    );
    // Reduced transparency and increased contrast are left to their opaque panes.
    expect(surface).toMatch(
      /@media \(prefers-reduced-transparency: no-preference\) \{\s*html:not\(\[data-octant-reduced-transparency="true"\], \[data-octant-increased-contrast="true"\]\)/,
    );
    const dock = read("styles/dock.css");
    expect(dock).toMatch(/\.dock-tile \{[^}]*background: var\(--octant-pane-fill\);/);
    expect(dock).toMatch(
      /\.dock-env-strip \{[^}]*background: var\(--octant-pane-fill, var\(--oct-bg\)\);/,
    );
    expect(read("styles/shell.css")).toMatch(
      /\.bottom-utility-panel \{[^}]*background: var\(--octant-pane-fill\);/,
    );
  });

  it("lays the dock beside a start screen on the sidebar's colour with the ground blurred and dimmed behind it", () => {
    const surface = read("styles/surface.css");
    const rule =
      /\.shell-frame:has\(main\.workspace\[data-octant-start-only\]:not\(\[hidden\]\)\)\s*\.right-utility-dock::before \{([^}]*)\}/.exec(
        surface,
      )?.[1];
    expect(rule).toBeDefined();
    expect(rule).toMatch(/backdrop-filter:\s*blur\(var\(--octant-glass-blur\)\)/);
    expect(rule).toMatch(/var\(--octant-start-pane-veil\)/);
    expect(rule).toMatch(/var\(--octant-start-pane-fill\)/);
    // The fill is the sidebar's colour, and reduced transparency keeps it whole.
    expect(surface).toMatch(
      /--octant-start-pane-fill: color-mix\(\s*in srgb,\s*color-mix\(in srgb, var\(--octant-panel-opaque\) 90%, var\(--octant-ground-opaque\)\) 72%,/,
    );
    expect(surface).toMatch(
      /data-octant-increased-contrast="true"\]\)\s*\.shell-frame:has\([^{]*\{\s*--octant-start-pane-fill: var\(--octant-panel-opaque\);/,
    );
    // The panes inside draw no second fill over it.
    expect(surface).toMatch(
      /\.right-utility-dock\s*:is\(\.dock-tile, \.dock-env-strip\) \{\s*background: transparent;/,
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
