import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RIGHT_UTILITY_DOCK_SURFACES } from "./rightUtilityDockModel";
import { RightUtilityDockSurface } from "./RightUtilityDockSurface";

const browser = surface("browser");
const terminal = surface("terminal");
const files = surface("files");
const dockStylesheet = readFileSync(resolve(import.meta.dirname, "../styles/dock.css"), "utf8");

function surface(id: "browser" | "terminal" | "files") {
  const found = RIGHT_UTILITY_DOCK_SURFACES.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`Missing ${id} dock surface.`);
  return found;
}

describe("the right sidebar surface", () => {
  it("keeps Add tool beside the visible tabs and draws the tab in front like a thread tab", () => {
    expect(ruleBody(dockStylesheet, ".dock-tool-strip")).toMatch(/flex:\s*0\s+1\s+auto/);
    // Selected and hovered must not share one tint, or pointing at a tab looks
    // the same as being on it. The tab in front takes the selection fill and a
    // hairline edge: the same treatment the workspace thread tabs use, so the
    // two strips read as one grammar.
    const selected = ruleBody(
      dockStylesheet,
      '.dock-tool-strip__tab:has(.dock-tool-strip__select[aria-selected="true"])',
    );
    expect(selected).toMatch(/background:\s*var\(--octant-selection\)/);
    expect(selected).toMatch(/box-shadow:\s*inset 0 0 0 1px var\(--octant-border\)/);
    expect(ruleBody(dockStylesheet, ".dock-tool-strip__tab:hover")).not.toMatch(
      /var\(--octant-selection\)/,
    );
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

    expect(screen.getByRole("heading", { name: "Current work" })).toBeVisible();
    expect(screen.getByText("Tools available for the active thread.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Browser" })).toHaveTextContent(
      "Inspect live web activity",
    );
    expect(screen.getByRole("button", { name: "Files" })).toHaveTextContent(
      "Browse the active checkout",
    );
    // The body already lists every tool; a second entry point beside an
    // empty strip would be a control with nothing to add.
    expect(screen.queryByRole("button", { name: "Add tool" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Terminal" }));
    expect(onOpenTab).toHaveBeenCalledWith("terminal");
    expect(screen.queryByRole("tab", { name: "Thread tools" })).not.toBeInTheDocument();
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
    expect(
      screen.getByRole("heading", { name: "Browser has nothing to describe here" }),
    ).toBeVisible();
  });
});

function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "s"));
  return match?.[1] ?? "";
}
