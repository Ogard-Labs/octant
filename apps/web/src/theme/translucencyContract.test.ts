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

  it("lights every float's top edge under Glass only, and never under reduced transparency or increased contrast", () => {
    const css = read("styles.css");
    const glass =
      /html\[data-octant-host-vibrancy="active"\]:not\(([^)]*)\)\s*\{([^}]*)\}/.exec(css) ?? [];
    expect(glass[1]).toContain('[data-octant-reduced-transparency="true"]');
    expect(glass[1]).toContain('[data-octant-increased-contrast="true"]');
    expect(glass[2]).toContain("--octant-float-rim: inset 0 1px 0 var(--octant-float-rim-lit);");
    const lit = [...css.matchAll(/--octant-float-rim:\s*([^;]*);/g)].map((match) => match[1]);
    expect(lit).toEqual(["0 0 transparent", "inset 0 1px 0 var(--octant-float-rim-lit)"]);
    for (const pop of css.matchAll(/--octant-shadow-pop:\s*([^;]*);/g)) {
      expect(pop[1]?.trim().startsWith("var(--octant-float-rim),")).toBe(true);
    }
    // A composer notice floats on its own soft shadow and carries the same rim.
    const notice =
      /\.callout\.composer-notice,\s*\.thread-column > \.callout\s*\{([^}]*)\}/.exec(
        read("styles/octant.css"),
      )?.[1] ?? "";
    expect(notice).toContain("box-shadow: var(--octant-float-rim), var(--oct-shadow-float);");
    // The picture-in-picture draws one lit line under Glass, not its own on top of the rim.
    const pip =
      /html\[data-octant-host-vibrancy="active"\]:not\([^)]*\)\s*:is\(([^)]*)\)\s*\{([^}]*)\}/.exec(
        read("styles/components.css"),
      ) ?? [];
    expect(pip[1]).toContain(".thread-activity-pip__card");
    expect(pip[2]?.trim()).toBe("box-shadow: var(--octant-shadow-pop);");
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

  it("dims and softens the window behind Settings in every window and behind a dialog in the desktop app, and draws the sheet solid", () => {
    const css = read("styles/components.css");
    // One rule softens the window for both: Settings in every window that
    // shows it as a sheet (the Mac window's mark is absent in full screen, on
    // Windows and Linux and in a browser), a dialog where the mark is set.
    const softened = String.raw`html:not\(([^)]*)\):is\(\s*:has\(\.octant-sheet__popup\[data-open\]\),\s*\[data-octant-native-host="true"\]:has\(\.octant-dialog__popup\[data-open\]\)\s*\)\s*\.shell-frame\s*>\s*:is\(([^)]*)\)\s*\{([^}]*)\}`;
    const modalFade = new RegExp(String.raw`\n${softened}`).exec(css);
    // The content layers blur past reading; the ground and frame stay.
    for (const layer of [".sidebar-rail", ".sidebar", ".window-chrome", ".workspace-layer"]) {
      expect(modalFade?.[2]).toContain(layer);
    }
    expect(Number(/blur\((\d+)px\)/.exec(modalFade?.[3] ?? "")?.[1])).toBeGreaterThanOrEqual(4);
    // Barely dimmed as well as blurred: the scrim is a separate layer.
    expect(modalFade?.[3]).toContain("opacity: 0.92;");
    expect(modalFade?.[3]).not.toMatch(/visibility|display|pointer-events/);
    // The app's reduced transparency and increased contrast draw no blur, and
    // neither does the system's reduced transparency, which sets no mark.
    expect(modalFade?.[1]).toContain('[data-octant-reduced-transparency="true"]');
    expect(modalFade?.[1]).toContain('[data-octant-increased-contrast="true"]');
    const systemReduced =
      new RegExp(String.raw`@media \(prefers-reduced-transparency: reduce\) \{\s*${softened}`).exec(
        css,
      )?.[3] ?? "";
    expect(systemReduced).toContain("filter: none;");
    expect(systemReduced).toContain("opacity: 1;");
    // The window is softened the same whichever Settings page is open: the
    // rule and its system override are the only two that name the open sheet,
    // and neither names a page or a mark on the sheet.
    expect(css.match(/\.octant-sheet__popup\[data-open\]/g) ?? []).toHaveLength(2);
    // The scrim behind Settings is the sheet's own, the one a browser draws:
    // the desktop app no longer thins it to a shade too faint to set Settings
    // apart from the thread behind it.
    expect(css).not.toMatch(/\.octant-sheet__backdrop\s*\{[^}]*background/);
    const dock = read("styles/dock.css");
    expect(/\n\.octant-sheet__backdrop \{([^}]*)\}/.exec(dock)?.[1]).toContain(
      "background: color-mix(in srgb, var(--octant-scrim) 34%, transparent);",
    );
    expect(
      /:root\[data-octant-theme-mode="light"\] \.octant-sheet__backdrop \{([^}]*)\}/.exec(
        dock,
      )?.[1],
    ).toContain("background: color-mix(in srgb, var(--octant-scrim) 20%, transparent);");
    // The sheet itself is solid: under Glass the apps behind the window show
    // through, and no blur in the page reaches them.
    const sheet = /\.octant-sheet__popup\.octant-sheet__popup \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(sheet).toContain("background: var(--octant-float);");
    expect(sheet).toContain("backdrop-filter: none;");
    // The rule that thins a modal where a ground is drawn names the sheet too
    // and carries a `:has()` more: the solid rule repeats that form, or the
    // sheet is 96% over a ground and the page's text reads through it.
    expect(css).toMatch(
      /:has\(\.shell-frame > \.app-backdrop\)\s*\.octant-sheet__popup\.octant-sheet__popup \{/,
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

  it("keeps a tool's pane solid wherever a ground is on, and clears only the stage", () => {
    const surface = read("styles/surface.css");
    const start = ".shell-frame:has(main.workspace[data-octant-start-only]:not([hidden]))";
    // The stage's own fill is the one thing a start screen clears.
    expect(surface).toContain(`${start} > .workspace-layer::before {\n  background: transparent;`);
    // The dock and the bottom panel carry an opaque pane colour of their own,
    // beside a start screen and under a ground that runs behind everything.
    const solid =
      /\.shell--app-backdrop\.shell-frame :is\(\.right-utility-dock, \.bottom-utility-panel\),\s*\.shell-frame:has\(main\.workspace\[data-octant-start-only\]:not\(\[hidden\]\)\)\s*:is\(\.right-utility-dock, \.bottom-utility-panel\) \{([^}]*)\}/.exec(
        surface,
      )?.[1];
    expect(solid).toBeDefined();
    expect(solid).toMatch(
      /--octant-panel-surface: color-mix\(\s*in srgb,\s*var\(--octant-workspace\) 98%,\s*var\(--octant-text-primary\)\s*\);/,
    );
    expect(solid).toMatch(
      /--octant-pane-fill: linear-gradient\(var\(--octant-panel-surface\), var\(--octant-panel-surface\)\);/,
    );
    // No see-through fill and no blur stands in for it.
    expect(solid).not.toMatch(/transparent|backdrop-filter/);
    expect(surface).not.toMatch(/--octant-start-pane-(fill|veil)/);
    const dock = read("styles/dock.css");
    expect(dock).toMatch(/\.dock-tile \{[^}]*background: var\(--octant-pane-fill\);/);
    expect(dock).toMatch(
      /\.dock-env-strip \{[^}]*background: var\(--octant-pane-fill, var\(--oct-bg\)\);/,
    );
    expect(read("styles/shell.css")).toMatch(
      /\.bottom-utility-panel \{[^}]*background: var\(--octant-pane-fill\);/,
    );
  });

  it("lays one solid fill under a lone tool beside a start screen", () => {
    const rule =
      /\.shell-frame:has\(main\.workspace\[data-octant-start-only\]:not\(\[hidden\]\)\)\s*\.right-utility-dock::before \{([^}]*)\}/.exec(
        read("styles/surface.css"),
      )?.[1];
    expect(rule).toBeDefined();
    expect(rule).toMatch(/background: var\(--octant-pane-fill\);/);
    expect(rule).not.toMatch(/backdrop-filter/);
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

describe("the ground behind a thread and Home", () => {
  const flat = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");
  const threadPane =
    '.workspace-pane:is([data-surface-kind="thread"], [data-surface-kind="side-chat"])';

  it("lays a feathered plate behind a thread's text column only, below the title band, with no blur", () => {
    const surface = flat(read("styles/surface.css"));
    const rule =
      new RegExp(
        `\\.shell--app-backdrop\\.shell-frame ${threadPane.replace(/[.[\]()":,=-]/g, "\\$&")} \\{([^}]*)\\}`,
      ).exec(surface)?.[1] ?? "";
    expect(rule).not.toBe("");
    // Clear at both edges, the plate's colour across the column and its pad,
    // easing out over the feather; the column is the one the text is laid in.
    expect(rule).toMatch(/background-image: linear-gradient\( to right, transparent calc\(/);
    expect(rule).toContain("var(--oct-thread-column)");
    expect(rule).toContain("var(--octant-reading-plate-pad)");
    expect(rule).toContain("var(--octant-reading-plate-feather)");
    expect(rule.match(/var\(--octant-thread-veil\)/g)).toHaveLength(2);
    expect(rule.match(/ transparent calc\(/g)).toHaveLength(2);
    // Below the title band, which belongs to the window frame.
    expect(rule).toContain("background-position: 0 var(--oct-title-rail-h);");
    expect(rule).toContain("background-size: 100% calc(100% - var(--oct-title-rail-h));");
    expect(rule).toContain("background-repeat: no-repeat;");
    expect(rule).not.toMatch(/backdrop-filter|filter:/);
    // The plate's measures come from the spacing scale.
    const shell = read("styles/shell.css");
    expect(shell).toContain("--octant-reading-plate-pad: var(--oct-space-6);");
    expect(shell).toContain("--octant-reading-plate-feather: var(--oct-space-12);");
  });

  it("clears the pane fill under a thread over a ground with Glass off, but not under a page or where transparency is reduced", () => {
    const surface = flat(read("styles/surface.css"));
    const clear =
      /@media \(prefers-reduced-transparency: no-preference\) \{ html:not\(\[data-octant-reduced-transparency="true"\], \[data-octant-increased-contrast="true"\]\) \.shell--app-backdrop\.shell-frame:has\( (\.workspace-pane:is\([^)]*\)) \):not\( :has\( \.primary-workspace-layer > :is\(([^)]*)\) \) \) > \.workspace-layer::before \{ background: transparent; \}/.exec(
        surface,
      );
    expect(clear?.[1]).toBe(threadPane);
    expect(clear?.[2]).toContain(".agents-center-layer");
  });

  it("draws every pane's veil in the coat's own colour at the reading keep, so it turns opaque wherever transparency is reduced", () => {
    const surface = flat(read("styles/surface.css"));
    expect(surface).toContain(
      '.shell--app-backdrop.shell-frame .workspace-pane:not([data-surface-kind="welcome"], [data-surface-kind="draft-thread"]) { --octant-veil-surface: var(--octant-workspace); }',
    );
    // The keep is 100% under reduced transparency and increased contrast, so
    // the veil and the plate made from it are opaque there.
    expect(surface).toContain(
      "--octant-thread-veil: color-mix( in srgb, var(--octant-veil-surface, var(--octant-sheet-surface)) var(--octant-reading-surface-keep, 94%), transparent );",
    );
  });

  it("keeps the ground at its own strength behind a thread and a start screen under Glass, and steps it down only under a destination page", () => {
    const surface = flat(read("styles/surface.css"));
    // A start screen's column keeps its feathered wash under Glass, in the
    // coat's own colour, rather than the whole ground at half strength.
    expect(surface).toMatch(
      /\.shell--app-backdrop\.shell--material-translucent\.shell-frame :is\(\.draft-thread, \.work-composer-adapter, \.code-composer-adapter\):not\( :is\(\.draft-thread, \.work-composer-adapter, \.code-composer-adapter\) \* \) \{ --octant-start-wash: var\(--octant-workspace\); \}/,
    );
    // No half-strength ground while a start screen is up.
    expect(surface).not.toMatch(
      /\.shell--material-translucent\.shell-frame:has\( :is\(\.draft-thread[^{]*\{ opacity: 0\.5; \}/,
    );
    const stepDown = [
      ...surface.matchAll(
        /([^{}]*) > \.app-backdrop\[data-placement="shell"\] \{ opacity: ([\d.]+); \}/g,
      ),
    ];
    expect(stepDown).toHaveLength(1);
    const [, selector, opacity] = stepDown[0] ?? [];
    expect(opacity).toBe("0.12");
    expect(selector).toContain(".primary-workspace-layer > :is(");
    expect(selector).not.toContain(".workspace-pane");
  });

  it("lets the ground through the Environment panel as faintly as through the sidebar, and keeps tool tiles solid", () => {
    const surface = flat(read("styles/surface.css"));
    const strip =
      /\.shell--app-backdrop\.shell-frame \.right-utility-dock\[data-dock-environment="true"\] \{([^}]*)\}/.exec(
        surface,
      )?.[1] ?? "";
    expect(strip).toContain(
      "--octant-panel-surface: color-mix( in srgb, color-mix(in srgb, var(--octant-workspace) 98%, var(--octant-text-primary)) var(--octant-sidebar-keep), transparent );",
    );
    expect(strip).not.toMatch(/backdrop-filter/);
    // The sidebar's keep is whole under reduced transparency and increased contrast.
    expect(read("styles/shell.css")).toMatch(
      /html:is\(\[data-octant-reduced-transparency="true"\], \[data-octant-increased-contrast="true"\]\)\s*:is\(\.shell, \.shell\[data-octant-sidebar-vibrancy\]\) \{[^}]*--octant-sidebar-keep: 100%;/,
    );
    // A tile in the dock keeps the solid pane fill.
    expect(read("styles/dock.css")).toMatch(
      /\.dock-tile \{[^}]*background: var\(--octant-pane-fill\);/,
    );
  });
});
