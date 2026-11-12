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
import { DockToolButtons } from "./DockToolButtons";
import { buildDockToolButtons } from "./dockToolButtonsModel";
import {
  addUtilityTabState,
  closeUtilityTabState,
  hideUtilityCard,
  hideUtilityTile,
  minimiseUtilityTool,
  restoreUtilityTool,
  moveUtilityTile,
  withoutTileLayout,
  openUtilityTabBesideState,
  openUtilityTabState,
  resizeUtilityTileColumn,
  resizeUtilityTileColumns,
  selectUtilityTabState,
  shownUtilityTabIds,
  showUtilityTabAlone,
  showUtilityTabBelow,
  showUtilityTabBeside,
  type ThreadUtilityDockState,
} from "./rightUtilityDockSelection";
import { StartQuickToolsContext, StartQuickToolsPlacementContext } from "./StartQuickTools";
import { DockMiniCard } from "./DockShelf";

const browser = surface("browser");
const terminal = surface("terminal");
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
  it("shows several Browsers as one Browser tool with a row of pages", async () => {
    const user = userEvent.setup();
    const onOpenTab = vi.fn();
    const onSelectSurface = vi.fn();
    const page = (id: string, label: string) => ({ id, label, surface: browser });
    render(
      <RightUtilityDockSurface
        activeTabId="browser-2"
        onCloseTab={vi.fn()}
        onOpenTab={onOpenTab}
        onSelectSurface={onSelectSurface}
        renderTab={(tab) => <p>{`Live ${tab.label}`}</p>}
        resolution={{ kind: "surface", surface: browser }}
        tabs={[page("browser-1", "Browser 1"), terminal, page("browser-2", "Browser 2")]}
      />,
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
  });

  it("never renders the previous tool's content for an unavailable active thread", () => {
    render(
      <RightUtilityDockSurface
        browser={<p>Previous thread Browser</p>}
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

  /** Files left, Review right and focused; Environment open but hidden. */
  function rowState() {
    return showUtilityTabBeside(opened("review", "environment", "files"), "review");
  }

  const toolbar = () => screen.getByRole("toolbar", { name: "Tools" });
  const toolButton = (name: string) => within(toolbar()).getByRole("button", { name });

  /** The items a tool button's context menu offers. */
  async function menuOf(tool: string) {
    const user = userEvent.setup();
    await user.pointer({ target: toolButton(tool), keys: "[MouseRight]" });
    const items = (await screen.findAllByRole("menuitem")).map((item) => item.textContent);
    await user.keyboard("{Escape}");
    return items;
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
    const shelfDrawn = props.narrow !== true;
    // One card for each minimised tool, standing for its first tab.
    const cards = ["browser", "terminal"].flatMap((id) => {
      const tab = state.tabs.find((candidate) => candidate.surface === id);
      return shelfDrawn && tab !== undefined && state.minimised?.includes(tab.id) === true
        ? [{ tabId: tab.id, surface: id as "browser" | "terminal" }]
        : [];
    });
    const model = buildDockToolButtons({
      surfaces: RIGHT_UTILITY_DOCK_SURFACES.map((tool) => ({ id: tool.id, label: tool.label })),
      tabs: state.tabs,
      shownTabIds: shownUtilityTabIds(props.narrow === true ? withoutTileLayout(state) : state),
      minimised: shelfDrawn ? (state.minimised ?? []) : [],
      shelfDrawn,
      ...(state.active === undefined ? {} : { activeTabId: state.active }),
      ...(state.lastBrowser === undefined ? {} : { lastBrowserTabId: state.lastBrowser }),
      dockOpen: true,
      dockPresentedOpen: true,
      narrow: props.narrow === true,
      layout: state.layout,
      bottomHeld: [],
      bottomPresentedOpen: false,
      capsFull: false,
    });
    // What the app's dispatcher does with a press or a menu choice, on this
    // state alone.
    const press = (id: RightUtilityDockSurfaceId) => {
      const button = [...model.buttons, ...model.more].find((candidate) => candidate.id === id);
      const action = button?.press;
      if (action === undefined) return;
      if (action.kind === "open-beside") {
        setState((current) => openUtilityTabBesideState(current, id, `new-${id}`));
      } else if (action.kind === "open") {
        setState((current) => openUtilityTabState(current, id));
      } else if (action.kind === "select") {
        setState((current) => selectUtilityTabState(current, action.tabId));
      } else if (action.kind === "show-beside") {
        setState((current) => showUtilityTabBeside(current, action.tabId));
      } else if (action.kind === "close") {
        for (const tabId of action.tabIds) {
          setState((current) => closeUtilityTabState(current, tabId));
        }
      } else if (action.kind === "minimise") {
        setState((current) => minimiseUtilityTool(current, action.tabId));
      } else if (action.kind === "restore") {
        setState((current) => restoreUtilityTool(current, action.tabId));
      }
    };
    const choose = (id: RightUtilityDockSurfaceId, value: string) => {
      const button = [...model.buttons, ...model.more].find((candidate) => candidate.id === id);
      const tabId = button?.tabId;
      if (value === "new") {
        setState((current) => addUtilityTabState(current, id, `new-${id}`));
      } else if (tabId === undefined) {
        return;
      } else if (value === "close") {
        for (const closing of id === "browser" ? (button?.tabIds ?? []) : [tabId]) {
          setState((current) => closeUtilityTabState(current, closing));
        }
      } else if (value === "minimise") {
        setState((current) => minimiseUtilityTool(current, tabId));
      } else if (value === "below") setState((current) => showUtilityTabBelow(current, tabId));
      else if (value === "alone") setState((current) => showUtilityTabAlone(current, tabId));
      else if (value === "hide") setState((current) => hideUtilityTile(current, tabId));
      else if (value.startsWith("move-")) {
        const direction = value.slice(5) as "left" | "right" | "up" | "down";
        setState((current) => moveUtilityTile(current, tabId, direction));
      }
    };
    const row = { model, onMenuAction: choose, onPress: press };
    return (
      <>
        {props.narrow === true ? null : <DockToolButtons {...row} />}
        <RightUtilityDockSurface
          {...(state.active === undefined ? {} : { activeTabId: state.active })}
          onCloseTab={(id) => setState((current) => closeUtilityTabState(current, id))}
          onOpenTab={vi.fn()}
          onSelectSurface={(id) => setState((current) => selectUtilityTabState(current, id))}
          renderTab={(tab) => <Probe id={tab.id} />}
          overview={<p>Thread overview</p>}
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
            onMove: (id, direction) =>
              setState((current) => moveUtilityTile(current, id, direction)),
            onResizeColumn: (index, shares) =>
              setState((current) => resizeUtilityTileColumn(current, index, shares)),
            onResizeColumns: (shares) =>
              setState((current) => resizeUtilityTileColumns(current, shares)),
            onShowAlone: (id) => setState((current) => showUtilityTabAlone(current, id)),
            onShowBelow: (id) => setState((current) => showUtilityTabBelow(current, id)),
            onShowBeside: (id) => setState((current) => showUtilityTabBeside(current, id)),
          }}
          {...(props.narrow === true ? { toolRow: { ...row, dragSource: false } } : {})}
        />
      </>
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

  it("pulls a shared tile edge in by the tile inset, which is 0 because panes share their edges, and leaves the dock's own edges alone", () => {
    render(<TiledDock initial={tiledState()} />);
    const [first, second] = ["Files", "iOS Simulator"].map(
      (name) => screen.getByRole("region", { name }).style,
    );
    // The inset is a stylesheet variable, 0px at every width: two tiles touch.
    const inset = "var(--octant-tile-inset, 0px)";
    expect(first?.left).toBe("calc(0% + 0px)");
    expect(first?.width).toBe(`calc(50% - ${inset})`);
    expect(second?.left).toBe(`calc(50% + ${inset})`);
    expect(second?.width).toBe(`calc(50% - ${inset})`);
    expect(first?.top).toBe("calc(0% + 0px)");
    expect(first?.height).toBe("calc(100% - 0px)");
  });

  it("keeps an 8px divider hit area centred on the edge between two tiles", () => {
    render(<TiledDock initial={tiledState()} />);
    const divider = screen.getByRole("separator", { name: "Resize Files and iOS Simulator" }).style;
    expect(divider.width).toBe("8px");
    expect(divider.left).toBe("calc(50% - 4px)");
  });

  it("shows a hidden open tool beside the focused tile when its button is pressed", async () => {
    const user = userEvent.setup();
    render(<TiledDock initial={rowState()} />);
    expect(toolButton("Environment")).toHaveAttribute("aria-description", "Open");
    expect(toolButton("Environment")).toHaveAttribute("aria-pressed", "false");
    await user.click(toolButton("Environment"));
    expect(screen.getByRole("region", { name: "Environment" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Files" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Review" })).toBeVisible();
    expect(toolButton("Environment")).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps a shown tool mounted while focus moves, a divider moves and another tile joins", async () => {
    const user = userEvent.setup();
    mounts.clear();
    render(<TiledDock initial={rowState()} />);
    expect(mounts.get("files")).toBe(1);
    expect(mounts.get("review")).toBe(1);

    await user.click(within(screen.getByRole("region", { name: "Files" })).getByText("Live files"));
    expect(screen.getByRole("region", { name: "Files" })).toHaveAttribute("data-focused", "true");

    screen.getByRole("separator", { name: "Resize Files and Review" }).focus();
    await user.keyboard("{ArrowRight}");

    await user.pointer({ target: toolButton("Environment"), keys: "[MouseRight]" });
    await user.click(await screen.findByRole("menuitem", { name: "Show below" }));
    expect(screen.getByRole("region", { name: "Environment" })).toBeVisible();

    expect(mounts.get("files")).toBe(1);
    expect(mounts.get("review")).toBe(1);
  });

  it("hides a tile without closing its tool", async () => {
    const user = userEvent.setup();
    render(<TiledDock initial={rowState()} />);
    await arrange(user, "Review", "Hide from view");
    expect(screen.queryByText("Live review")).not.toBeInTheDocument();
    expect(screen.getByText("Live files")).toBeVisible();
    expect(toolButton("Review")).toHaveAttribute("aria-description", "Open");
    expect(toolButton("Review")).toHaveAttribute("aria-pressed", "false");
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

  it("leaves the dock's header empty when the row lives in the title band", () => {
    render(<TiledDock initial={rowState()} />);
    const header = document.querySelector(".right-utility-dock__toolbar");
    expect(header).not.toBeNull();
    expect(within(header as HTMLElement).queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByRole("tablist", { name: "Open tools" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add tool" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Show another tool" })).toBeNull();
  });

  it("puts the row in the drawer's header and replaces the shown tool when another is pressed", async () => {
    const user = userEvent.setup();
    render(<TiledDock initial={opened("files", "environment")} narrow />);
    const header = document.querySelector(".right-utility-dock__toolbar") as HTMLElement;
    const row = within(header).getByRole("toolbar", { name: "Tools" });
    expect(screen.getAllByRole("toolbar", { name: "Tools" })).toHaveLength(1);
    expect(within(row).getByRole("button", { name: "Environment" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(row).getByRole("button", { name: "Files" })).not.toHaveAttribute("draggable");
    await user.click(within(row).getByRole("button", { name: "Files" }));
    expect(screen.getByText("Live files")).toBeVisible();
    expect(screen.queryByText("Live environment")).not.toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Files" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(within(row).getByRole("button", { name: "Review" }));
    expect(screen.getByText("Live review")).toBeVisible();
    expect(screen.queryByText("Live files")).not.toBeInTheDocument();
  });

  it("shows only the focused tool in the narrow presentation", () => {
    render(<TiledDock initial={tiledState()} narrow />);
    expect(screen.getByText("Live ios-simulator")).toBeVisible();
    expect(screen.queryByText("Live files")).not.toBeInTheDocument();
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

  it("gives a single tool no bar and marks the other open tool on its button", () => {
    render(<TiledDock initial={opened("files", "environment")} />);
    expect(document.querySelector(".dock-tile__bar")).toBeNull();
    expect(toolButton("Environment")).toHaveAttribute("aria-pressed", "true");
    expect(toolButton("Files")).toHaveAttribute("aria-description", "Open");
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

  it("offers Show below and Close in a hidden tool's context menu", async () => {
    render(<TiledDock initial={opened("files", "environment")} />);
    expect(await menuOf("Files")).toEqual(["Show below", "Close Files"]);
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

  it("offers the same arranging, and Close, from a shown tool's button", async () => {
    render(<TiledDock initial={rowState()} />);
    expect(await menuOf("Files")).toEqual([
      "Show alone",
      "Hide from view",
      "Move right",
      "Close Files",
    ]);
    expect(await menuOf("Review")).toEqual([
      "Show alone",
      "Hide from view",
      "Move left",
      "Close Review",
    ]);
    expect(await menuOf("Environment")).toEqual(["Show below", "Close Environment"]);
  });

  it("offers a new shell on the Terminal button and a new page on the Browser button", async () => {
    const user = userEvent.setup();
    render(<TiledDock initial={opened("files")} />);
    expect(await menuOf("Terminal")).toEqual(["New Terminal"]);
    expect(await menuOf("Browser")).toEqual(["New Browser page"]);
    await user.pointer({ target: toolButton("Browser"), keys: "[MouseRight]" });
    await user.click(await screen.findByRole("menuitem", { name: "New Browser page" }));
    expect(screen.getByRole("region", { name: "Browser" })).toBeVisible();
    expect(await menuOf("Browser")).toEqual([
      "Minimise to card",
      "New Browser page",
      "Close Browser",
    ]);
  });

  it("opens a tool button's menu from the keyboard with Shift+F10", async () => {
    const user = userEvent.setup();
    render(<TiledDock initial={opened("files", "environment")} />);
    toolButton("Files").focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    expect(await screen.findByRole("menuitem", { name: "Close Files" })).toBeVisible();
  });

  it("closes a tool from its tile, as its strip tab's close does", async () => {
    const user = userEvent.setup();
    render(<TiledDock initial={tiledState()} />);
    await user.click(screen.getByRole("button", { name: "Close Files" }));
    expect(screen.queryByText("Live files")).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Files" })).not.toBeInTheDocument();
  });

  it("offers only Close for the only tool on screen", async () => {
    render(<TiledDock initial={opened("files")} />);
    expect(await menuOf("Files")).toEqual(["Close Files"]);
  });

  it("closes a tool from its button's menu", async () => {
    const user = userEvent.setup();
    render(<TiledDock initial={opened("files", "environment")} />);
    await user.pointer({ target: toolButton("Environment"), keys: "[MouseRight]" });
    await user.click(await screen.findByRole("menuitem", { name: "Close Environment" }));
    expect(screen.queryByRole("region", { name: "Environment" })).not.toBeInTheDocument();
    expect(toolButton("Environment")).toHaveAttribute("aria-pressed", "false");
  });

  it("tiles a tool dragged from its button and dropped on the right third of the dock body", async () => {
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(() => DOMRect.fromRect({ x: 0, y: 0, width: 300, height: 300 }));
    try {
      render(<TiledDock initial={opened("files", "environment")} />);
      const transfer = { setData: vi.fn(), effectAllowed: "" };
      expect(toolButton("Files")).toHaveAttribute("draggable", "true");
      fireEvent.dragStart(toolButton("Files"), { dataTransfer: transfer });
      // Some engines refuse to start a drag that carries no data.
      expect(transfer.setData).toHaveBeenCalledWith("text/plain", "Files");
      expect(transfer.effectAllowed).toBe("move");
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
      expect(screen.getByRole("region", { name: "Environment" })).toBeVisible();
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
    render(<TiledDock initial={opened("files", "environment")} />);
    expect(mounts.get("environment")).toBe(1);
    await user.click(toolButton("Files"));
    expect(screen.getByRole("region", { name: "Files" })).toBeVisible();
    await arrange(user, "Files", "Hide from view");
    expect(screen.queryByRole("region", { name: "Files" })).not.toBeInTheDocument();
    expect(mounts.get("environment")).toBe(1);
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

  it("moves keyboard focus to the tool's button when its tile is hidden from its menu", async () => {
    const user = userEvent.setup();
    render(<TiledDock initial={tiledState()} />);
    await arrange(user, "Files", "Hide from view");
    await waitFor(() => expect(toolButton("Files")).toHaveFocus());
  });

  it("moves keyboard focus to the dock toggle when the hidden tool has no button of its own", async () => {
    const user = userEvent.setup();
    render(
      <>
        <button data-dock-opener="true" type="button">
          Toggle
        </button>
        <TiledDock initial={showUtilityTabBeside(opened("files", "vitals"), "files")} />
      </>,
    );
    await arrange(user, "Vitals", "Hide from view");
    await waitFor(() => expect(screen.getByRole("button", { name: "Toggle" })).toHaveFocus());
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

  // A tile's box is its share of the surface; the frame's gap is then taken off
  // each edge it shares with a neighbour, so the height is a calc of both.
  const pixelsOf = (name: string, total: number) => {
    const height = screen.getByRole("region", { name }).style.height;
    const share = Number.parseFloat(/calc\(([\d.]+)%/.exec(height)?.[1] ?? "NaN");
    return (share / 100) * total;
  };

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
    await user.click(toolButton("Browser"));
    const pages = within(screen.getByRole("tablist", { name: "Browser pages" })).getAllByRole(
      "tab",
    );
    expect(pages[1]).toHaveAttribute("aria-selected", "true");
  });

  describe("minimised tools", () => {
    const shelf = () => screen.queryByRole("group", { name: "Minimised tools" });

    it("brings the overview back, with the card under it, when the only shown tool is minimised from its button's menu", async () => {
      const user = userEvent.setup();
      render(<TiledDock initial={opened("files", "terminal")} />);
      expect(shelf()).not.toBeInTheDocument();
      fireEvent.contextMenu(toolButton("Terminal"));
      await user.click(await screen.findByRole("menuitem", { name: "Minimise to card" }));

      expect(screen.getByText("Thread overview")).toBeVisible();
      expect(screen.queryByText("Live terminal")).not.toBeInTheDocument();
      const card = within(shelf()!).getByRole("region", { name: "Minimised Terminal" });
      expect(within(card).getByText("Preview of terminal")).toBeInTheDocument();
      // The card stands for the tool, and the button says so.
      expect(toolButton("Terminal")).toHaveAttribute("aria-pressed", "false");
      expect(toolButton("Terminal")).toHaveAttribute("aria-description", "Minimised to a card");
      expect(toolButton("Files")).toHaveAttribute("aria-description", "Open");
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

    it("offers Minimise to card only for the Browser and the Terminal, in the tile's Arrange menu and the button's context menu", async () => {
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
      expect(await menuOf("Browser")).toContain("Minimise to card");
      expect(await menuOf("Files")).not.toContain("Minimise to card");
    });

    it("opens the button's context menu with Minimise to card from the keyboard with Shift+F10", async () => {
      const user = userEvent.setup();
      render(<TiledDock initial={opened("files", "terminal")} />);
      toolButton("Terminal").focus();
      await user.keyboard("{Shift>}{F10}{/Shift}");
      expect(await screen.findByRole("menuitem", { name: "Minimise to card" })).toBeVisible();
    });

    it("minimises a pressed Terminal button to a card instead of closing it, and closes it from its menu", async () => {
      const user = userEvent.setup();
      render(<TiledDock initial={opened("files", "terminal")} />);
      expect(toolButton("Terminal")).toHaveAttribute("aria-pressed", "true");
      await user.click(toolButton("Terminal"));
      expect(within(shelf()!).getByRole("region", { name: "Minimised Terminal" })).toBeVisible();
      expect(toolButton("Terminal")).toHaveAttribute("aria-pressed", "false");

      await user.click(toolButton("Terminal"));
      expect(shelf()).not.toBeInTheDocument();
      expect(screen.getByText("Live terminal")).toBeVisible();

      fireEvent.contextMenu(toolButton("Terminal"));
      await user.click(await screen.findByRole("menuitem", { name: "Close Terminal" }));
      expect(shelf()).not.toBeInTheDocument();
      expect(screen.queryByText("Live terminal")).not.toBeInTheDocument();
      expect(toolButton("Terminal")).not.toHaveAttribute("aria-description");
    });

    it("closes a pressed tool other than the Browser and the Terminal on a press, as before", async () => {
      const user = userEvent.setup();
      render(<TiledDock initial={opened("files", "terminal")} />);
      await user.click(toolButton("Terminal"));
      await user.click(toolButton("Files"));
      await user.click(toolButton("Files"));
      expect(toolButton("Files")).not.toHaveAttribute("aria-description");
    });

    it("restores the tool into the focused tile from the card's expand control", async () => {
      const user = userEvent.setup();
      render(<TiledDock initial={minimiseUtilityTool(opened("files", "terminal"), "terminal")} />);
      await user.click(screen.getByRole("button", { name: "Show Terminal" }));
      expect(screen.getByText("Live terminal")).toBeVisible();
      expect(shelf()).not.toBeInTheDocument();
      expect(toolButton("Terminal")).toHaveAttribute("aria-pressed", "true");
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

    it("takes only the card away from its hide control: the tool stays open, not shown, and nothing is closed", async () => {
      const user = userEvent.setup();
      render(<TiledDock initial={minimiseUtilityTool(opened("files", "terminal"), "terminal")} />);
      expect(toolButton("Terminal")).toHaveAttribute("aria-description", "Minimised to a card");
      await user.click(screen.getByRole("button", { name: "Hide Terminal card" }));
      expect(shelf()).not.toBeInTheDocument();
      expect(toolButton("Terminal")).toHaveAttribute("aria-pressed", "false");
      expect(toolButton("Terminal")).toHaveAttribute("aria-description", "Open");
      expect(screen.getByText("Thread overview")).toBeVisible();
      expect(screen.queryByText("Live terminal")).not.toBeInTheDocument();
    });

    it("moves the keyboard to the tool's button when Show is pressed on a card", async () => {
      const user = userEvent.setup();
      render(<TiledDock initial={minimiseUtilityTool(opened("files", "terminal"), "terminal")} />);
      screen.getByRole("button", { name: "Show Terminal" }).focus();
      await user.keyboard("{Enter}");
      await waitFor(() => expect(document.activeElement).toBe(toolButton("Terminal")));
    });

    it("hands the keyboard to the tool's button when a card is hidden and nothing is shown", async () => {
      render(<TiledDock initial={minimiseUtilityTool(opened("files", "terminal"), "terminal")} />);
      fireEvent.click(screen.getByRole("button", { name: "Hide Terminal card" }));
      // The overview is showing, so no tile holds focus: it must not fall to
      // the page body.
      await waitFor(() => expect(document.activeElement).toBe(toolButton("Terminal")));
    });

    it("hands the keyboard to the tool's button when a card is hidden beside a shown tool", async () => {
      const user = userEvent.setup();
      let state = opened("terminal", "files");
      state = minimiseUtilityTool(state, "terminal");
      render(<TiledDock initial={state} />);
      screen.getByRole("button", { name: "Hide Terminal card" }).focus();
      await user.keyboard("{Enter}");
      await waitFor(() => expect(document.activeElement).toBe(toolButton("Terminal")));
    });

    it("reads a minimised tool's button as open, not pressed, and minimised to a card", () => {
      render(<TiledDock initial={minimiseUtilityTool(opened("files", "terminal"), "terminal")} />);
      expect(toolButton("Terminal")).toHaveAttribute("aria-pressed", "false");
      expect(toolButton("Terminal")).toHaveAttribute("aria-description", "Minimised to a card");
      expect(toolButton("Terminal")).toHaveAttribute("data-dock-open", "true");
    });

    it("restores a minimised tool beside the shown one when its button is pressed", async () => {
      const user = userEvent.setup();
      render(<TiledDock initial={minimiseUtilityTool(opened("terminal", "files"), "terminal")} />);
      await user.click(toolButton("Terminal"));
      expect(screen.getByRole("region", { name: "Terminal" })).toBeVisible();
      expect(screen.getByRole("region", { name: "Files" })).toBeVisible();
      expect(shelf()).not.toBeInTheDocument();
    });

    it("draws no shelf in the narrow presentation and shows a tool from the drawer's row as any other", async () => {
      const user = userEvent.setup();
      render(
        <TiledDock initial={minimiseUtilityTool(opened("files", "terminal"), "terminal")} narrow />,
      );
      expect(shelf()).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Show Terminal" })).not.toBeInTheDocument();
      expect(toolButton("Terminal")).toHaveAttribute("aria-description", "Open");
      await user.click(toolButton("Terminal"));
      expect(screen.getByText("Live terminal")).toBeVisible();
    });

    it("caps the shelf at two fifths of the dock and lets it scroll inside", () => {
      expect(dockStylesheet).toMatch(
        /\.dock-shelf\s*\{[^}]*max-height:\s*40%[^}]*overflow-y:\s*auto/,
      );
    });

    it("keeps a card compact: a 28px bar over a 104px preview, with 24px buttons, side by side from 160px each", () => {
      expect(dockStylesheet).toMatch(
        /\.dock-shelf\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(160px,\s*1fr\)\)/,
      );
      expect(dockStylesheet).toMatch(/\.dock-mini-card__head\s*\{[^}]*height:\s*28px/);
      expect(dockStylesheet).toMatch(/\.dock-mini-card__preview\s*\{[^}]*height:\s*104px/);
      expect(dockStylesheet).toMatch(
        /\.dock-mini-card__action\s*\{[^}]*width:\s*24px[^}]*height:\s*24px/,
      );
      expect(dockStylesheet).toMatch(
        /\.dock-mini-card__picture\s*\{[^}]*object-fit:\s*cover[^}]*object-position:\s*top left/,
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

    it("puts a tool back in its own tile beside the other, which stays mounted, and returns the keyboard to its button", async () => {
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
      await waitFor(() => expect(toolButton("Terminal")).toHaveFocus());
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
