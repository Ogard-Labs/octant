import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  RIGHT_UTILITY_DOCK_SURFACES,
  type RightUtilityDockSurfaceId,
} from "./rightUtilityDockModel";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import { decodeProjectId } from "@octant/contracts/projects";
import { RightUtilityDockSurface } from "./RightUtilityDockSurface";
import { StartQuickToolsContext, StartQuickToolsPlacementContext } from "./StartQuickTools";

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
    // A neutral ink wash, not the theme-tinted control fill with a ring.
    expect(selected).toMatch(
      /background:\s*color-mix\(in oklab, var\(--oct-fg\) 9%, transparent\)/,
    );
    expect(selected).not.toMatch(/box-shadow/);
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
  it("offers Environment by name and the common tools as icons in the title band before any opens", async () => {
    const user = userEvent.setup();
    const onOpenTab = vi.fn();
    render(
      <RightUtilityDockSurface
        launchableSurfaces={[browser, terminal, files, surface("environment"), surface("plan")]}
        onCloseTab={vi.fn()}
        onOpenTab={onOpenTab}
        onSelectSurface={vi.fn()}
        resolution={{ kind: "closed", reason: "no-surface" }}
        tabs={[]}
      />,
    );

    const band = screen.getByRole("group", { name: "Quick tools" });
    const tools = within(band).getAllByRole("button");
    expect(tools.map((tool) => tool.getAttribute("aria-label"))).toEqual([
      "Open Environment",
      "Open Terminal",
      "Open Browser",
      "Open Files",
    ]);
    expect(tools[0]).toHaveTextContent("Environment");
    expect(tools[1]).not.toHaveTextContent("Terminal");
    const terminalTool = tools[1];
    if (terminalTool === undefined) throw new Error("Expected the Terminal tool.");
    await user.click(terminalTool);
    expect(onOpenTab).toHaveBeenCalledWith("terminal");
  });

  it("lists every launchable tool in Add tool with no tool open, and shows no tool grid", async () => {
    const user = userEvent.setup();
    const onOpenTab = vi.fn();
    render(
      <RightUtilityDockSurface
        launchableSurfaces={[browser, terminal, files, surface("plan")]}
        onCloseTab={vi.fn()}
        onOpenTab={onOpenTab}
        onSelectSurface={vi.fn()}
        resolution={{ kind: "closed", reason: "no-surface" }}
        tabs={[]}
      />,
    );

    expect(screen.queryByRole("heading", { name: "Tools" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Browser" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Add tool" }));
    await screen.findByRole("menuitem", { name: "Browser" });
    const menu = within(document.body);
    for (const name of ["Browser", "Terminal", "Files", "Plan"]) {
      expect(menu.getByRole("menuitem", { name })).toBeVisible();
    }
    await user.click(menu.getByRole("menuitem", { name: "Plan" }));
    expect(onOpenTab).toHaveBeenCalledWith("plan");
  });

  it("moves focus into the tool a quick tool opened, because the quick tools are replaced by the tab strip", async () => {
    const user = userEvent.setup();
    function Dock() {
      const [open, setOpen] = useState(false);
      return (
        <RightUtilityDockSurface
          browser={<p>Live Browser</p>}
          launchableSurfaces={[browser, terminal]}
          onCloseTab={vi.fn()}
          onOpenTab={() => setOpen(true)}
          onSelectSurface={vi.fn()}
          resolution={
            open ? { kind: "surface", surface: browser } : { kind: "closed", reason: "no-surface" }
          }
          tabs={open ? [browser] : []}
        />
      );
    }
    render(<Dock />);

    within(screen.getByRole("group", { name: "Quick tools" }))
      .getByRole("button", { name: "Open Browser" })
      .focus();
    await user.keyboard("{Enter}");

    expect(screen.getByRole("region", { name: "Browser" })).toHaveFocus();
    expect(screen.getByText("Live Browser")).toBeVisible();
  });

  it("groups a long Add tool list under what each tool looks at", async () => {
    const user = userEvent.setup();
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

    await user.click(screen.getByRole("button", { name: "Add tool" }));
    const thread = await screen.findByRole("group", { name: "Thread tools" });
    const workspace = screen.getByRole("group", { name: "Workspace" });
    const devices = screen.getByRole("group", { name: "Devices" });
    expect(within(thread).getByRole("menuitem", { name: "Environment" })).toBeVisible();
    expect(within(workspace).getByRole("menuitem", { name: "Browser" })).toBeVisible();
    expect(within(workspace).getByRole("menuitem", { name: "Terminal" })).toBeVisible();
    expect(within(devices).getByRole("menuitem", { name: "Android emulator" })).toBeVisible();
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

  it("shows several Browsers as one Browser tool with a row of pages", async () => {
    const user = userEvent.setup();
    const onCloseTab = vi.fn();
    const onOpenTab = vi.fn();
    const onSelectSurface = vi.fn();
    const page = (id: string, label: string) => ({ id, label, surface: browser });
    render(
      <RightUtilityDockSurface
        activeTabId="browser-2"
        launchableSurfaces={[browser, terminal]}
        onCloseTab={onCloseTab}
        onOpenTab={onOpenTab}
        onSelectSurface={onSelectSurface}
        renderTab={(tab) => <p>{`Live ${tab.label}`}</p>}
        resolution={{ kind: "surface", surface: browser }}
        tabs={[page("browser-1", "Browser 1"), terminal, page("browser-2", "Browser 2")]}
      />,
    );

    // The title band names the Browser once, in its first page's place,
    // whichever page shows.
    const strip = screen.getByRole("tablist", { name: "Open tools" });
    expect(
      within(strip)
        .getAllByRole("tab")
        .map((tab) => tab.textContent),
    ).toEqual(["Browser", "Terminal"]);
    expect(within(strip).getByRole("tab", { name: "Browser" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const pages = screen.getByRole("tablist", { name: "Browser pages" });
    expect(within(pages).getByRole("tab", { name: "Browser 2" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText("Live Browser 2")).toBeVisible();
    await user.click(within(pages).getByRole("tab", { name: "Browser 1" }));
    expect(onSelectSurface).toHaveBeenCalledWith("browser-1");
    await user.click(within(pages).getByRole("button", { name: "New Browser page" }));
    expect(onOpenTab).toHaveBeenCalledWith("browser");
    // Closing the Browser in the band closes every page.
    await user.click(within(strip).getByRole("button", { name: "Hide Browser" }));
    expect(onCloseTab.mock.calls.map(([id]) => id)).toEqual(["browser-1", "browser-2"]);
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

  it("shows the common tools disabled, with no Add tool, while the pane's task has no thread yet", async () => {
    const user = userEvent.setup();
    const onOpenTab = vi.fn();
    render(
      <RightUtilityDockSurface
        launchableSurfaces={[]}
        onCloseTab={vi.fn()}
        onOpenTab={onOpenTab}
        onSelectSurface={vi.fn()}
        resolution={{ kind: "closed", reason: "no-surface" }}
        tabs={[]}
        toolsAwaitingThread={[surface("environment"), terminal, browser, files]}
      />,
    );

    const band = screen.getByRole("group", { name: "Quick tools" });
    const tools = within(band).getAllByRole("button");
    expect(tools.map((tool) => tool.getAttribute("aria-label"))).toEqual([
      "Open Environment",
      "Open Terminal",
      "Open Browser",
      "Open Files",
    ]);
    for (const tool of tools) {
      expect(tool).toBeDisabled();
      expect(tool).toHaveAttribute("title", "Available once the task starts");
      expect(tool).toHaveAttribute("aria-description", "Available once the task starts");
    }
    expect(screen.queryByRole("button", { name: "Add tool" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Tools open once the task starts" })).toBeVisible();
    const terminalTool = tools[1];
    if (terminalTool === undefined) throw new Error("Expected the Terminal tool.");
    await user.click(terminalTool);
    expect(onOpenTab).not.toHaveBeenCalled();
  });

  it("holds the chosen Project's terminal and browser while the new task waits for its thread", () => {
    const services = {
      hostId: LOCAL_HOST_ID,
      projectTerminalClient: { execute: vi.fn() } as never,
      projectBrowserClient: { execute: vi.fn() } as never,
    };
    render(
      <StartQuickToolsContext.Provider value={services}>
        <StartQuickToolsPlacementContext.Provider
          value={{
            projectId: decodeProjectId("30000000-0000-4000-8000-000000000001"),
            chooseProject: vi.fn(),
          }}
        >
          <RightUtilityDockSurface
            launchableSurfaces={[]}
            onCloseTab={vi.fn()}
            onOpenTab={vi.fn()}
            onSelectSurface={vi.fn()}
            resolution={{ kind: "closed", reason: "no-surface" }}
            tabs={[]}
            toolsAwaitingThread={[terminal, browser]}
          />
        </StartQuickToolsPlacementContext.Provider>
      </StartQuickToolsContext.Provider>,
    );

    const projectTools = screen.getByRole("complementary", { name: "Project tools" });
    expect(within(projectTools).getByRole("button", { name: "Terminal" })).toBeEnabled();
    expect(within(projectTools).getByRole("button", { name: "Browser" })).toBeEnabled();
    expect(within(projectTools).getByText("Other tools open once the task starts")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Tools open once the task starts" })).toBeNull();
  });
});

function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "s"));
  return match?.[1] ?? "";
}
