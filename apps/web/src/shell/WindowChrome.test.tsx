import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { WindowChrome } from "./WindowChrome";
import type { OctantHostBridge } from "./hostBridge";

function hostBridge(): OctantHostBridge {
  return {
    clearProviderCredential: vi.fn(),
    close: vi.fn(),
    maximizeOrRestore: vi.fn(),
    minimize: vi.fn(),
    projectWindowCapability: "C".repeat(43),
    providerCredentialStatus: vi.fn(async () => "missing" as const),
    resetBounds: vi.fn(),
    selectProjectRoot: vi.fn(),
    setProviderCredential: vi.fn(),
    setSidebarMaterialPreference: vi.fn(),
    subscribeResolvedMaterial: vi.fn(() => () => undefined),
  };
}

function renderChrome(overrides: Partial<React.ComponentProps<typeof WindowChrome>> = {}) {
  const props: React.ComponentProps<typeof WindowChrome> = {
    activeSurface: "Welcome to Code",
    bottomPanelAvailable: true,
    bottomPanelExpanded: false,
    dockAvailable: false,
    dockExpanded: false,
    dockLabel: "Right sidebar",
    hostBridge: hostBridge(),
    isNarrow: false,
    material: "opaque",
    onToggleBottomPanel: vi.fn(),
    onToggleDock: vi.fn(),
    ...overrides,
  };
  return { ...render(<WindowChrome {...props} />), props };
}

const rootStyles = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8")
  .replace('@import "./styles/shell.css";', "")
  .replace('@import "./styles/chat.css";', "")
  .replace('@import "./styles/code.css";', "");
const shellStyles = readFileSync(resolve(process.cwd(), "src/styles/shell.css"), "utf8");
const dockStyles = readFileSync(resolve(process.cwd(), "src/styles/dock.css"), "utf8");
/*
 * Comments are stripped before matching. `cssRule` reads a rule's prelude as
 * "everything since the last brace", so a comment written above a rule became
 * part of the selector it was documenting and the rule stopped being found —
 * the assertion then silently moved on to the next rule sharing that selector,
 * usually one inside a media query.
 */
