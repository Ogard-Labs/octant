import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import {
  NATIVE_HIDDEN_INSET_TITLEBAR_HEIGHT,
  NATIVE_TRAFFIC_LIGHT_LEADING_WIDTH,
} from "@octant/contracts/shell";
import { DEFAULT_THEME_SETTINGS } from "@octant/contracts/theme";
import { describe, expect, it, vi } from "vitest";
import { MIN_CONTEXT_SIDEBAR_WIDTH } from "@octant/contracts/shell";
import {
  ENVIRONMENT_STRIP_WIDTH,
  threadBoxMinimum,
  WORKBENCH_DOCK_WIDTH,
} from "./rightUtilityDockModel";
import { ShellFrame } from "./ShellFrame";

// Comments are stripped before matching: `cssRule` reads a rule's prelude as
// "everything since the last brace", so a comment above a rule would become
// part of the selector it documents and the rule would stop being found.
const shellStyles = readFileSync(resolve(process.cwd(), "src/styles/shell.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

function cssRule(selector: string): string {
  const match = [...shellStyles.matchAll(/([^{}]+)\{([^{}]*)\}/gs)].find((candidate) =>
    candidate[1]
      ?.split(",")
      .map((value) => value.trim())
      .includes(selector),
  );
  expect(match, `missing CSS rule for ${selector}`).toBeDefined();
  return match?.[2] ?? "";
}

const rootStyles = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

function rootRule(selector: string): string {
  // Every rule with this selector: a selector may be declared more than once.
  const bodies = [...rootStyles.matchAll(/([^{}]+)\{([^{}]*)\}/gs)]
    .filter((candidate) => candidate[1]?.trim() === selector)
    .map((candidate) => candidate[2] ?? "");
  expect(bodies.length, `missing CSS rule for ${selector}`).toBeGreaterThan(0);
  return squash(bodies.join(" "));
}

/** CSS with its whitespace taken out, so a formatter's line breaks do not matter. */
function squash(css: string): string {
  return css.replace(/\s+/g, "");
}

describe("the line the thread header's tool row stands on", () => {
  it("is the thread box's minimum, worked out in the stylesheet as the dock model works it out", () => {
    const layer = rootRule(".workspace-layer");
    // threadBoxMinimum: the thread's minimum and the section at most, what a
    // tool region at its asked width leaves, and the thread's own minimum.
    expect(layer).toContain(
      squash(
        "--octant-thread-box-min: min( calc(var(--octant-wide-primary-min) + var(--octant-env-strip-width, 300px)), max( " +
          `calc(var(--octant-workspace-width, 100%) - ${WORKBENCH_DOCK_WIDTH}px), max( ` +
          "var(--octant-narrow-primary-min), min( var(--octant-wide-primary-min), " +
          `calc(var(--octant-workspace-width, 100%) - ${MIN_CONTEXT_SIDEBAR_WIDTH}px) ) ) ) );`,
      ),
    );
    expect(threadBoxMinimum(1464, 1800)).toBe(1464 - WORKBENCH_DOCK_WIDTH);
  });

  it("ends the header's lead on that line, measured from the pane's edge, with the row 8px in", () => {
    expect(rootRule(".workspace-pane__lead")).toContain(
      squash("flex: 0 1 calc(var(--octant-thread-box-min, 100%) - var(--pane-header-start));"),
    );
    expect(rootRule(".workspace-pane__tools")).toContain(
      squash("margin-right: var(--oct-space-2);"),
    );
  });

  it("keeps the tool region out of the thread box's minimum, with Environment open or closed", () => {
    expect(rootRule(".workspace-layer")).toContain(
      squash(
        "--octant-dock-thread-keep: max( var(--octant-wide-primary-min), calc(var(--octant-thread-box-min) - var(--octant-dock-env-width, 0px)), var(--octant-split-primary-min, 0px) );",
      ),
    );
    const one = rootRule(".workspace-layer--wide-context-open");
    const two = rootRule('.workspace-layer--wide-context-open[data-dock-tile-columns="2"]');
    expect(one).toContain(squash("calc(100% - var(--octant-dock-thread-keep))"));
    expect(two).toContain(squash("calc(100% - var(--octant-dock-thread-keep))"));
    expect(two).toContain(
      squash(
        "--octant-dock-tool-room: calc( 100% - var(--octant-dock-thread-keep) - var(--octant-dock-env-width, 0px) );",
      ),
    );
  });

  it("lets the thread give before the sidebar, so opening Environment beside a tool does not move the thread", () => {
    const open = cssRule(".shell.shell-frame.shell--wide-context-open").replace(/\s+/g, " ");
    expect(open).toContain(
      "100vw - var(--octant-rail-offset, 0px) - var(--octant-narrow-primary-min) - var(--octant-context-sidebar-min)",
    );
    // The thread's 560px holds whether or not the dock is open: the line is
    // worked out from it before anything opens.
    expect(shellStyles.replace(/\s+/g, " ")).toContain(
      "@media (min-width: 1100px) { .shell.shell-frame { --octant-wide-primary-min: 560px; } }",
    );
  });

  it("tells the stylesheet what the panes of a split keep, and nothing for one pane", () => {
    const frame = (splitPrimaryMinimum: number | undefined) =>
      render(
        <ShellFrame
          chrome={<header>Chrome</header>}
          contextSidebarWidth={420}
          material="opaque"
          onCommitSidebarWidth={vi.fn()}
          onPreviewSidebarWidth={vi.fn()}
          sidebar={<aside>Sidebar</aside>}
          sidebarResizable={false}
          sidebarWidth={232}
          splitPrimaryMinimum={splitPrimaryMinimum}
          wideContextOpen
          workspace={<main>Workspace</main>}
        />,
      ).container.firstElementChild?.getAttribute("style");
    expect(frame(887)).toContain("--octant-split-primary-min: 887px");
    expect(frame(undefined)).not.toContain("--octant-split-primary-min");
  });

  it("publishes the Environment section's width to the stylesheet whether or not it is open", () => {
    const { container } = render(
      <ShellFrame
        chrome={<header>Chrome</header>}
        contextSidebarWidth={420}
        material="opaque"
        onCommitSidebarWidth={vi.fn()}
        onPreviewSidebarWidth={vi.fn()}
        sidebar={<aside>Sidebar</aside>}
        sidebarResizable={false}
        sidebarWidth={232}
        wideContextOpen={false}
        workspace={<main>Workspace</main>}
      />,
    );
    expect(container.firstElementChild?.getAttribute("style")).toContain(
      `--octant-env-strip-width: ${ENVIRONMENT_STRIP_WIDTH}px`,
    );
  });
});

describe("ShellFrame", () => {
  function frameFor(collapsed: boolean, width: number) {
    return (
      <ShellFrame
        chrome={<header>Chrome</header>}
        contextSidebarWidth={360}
        material="opaque"
        onCommitSidebarWidth={vi.fn()}
        onPreviewSidebarWidth={vi.fn()}
        sidebar={
          <aside className="sidebar" data-octant-sidebar>
            Sidebar
          </aside>
        }
        sidebarCollapsed={collapsed}
        sidebarResizable
        sidebarWidth={width}
        wideContextOpen={false}
        workspace={<main>Workspace</main>}
      />
    );
  }

  function stubWindowMedia(reducedMotion: boolean) {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("reduce") ? reducedMotion : query.includes("min-width"),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
  }

  it("slides the sidebar when it is shut and keeps a still copy through the closing slide", () => {
    stubWindowMedia(false);
    try {
      const { container, rerender } = render(frameFor(false, 232));
      const shell = container.querySelector(".shell-frame");
      expect(shell?.hasAttribute("data-octant-sidebar-sliding")).toBe(false);
      rerender(frameFor(true, 232));
      expect(shell?.getAttribute("data-octant-sidebar-sliding")).toBe("true");
      expect(shell?.querySelector("[data-octant-sidebar-ghost]")).not.toBeNull();
      fireEvent.transitionEnd(shell as Element, {
        propertyName: "--octant-rendered-sidebar-width",
      });
      expect(shell?.hasAttribute("data-octant-sidebar-sliding")).toBe(false);
      expect(shell?.querySelector("[data-octant-sidebar-ghost]")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not slide when the sidebar's edge is dragged to a new width", () => {
    stubWindowMedia(false);
    try {
      const { container, rerender } = render(frameFor(false, 232));
      rerender(frameFor(false, 300));
      rerender(frameFor(false, 340));
      const shell = container.querySelector(".shell-frame");
      expect(shell?.hasAttribute("data-octant-sidebar-sliding")).toBe(false);
      expect(shell?.getAttribute("style")).toContain("--octant-sidebar-width: 340px");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("changes at once, without sliding, when the window has asked for reduced motion", () => {
    stubWindowMedia(true);
    try {
      const { container, rerender } = render(frameFor(false, 232));
      rerender(frameFor(true, 232));
      expect(
        container.querySelector(".shell-frame")?.hasAttribute("data-octant-sidebar-sliding"),
      ).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("lays the ground in the frame before the sidebar, the chrome and the workspace", () => {
    const { container } = render(
      <ShellFrame
        backdrop={<div data-testid="shell-ground" />}
        chrome={<header>Chrome</header>}
        contextSidebarWidth={360}
        material="opaque"
        onCommitSidebarWidth={vi.fn()}
        onPreviewSidebarWidth={vi.fn()}
        sidebar={<aside>Sidebar</aside>}
        sidebarResizable={false}
        sidebarWidth={232}
        wideContextOpen={false}
        welcomeGround={<div data-testid="welcome-ground" />}
        workspace={<main>Workspace</main>}
      />,
    );
    const order = [...(container.querySelector(".shell-frame")?.children ?? [])].map(
      (child) => child.getAttribute("data-testid") ?? child.tagName,
    );
    const ground = Math.max(order.indexOf("shell-ground"), order.indexOf("welcome-ground"));
    expect(order.indexOf("shell-ground")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("welcome-ground")).toBeGreaterThanOrEqual(0);
    for (const later of ["ASIDE", "HEADER", "MAIN"]) {
      const at = order.indexOf(later);
      if (at >= 0) expect(at, later).toBeGreaterThan(ground);
    }
  });

  it("reserves a real native drag target at the top edge without covering the traffic lights", () => {
    const { container } = render(
      <ShellFrame
        chrome={<header>Chrome</header>}
        contextSidebarWidth={360}
        material="opaque"
        onCommitSidebarWidth={vi.fn()}
        onPreviewSidebarWidth={vi.fn()}
        sidebar={<aside>Sidebar</aside>}
        sidebarResizable={false}
        sidebarWidth={232}
        wideContextOpen={false}
        workspace={<main>Workspace</main>}
      />,
    );

    const dragTarget = container.querySelector("[data-window-drag-band]");
    expect(dragTarget).toHaveClass("shell-frame__title-band-drag", "window-drag-region");
    expect(container.firstElementChild?.firstElementChild).toBe(dragTarget);
    expect(cssRule(".shell-frame__title-band-drag")).toContain("display: none;");
    const band = cssRule('html[data-octant-native-host="true"] .shell-frame__title-band-drag');
    expect(band).toContain("position: fixed;");
    expect(band).toContain("top: 0;");
    expect(band).toContain("left: 0;");
    expect(band).toContain("right: 0;");
    expect(band).toContain("height: var(--oct-title-rail-h);");
  });

  it("puts the navigation sidebar ahead of the window chrome in tab order", () => {
    render(
      <ShellFrame
        chrome={
          <header>
            <button type="button">Open bottom panel</button>
          </header>
        }
        contextSidebarWidth={360}
        material="opaque"
        onCommitSidebarWidth={vi.fn()}
        onPreviewSidebarWidth={vi.fn()}
        sidebar={
          <aside>
            <button type="button">New task</button>
          </aside>
        }
        sidebarResizable={false}
        sidebarWidth={232}
        wideContextOpen={false}
        workspace={
          <main>
            <button type="button">Send</button>
          </main>
        }
      />,
    );

    const order = screen.getAllByRole("button").map((button) => button.textContent);
    expect(order).toEqual(["New task", "Open bottom panel", "Send"]);
  });

  it("owns one edge-to-edge landmark composition without an outer client frame", () => {
    const { container } = render(
      <ShellFrame
        chrome={<header aria-label="Workspace actions">Chrome</header>}
        contextSidebarWidth={360}
        material="translucent"
        onCommitSidebarWidth={vi.fn()}
        onPreviewSidebarWidth={vi.fn()}
        sidebar={<aside aria-label="Octant sidebar">Sidebar</aside>}
        sidebarResizable
        sidebarVibrancyMode="strong"
        sidebarWidth={244}
        wideContextOpen={false}
        workspace={<main>Workspace</main>}
      />,
    );

    const shell = container.firstElementChild;
    expect(shell).toHaveClass("shell", "shell-frame", "shell--material-translucent");
    expect(shell).toHaveAttribute("data-octant-sidebar-vibrancy", "strong");
    expect(shell).toHaveStyle({
      "--octant-context-sidebar-width": "360px",
      "--octant-native-hidden-inset-titlebar-height": `${NATIVE_HIDDEN_INSET_TITLEBAR_HEIGHT}px`,
      "--octant-native-traffic-light-leading-width": `${NATIVE_TRAFFIC_LIGHT_LEADING_WIDTH}px`,
      "--octant-sidebar-width": "244px",
    });
    expect(shell).not.toHaveAttribute("data-client-frame");
    expect(shell?.children).toHaveLength(5);
    expect(shell?.children[0]).toHaveClass("shell-frame__title-band-drag");
    expect(shell?.children[1]).toBe(screen.getByRole("complementary", { name: "Octant sidebar" }));
    expect(shell?.children[2]).toHaveClass("shell-frame__sidebar-resize");
    expect(shell?.children[3]).toBe(screen.getByRole("banner", { name: "Workspace actions" }));
    expect(shell?.children[4]).toHaveClass("workspace-layer");
    expect(screen.getAllByRole("banner")).toHaveLength(1);
    expect(screen.getAllByRole("main")).toHaveLength(1);
  });

  it("preserves the resolved material around a standalone surface without workspace geometry", () => {
    const { container } = render(
      <ShellFrame
        chrome={<header>Chrome</header>}
        contextSidebarWidth={360}
        material="translucent"
        onCommitSidebarWidth={vi.fn()}
        onPreviewSidebarWidth={vi.fn()}
        sidebar={<aside>Sidebar</aside>}
        sidebarResizable={false}
        sidebarWidth={232}
        standaloneSurface={<main aria-label="Settings">Settings</main>}
        wideContextOpen={false}
        workspace={<main>Workspace</main>}
      />,
    );

    const shell = container.firstElementChild;
    expect(shell).toHaveClass("shell", "shell-frame--standalone", "shell--material-translucent");
    expect(shell).toHaveStyle({ "--octant-sidebar-width": "232px" });
    expect(shell).not.toHaveClass("shell-frame");
    expect(shell?.children).toHaveLength(1);
    expect(shell?.children[0]).toBe(screen.getByRole("main", { name: "Settings" }));
    expect(screen.queryByText("Chrome")).not.toBeInTheDocument();
    expect(screen.queryByText("Sidebar")).not.toBeInTheDocument();
    expect(screen.queryByText("Workspace")).not.toBeInTheDocument();
  });

  it("returns to the same first-run draft after Settings closes", () => {
    function FirstRunDraft({ concealed }: { readonly concealed: boolean }) {
      const [step, setStep] = useState(1);
      return concealed ? null : (
        <button onClick={() => setStep(4)} type="button">
          Step {step}
        </button>
      );
    }
    function frame(settingsOpen: boolean) {
      return (
        <ShellFrame
          chrome={<header>Chrome</header>}
          contextSidebarWidth={360}
          material="opaque"
          onCommitSidebarWidth={vi.fn()}
          onPreviewSidebarWidth={vi.fn()}
          sidebar={<aside>Sidebar</aside>}
          sidebarResizable={false}
          sidebarWidth={232}
          {...(settingsOpen ? { standaloneSurface: <main>Settings</main> } : {})}
          wideContextOpen={false}
          workspace={<main>Workspace</main>}
        >
          <FirstRunDraft concealed={settingsOpen} />
        </ShellFrame>
      );
    }

    const { rerender } = render(frame(false));
    fireEvent.click(screen.getByRole("button", { name: "Step 1" }));
    rerender(frame(true));
    expect(screen.queryByRole("button", { name: "Step 4" })).not.toBeInTheDocument();
    rerender(frame(false));
    expect(screen.getByRole("button", { name: "Step 4" })).toBeInTheDocument();
  });

  it("keeps selected typography applied when entering a standalone surface", () => {
    const typography = {
      ...DEFAULT_THEME_SETTINGS.typography,
      ui: { ...DEFAULT_THEME_SETTINGS.typography.ui, family: "Inter", size: 19 },
    };

    render(
      <ShellFrame
        availableFonts={["Inter"]}
        chrome={<header>Chrome</header>}
        contextSidebarWidth={360}
        material="opaque"
        onCommitSidebarWidth={vi.fn()}
        onPreviewSidebarWidth={vi.fn()}
        sidebar={<aside>Sidebar</aside>}
        sidebarResizable={false}
        sidebarWidth={232}
        standaloneSurface={
          <div className="settings-view">
            <aside className="settings-view__sidebar">Settings navigation</aside>
            <main>Settings content</main>
          </div>
        }
        typography={typography}
        theme={DEFAULT_THEME_SETTINGS}
        wideContextOpen={false}
        workspace={<main>Workspace</main>}
      />,
    );

    expect(document.documentElement.style.getPropertyValue("--octant-ui-font-family")).toBe(
      "Inter",
    );
    expect(document.documentElement.style.getPropertyValue("--octant-ui-font-size")).toBe("19px");
    expect(screen.getByText("Settings navigation")).toBeInTheDocument();
    expect(screen.getByText("Settings content")).toBeInTheDocument();
  });

  it("applies the shared wide-context geometry without inline grid ownership", () => {
    const { container } = render(
      <ShellFrame
        chrome={<header>Chrome</header>}
        contextSidebarWidth={420}
        material="opaque"
        onCommitSidebarWidth={vi.fn()}
        onPreviewSidebarWidth={vi.fn()}
        sidebar={<aside>Sidebar</aside>}
        sidebarResizable={false}
        sidebarWidth={232}
        wideContextOpen
        workspace={<main>Workspace</main>}
      />,
    );

    const shell = container.firstElementChild;
    expect(shell).toHaveClass("shell--wide-context-open", "shell--material-opaque");
    expect(shell?.getAttribute("style")).not.toMatch(/grid-template/i);
    expect(container.querySelector(".workspace-layer")).toHaveClass(
      "workspace-layer--wide-context-open",
    );
  });

  it("renders a workspace-facing resize separator only for stable wide sidebars", () => {
    const { rerender } = render(
      <ShellFrame
        chrome={<header>Chrome</header>}
        contextSidebarWidth={360}
        material="translucent"
        onCommitSidebarWidth={vi.fn()}
        onPreviewSidebarWidth={vi.fn()}
        sidebar={<aside>Sidebar</aside>}
        sidebarResizable
        sidebarWidth={260}
        wideContextOpen={false}
        workspace={<main>Workspace</main>}
      />,
    );

    const separator = screen.getByRole("separator", { name: "Resize navigation sidebar" });
    expect(separator).toHaveClass("shell-frame__sidebar-resize", "window-no-drag");
    expect(separator).toHaveAttribute("aria-valuenow", "260");

    rerender(
      <ShellFrame
        chrome={<header>Chrome</header>}
        contextSidebarWidth={360}
        material="opaque"
        onCommitSidebarWidth={vi.fn()}
        onPreviewSidebarWidth={vi.fn()}
        sidebar={<aside>Sidebar</aside>}
        sidebarResizable={false}
        sidebarWidth={260}
        wideContextOpen={false}
        workspace={<main>Workspace</main>}
      />,
    );
    expect(screen.queryByRole("separator", { name: "Resize navigation sidebar" })).toBeNull();
  });

  it("keeps the primary workspace full-height while the narrow sidebar becomes an overlay", () => {
    const shell = cssRule(".shell.shell-frame");
    const sidebarContent = cssRule(
      ".shell-frame > .sidebar > .sidebar__primary > .sidebar__content",
    );

    expect(shell).toContain("height: 100vh;");
    expect(shell).toContain("max-width: 100vw;");
    expect(shell).toContain("overflow: hidden;");
    expect(sidebarContent).toContain("overflow-y: auto;");
    expect(sidebarContent).toContain("scrollbar-gutter: stable;");
    expect(shellStyles).toMatch(
      /@media \(max-width: 680px\)[\s\S]*\.shell\.shell-frame\s*\{[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\);/,
    );
    // The chrome row is the title rail (`--oct-title-rail-h`), the
    // same height the thread tab band takes, so the narrow drawer starts
    // where the rail ends instead of four pixels above it.
    expect(shellStyles).toMatch(
      /@media \(max-width: 680px\)[\s\S]*\.shell\.shell-frame\s*\{[\s\S]*grid-template-rows:\s*var\(--oct-title-rail-h\) minmax\(0, 1fr\);/,
    );
    expect(shellStyles).toMatch(
      /@media \(max-width: 680px\)[\s\S]*\.shell-frame > \.sidebar\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*var\(--oct-title-rail-h\) auto 0 0;[^}]*box-shadow:\s*var\(--octant-shadow-overlay\);/,
    );
    expect(shellStyles).toMatch(
      /@media \(max-width: 680px\)[\s\S]*\.shell-frame > \.workspace-layer\s*\{[\s\S]*grid-column:\s*1;/,
    );
    expect(shellStyles).toMatch(
      /@media \(max-width: 960px\)[\s\S]*\.shell-frame__sidebar-resize\s*\{[\s\S]*display:\s*none;/,
    );
  });

  it("sets the Projects collection on the window surface with only a dividing hairline", () => {
    const primarySidebar = cssRule(".sidebar--projects > .sidebar__primary");
    const projectsPane = cssRule(".sidebar__projects-pane");

    expect(primarySidebar).toContain("border-right: 1px solid var(--oct-border);");
    expect(projectsPane).toContain("background: transparent;");
    expect(projectsPane).not.toContain("box-shadow:");
  });

  it("shares the wide Electron titlebar row with workspace tabs without a separator", () => {
    const chrome = cssRule(".shell-frame > .window-chrome");
    const workspace = cssRule(".shell-frame > .workspace-layer");
    const trailing = cssRule(".window-chrome__trailing");

    expect(chrome).toContain("background: transparent;");
    expect(chrome).toContain("border-bottom: 0;");
    expect(chrome).toContain("pointer-events: none;");
    expect(chrome).not.toContain("top: calc(var(--oct-space-2) + 4px);");
    // One rank for both hosts: the workspace column spans this row, so the
    // chrome has to outrank whatever it paints there rather than only the
    // native pane header.
    expect(chrome).toContain("z-index: 7;");
    expect(shellStyles).not.toContain(
      'html[data-octant-native-host="true"] .shell-frame > .window-chrome',
    );
    expect(workspace).toContain("grid-row: 1 / -1;");
    expect(trailing).toContain("pointer-events: auto;");
    expect(shellStyles).toMatch(
      /@media \(max-width: 680px\)[\s\S]*\.shell-frame > \.workspace-layer\s*\{[\s\S]*grid-row:\s*2;/,
    );
  });

  it("keeps narrow sidebar controls in scroll flow at the effective 450 by 300 viewport", () => {
    expect(shellStyles).toMatch(
      /@media \(max-width: 680px\)[\s\S]*\.sidebar-navigation\s*\{[^}]*flex:\s*0 0 auto;/,
    );
    expect(shellStyles).toMatch(
      /@media \(max-width: 680px\)[\s\S]*\.sidebar-navigation__projects\s*\{[^}]*flex:\s*0 0 auto;/,
    );
    expect(shellStyles).toMatch(
      /@media \(max-width: 680px\)[\s\S]*\.project-nav\s*\{[^}]*max-height:\s*none;[^}]*overflow-y:\s*visible;/,
    );
  });

  it("gives Chat's start screen no phone-width layout of its own, so it matches Code's", () => {
    expect(shellStyles).not.toMatch(/\.draft-thread\.chat-welcome/);
    expect(shellStyles).not.toMatch(/\.draft-thread__canvas/);
  });
});
