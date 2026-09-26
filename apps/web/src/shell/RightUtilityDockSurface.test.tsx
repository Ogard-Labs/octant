import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  RIGHT_UTILITY_DOCK_SURFACES,
  type RightUtilityDockSurfaceId,
} from "./rightUtilityDockModel";
import { RightUtilityDockSurface } from "./RightUtilityDockSurface";

const browser = surface("browser");
const terminal = surface("terminal");
const files = surface("files");
const sharedStylesheet = readFileSync(resolve(import.meta.dirname, "../styles.css"), "utf8");
const dockStylesheet = readFileSync(resolve(import.meta.dirname, "../styles/dock.css"), "utf8");

function surface(id: RightUtilityDockSurfaceId) {
  const found = RIGHT_UTILITY_DOCK_SURFACES.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`Missing ${id} dock surface.`);
  return found;
}

describe("the right sidebar surface", () => {
  it("puts every tool's toolbar on the dock's own rail", () => {
    const rail = dockStylesheet.match(/\.right-utility-dock__tool\s+:is\(([^)]*)\)\s*\{([^}]*)\}/);
    expect(rail).not.toBeNull();
    for (const toolbar of [
      ".code-file-explorer__head",
      ".code-delivery-pane__toolbar",
      ".code-diff-pane__toolbar",
      ".browser-workspace__chrome",
      ".side-chat__header",
    ]) {
      expect(rail?.[1]).toContain(toolbar);
    }
    expect(rail?.[2]).toMatch(/min-height:\s*var\(--oct-title-rail-h\)/);
    expect(rail?.[2]).toMatch(/background:\s*transparent/);
  });

  it("keeps Add tool beside the visible tabs and draws the tab in front like a thread tab", () => {
    expect(ruleBody(dockStylesheet, ".dock-tool-strip")).toMatch(/flex:\s*0\s+1\s+auto/);
    // Both strips use the shared recipe, including distinct hover and selected
    // fills and a stable close target that does not shift the tab label.
    const selected = ruleBody(
      sharedStylesheet,
      '.content-tab:has([role="tab"][aria-selected="true"])',
    );
    expect(selected).toMatch(/background:\s*var\(--octant-control\)/);
    expect(selected).toMatch(/box-shadow:\s*inset 0 0 0 1px var\(--octant-border\)/);
    expect(ruleBody(sharedStylesheet, ".content-tab:hover")).toMatch(
      /background:\s*var\(--oct-fg-soft\)/,
    );
    expect(ruleBody(sharedStylesheet, ".content-tab")).toMatch(/height:\s*26px/);
    expect(ruleBody(sharedStylesheet, ".content-tab > .content-tab__close")).toMatch(
      /width:\s*22px/,
    );
    for (const selector of [
      ".content-tab > .content-tab__select",
      ".content-tab > .content-tab__close",
    ]) {
      expect(ruleBody(sharedStylesheet, selector)).toMatch(/transform:\s*none/);
    }
    expect(dockStylesheet).not.toContain("--oct-radius-xs");
    expect(ruleBody(dockStylesheet, ".dock-tool-strip__tab")).not.toMatch(/overflow:\s*hidden/);
  });
  it("shows the active thread work map with no tool open", async () => {
    const user = userEvent.setup();
    const onOpenTab = vi.fn();
    render(
      <RightUtilityDockSurface
        launchableSurfaces={[browser, terminal, files]}
        onCloseTab={vi.fn()}
        onOpenTab={onOpenTab}
        onSelectSurface={vi.fn()}
        resolution={{ kind: "closed", reason: "no-surface" }}
        tabs={[]}
      />,
    );

    expect(screen.getByRole("heading", { name: "Tools" })).toBeVisible();
    // One line per tool; what it opens is the row's hover description.
    expect(screen.getByRole("button", { name: "Browser" })).toHaveAttribute(
      "title",
      "Inspect live web activity",
    );
    expect(screen.getByRole("button", { name: "Files" })).toHaveAttribute(
      "title",
      "Browse the active checkout",
    );
    // The body already lists every tool; a second entry point beside an
    // empty strip would be a control with nothing to add.
    expect(screen.queryByRole("button", { name: "Add tool" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Terminal" }));
    expect(onOpenTab).toHaveBeenCalledWith("terminal");
    expect(screen.queryByRole("tab", { name: "Thread tools" })).not.toBeInTheDocument();
  });

  it("groups a long tool list under what each tool looks at", () => {
    render(
      <RightUtilityDockSurface
        launchableSurfaces={[
          surface("environment"),
          browser,
          terminal,
          surface("android-emulator"),
        ]}
        onCloseTab={vi.fn()}
        onOpenTab={vi.fn()}
        onSelectSurface={vi.fn()}
        resolution={{ kind: "closed", reason: "no-surface" }}
        tabs={[]}
      />,
    );

    const thread = screen.getByRole("group", { name: "This thread" });
    const workspace = screen.getByRole("group", { name: "Workspace" });
    const devices = screen.getByRole("group", { name: "Devices" });
    expect(within(thread).getByRole("button", { name: "Environment" })).toBeVisible();
    expect(within(workspace).getByRole("button", { name: "Browser" })).toBeVisible();
    expect(within(workspace).getByRole("button", { name: "Terminal" })).toBeVisible();
    expect(within(devices).getByRole("button", { name: "Android emulator" })).toBeVisible();
  });

  it("selects and hides open tools without stopping their strip", async () => {
    const user = userEvent.setup();
    const onCloseTab = vi.fn();
    const onSelectSurface = vi.fn();
    render(
      <RightUtilityDockSurface
        browser={<p>Live Browser</p>}
        launchableSurfaces={[browser, terminal]}
        onCloseTab={onCloseTab}
        onOpenTab={vi.fn()}
        onSelectSurface={onSelectSurface}
        resolution={{ kind: "surface", surface: browser }}
        tabs={[browser, terminal]}
        terminal={<p>Live Terminal</p>}
      />,
    );

    expect(screen.getByRole("tab", { name: "Browser" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Live Browser")).toBeVisible();
    expect(screen.queryByText("Live Terminal")).not.toBeInTheDocument();
    const tabs = screen.getByRole("tablist", { name: "Open tools" }).parentElement;
    if (tabs === null) throw new Error("Expected the right-dock tab cluster.");
    expect(tabs).toHaveClass("right-utility-dock__tabs");
    expect(within(tabs).getByRole("button", { name: "Add tool" })).toBeVisible();
    await user.click(screen.getByRole("tab", { name: "Terminal" }));
    expect(onSelectSurface).toHaveBeenCalledWith("terminal");
    await user.click(screen.getByRole("button", { name: "Hide Browser" }));
    expect(onCloseTab).toHaveBeenCalledWith("browser");
    // Browser and Terminal are repeatable workspaces, so the launcher remains
    // available even when one instance of each is already open.
    expect(screen.getByRole("button", { name: "Add tool" })).toBeVisible();
  });

  it("moves between tools from the keyboard without leaving the strip", async () => {
    const user = userEvent.setup();
    const onSelectSurface = vi.fn();
    render(
      <RightUtilityDockSurface
        browser={<p>Live Browser</p>}
        launchableSurfaces={[browser, terminal]}
        onCloseTab={vi.fn()}
        onOpenTab={vi.fn()}
        onSelectSurface={onSelectSurface}
        resolution={{ kind: "surface", surface: browser }}
        tabs={[browser, terminal]}
        terminal={<p>Live Terminal</p>}
      />,
    );

    screen.getByRole("tab", { name: "Browser" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(onSelectSurface).toHaveBeenCalledWith("terminal");
  });

  it("never renders the previous tool's content for an unavailable active thread", () => {
    render(
      <RightUtilityDockSurface
        browser={<p>Previous thread Browser</p>}
        launchableSurfaces={[browser]}
        onCloseTab={vi.fn()}
        onOpenTab={vi.fn()}
        onSelectSurface={vi.fn()}
        resolution={{ kind: "unavailable", reason: "thread-required", surface: browser }}
        tabs={[browser]}
      />,
    );

    expect(screen.queryByText("Previous thread Browser")).toBeNull();
    expect(screen.getByRole("heading", { name: "Browser is unavailable" })).toBeVisible();
  });

  it("says what Tests does, like every other tool row", () => {
    render(
      <RightUtilityDockSurface
        launchableSurfaces={[{ ...browser, id: "tests" as never, label: "Tests" }]}
        onCloseTab={vi.fn()}
        onOpenTab={vi.fn()}
        onSelectSurface={vi.fn()}
        resolution={{ kind: "closed", reason: "no-surface" }}
        tabs={[]}
      />,
    );

    // "Tests: Open this tool" beside twelve rows that each name what they do
    // reads as a row nobody finished.
    const row = screen.getByRole("button", { name: "Tests" });
    expect(row).toHaveAttribute("title", "Run this checkout's tests");
  });

  it("uses a generic detail for an unknown launchable tool", () => {
    render(
      <RightUtilityDockSurface
        launchableSurfaces={[{ ...browser, id: "unknown-tool" as never, label: "Custom tool" }]}
        onCloseTab={vi.fn()}
        onOpenTab={vi.fn()}
        onSelectSurface={vi.fn()}
        resolution={{ kind: "closed", reason: "no-surface" }}
        tabs={[]}
      />,
    );

    expect(screen.getByRole("button", { name: "Custom tool" })).toHaveAttribute(
      "title",
      "Open this tool",
    );
    expect(screen.queryByText("Run discovered repository tests")).not.toBeInTheDocument();
  });
});

function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "s"));
  return match?.[1] ?? "";
}
