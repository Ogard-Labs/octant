import { createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  RIGHT_UTILITY_DOCK_SURFACES,
  type RightUtilityDockSurfaceId,
} from "./rightUtilityDockModel";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import { decodeProjectId } from "@octant/contracts/projects";
import { ServerCodeProjectsContext } from "../projects/serverProjectEntries";
import { RightUtilityDockSurface, type DockTileControls } from "./RightUtilityDockSurface";
import {
  addUtilityTabState,
  closeUtilityTabState,
  hideUtilityCard,
  hideUtilityTile,
  minimiseUtilityTool,
  restoreUtilityTool,
  moveUtilityTile,
  openUtilityTabBesideState,
  openUtilityTabState,
  resizeUtilityTileColumn,
  resizeUtilityTileColumns,
  selectUtilityTabState,
  showUtilityTabAlone,
  showUtilityTabBelow,
  showUtilityTabBeside,
  type ThreadUtilityDockState,
} from "./rightUtilityDockSelection";
import { StartQuickToolsContext, StartQuickToolsPlacementContext } from "./StartQuickTools";
import { DockMiniCard } from "./DockShelf";

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

  it("offers a server Project's terminal and no browser of this computer", () => {
    const projectId = decodeProjectId("30000000-0000-4000-8000-000000000002");
    const services = {
      hostId: LOCAL_HOST_ID,
      projectTerminalClient: { execute: vi.fn() } as never,
      projectBrowserClient: { execute: vi.fn() } as never,
      extraFolders: () => ["/Users/person/elsewhere"],
    };
    render(
      <ServerCodeProjectsContext.Provider
        value={{
          projects: [{ projectId, name: "Service", location: "web1:/srv/service" }],
          workProjects: [],
          refresh: vi.fn(),
        }}
      >
        <StartQuickToolsContext.Provider value={services}>
          <StartQuickToolsPlacementContext.Provider value={{ projectId, chooseProject: vi.fn() }}>
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
        </StartQuickToolsContext.Provider>
      </ServerCodeProjectsContext.Provider>,
    );

    const projectTools = screen.getByRole("complementary", { name: "Project tools" });
    expect(
      within(projectTools)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Terminal"]);
  });
});

function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "s"));
  return match?.[1] ?? "";
}