const styles = [rootStyles, shellStyles, dockStyles].join("\n").replace(/\/\*[\s\S]*?\*\//g, "");

function cssRule(selector: string, occurrence = 0): string {
  if (selector === ":root" && occurrence === 0) {
    const start = styles.indexOf(":root {");
    expect(start, "missing base CSS rule for :root").toBeGreaterThanOrEqual(0);
    const openingBrace = styles.indexOf("{", start);
    const closingBrace = styles.indexOf("}", openingBrace);
    return styles.slice(openingBrace + 1, closingBrace);
  }
  const matches = [...styles.matchAll(/([^{}]+)\{([^{}]*)\}/gs)].filter((match) =>
    match[1]
      ?.split(",")
      .map((candidate) => candidate.trim())
      .includes(selector),
  );
  expect(matches, `missing CSS rule for ${selector}`).not.toHaveLength(0);
  return matches[occurrence]?.[2] ?? "";
}

function atRuleBlock(atRule: string): string {
  const start = styles.indexOf(atRule);
  expect(start, `missing CSS at-rule ${atRule}`).toBeGreaterThanOrEqual(0);
  const openingBrace = styles.indexOf("{", start);
  expect(openingBrace, `missing opening brace for ${atRule}`).toBeGreaterThan(start);

  let depth = 1;
  for (let index = openingBrace + 1; index < styles.length; index += 1) {
    if (styles[index] === "{") depth += 1;
    if (styles[index] === "}") depth -= 1;
    if (depth === 0) return styles.slice(openingBrace + 1, index);
  }

  throw new Error(`missing closing brace for ${atRule}`);
}

describe("WindowChrome", () => {
  it("keeps creating a thread reachable beside the sidebar recovery control", async () => {
    const user = userEvent.setup();
    const onNewThread = vi.fn();
    renderChrome({
      onExpandSidebar: vi.fn(),
      onNewThread,
    });

    const button = screen.getByRole("button", { name: "New thread" });
    expect(button).toHaveClass("window-chrome__new-thread");
    await user.click(button);
    expect(onNewThread).toHaveBeenCalledOnce();
  });

  it("keeps development authentication out of the working chrome", () => {
    render(
      <WindowChrome
        activeSurface="Chat"
        dockAvailable={false}
        dockExpanded={false}
        dockLabel="Utility dock"
        isNarrow={false}
        material="opaque"
        onToggleDock={() => undefined}
      />,
    );

    expect(screen.queryByText("Development authentication")).not.toBeInTheDocument();
  });
  it("uses neutral semantic roles for the shell palette", () => {
    const root = cssRule(":root");

    expect(root).toContain("--octant-focus-ring:");
    expect(root).toContain("--octant-workspace:");
    expect(root).toContain("--octant-chrome:");
    expect(root).toContain("--octant-sidebar-opaque:");
    expect(root).toContain("--octant-floating:");
    expect(root).toContain("--octant-control-hover:");
    expect(root).toContain("--octant-control-pressed:");
    expect(root).toContain("--octant-border:");
    expect(root).toContain("--octant-border-strong:");
    expect(root).toContain("--octant-text-primary:");
    expect(root).toContain("--octant-text-secondary:");
    expect(root).toContain("--octant-text-muted:");
    expect(root).toContain("--octant-text-primary-high-contrast:");
    expect(root).toContain("--octant-text-secondary-high-contrast:");
    expect(root).toContain("--octant-text-muted-high-contrast:");
    expect(root).toContain("--octant-success-text:");
    expect(root).toContain("--octant-warning-text:");
    expect(root).toContain("--octant-danger-text:");
    expect(root).toContain("--octant-addition-text:");
    expect(root).toContain("--octant-deletion-text:");
    // accent-text is a policed theme role (accent held to normal-text
    // contrast), unlike the retired derived-accent palette guarded below.
    expect(root).toContain("--octant-accent-text:");
    expect(root).not.toMatch(/#9a8cff|#d5ceff|154 140 255/i);
    expect(root).not.toMatch(/--octant-accent-(focus|border|surface)/);
  });

  it("keeps ordinary palette literals behind neutral semantic roles", () => {
    const declarationsOutsideRoot = shellStyles;

    expect(styles).not.toMatch(/#1a1a1f|#34343a|#414148|#16161a|#121216|#55525e/i);
    expect(declarationsOutsideRoot).not.toMatch(/#(?:[0-9a-f]{3}|[0-9a-f]{6})\b/i);
    expect(declarationsOutsideRoot).not.toMatch(/rgb\((?:255 255 255|7 7 9)\s*\//i);
  });

  it("uses only the approved native hierarchy weights", () => {
    const weights = [...styles.matchAll(/font-weight:\s*(\d+);/g)].map((match) => Number(match[1]));

    expect(weights.length).toBeGreaterThan(0);
    expect(weights.every((weight) => [400, 500, 600].includes(weight))).toBe(true);
  });

  it("normalizes rendered semantic headings and strong text below browser bold", () => {
    const stylesheet = document.createElement("style");
    stylesheet.textContent = styles;
    document.head.append(stylesheet);

    const fixture = document.createElement("section");
    fixture.innerHTML = `
      <div class="workspace__message"><h1>Workspace</h1></div>
      <section class="provider-settings">
        <div class="provider-settings__intro"><h2>Providers</h2></div>
        <article class="provider-card"><header class="provider-card__header"><h3>Codex</h3></header></article>
        <div class="provider-card__discovery"><h4>Capabilities</h4></div>
      </section>
      <p class="project-overview__warning"><strong>Unavailable</strong></p>
    `;
    document.body.append(fixture);

    try {
      const weights = [...fixture.querySelectorAll("h1, h2, h3, h4, strong")].map(
        (element) => getComputedStyle(element).fontWeight,
      );

      expect(weights).toEqual(["600", "600", "600", "600", "600"]);
    } finally {
      fixture.remove();
      stylesheet.remove();
    }
  });

  it("keeps compact native chrome geometry and neutral tool controls", () => {
    expect(cssRule(".shell-frame > .window-chrome")).toContain("height: 34px;");
    expect(cssRule(".shell-frame > .window-chrome")).toContain("top: 0;");
    expect(
      cssRule('html[data-octant-native-host="true"] .shell-frame > .window-chrome'),
    ).not.toContain("top: calc(var(--oct-space-2) + 4px);");
    expect(cssRule('html[data-octant-native-host="true"] .shell-frame > .window-chrome')).toContain(
      "z-index: 7;",
    );
    expect(cssRule(".shell-frame > .window-chrome")).toContain("background: transparent;");
    expect(cssRule(".shell-frame > .window-chrome")).toContain("border-bottom: 0;");
    expect(cssRule(".window-chrome__button")).toContain("width: 26px;");
    expect(cssRule(".window-chrome__button")).toContain("height: 26px;");
    expect(cssRule(".window-chrome__button")).toContain("background: transparent;");
    // The hover fill is the design system's neutral soft ink (--oct-fg-soft),
    // the same feedback .shell-icon-button gives, still no accent.
    expect(cssRule(".window-chrome__button:hover")).toContain("background: var(--oct-fg-soft);");
    expect(cssRule('.window-chrome__button[aria-expanded="true"]')).toContain(
      "background: var(--oct-fg-soft);",
    );
  });

  it("keeps shell separators and authority notices visually quiet", () => {
    expect(cssRule(".workspace-split")).toContain("background: transparent;");
    expect(cssRule(".workspace-split__resize")).toContain("background: transparent;");
    expect(cssRule(".workspace-split__resize::before")).toContain(
      "background: var(--octant-border);",
    );
    expect(cssRule(".workspace-cross-context-banner")).toContain("box-shadow: none;");
    expect(cssRule(".workspace-cross-context-banner")).toContain(
      "background: var(--octant-floating);",
    );
  });

  it("keeps ordinary navigation selection neutral", () => {
    // The mode switcher's active state moved to the design system sheet,
    // where .mode[aria-current="page"] uses the shadcn-projected neutral fill.
    const systemStyles = readFileSync(resolve(process.cwd(), "src/styles/octant.css"), "utf8");
    const activeMode = systemStyles.match(/\.mode\[aria-current="page"\]\s*{[^}]*}/)?.[0] ?? "";
    expect(activeMode).toContain("var(--sidebar-accent)");
    expect(activeMode).not.toMatch(/--octant-accent|purple/i);
    // The Project header is a quiet section label, so its active state is
    // carried by ink alone rather than a filled pill.
    expect(cssRule('.project-row[data-active="true"]')).toContain("color: var(--oct-fg);");
    expect(cssRule('.project-row[data-active="true"]')).not.toMatch(/accent|purple|background/i);
    expect(styles).not.toMatch(/\.project-row__mark\[data-type=/);
  });

  it("keeps sidebar recovery and pane-tab controls aligned to compact hit targets", () => {
    expect(cssRule(".sidebar__traffic-light-space")).toContain(
      "flex: 0 0 var(--octant-native-traffic-light-leading-width, 74px);",
    );
    expect(cssRule(".sidebar__native-collapse")).toContain("top: 0;");
    expect(cssRule(".window-chrome__new-thread")).toContain(
      "background: var(--oct-surface-muted);",
    );
    expect(cssRule(".workspace-pane__provider")).toContain("width: 14px;");
  });

  it("keeps the Project tree readable and reserves status ink for active work", () => {
    const projectName = cssRule(".project-row__copy > span");
    expect(projectName).toContain("font-family: var(--oct-font-display);");
    expect(projectName).toContain("font-weight: 400;");
    expect(projectName).not.toMatch(/text-transform|letter-spacing|mono/);
    expect(cssRule('.sidebar-navigation__thread-status[data-activity="idle"]')).toContain(
      "opacity: 0;",
    );
    expect(cssRule(".sidebar-navigation__thread-provider")).toContain("width: 14px;");
    expect(cssRule(".sidebar-navigation__thread-provider")).toContain("opacity: 0.78;");
    expect(cssRule('.sidebar-navigation__thread[aria-current="page"]')).not.toContain(
      "var(--oct-accent)",
    );
    const sectionLabel = cssRule(".project-section > .sidebar-section");
    expect(sectionLabel).toContain("font-family: var(--oct-font-display);");
    // Sentence case: the section label reads "Projects", not a spaced-out
    // "PROJECTS" kicker (DESIGN.md "Language").
    expect(sectionLabel).toContain("letter-spacing: 0;");
    expect(sectionLabel).toContain("text-transform: none;");
    expect(sectionLabel).not.toContain("mono");
    expect(cssRule('.sidebar-navigation__thread-status[data-activity="unread"]')).toContain(
      "background: var(--octant-text-secondary);",
    );
  });

  it("keeps semantic shell borders and controls restrained", () => {
    expect(cssRule(":root")).toContain("--octant-border: #303030;");
    expect(cssRule(":root")).toContain("--octant-border-strong: #4d4d4d;");
    expect(cssRule(".sidebar__native-leading")).not.toMatch(/background|border|box-shadow/);

    expect(cssRule(".new-project", 1)).toContain("color: var(--octant-text-primary);");
    expect(cssRule(".new-project", 1)).toContain("background: transparent;");
    expect(cssRule(".new-project:hover")).toContain("background: var(--octant-control-hover);");
    expect(cssRule(".new-project--subtle")).toContain("color: var(--octant-text-muted);");
    expect(cssRule(".new-project--subtle")).toContain("font-weight: 400;");
    expect(cssRule(".new-project--subtle:hover")).toContain("color: var(--octant-text-secondary);");
  });

  it("keeps the pane's title band free of a parked actions button", () => {
    // A pane's actions moved to right-click over its header. The band is also
    // the window's drag handle, and a button parked in every pane at all times
    // spent that scarce width on actions taken rarely.
    expect(styles).not.toMatch(/\.workspace-pane-actions/);
  });

  it("keeps reduced transparency independent from increased contrast", () => {
    const reducedTransparency = atRuleBlock("@media (prefers-reduced-transparency: reduce)");
    const increasedContrast = atRuleBlock("@media (prefers-contrast: more)");

    expect(styles).not.toContain(
      "@media (prefers-reduced-transparency: reduce), (prefers-contrast: more)",
    );
    expect(reducedTransparency).toContain(".shell--material-translucent.shell-frame > .sidebar");
    expect(reducedTransparency).toContain(
      '.shell--material-translucent[data-octant-sidebar-vibrancy="subtle"].shell-frame > .sidebar',
    );
    expect(reducedTransparency).toContain(
      '.shell--material-translucent[data-octant-sidebar-vibrancy="strong"].shell-frame > .sidebar',
    );
    expect(reducedTransparency).toContain("backdrop-filter: none;");
    expect(reducedTransparency).not.toContain("--octant-border-strong");
    expect(reducedTransparency).not.toContain("--octant-text-");
    expect(reducedTransparency).not.toContain("box-shadow:");
    expect(increasedContrast).toContain(
      "--octant-text-primary: var(--octant-text-primary-high-contrast) !important;",
    );
    expect(increasedContrast).toContain(
      "--octant-text-secondary: var(--octant-text-secondary-high-contrast) !important;",
    );
    expect(increasedContrast).toContain(
      "--octant-text-muted: var(--octant-text-muted-high-contrast) !important;",
    );
    expect(increasedContrast).toContain("border-color: var(--octant-border-strong);");
    expect(increasedContrast).toContain("box-shadow: inset 0 0 0 1px var(--octant-border-strong);");
  });

  it("overrides inline theme text tokens for OS Increased Contrast", () => {
    const increasedContrast = atRuleBlock("@media (prefers-contrast: more)");
    expect(increasedContrast).toContain(
      "--octant-text-primary: var(--octant-text-primary-high-contrast) !important;",
    );
    expect(increasedContrast).toContain(
      "--octant-text-secondary: var(--octant-text-secondary-high-contrast) !important;",
    );
    expect(increasedContrast).toContain(
      "--octant-text-muted: var(--octant-text-muted-high-contrast) !important;",
    );
  });

  it("keeps transient project dialogs as compact centered overlays", () => {
    expect(cssRule(".octant-dialog__viewport")).toContain("align-items: center");
    expect(cssRule(".octant-dialog__viewport")).toContain("justify-content: center");
    expect(cssRule(".octant-dialog__popup")).toContain("height: auto");
    // A dialog may ask for more room, but the default stays confirm-sized and
    // the viewport clamp applies whatever it asks for.
    expect(cssRule(".octant-dialog__popup")).toContain(
      "width: min(var(--octant-dialog-width, 420px), calc(100vw - 48px))",
    );
    // The shared dialog recipe caps every popup at max-w-lg, so a width alone
    // is a request the recipe overrules. Both properties, or a dialog that asks
    // to be wide silently is not.
    expect(cssRule(".octant-dialog__popup")).toContain(
      "max-width: min(var(--octant-dialog-width, 420px), calc(100vw - 48px))",
    );
    // 12px now arrives as the system radius token (--oct-radius-lg: 12px).
    expect(cssRule(".octant-dialog__popup")).toContain("border-radius: var(--oct-radius-lg)");
    expect(cssRule(".octant-dialog__popup")).not.toContain("height: 100%");
    expect(cssRule(".octant-dialog__popup")).not.toContain("border-left: 1px solid");
    // The wash behind a modal is the system scrim token rather than a literal.
    expect(cssRule(".octant-dialog__backdrop")).toContain("var(--oct-scrim)");
    expect(cssRule(".project-dialog")).toContain("width: min(100%, 380px)");
    expect(cssRule(".project-dialog")).toContain("padding: var(--oct-space-4)");
    expect(cssRule(".project-dialog h1")).toContain("font-size: var(--oct-text-base)");
  });

  it("keeps the opaque utility dock and accessibility fallbacks", () => {
    // --oct-bg is the bridge's alias for the opaque --octant-workspace ground,
    // so the dock and dialog stay workspace-opaque under every theme.
    expect(cssRule(".right-utility-dock")).toContain("background: var(--oct-bg);");
    expect(cssRule(".octant-dialog__popup")).toContain("background: var(--oct-bg);");
    expect(cssRule(".environment-git-group dl")).toContain("background: var(--octant-control);");
    expect(cssRule(".environment-git-group dl")).toContain(
      "border: 1px solid var(--octant-border);",
    );
    expect(cssRule(".environment-git-group dl")).toContain("border-radius: var(--oct-radius-sm);");
    expect(cssRule(".environment-git-group__row")).toContain("min-height: 30px;");
    expect(cssRule(".environment-git-group__row + .environment-git-group__row")).toContain(
      "border-top: 1px solid var(--octant-border);",
    );
    expect(cssRule(".environment-git-group__identity-secondary", 1)).toContain(
      "font-family: var(--oct-font-mono);",
    );

    expect(styles).toContain("@media (min-width: 681px) and (max-width: 960px)");
    expect(cssRule(".workspace")).toContain("min-width: 0;");
    expect(cssRule(".primary-workspace-layer")).toContain("position: relative;");
    expect(cssRule(".right-utility-dock")).not.toContain("position: fixed;");
    expect(styles).toContain("@media (max-width: 680px)");
    expect(styles).not.toContain(".project-memory-inspector--narrow");
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
    expect(styles).toContain(".workspace-split__resize::before,");
    expect(styles).toContain(".project-memory-inspector *");
    expect(styles).toContain("@media (prefers-reduced-transparency: reduce)");
    expect(styles).toContain("@media (prefers-contrast: more)");
    expect(styles).toContain(".shell--material-translucent.shell-frame > .sidebar");
    expect(styles).toContain(".environment-git-group dl,");
    expect(cssRule('.project-row[data-active="true"]', 1)).toContain(
      "box-shadow: inset 0 0 0 1px var(--octant-border-strong);",
    );
    expect(cssRule('.workspace-pane[data-active="true"] .workspace-pane__header')).toContain(
      "box-shadow: none;",
    );
    expect(cssRule('.workspace-pane[data-active="true"] .workspace-pane__grip')).toContain(
      "color: var(--oct-fg);",
    );
    expect(cssRule('.workspace-pane[data-active="true"] .workspace-pane__grip')).not.toContain(
      "border-color: var(--octant-border-strong);",
    );
    expect(cssRule('.workspace-pane[data-active="true"] .workspace-pane__grip')).toContain(
      "background: var(--octant-control);",
    );
    expect(cssRule(".shell--sidebar-collapsed .workspace-pane__header")).toContain(
      "padding-left: var(--octant-window-chrome-leading-width",
    );
    expect(cssRule('.workspace-pane[data-active="true"]')).toContain(
      "box-shadow: inset 0 0 0 1px var(--octant-border-strong);",
    );
    expect(cssRule('.workspace-pane[data-active="true"]')).not.toMatch(/accent|purple/i);
    expect(atRuleBlock("@media (prefers-contrast: more)")).toContain(".workspace-pane__header");
    expect(atRuleBlock("@media (prefers-contrast: more)")).toContain(
      '.workspace-pane[data-active="true"]',
    );
  });

  it("keeps the environment disclosure compact, neutral, and interface-typed", () => {
    expect(cssRule(".thread-environment-disclosure")).toContain(
      "width: min(320px, calc(100vw - 24px));",
    );
    expect(cssRule(".thread-environment-disclosure")).toContain(
      "border-radius: var(--oct-radius-lg);",
    );
    expect(cssRule(".thread-environment-disclosure__header")).toContain("min-height: 44px;");
    expect(cssRule(".environment-git-group__error")).toContain("color: var(--oct-muted);");
    expect(cssRule(".environment-git-group__error")).toContain("background: transparent;");
    expect(cssRule(".environment-git-group__error")).not.toMatch(/warn|yellow/i);
    expect(cssRule(".thread-environment-dock__header span")).toContain("color: var(--oct-muted);");
    expect(styles).not.toContain(".thread-environment-summary");
    expect(cssRule(".thread-environment-disclosure .environment-group__summary")).toContain(
      "font-family: var(--oct-font-display);",
    );
  });

  it("exposes the native sidebar canvas and integrated titlebar while keeping workspace surfaces opaque", () => {
    expect(cssRule('html[data-octant-native-host="true"]')).toContain("background: transparent;");
    expect(cssRule('html[data-octant-native-host="true"] .shell.shell-frame')).toContain(
      "background: transparent;",
    );
    expect(cssRule(".workspace")).toContain("background: var(--octant-workspace);");
    expect(cssRule(".shell-frame > .window-chrome")).toContain("background: transparent;");
  });

  it("keeps the near-opaque native sidebar wash until the host reports applied window vibrancy", () => {
    // The wash matches only while data-octant-host-vibrancy is absent, and the
    // gate lives in :where() so the prefers-reduced-transparency override
    // below it keeps winning on equal specificity.
    const flattened = styles.replace(/\s+/g, " ");
    expect(flattened).toContain(
      'html[data-octant-native-host="true"]:where(:not([data-octant-host-vibrancy="active"])) .shell-frame:not(.shell--material-opaque) > .sidebar { background: color-mix(in srgb, var(--octant-sidebar-opaque) 97%, transparent); }',
    );
    expect(atRuleBlock("@media (prefers-reduced-transparency: reduce)")).toContain(
      'html[data-octant-native-host="true"] .shell-frame:not(.shell--material-opaque) > .sidebar',
    );
  });

  it("exposes exactly one wide utility dock toggle only when a real surface is available", () => {
    const { props, rerender } = renderChrome({
      dockAvailable: true,
    });

    const dock = screen.getByRole("button", { name: "Open Right sidebar" });
    expect(dock).toHaveAttribute("title", "Open Right sidebar");
    expect(dock).toHaveAttribute("aria-expanded", "false");
    expect(dock).toHaveAttribute("aria-controls", "right-utility-dock");
    expect(dock).toHaveAttribute("data-dock-opener", "true");

    dock.click();
    expect(props.onToggleDock).toHaveBeenCalledWith(dock);

    rerender(<WindowChrome {...props} dockAvailable dockExpanded />);
    expect(screen.getByRole("button", { name: "Close Right sidebar" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );

    rerender(<WindowChrome {...props} dockAvailable={false} />);
    expect(screen.queryByRole("button", { name: /Right sidebar/i })).not.toBeInTheDocument();
  });

  it("moves the single utility dock action into narrow disclosure", async () => {
    const user = userEvent.setup();
    const { props } = renderChrome({
      dockAvailable: true,
      isNarrow: true,
    });
    const overflow = screen.getByRole("button", { name: "More window actions" });
    expect(overflow).toHaveAttribute("data-dock-opener", "true");

    await user.click(overflow);
    const dock = screen.getByRole("button", { name: "Open Right sidebar" });
    expect(dock).toHaveAttribute("aria-expanded", "false");
    expect(dock).toHaveAttribute("aria-controls", "right-utility-dock");
    dock.focus();
    await user.keyboard("{Enter}");

    expect(props.onToggleDock).toHaveBeenCalledWith(overflow);
    expect(overflow).toHaveAttribute("aria-expanded", "false");
    expect(overflow).toHaveFocus();
  });

  it("keeps workspace actions quiet without duplicating sidebar identity or the page title", async () => {
    const user = userEvent.setup();
    const bridge = hostBridge();
    const { container, props } = renderChrome({ hostBridge: bridge });

    expect(container.querySelector("[data-traffic-light-safe-space]")).not.toBeInTheDocument();
    expect(container.querySelector(".window-chrome__leading")).not.toBeInTheDocument();
    expect(container.querySelector(".window-chrome__brand")).not.toBeInTheDocument();
    expect(container.querySelector(".window-chrome__identity")).not.toBeInTheDocument();
    expect(screen.queryByText("Welcome to Code")).not.toBeInTheDocument();
    expect(screen.getByRole("banner")).toHaveAccessibleName(
      "Workspace actions for Welcome to Code",
    );
    expect(container.querySelector(".window-chrome__trailing")).toHaveClass("window-no-drag");
    expect(cssRule(".shell-frame > .window-chrome")).toContain("pointer-events: none;");
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    expect(screen.queryByRole("button", { name: "Open Zen" })).not.toBeInTheDocument();
    const bottomPanel = screen.getByRole("button", { name: "Open bottom panel" });
    expect(bottomPanel).toHaveAttribute("aria-controls", "bottom-utility-panel");
    expect(bottomPanel).toHaveClass("window-no-drag");
    bottomPanel.focus();
    await user.keyboard("{Enter}");
    expect(props.onToggleBottomPanel).toHaveBeenCalledWith(bottomPanel);

    expect(screen.queryByRole("group", { name: "Window controls" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Minimize window" })).not.toBeInTheDocument();

    // The rail offers nothing that discards a layout or a window's size: both
    // resets live in Settings, where a destructive action is deliberate.
    expect(screen.queryByRole("button", { name: "Reset layout" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reset window bounds" })).not.toBeInTheDocument();
    expect(bridge.resetBounds).not.toHaveBeenCalled();
  });

  it("uses disclosure keyboard behavior for narrow overflow actions", async () => {
    const user = userEvent.setup();
    const { container, props } = renderChrome({ isNarrow: true });

    expect(screen.queryByRole("button", { name: "Open Zen" })).not.toBeInTheDocument();

    const overflow = screen.getByRole("button", { name: "More window actions" });
    expect(overflow).toHaveAttribute("aria-expanded", "false");
    expect(overflow).not.toHaveAttribute("aria-haspopup");
    expect(overflow).toHaveClass("window-no-drag");
    await user.click(overflow);

    expect(overflow).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(container.querySelector(".window-chrome__disclosure")).toBeInTheDocument();
    const openBottomPanel = screen.getByRole("button", { name: "Open bottom panel" });
    expect(openBottomPanel).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(overflow).toHaveAttribute("aria-expanded", "false");
    expect(overflow).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: "Open bottom panel" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(props.onToggleBottomPanel).toHaveBeenCalledOnce();
    expect(overflow).toHaveAttribute("aria-expanded", "false");
    expect(overflow).toHaveFocus();
  });

  it("resets disclosure state and focus across narrow-wide-narrow transitions", async () => {
    const user = userEvent.setup();
    const { props, rerender } = renderChrome({ isNarrow: true });

    await user.click(screen.getByRole("button", { name: "More window actions" }));
    expect(screen.getByRole("button", { name: "Open bottom panel" })).toHaveFocus();

    rerender(<WindowChrome {...props} isNarrow={false} />);
    expect(screen.queryByRole("button", { name: "More window actions" })).not.toBeInTheDocument();
    expect(document.body).toHaveFocus();

    rerender(<WindowChrome {...props} isNarrow />);
    const overflow = screen.getByRole("button", { name: "More window actions" });
    expect(overflow).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Open bottom panel" })).not.toBeInTheDocument();
    expect(document.body).toHaveFocus();

    overflow.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: "Open bottom panel" })).toHaveFocus();
  });

  it("keeps the browser sidebar opener clear of native titlebar spacing", async () => {
    const user = userEvent.setup();
    const onExpandSidebar = vi.fn();
    const { container } = renderChrome({ onExpandSidebar });

    const leading = container.querySelector(".window-chrome__leading");
    const opener = screen.getByRole("button", { name: "Show sidebar" });

    expect(leading).toHaveClass("window-no-drag", "window-chrome__leading--browser");
    expect(leading).toContainElement(opener);
    expect(cssRule(".window-chrome__leading--browser .window-chrome__button")).toContain(
      "width: 28px;",
    );
    expect(leading?.querySelector(".window-chrome__traffic-light-space")).not.toBeInTheDocument();
    await user.click(opener);
    expect(onExpandSidebar).toHaveBeenCalledOnce();
  });

  it("reserves traffic-light space for the native sidebar opener", () => {
    const { container } = renderChrome({ nativeTitlebarInset: true, onExpandSidebar: vi.fn() });

    const leading = container.querySelector(".window-chrome__leading");
    expect(leading).not.toHaveClass("window-chrome__leading--browser");
    expect(leading?.querySelector(".window-chrome__traffic-light-space")).toBeInTheDocument();
    expect(cssRule(".window-chrome__traffic-light-space")).toContain(
      "flex: 0 0 var(--octant-native-traffic-light-leading-width, 74px);",
    );
  });

  it("reserves the title band for whichever window controls the thread actually renders", () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    // Stand in for layout: the cluster is as wide as the controls it holds.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const width = this.classList.contains("window-chrome__trailing")
          ? this.querySelectorAll("button").length * 40
          : 0;
        return {
          width,
          height: 0,
          top: 0,
          left: 0,
          right: width,
          bottom: 0,
          x: 0,
          y: 0,
        } as DOMRect;
      },
    );

    const reserveFor = (dockAvailable: boolean): string => {
      const surface = document.createElement("div");
      surface.className = "shell-frame";
      document.body.appendChild(surface);
      const { unmount } = render(
        <WindowChrome
          activeSurface="Welcome to Code"
          bottomPanelAvailable
          bottomPanelExpanded={false}
          dockAvailable={dockAvailable}
          dockExpanded={false}
          dockLabel="Right sidebar"
          isNarrow={false}
          material="opaque"
          onToggleBottomPanel={vi.fn()}
          onToggleDock={vi.fn()}
        />,
        { container: surface.appendChild(document.createElement("div")) },
      );
      const reserve = surface.style.getPropertyValue("--octant-window-chrome-reserved-width");
      unmount();
      surface.remove();
      return reserve;
    };

    // A thread that renders the dock toggle needs a wider band than one that
    // does not; a constant reserve is wrong for one of them by construction.
    expect(reserveFor(false)).toBe("40px");
    expect(reserveFor(true)).toBe("80px");

    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("reserves the leading band for the controls that replace a collapsed sidebar", () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const width = this.classList.contains("window-chrome__leading") ? 148 : 0;
        return {
          width,
          height: 0,
          top: 0,
          left: 0,
          right: width,
          bottom: 0,
          x: 0,
          y: 0,
        } as DOMRect;
      },
    );

    const surface = document.createElement("div");
    surface.className = "shell-frame";
    document.body.appendChild(surface);
    const { unmount } = render(
      <WindowChrome
        activeSurface="Welcome to Code"
        dockAvailable={false}
        dockExpanded={false}
        dockLabel="Right sidebar"
        isNarrow={false}
        material="opaque"
        onExpandSidebar={vi.fn()}
        onToggleDock={vi.fn()}
      />,
      { container: surface.appendChild(document.createElement("div")) },
    );

    // Measured, not assumed: a constant narrower than the traffic lights plus
    // Show sidebar plus New thread drew the pane tab over them.
    expect(surface.style.getPropertyValue("--octant-window-chrome-leading-width")).toBe("148px");

    unmount();
    surface.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("measures the leading band when a collapsing sidebar first renders it", () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const width = this.classList.contains("window-chrome__leading") ? 148 : 0;
        return {
          width,
          height: 0,
          top: 0,
          left: 0,
          right: width,
          bottom: 0,
          x: 0,
          y: 0,
        } as DOMRect;
      },
    );

    const surface = document.createElement("div");
    surface.className = "shell-frame";
    document.body.appendChild(surface);
    const container = surface.appendChild(document.createElement("div"));
    const chrome = (onExpandSidebar?: () => void) => (
      <WindowChrome
        activeSurface="Welcome to Code"
        dockAvailable={false}
        dockExpanded={false}
        dockLabel="Right sidebar"
        isNarrow={false}
        material="opaque"
        {...(onExpandSidebar === undefined ? {} : { onExpandSidebar })}
        onToggleDock={vi.fn()}
      />
    );

    // The cluster does not exist until the sidebar collapses, so the measurement
    // has to start when it mounts rather than when the chrome first renders.
    const { rerender, unmount } = render(chrome(), { container });
    expect(surface.style.getPropertyValue("--octant-window-chrome-leading-width")).toBe("");

    rerender(chrome(vi.fn()));
    expect(surface.style.getPropertyValue("--octant-window-chrome-leading-width")).toBe("148px");

    // Expanding the sidebar takes the cluster away; the reserve goes with it.
    rerender(chrome());
    expect(surface.style.getPropertyValue("--octant-window-chrome-leading-width")).toBe("");

    unmount();
    surface.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("drops the reserve on unmount even where ResizeObserver is unavailable", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const width = this.classList.contains("window-chrome__trailing") ? 96 : 0;
        return {
          width,
          height: 0,
          top: 0,
          left: 0,
          right: width,
          bottom: 0,
          x: 0,
          y: 0,
        } as DOMRect;
      },
    );

    const surface = document.createElement("div");
    surface.className = "shell-frame";
    document.body.appendChild(surface);
    const { unmount } = render(
      <WindowChrome
        activeSurface="Welcome to Code"
        dockAvailable
        dockExpanded={false}
        dockLabel="Right sidebar"
        isNarrow={false}
        material="opaque"
        onToggleDock={vi.fn()}
      />,
      { container: surface.appendChild(document.createElement("div")) },
    );
    expect(surface.style.getPropertyValue("--octant-window-chrome-reserved-width")).toBe("96px");

    // Without an observer there is nothing to disconnect, but the reserve still
    // describes a cluster that is gone.
    unmount();
    expect(surface.style.getPropertyValue("--octant-window-chrome-reserved-width")).toBe("");

    surface.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("ends the pane header's box before the window controls instead of padding it", () => {
    const header = cssRule(".workspace-pane__header");
    // Padding stays inside the header's border box, so a padded reserve still
    // won the hit test over every control in this row and swallowed the click.
    expect(header).toContain("margin-right: var(--octant-window-chrome-reserved-width");
    expect(header).not.toMatch(/padding:[^;]*--octant-window-chrome-reserved-width/);
  });

  it("keeps the window controls above the pane header rather than tied with it", () => {
    const nativeChrome = atRuleBlock(
      'html[data-octant-native-host="true"] .shell-frame > .window-chrome',
    );
    const nativeHeader = atRuleBlock(
      'html[data-octant-native-host="true"] .workspace-pane__header',
    );
    const chromeLayer = Number(/z-index:\s*(\d+)/.exec(nativeChrome)?.[1] ?? "0");
    const headerLayer = Number(/z-index:\s*(\d+)/.exec(nativeHeader)?.[1] ?? "0");
    // Equal layers left the winner to document order, and the header — rendered
    // after the chrome — covered every control in the title band.
    expect(chromeLayer).toBeGreaterThan(headerLayer);
  });

  it("leaves native dragging to the shell strip so pointer controls have no nested drag region", () => {
    const { container } = render(
      <WindowChrome
        activeSurface="Welcome to Code"
        bottomPanelAvailable
        bottomPanelExpanded={false}
        dockAvailable={false}
        dockExpanded={false}
        dockLabel="Right sidebar"
        isNarrow={false}
        material="opaque"
        onToggleBottomPanel={vi.fn()}
        onToggleDock={vi.fn()}
      />,
    );

    expect(container.firstChild).toHaveClass("window-chrome--material-opaque");
    expect(container.firstChild).not.toHaveClass("window-drag-region");
    expect(
      cssRule('html[data-octant-native-host="true"] .shell-frame > .window-chrome'),
    ).not.toContain("top: calc(var(--oct-space-2) + 4px);");
    expect(container.querySelector(".window-chrome__drag-space")).not.toHaveClass(
      "window-drag-region",
    );
    expect(cssRule(".window-chrome__drag-space")).toContain("pointer-events: none;");
    expect(container.querySelectorAll(".window-drag-region")).toHaveLength(0);
    for (const control of screen.getAllByRole("button")) {
      expect(control).toHaveClass("window-no-drag");
    }
    expect(screen.queryByRole("button", { name: "Minimize window" })).not.toBeInTheDocument();
  });
});
