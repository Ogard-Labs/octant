import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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

describe("ShellFrame", () => {
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
      "--octant-sidebar-width": "244px",
    });
    expect(shell).not.toHaveAttribute("data-client-frame");
    expect(shell?.children).toHaveLength(4);
    expect(shell?.children[0]).toBe(screen.getByRole("banner", { name: "Workspace actions" }));
    expect(shell?.children[1]).toBe(screen.getByRole("complementary", { name: "Octant sidebar" }));
    expect(shell?.children[2]).toHaveClass("shell-frame__sidebar-resize");
    expect(shell?.children[3]).toHaveClass("workspace-layer");
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
    expect(shell).not.toHaveClass("shell-frame");
    expect(shell?.children).toHaveLength(1);
    expect(shell?.children[0]).toBe(screen.getByRole("main", { name: "Settings" }));
    expect(screen.queryByText("Chrome")).not.toBeInTheDocument();
    expect(screen.queryByText("Sidebar")).not.toBeInTheDocument();
    expect(screen.queryByText("Workspace")).not.toBeInTheDocument();
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

  it("contains wide and narrow layouts while allowing larger sidebar text to remain reachable", () => {
    const shell = cssRule(".shell.shell-frame");
    const sidebarContent = cssRule(".shell-frame > .sidebar > .sidebar__content");

    expect(shell).toContain("height: 100vh;");
    expect(shell).toContain("max-width: 100vw;");
    expect(shell).toContain("overflow: hidden;");
    expect(sidebarContent).toContain("overflow-y: auto;");
    expect(sidebarContent).toContain("scrollbar-gutter: stable;");
    expect(shellStyles).toMatch(
      /@media \(max-width: 680px\)[\s\S]*\.shell\.shell-frame\s*\{[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\);/,
    );
    expect(shellStyles).toMatch(
      /@media \(max-width: 680px\)[\s\S]*\.shell-frame > \.workspace-layer\s*\{[\s\S]*grid-column:\s*1;/,
    );
    expect(shellStyles).toMatch(
      /@media \(max-width: 960px\)[\s\S]*\.shell-frame__sidebar-resize\s*\{[\s\S]*display:\s*none;/,
    );
  });

  it("shares the wide Electron titlebar row with workspace tabs without a separator", () => {
    const chrome = cssRule(".shell-frame > .window-chrome");
    const workspace = cssRule(".shell-frame > .workspace-layer");
    const trailing = cssRule(".window-chrome__trailing");

    expect(chrome).toContain("background: transparent;");
    expect(chrome).toContain("border-bottom: 0;");
    expect(chrome).toContain("pointer-events: auto;");
    expect(workspace).toContain("grid-row: 1 / -1;");
    expect(trailing).toContain("pointer-events: auto;");
    expect(shellStyles).toMatch(
      /@media \(max-width: 680px\)[\s\S]*\.shell-frame > \.workspace-layer\s*\{[\s\S]*grid-row:\s*3;/,
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

  it("keeps the narrow Chat draft surface inside the scrollable 200% panel", () => {
    expect(shellStyles).toMatch(
      /@media \(max-width: 640px\)[\s\S]*\.draft-thread__canvas\s*\{[^}]*width:\s*calc\(100% - 24px\);[^}]*padding:\s*24px 12px;/,
    );
    expect(shellStyles).toMatch(
      /@media \(max-width: 640px\)[\s\S]*\.draft-thread\.chat-welcome\s*\{[^}]*box-sizing:\s*border-box;[^}]*height:\s*auto;[^}]*overflow-y:\s*auto;/,
    );
    expect(shellStyles).toMatch(
      /@media \(max-width: 640px\)[\s\S]*\.draft-thread\.chat-welcome\s+\.draft-thread__canvas\s*\{[^}]*box-sizing:\s*border-box;[^}]*justify-content:\s*flex-start;[^}]*padding:\s*12px;/,
    );
  });
});