describe("tool tiles in the right sidebar", () => {
  const mounts = new Map<string, number>();

  function Probe(props: { readonly id: string }) {
    useEffect(() => {
      mounts.set(props.id, (mounts.get(props.id) ?? 0) + 1);
    }, [props.id]);
    return <p>{`Live ${props.id}`}</p>;
  }

  /** A tile's menu: Arrange <tool>, then the item. */
  async function arrange(user: ReturnType<typeof userEvent.setup>, tool: string, item: string) {
    await user.click(
      within(screen.getByRole("region", { name: tool })).getByRole("button", {
        name: `Arrange ${tool}`,
      }),
    );
    await user.click(await screen.findByRole("menuitem", { name: item }));
  }

  function opened(...ids: ReadonlyArray<RightUtilityDockSurfaceId>): ThreadUtilityDockState {
    let state: ThreadUtilityDockState = { tabs: [] };
    for (const id of ids) state = openUtilityTabState(state, id);
    return state;
  }

  /** Files left, iOS Simulator right and focused; Canvas open but hidden. */
  function tiledState() {
    return showUtilityTabBeside(opened("ios-simulator", "canvas", "files"), "ios-simulator");
  }

  function TiledDock(props: {
    readonly initial: ThreadUtilityDockState;
    readonly launchable?: ReadonlyArray<(typeof RIGHT_UTILITY_DOCK_SURFACES)[number]>;
    readonly narrow?: boolean;
    readonly resolveSurface?: DockTileControls["resolveSurface"];
  }) {
    const [state, setState] = useState(props.initial);
    const tabs = state.tabs.map((tab) => ({
      id: tab.id,
      label: surface(tab.surface).label,
      surface: surface(tab.surface),
    }));
    const active = state.tabs.find((tab) => tab.id === state.active);
    // One card for each minimised tool, standing for its first tab.
    const cards = ["browser", "terminal"].flatMap((id) => {
      const tab = state.tabs.find((candidate) => candidate.surface === id);
      return tab !== undefined && state.minimised?.includes(tab.id) === true
        ? [{ tabId: tab.id, surface: id as "browser" | "terminal" }]
        : [];
    });
    return (
      <RightUtilityDockSurface
        {...(state.active === undefined ? {} : { activeTabId: state.active })}
        {...(state.lastBrowser === undefined ? {} : { lastBrowserTabId: state.lastBrowser })}
        launchableSurfaces={props.launchable ?? []}
        onCloseTab={(id) => setState((current) => closeUtilityTabState(current, id))}
        onOpenTab={vi.fn()}
        onSelectSurface={(id) => setState((current) => selectUtilityTabState(current, id))}
        overview={<p>Thread overview</p>}
        renderTab={(tab) => <Probe id={tab.id} />}
        resolution={
          active === undefined
            ? { kind: "closed", reason: "no-surface" }
            : { kind: "surface", surface: surface(active.surface) }
        }
        shelf={{
          entries: cards,
          onHide: (id) => setState((current) => hideUtilityCard(current, id)),
          onShow: (id) => setState((current) => restoreUtilityTool(current, id)),
          renderCard: (entry, controls) => (
            <DockMiniCard
              onHide={controls.onHide}
              onExpand={controls.onShow}
              previewLabel={`Show ${surface(entry.surface).label}, live preview`}
              surface={entry.surface}
              title={surface(entry.surface).label}
              toolLabel={surface(entry.surface).label}
            >
              <p>{`Preview of ${entry.surface}`}</p>
            </DockMiniCard>
          ),
        }}
        tabs={tabs}
        tiles={{
          ...(state.layout === undefined ? {} : { layout: state.layout }),
          ...(state.minimised === undefined ? {} : { minimised: state.minimised }),
          narrow: props.narrow ?? false,
          resolveSurface:
            props.resolveSurface ?? ((id) => ({ kind: "surface", surface: surface(id) })),
          onHideTile: (id) => setState((current) => hideUtilityTile(current, id)),
          onMinimise: (id) => setState((current) => minimiseUtilityTool(current, id)),
          onMove: (id, direction) => setState((current) => moveUtilityTile(current, id, direction)),
          onOpenBeside: (id) =>
            setState((current) => openUtilityTabBesideState(current, id, `new-${id}`)),
          onResizeColumn: (index, shares) =>
            setState((current) => resizeUtilityTileColumn(current, index, shares)),
          onResizeColumns: (shares) =>
            setState((current) => resizeUtilityTileColumns(current, shares)),
          onShowAlone: (id) => setState((current) => showUtilityTabAlone(current, id)),
          onShowBelow: (id) => setState((current) => showUtilityTabBelow(current, id)),
          onShowBeside: (id) => setState((current) => showUtilityTabBeside(current, id)),
        }}
      />
    );
  }

  it("shows two open tools together, each live, with the focused one marked", () => {
    render(<TiledDock initial={tiledState()} />);
    const files = screen.getByRole("region", { name: "Files" });
    const simulator = screen.getByRole("region", { name: "iOS Simulator" });
    expect(within(files).getByText("Live files")).toBeVisible();
    expect(within(simulator).getByText("Live ios-simulator")).toBeVisible();
    expect(simulator).toHaveAttribute("data-focused", "true");
    expect(files).not.toHaveAttribute("data-focused");
    expect(screen.queryByText("Live canvas")).not.toBeInTheDocument();
  });

  it("replaces only the focused tile when a hidden tab is chosen", async () => {
    const user = userEvent.setup();
    render(<TiledDock initial={tiledState()} />);
    await user.click(screen.getByRole("tab", { name: "Canvas" }));
    expect(screen.getByRole("region", { name: "Canvas" })).toHaveAttribute("data-focused", "true");
    expect(screen.getByRole("region", { name: "Files" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "iOS Simulator" })).not.toBeInTheDocument();
  });

  it("keeps a shown tool mounted while focus moves, a divider moves and another tile joins", async () => {
    const user = userEvent.setup();
    mounts.clear();
    render(<TiledDock initial={tiledState()} />);
    expect(mounts.get("files")).toBe(1);
    expect(mounts.get("ios-simulator")).toBe(1);

    await user.click(within(screen.getByRole("region", { name: "Files" })).getByText("Live files"));
    expect(screen.getByRole("region", { name: "Files" })).toHaveAttribute("data-focused", "true");

    screen.getByRole("separator", { name: "Resize Files and iOS Simulator" }).focus();
    await user.keyboard("{ArrowRight}");

    await user.pointer({
      target: screen.getByRole("tab", { name: "Canvas" }),
      keys: "[MouseRight]",
    });
    await user.click(await screen.findByRole("menuitem", { name: "Show below" }));
    expect(screen.getByRole("region", { name: "Canvas" })).toBeVisible();

    expect(mounts.get("files")).toBe(1);
    expect(mounts.get("ios-simulator")).toBe(1);
  });

  it("hides a tile without closing its tool", async () => {
    const user = userEvent.setup();
    render(<TiledDock initial={tiledState()} />);
    await arrange(user, "iOS Simulator", "Hide from view");
    expect(screen.queryByText("Live ios-simulator")).not.toBeInTheDocument();
    expect(screen.getByText("Live files")).toBeVisible();
    expect(screen.getByRole("tab", { name: "iOS Simulator" })).toBeVisible();
  });

  it("says a tile is unavailable inside that tile and shows no other pane's content", () => {
    render(
      <TiledDock
        initial={tiledState()}
        resolveSurface={(id) =>
          id === "files"
            ? { kind: "unavailable", reason: "thread-required", surface: surface(id) }
            : { kind: "surface", surface: surface(id) }
        }
      />,
    );
    const files = screen.getByRole("region", { name: "Files" });
    expect(within(files).getByText("Files is unavailable")).toBeVisible();
    expect(within(files).queryByText("Live files")).not.toBeInTheDocument();
    expect(screen.getByText("Live ios-simulator")).toBeVisible();
  });

  it("shows only the focused tool in the narrow presentation", () => {
    render(<TiledDock initial={tiledState()} narrow />);
    expect(screen.getByText("Live ios-simulator")).toBeVisible();
    expect(screen.queryByText("Live files")).not.toBeInTheDocument();
  });

  it("lists only the open tools that are not shown in the strip while tiled", () => {
    render(<TiledDock initial={tiledState()} />);
    const strip = screen.getByRole("tablist", { name: "Open tools" });
    expect(
      within(strip)
        .getAllByRole("tab")
        .map((tab) => tab.textContent),
    ).toEqual(["Canvas"]);
    expect(within(strip).getByRole("tab", { name: "Canvas" })).toHaveAttribute("tabindex", "0");
  });

  it("has no strip tablist when every open tool is shown, and keeps one bar per tile", () => {
    render(<TiledDock initial={showUtilityTabBeside(opened("files", "canvas"), "files")} />);
    expect(screen.queryByRole("tablist", { name: "Open tools" })).not.toBeInTheDocument();
    for (const name of ["Files", "Canvas"]) {
      const region = screen.getByRole("region", { name });
      expect(region.querySelectorAll(".dock-tile__bar")).toHaveLength(1);
      expect(within(region).getAllByText(name)).toHaveLength(1);
    }
  });

  it("gives a single tool no bar and keeps the ordinary strip", () => {
    render(<TiledDock initial={opened("files", "canvas")} />);
    expect(document.querySelector(".dock-tile__bar")).toBeNull();
    expect(
      within(screen.getByRole("tablist", { name: "Open tools" })).getAllByRole("tab"),
    ).toHaveLength(2);
  });

  it("resizes a column pair from the keyboard through a separator named for the tools it divides", async () => {
    const user = userEvent.setup();
    render(<TiledDock initial={tiledState()} />);
    const divider = screen.getByRole("separator", { name: "Resize Files and iOS Simulator" });
    expect(divider).toHaveAttribute("aria-orientation", "vertical");
    const before = Number(divider.getAttribute("aria-valuenow"));
    divider.focus();
    await user.keyboard("{ArrowRight}");
    expect(
      Number(
        screen
          .getByRole("separator", { name: "Resize Files and iOS Simulator" })
          .getAttribute("aria-valuenow"),
      ),
    ).toBeGreaterThan(before);
  });

  async function menuOf(tab: string) {
    const user = userEvent.setup();
    await user.pointer({ target: screen.getByRole("tab", { name: tab }), keys: "[MouseRight]" });
    return (await screen.findAllByRole("menuitem")).map((item) => item.textContent);
  }

  it("offers Show beside and Show below for a tool that is not focused", async () => {
    render(<TiledDock initial={opened("files", "canvas")} />);
    expect(await menuOf("Files")).toEqual(["Show beside", "Show below"]);
  });

  it("offers the moves that are possible, then Show alone and Hide from view, in a tile's Arrange menu", async () => {
    const user = userEvent.setup();
    render(<TiledDock initial={tiledState()} />);
    const items = async (tool: string) => {
      await user.click(
        within(screen.getByRole("region", { name: tool })).getByRole("button", {
          name: `Arrange ${tool}`,
        }),
      );
      const found = (await screen.findAllByRole("menuitem")).map((item) => item.textContent);
      await user.keyboard("{Escape}");
      return found;
    };
    expect(await items("Files")).toEqual(["Move right", "Show alone", "Hide from view"]);
    expect(await items("iOS Simulator")).toEqual(["Move left", "Show alone", "Hide from view"]);
  });

  it("offers Show beside and Show below for a hidden tab in the strip", async () => {
    render(<TiledDock initial={tiledState()} />);
    expect(await menuOf("Canvas")).toEqual(["Show beside", "Show below"]);
  });

  it("closes a tool from its tile, as its strip tab's close does", async () => {
    const user = userEvent.setup();
    render(<TiledDock initial={tiledState()} />);
    await user.click(screen.getByRole("button", { name: "Close Files" }));
    expect(screen.queryByText("Live files")).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Files" })).not.toBeInTheDocument();
  });

  it("offers no menu for the only tool on screen", () => {
    render(<TiledDock initial={opened("files")} />);
    const tab = screen.getByRole("tab", { name: "Files" });
    fireEvent.contextMenu(tab);
    expect(screen.queryByRole("menuitem")).not.toBeInTheDocument();
  });

  it("tiles a tab dropped on the right third of the dock body", async () => {
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(() => DOMRect.fromRect({ x: 0, y: 0, width: 300, height: 300 }));
    try {
      render(<TiledDock initial={opened("files", "canvas")} />);
      const transfer = { setData: vi.fn(), effectAllowed: "" };
      fireEvent.dragStart(screen.getByRole("tab", { name: "Files" }), { dataTransfer: transfer });
      const shield = document.querySelector(".dock-tiles__drag-shield");
      if (shield === null) throw new Error("Expected the drop target over the dock body.");
      // jsdom's drag events carry no pointer position, so it is set directly.
      const dragged = (kind: "dragOver" | "drop") => {
        const event = createEvent[kind](shield);
        Object.defineProperties(event, {
          clientX: { value: 280 },
          clientY: { value: 100 },
        });
        fireEvent(shield, event);
      };
      dragged("dragOver");
      expect(shield.querySelector(".dock-tiles__drop")).toHaveAttribute("data-drop-edge", "right");
      dragged("drop");
      await waitFor(() => expect(screen.getByRole("region", { name: "Files" })).toBeVisible());
      expect(screen.getByRole("region", { name: "Canvas" })).toBeVisible();
      expect(document.querySelector(".dock-tiles__drag-shield")).toBeNull();
    } finally {
      rect.mockRestore();
    }
  });

  /** jsdom's pointer events carry no position, so each one is built and given its own. */
  function pointer(
    kind: "pointerDown" | "pointerMove" | "pointerUp" | "pointerCancel",
    target: Element,
    clientX = 0,
  ) {
    const event = createEvent[kind](target, { button: 0 });
    Object.defineProperties(event, { clientX: { value: clientX }, pointerId: { value: 1 } });
    fireEvent(target, event);
  }

  it("keeps the first tool mounted when a second one is shown and when it is hidden again", async () => {
    const user = userEvent.setup();
    mounts.clear();
    render(<TiledDock initial={opened("files", "canvas")} />);
    expect(mounts.get("canvas")).toBe(1);
    await user.pointer({
      target: screen.getByRole("tab", { name: "Files" }),
      keys: "[MouseRight]",
    });
    await user.click(await screen.findByRole("menuitem", { name: "Show beside" }));
    expect(screen.getByRole("region", { name: "Files" })).toBeVisible();
    await arrange(user, "Files", "Hide from view");
    expect(screen.queryByRole("region", { name: "Files" })).not.toBeInTheDocument();
    expect(mounts.get("canvas")).toBe(1);
    expect(mounts.get("files")).toBe(1);
  });

  it("keeps the second column's tool mounted when the only tile of the first column is hidden", async () => {
    const user = userEvent.setup();
    mounts.clear();
    render(<TiledDock initial={tiledState()} />);
    await arrange(user, "Files", "Hide from view");
    expect(screen.getByText("Live ios-simulator")).toBeVisible();
    expect(mounts.get("ios-simulator")).toBe(1);
  });

  it("keeps a tool mounted when its tile is moved", async () => {
    const user = userEvent.setup();
    mounts.clear();
    render(<TiledDock initial={tiledState()} />);
    await arrange(user, "iOS Simulator", "Move left");
    expect(screen.getByRole("region", { name: "iOS Simulator" })).toBeVisible();
    await arrange(user, "iOS Simulator", "Move down");
    expect(mounts.get("files")).toBe(1);
    expect(mounts.get("ios-simulator")).toBe(1);
  });

  it("keeps the other tiles on screen when the focused tile's tool is unavailable", () => {
    render(
      <TiledDock
        initial={tiledState()}
        resolveSurface={(id) =>
          id === "ios-simulator"
            ? { kind: "unavailable", reason: "thread-required", surface: surface(id) }
            : { kind: "surface", surface: surface(id) }
        }
      />,
    );
    expect(
      within(screen.getByRole("region", { name: "iOS Simulator" })).getByText(
        "iOS Simulator is unavailable",
      ),
    ).toBeVisible();
    expect(screen.getByText("Live files")).toBeVisible();
  });

  it("makes the Browser tile's bar its row of pages, naming the Browser once", () => {
    const pageOne = "10000000-0000-4000-8000-000000000001";
    const pageTwo = "10000000-0000-4000-8000-000000000002";
    let state = openUtilityTabState({ tabs: [] }, "files");
    state = addUtilityTabState(state, "browser", pageOne);
    state = addUtilityTabState(state, "browser", pageTwo);
    state = showUtilityTabBeside(state, "files");
    render(<TiledDock initial={state} />);
    const region = screen.getByRole("region", { name: "Browser" });
    const bar = region.querySelector(".dock-tile__bar");
    expect(bar).not.toBeNull();
    expect(
      within(bar as HTMLElement).getByRole("tablist", { name: "Browser pages" }),
    ).toBeVisible();
    expect(region.querySelectorAll(".dock-browser-pages")).toHaveLength(1);
    expect(
      within(screen.getByRole("tablist", { name: "Browser pages" })).getAllByRole("tab")[1],
    ).toHaveAttribute("aria-selected", "true");
  });

  it("moves keyboard focus to the tool's tab when its tile is hidden from its menu", async () => {
    const user = userEvent.setup();
    render(<TiledDock initial={tiledState()} />);
    await arrange(user, "Files", "Hide from view");
    await waitFor(() => expect(screen.getByRole("tab", { name: "Files" })).toHaveFocus());
  });

  it("focuses a tile when a pointer lands in content portalled into it from elsewhere", async () => {
    const user = userEvent.setup();
    function Portalled() {
      const [host, setHost] = useState<Element | null>(null);
      useEffect(() => {
        setHost(document.querySelector('[data-dock-tile="files"] .right-utility-dock__tool'));
      }, []);
      return host === null
        ? null
        : createPortal(<button type="button">Inside the portal</button>, host);
    }
    render(
      <>
        <TiledDock initial={tiledState()} />
        <Portalled />
      </>,
    );
    expect(screen.getByRole("region", { name: "iOS Simulator" })).toHaveAttribute(
      "data-focused",
      "true",
    );
    await user.click(screen.getByRole("button", { name: "Inside the portal" }));
    expect(screen.getByRole("region", { name: "Files" })).toHaveAttribute("data-focused", "true");
  });

  it("drops a divider's preview and its shield when the drag is cancelled", () => {
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(() => DOMRect.fromRect({ x: 0, y: 0, width: 1000, height: 600 }));
    try {
      render(<TiledDock initial={tiledState()} />);
      const divider = screen.getByRole("separator", { name: "Resize Files and iOS Simulator" });
      pointer("pointerDown", divider, 500);
      expect(document.querySelector(".dock-tiles__drag-shield")).not.toBeNull();
      pointer("pointerMove", divider, 700);
      expect(Number(divider.getAttribute("aria-valuenow"))).toBeGreaterThan(50);
      pointer("pointerCancel", divider, 700);
      expect(document.querySelector(".dock-tiles__drag-shield")).toBeNull();
      expect(
        screen
          .getByRole("separator", { name: "Resize Files and iOS Simulator" })
          .getAttribute("aria-valuenow"),
      ).toBe("50");
    } finally {
      rect.mockRestore();
    }
  });

  it("clears the drag shield when the divider under the pointer goes away", () => {
    const { rerender } = render(<TiledDock initial={tiledState()} />);
    pointer(
      "pointerDown",
      screen.getByRole("separator", { name: "Resize Files and iOS Simulator" }),
      500,
    );
    expect(document.querySelector(".dock-tiles__drag-shield")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close Files" }));
    rerender(<TiledDock initial={tiledState()} />);
    expect(document.querySelector(".dock-tiles__drag-shield")).toBeNull();
  });

  it("reports the range a separator can really reach and goes to its ends with Home and End", async () => {
    const user = userEvent.setup();
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(() => DOMRect.fromRect({ x: 0, y: 0, width: 600, height: 600 }));
    try {
      render(<TiledDock initial={tiledState()} />);
      const divider = () =>
        screen.getByRole("separator", { name: "Resize Files and iOS Simulator" });
      // Two 280px columns in 600px: the pair may trade only 280/600 to 320/600.
      expect(divider()).toHaveAttribute("aria-valuemin", "47");
      expect(divider()).toHaveAttribute("aria-valuemax", "53");
      divider().focus();
      await user.keyboard("{End}");
      expect(divider()).toHaveAttribute("aria-valuenow", "53");
      await user.keyboard("{Home}");
      expect(divider()).toHaveAttribute("aria-valuenow", "47");
    } finally {
      rect.mockRestore();
    }
  });

  it("stacks the columns when the area cannot give two columns 280px each", () => {
    const width = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockImplementation(function (this: HTMLElement) {
        return this.classList.contains("dock-tiles") ? 500 : 0;
      });
    try {
      render(<TiledDock initial={tiledState()} />);
      expect(document.querySelector(".dock-tiles")).toHaveAttribute("data-stacked", "true");
      // The columns stay resizable, along the vertical axis.
      expect(
        screen.getByRole("separator", { name: "Resize Files and iOS Simulator" }),
      ).toHaveAttribute("aria-orientation", "horizontal");
      expect(screen.getByRole("region", { name: "Files" })).toBeVisible();
    } finally {
      width.mockRestore();
    }
  });

  it("offers a tool beside the focused one from a header button, open tools first", async () => {
    const user = userEvent.setup();
    render(
      <TiledDock
        initial={opened("files", "canvas")}
        launchable={[surface("plan"), surface("browser"), surface("canvas")]}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Show another tool" }));
    const menu = await screen.findByRole("menu", { name: "Show another tool" });
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Files", "Plan", "Browser"]);
    await user.click(within(menu).getByRole("menuitem", { name: "Plan" }));
    expect(screen.getByRole("region", { name: "Plan" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Canvas" })).toBeVisible();
    expect(mounts.get("canvas")).toBeGreaterThan(0);
  });

  it("shows an open tool beside the focused tile from the header menu", async () => {
    const user = userEvent.setup();
    render(<TiledDock initial={opened("files", "canvas")} />);
    await user.click(screen.getByRole("button", { name: "Show another tool" }));
    await user.click(await screen.findByRole("menuitem", { name: "Files" }));
    expect(screen.getByRole("region", { name: "Files" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Canvas" })).toBeVisible();
  });

  it("has no show-beside button in the narrow dock or when no more tiles fit", () => {
    const { unmount } = render(<TiledDock initial={opened("files", "canvas")} narrow />);
    expect(screen.queryByRole("button", { name: "Show another tool" })).not.toBeInTheDocument();
    unmount();
    let full = opened("ios-simulator", "canvas", "files", "plan", "terminal", "tests");
    full = showUtilityTabBeside(full, "ios-simulator");
    full = showUtilityTabBelow(full, "canvas");
    full = showUtilityTabBelow(full, "files");
    full = showUtilityTabBeside(full, "plan");
    expect(full.layout?.columns.map((column) => column.tiles.length)).toEqual([1, 3]);
    render(<TiledDock initial={full} />);
    expect(screen.queryByRole("button", { name: "Show another tool" })).not.toBeInTheDocument();
  });

  const pixelsOf = (name: string, total: number) =>
    (Number.parseFloat(screen.getByRole("region", { name }).style.height) / 100) * total;

  function tileState(
    columns: ReadonlyArray<ReadonlyArray<readonly [RightUtilityDockSurfaceId, number]>>,
    shares: ReadonlyArray<number>,
    active: RightUtilityDockSurfaceId,
  ): ThreadUtilityDockState {
    return {
      tabs: columns.flat().map(([id]) => ({ id, surface: id })),
      active,
      layout: {
        columns: columns.map((tiles, index) => ({
          share: shares[index] ?? 1,
          tiles: tiles.map(([tabId, share]) => ({ tabId, share })),
        })),
      },
    };
  }

  it("keeps every tile at its floor height when one is added to a column already near it", () => {
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(() => DOMRect.fromRect({ x: 0, y: 0, width: 848, height: 848 }));
    try {
      // The shares an added third tile leaves a tile that was at its floor.
      render(
        <TiledDock
          initial={tileState(
            [
              [
                ["files", 0.11],
                ["canvas", 0.557],
                ["plan", 0.333],
              ],
              [["ios-simulator", 1]],
            ],
            [0.5, 0.5],
            "plan",
          )}
        />,
      );
      for (const name of ["Files", "Canvas", "Plan"]) {
        expect(pixelsOf(name, 848)).toBeGreaterThanOrEqual(139.5);
      }
    } finally {
      rect.mockRestore();
    }
  });

  it("keeps every tile at its floor height when the columns stack", () => {
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(() => DOMRect.fromRect({ x: 0, y: 0, width: 500, height: 700 }));
    const width = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockImplementation(function (this: HTMLElement) {
        return this.classList.contains("dock-tiles") ? 500 : 0;
      });
    try {
      render(
        <TiledDock
          initial={tileState(
            [
              [
                ["files", 0.9],
                ["canvas", 0.1],
              ],
              [["ios-simulator", 1]],
            ],
            [0.6, 0.4],
            "files",
          )}
        />,
      );
      expect(document.querySelector(".dock-tiles")).toHaveAttribute("data-stacked", "true");
      for (const name of ["Files", "Canvas", "iOS Simulator"]) {
        expect(pixelsOf(name, 700)).toBeGreaterThanOrEqual(139.5);
      }
    } finally {
      width.mockRestore();
      rect.mockRestore();
    }
  });

  it("scrolls with every tile at its floor when stacked tiles cannot fit the dock", () => {
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(() => DOMRect.fromRect({ x: 0, y: 0, width: 500, height: 200 }));
    const width = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockImplementation(function (this: HTMLElement) {
        return this.classList.contains("dock-tiles") ? 500 : 0;
      });
    try {
      render(<TiledDock initial={tiledState()} />);
      const surfaceEl = document.querySelector<HTMLElement>(".dock-tiles__surface");
      expect(surfaceEl?.style.height).toBe("280px");
      expect(pixelsOf("Files", 280)).toBeCloseTo(140);
      expect(pixelsOf("iOS Simulator", 280)).toBeCloseTo(140);
    } finally {
      width.mockRestore();
      rect.mockRestore();
    }
  });

  it("abandons a divider drag on Escape and commits nothing when the pointer is released", () => {
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(() => DOMRect.fromRect({ x: 0, y: 0, width: 1000, height: 600 }));
    try {
      render(<TiledDock initial={tiledState()} />);
      const name = "Resize Files and iOS Simulator";
      const divider = screen.getByRole("separator", { name });
      pointer("pointerDown", divider, 500);
      pointer("pointerMove", divider, 700);
      expect(Number(divider.getAttribute("aria-valuenow"))).toBeGreaterThan(50);
      fireEvent.keyDown(window, { key: "Escape" });
      expect(document.querySelector(".dock-tiles__drag-shield")).toBeNull();
      pointer("pointerUp", divider, 700);
      expect(screen.getByRole("separator", { name })).toHaveAttribute("aria-valuenow", "50");
    } finally {
      rect.mockRestore();
    }
  });

  it("moves a divider in a column of three as far as the pointer moved", () => {
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(() => DOMRect.fromRect({ x: 0, y: 0, width: 1000, height: 900 }));
    try {
      const third = 1 / 3;
      render(
        <TiledDock
          initial={tileState(
            [
              [
                ["files", third],
                ["canvas", third],
                ["plan", third],
              ],
              [["ios-simulator", 1]],
            ],
            [0.5, 0.5],
            "plan",
          )}
        />,
      );
      const name = "Resize Files and Canvas";
      const divider = screen.getByRole("separator", { name });
      expect(divider).toHaveAttribute("aria-valuenow", "33");
      const at = (kind: "pointerDown" | "pointerMove" | "pointerUp", clientY: number) => {
        const event = createEvent[kind](divider, { button: 0 });
        Object.defineProperties(event, { clientY: { value: clientY }, pointerId: { value: 1 } });
        fireEvent(divider, event);
      };
      at("pointerDown", 300);
      // 90px of a 900px column is a tenth of the column.
      at("pointerMove", 390);
      at("pointerUp", 390);
      expect(screen.getByRole("separator", { name })).toHaveAttribute("aria-valuenow", "43");
    } finally {
      rect.mockRestore();
    }
  });

  it("leaves focus where the person put it when it moves out of the dock before the retries fire", async () => {
    const user = userEvent.setup();
    render(
      <>
        <TiledDock initial={tiledState()} />
        <input aria-label="Composer" />
      </>,
    );
    await arrange(user, "Files", "Hide from view");
    const composer = screen.getByRole("textbox", { name: "Composer" });
    composer.focus();
    await new Promise((done) => setTimeout(done, 400));
    expect(composer).toHaveFocus();
  });

  it("keeps keyboard focus in the dock when a header choice leaves nothing for the strip or the control", async () => {
    const user = userEvent.setup();
    render(<TiledDock initial={opened("files")} launchable={[surface("terminal")]} />);
    await user.click(screen.getByRole("button", { name: "Show another tool" }));
    await user.click(await screen.findByRole("menuitem", { name: "Terminal" }));
    expect(screen.getByRole("region", { name: "Terminal" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Terminal" })).toHaveFocus();
  });

  it("returns to the Browser page that was showing when the Browser is hidden and shown again", async () => {
    const user = userEvent.setup();
    const pageOne = "10000000-0000-4000-8000-000000000001";
    const pageTwo = "10000000-0000-4000-8000-000000000002";
    let state = openUtilityTabState({ tabs: [] }, "files");
    state = addUtilityTabState(state, "browser", pageOne);
    state = addUtilityTabState(state, "browser", pageTwo);
    state = showUtilityTabBeside(state, "files");
    render(<TiledDock initial={state} />);
    await arrange(user, "Browser", "Hide from view");
    expect(screen.queryByRole("tablist", { name: "Browser pages" })).not.toBeInTheDocument();
    await user.pointer({
      target: screen.getByRole("tab", { name: "Browser" }),
      keys: "[MouseRight]",
    });
    await user.click(await screen.findByRole("menuitem", { name: "Show beside" }));
    const pages = within(screen.getByRole("tablist", { name: "Browser pages" })).getAllByRole(
      "tab",
    );
    expect(pages[1]).toHaveAttribute("aria-selected", "true");
  });

  describe("minimised tools", () => {
    const shelf = () => screen.queryByRole("group", { name: "Minimised tools" });

    it("brings the overview back, with the card under it, when the only shown tool is minimised from its tab's menu", async () => {
      const user = userEvent.setup();
      render(<TiledDock initial={opened("files", "terminal")} />);
      expect(shelf()).not.toBeInTheDocument();
      fireEvent.contextMenu(screen.getByRole("tab", { name: "Terminal" }));
      await user.click(await screen.findByRole("menuitem", { name: "Minimise to card" }));

      expect(screen.getByText("Thread overview")).toBeVisible();
      expect(screen.queryByText("Live terminal")).not.toBeInTheDocument();
      const card = within(shelf()!).getByRole("region", { name: "Minimised Terminal" });
      expect(within(card).getByText("Preview of terminal")).toBeInTheDocument();
      // The card stands for the tool, so the strip lists only what else is open.
      expect(screen.queryByRole("tab", { name: "Terminal" })).not.toBeInTheDocument();
      expect(screen.getByRole("tab", { name: "Files" })).toBeVisible();
    });

    it("leaves the other tile mounted when one of two tiles is minimised from its Arrange menu, and adds a card", async () => {
      const user = userEvent.setup();
      render(<TiledDock initial={showUtilityTabBeside(opened("terminal", "files"), "terminal")} />);
      const before = mounts.get("files");
      expect(before).toBeGreaterThan(0);
      await arrange(user, "Terminal", "Minimise to card");

      expect(screen.getByRole("region", { name: "Files" })).toBeVisible();
      expect(mounts.get("files")).toBe(before);
      expect(within(shelf()!).getByRole("region", { name: "Minimised Terminal" })).toBeVisible();
      expect(screen.queryByRole("region", { name: "Terminal" })).not.toBeInTheDocument();
    });

    it("offers Minimise to card only for the Browser and the Terminal, in the tile bar and the strip tab's menu", async () => {
      const user = userEvent.setup();
      render(<TiledDock initial={showUtilityTabBeside(opened("browser", "files"), "browser")} />);
      // The tile bar carries no button of its own for it: it lives in Arrange.
      expect(screen.queryByRole("button", { name: /^Minimise/ })).not.toBeInTheDocument();
      await user.click(
        within(screen.getByRole("region", { name: "Browser" })).getByRole("button", {
          name: "Arrange Browser",
        }),
      );
      expect(await screen.findByRole("menuitem", { name: "Minimise to card" })).toBeVisible();
      await user.keyboard("{Escape}");
      await user.click(
        within(screen.getByRole("region", { name: "Files" })).getByRole("button", {
          name: "Arrange Files",
        }),
      );
      const menu = await screen.findByRole("menu", { name: "Arrange Files" });
      expect(
        within(menu).queryByRole("menuitem", { name: "Minimise to card" }),
      ).not.toBeInTheDocument();
      await user.keyboard("{Escape}");
    });

    it("opens the strip tab menu with Minimise to card from the keyboard with Shift+F10", async () => {
      const user = userEvent.setup();
      render(<TiledDock initial={opened("files", "terminal")} />);
      screen.getByRole("tab", { name: "Terminal" }).focus();
      await user.keyboard("{Shift>}{F10}{/Shift}");
      expect(await screen.findByRole("menuitem", { name: "Minimise to card" })).toBeVisible();
    });

    it("restores the tool into the focused tile from the card's expand control", async () => {
      const user = userEvent.setup();
      render(<TiledDock initial={minimiseUtilityTool(opened("files", "terminal"), "terminal")} />);
      await user.click(screen.getByRole("button", { name: "Show Terminal" }));
      expect(screen.getByText("Live terminal")).toBeVisible();
      expect(shelf()).not.toBeInTheDocument();
      expect(screen.getByRole("tab", { name: "Terminal" })).toBeVisible();
    });

    it("restores the tool from the whole preview, which is one button with no content of its own to reach", async () => {
      const user = userEvent.setup();
      render(<TiledDock initial={minimiseUtilityTool(opened("files", "terminal"), "terminal")} />);
      const preview = screen.getByRole("button", { name: "Show Terminal, live preview" });
      expect(preview.querySelector("a, button, input, [tabindex]")).toBeNull();
      expect(preview.parentElement?.querySelector("[inert]")).not.toBeNull();
      await user.click(preview);
      expect(screen.getByText("Live terminal")).toBeVisible();
    });

    it("takes only the card away from its hide control: the tool stays an open tab, not shown, and nothing is closed", async () => {
      const user = userEvent.setup();
      render(<TiledDock initial={minimiseUtilityTool(opened("files", "terminal"), "terminal")} />);
      expect(screen.queryByRole("tab", { name: "Terminal" })).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Hide Terminal card" }));
      expect(shelf()).not.toBeInTheDocument();
      expect(screen.getByRole("tab", { name: "Terminal" })).toBeVisible();
      expect(screen.getByRole("tab", { name: "Terminal" })).not.toHaveAttribute(
        "aria-selected",
        "true",
      );
      expect(screen.getByText("Thread overview")).toBeVisible();
      expect(screen.queryByText("Live terminal")).not.toBeInTheDocument();
    });

    it("moves the keyboard to the restored tool when Show is pressed on a card", async () => {
      const user = userEvent.setup();
      render(<TiledDock initial={minimiseUtilityTool(opened("files", "terminal"), "terminal")} />);
      screen.getByRole("button", { name: "Show Terminal" }).focus();
      await user.keyboard("{Enter}");
      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByRole("region", { name: "Terminal" })),
      );
    });

    it("hands the keyboard to the strip when a card is hidden and no tab is selected", () => {
      const focused: Array<string | null> = [];
      const focus = vi
        .spyOn(HTMLElement.prototype, "focus")
        .mockImplementation(function (this: HTMLElement) {
          focused.push(this.getAttribute("aria-label"));
        });
      try {
        render(
          <TiledDock
            initial={minimiseUtilityTool(opened("files", "terminal"), "terminal")}
            launchable={[surface("plan")]}
          />,
        );
        fireEvent.click(screen.getByRole("button", { name: "Hide Terminal card" }));
        // The overview is showing, so no tab is selected: the strip's overflow
        // count (here the hidden tool does not fit), else the Add tool control.
        expect(focused).toHaveLength(1);
        expect(["1 more open tab", "Add tool"]).toContain(focused[0]);
      } finally {
        focus.mockRestore();
      }
    });

    it("moves the keyboard to the selected tab when a card is hidden beside a shown tool", async () => {
      const user = userEvent.setup();
      let state = opened("terminal", "files");
      state = minimiseUtilityTool(state, "terminal");
      render(<TiledDock initial={state} />);
      screen.getByRole("button", { name: "Hide Terminal card" }).focus();
      await user.keyboard("{Enter}");
      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Files" })),
      );
    });

    it("lists the strip without a minimised tool, which its card stands for", () => {
      render(<TiledDock initial={minimiseUtilityTool(opened("files", "terminal"), "terminal")} />);
      expect(screen.queryByRole("tab", { name: "Terminal" })).not.toBeInTheDocument();
      expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Files"]);
    });

    it("lists a minimised tool among the open tools in Show another tool and restores it beside", async () => {
      const user = userEvent.setup();
      render(<TiledDock initial={minimiseUtilityTool(opened("terminal", "files"), "terminal")} />);
      await user.click(screen.getByRole("button", { name: "Show another tool" }));
      const menu = await screen.findByRole("menu", { name: "Show another tool" });
      expect(
        within(menu)
          .getAllByRole("menuitem")
          .map((item) => item.textContent),
      ).toEqual(["Terminal"]);
      await user.click(within(menu).getByRole("menuitem", { name: "Terminal" }));
      expect(screen.getByRole("region", { name: "Terminal" })).toBeVisible();
      expect(screen.getByRole("region", { name: "Files" })).toBeVisible();
      expect(shelf()).not.toBeInTheDocument();
    });

    it("draws no shelf in the narrow presentation and keeps the minimised tool reachable in the strip", async () => {
      const user = userEvent.setup();
      render(
        <TiledDock initial={minimiseUtilityTool(opened("files", "terminal"), "terminal")} narrow />,
      );
      expect(shelf()).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Show Terminal" })).not.toBeInTheDocument();
      await user.click(screen.getByRole("tab", { name: "Terminal" }));
      expect(screen.getByText("Live terminal")).toBeVisible();
    });

    it("caps the shelf at two fifths of the dock and lets it scroll inside", () => {
      expect(dockStylesheet).toMatch(
        /\.dock-shelf\s*\{[^}]*max-height:\s*40%[^}]*overflow-y:\s*auto/,
      );
    });

    it("names the shelf's group Minimised tools", () => {
      render(<TiledDock initial={minimiseUtilityTool(opened("files", "terminal"), "terminal")} />);
      expect(screen.getByRole("group", { name: "Minimised tools" })).toBeVisible();
    });

    it("names the card's controls and gives them roles", () => {
      render(<TiledDock initial={minimiseUtilityTool(opened("files", "browser"), "browser")} />);
      const card = within(shelf()!).getByRole("region", { name: "Minimised Browser" });
      expect(within(card).getByRole("button", { name: "Show Browser" })).toBeVisible();
      expect(within(card).getByRole("button", { name: "Hide Browser card" })).toBeVisible();
      expect(
        within(card).getByRole("button", { name: "Show Browser, live preview" }),
      ).toBeVisible();
    });

    it("moves keyboard focus to the card when the focused tile is minimised from its menu", async () => {
      const user = userEvent.setup();
      render(<TiledDock initial={showUtilityTabBeside(opened("terminal", "files"), "terminal")} />);
      await arrange(user, "Terminal", "Minimise to card");
      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByRole("button", { name: "Show Terminal" })),
      );
    });

    it("leaves keyboard focus where the person put it after a tile is minimised", async () => {
      const user = userEvent.setup();
      render(
        <>
          <TiledDock initial={showUtilityTabBeside(opened("terminal", "files"), "terminal")} />
          <input aria-label="Elsewhere" />
        </>,
      );
      await arrange(user, "Terminal", "Minimise to card");
      const elsewhere = screen.getByRole("textbox", { name: "Elsewhere" });
      elsewhere.focus();
      await new Promise((done) => setTimeout(done, 400));
      expect(elsewhere).toHaveFocus();
    });

    it("puts a tool back in its own tile beside the other, which stays mounted, and focuses it", async () => {
      const user = userEvent.setup();
      render(<TiledDock initial={showUtilityTabBeside(opened("terminal", "files"), "terminal")} />);
      await arrange(user, "Terminal", "Minimise to card");
      const before = mounts.get("files");
      await user.click(screen.getByRole("button", { name: "Show Terminal" }));
      const files = screen.getByRole("region", { name: "Files" });
      const terminal = screen.getByRole("region", { name: "Terminal" });
      expect(
        files.compareDocumentPosition(terminal) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(mounts.get("files")).toBe(before);
      expect(terminal).toHaveAttribute("data-focused", "true");
      expect(shelf()).not.toBeInTheDocument();
      await waitFor(() => expect(terminal).toHaveFocus());
    });

    it("keeps a tool shown in the tile it already has when another tool is restored from a card", async () => {
      const user = userEvent.setup();
      render(<TiledDock initial={minimiseUtilityTool(opened("files", "terminal"), "terminal")} />);
      const before = mounts.get("files");
      await user.click(screen.getByRole("button", { name: "Show Terminal" }));
      expect(screen.getByRole("region", { name: "Terminal" })).toBeVisible();
      expect(shelf()).not.toBeInTheDocument();
      expect(mounts.get("files") ?? 0).toBeLessThanOrEqual(before ?? 1);
    });
  });
});
