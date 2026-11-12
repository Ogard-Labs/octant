import { Plus, X } from "lucide-react";
import {
  useContext,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
  type Ref,
} from "react";
import { DockTiles, type DockTileContent } from "./DockTiles";
import { DockToolButtons, type DockToolButtonsProps } from "./DockToolButtons";
import { endDockToolDrag, useDraggedDockTool } from "./dockToolDrag";
import { DockToolIcon } from "./dockToolIcons";
import { IconButton } from "./IconButton";
import { OctantButton } from "../ui/base/OctantButton";
import { ShellState } from "./ShellState";
import { StartQuickTools, StartQuickToolsPlacementContext } from "./StartQuickTools";
import {
  moveUtilityTile,
  type DockTileLayout,
  type DockTileMove,
  type ThreadUtilityDockState,
} from "./rightUtilityDockSelection";
import type {
  RightUtilityDockResolution,
  RightUtilityDockSurfaceDescriptor,
  RightUtilityDockSurfaceId,
  RightUtilityDockTabDescriptor,
} from "./rightUtilityDockModel";

function unavailableMessage(): string {
  return "The active pane holds no compatible thread. Focus a thread pane to restore its tools.";
}

/**
 * What the dock needs to show several tools at once. Absent, the dock is the
 * single-tool view it always was.
 */
export interface DockTileControls {
  readonly layout?: DockTileLayout;
  /** The modal presentation has room for one tool, so it draws only the focused tile. */
  readonly narrow: boolean;
  /** Each tile answers for its own tool: the dock's one resolution is the focused tile's. */
  readonly resolveSurface: (surface: RightUtilityDockSurfaceId) => RightUtilityDockResolution;
  readonly onHideTile: (tabId: string) => void;
  readonly onMove: (tabId: string, direction: DockTileMove) => void;
  /** Opens a tool and shows it beside the focused tile in one step. */
  readonly onResizeColumn: (columnIndex: number, shares: ReadonlyArray<number>) => void;
  readonly onResizeColumns: (shares: ReadonlyArray<number>) => void;
  readonly onShowAlone: (tabId: string) => void;
  readonly onShowBelow: (tabId: string) => void;
  readonly onShowBeside: (tabId: string) => void;
}

/**
 * What the dock needs to show several tools at once. Absent, the dock is the
 * single-tool view it always was.
 */
export interface DockTileControls {
  readonly layout?: DockTileLayout;
  /** The modal presentation has room for one tool, so it draws only the focused tile. */
  readonly narrow: boolean;
  /** Each tile answers for its own tool: the dock's one resolution is the focused tile's. */
  readonly resolveSurface: (surface: RightUtilityDockSurfaceId) => RightUtilityDockResolution;
  readonly onHideTile: (tabId: string) => void;
  readonly onMove: (tabId: string, direction: DockTileMove) => void;
  /** Opens a tool and shows it beside the focused tile in one step. */
  readonly onOpenBeside: (surface: RightUtilityDockSurfaceId) => void;
  readonly onResizeColumn: (columnIndex: number, shares: ReadonlyArray<number>) => void;
  readonly onResizeColumns: (shares: ReadonlyArray<number>) => void;
  readonly onShowAlone: (tabId: string) => void;
  readonly onShowBelow: (tabId: string) => void;
  readonly onShowBeside: (tabId: string) => void;
}

export interface RightUtilityDockSurfaceProps {
  readonly activeTabId?: string;
  readonly agents?: ReactNode;
  readonly browser?: ReactNode;
  readonly canvas?: ReactNode;
  readonly review?: ReactNode;
  readonly closeButtonRef?: Ref<HTMLButtonElement>;
  readonly delivery?: ReactNode;
  readonly document?: ReactNode;
  readonly environment?: ReactNode;
  readonly files?: ReactNode;
  readonly iosSimulator?: ReactNode;
  readonly androidEmulator?: ReactNode;
  readonly desktop?: ReactNode;
  readonly debug?: ReactNode;
  readonly vitals?: ReactNode;
  readonly onClose?: () => void;
  readonly onCloseTab: (tabId: string) => void;
  readonly onOpenTab: (surface: RightUtilityDockSurfaceId) => void;
  readonly onSelectSurface: (tabId: string) => void;
  /** What the dock shows above its tool launcher while no tool is chosen. */
  readonly overview?: ReactNode;
  readonly plan?: ReactNode;
  readonly resolution: RightUtilityDockResolution;
  readonly sideChat?: ReactNode;
  readonly renderTab?: (tab: RightUtilityDockTabDescriptor) => ReactNode;
  readonly tabs: ReadonlyArray<RightUtilityDockSurfaceDescriptor | RightUtilityDockTabDescriptor>;
  readonly terminal?: ReactNode;
  readonly tests?: ReactNode;
  readonly tiles?: DockTileControls;
  /**
   * The row of tool buttons, given only where the dock is a drawer: the title
   * band is inert behind it, so the row stands in the drawer's header. Docked,
   * the row lives in the title band and the header is an empty spacer.
   */
  readonly toolRow?: DockToolButtonsProps;
  /**
   * The active pane is a new Code task whose thread does not exist yet. The
   * row shows these tools disabled and the body says when they open, so the
   * dock keeps its place instead of closing and reopening around the first
   * message.
   */
  readonly toolsAwaitingThread?: ReadonlyArray<RightUtilityDockSurfaceDescriptor>;
}

export function RightUtilityDockSurface(props: RightUtilityDockSurfaceProps) {
  const activeSurface = props.resolution.kind === "closed" ? undefined : props.resolution.surface;
  const activeTabId = props.activeTabId ?? activeSurface?.id;
  const activeTab = props.tabs.find((tab) => tab.id === activeTabId);
  const quickToolsProjectId = useContext(StartQuickToolsPlacementContext)?.projectId;
  const toolPanel = useRef<HTMLElement>(null);
  // Every open Browser is one Browser tool with pages, the way a browser
  // keeps its tabs inside its own window: the title band's Browser button names
  // it once, and the pages sit in a row of their own inside it.
  const browserTabs = props.tabs.filter((tab) => dockTabSurface(tab).id === "browser");
  const tiles = props.tiles;
  const layout = tiles?.layout;
  // Tiles are drawn whenever a layout exists and the dock is not the narrow
  // modal, whatever the focused tool's own state: each tile resolves itself, so
  // one unavailable tool never takes the others off screen.
  const tiled = tiles !== undefined && layout !== undefined && !tiles.narrow;
  const draggedTool = useDraggedDockTool();
  const [dropZone, setDropZone] = useState<"beside" | "below" | "replace">();
  const root = useRef<HTMLDivElement>(null);
  // Hiding a tile or closing a tool unmounts the control that held keyboard
  // focus; the tool's button in the title band takes it, so the keyboard keeps
  // its place.
  const [refocus, setRefocus] = useState<{ readonly surface?: RightUtilityDockSurfaceId }>();
  useEffect(() => {
    if (refocus === undefined) return;
    const buttonOf = (surface: RightUtilityDockSurfaceId | undefined) =>
      surface === undefined
        ? undefined
        : (document.querySelector<HTMLElement>(`[data-dock-tool="${surface}"]`) ?? undefined);
    // The tool's own button, else the dock toggle that opened the dock.
    const target =
      buttonOf(refocus.surface) ??
      document.querySelector<HTMLElement>('[data-dock-opener="true"]') ??
      toolPanel.current;
    target?.focus();
    // The button can appear a beat late (a pressed tool re-renders the row),
    // and a closing menu returns focus to its trigger, which may be the tile
    // that just went. Focus is taken again only from the page body, from the
    // stand-in just focused, or from a popup that is closing; anywhere else it
    // is where the person put it and stays.
    const wanted = refocus.surface;
    const timers = [0, 60, 250].map((delay) =>
      setTimeout(() => {
        const preferred = buttonOf(wanted);
        const current = document.activeElement;
        const free =
          current === null ||
          current === document.body ||
          current === target ||
          current.closest('[role="menu"]') !== null;
        const next = preferred ?? target;
        if (next?.isConnected === true && free && current !== next) next.focus();
      }, delay),
    );
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, [refocus]);
  // A drag that ends where no dragend reaches (its source unmounted) must not
  // leave the drop target over the dock.
  useEffect(() => {
    if (draggedTool === undefined) return;
    const clear = () => {
      endDockToolDrag();
      setDropZone(undefined);
    };
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
    };
  }, [draggedTool]);
  const surfaceOfTab = (tabId: string): RightUtilityDockSurfaceId | undefined => {
    const tab = props.tabs.find((candidate) => candidate.id === tabId);
    return tab === undefined ? undefined : dockTabSurface(tab).id;
  };
  const placementState: ThreadUtilityDockState = {
    tabs: props.tabs.map((tab) => ({ id: tab.id, surface: dockTabSurface(tab).id })),
    ...(activeTabId === undefined ? {} : { active: activeTabId }),
    ...(layout === undefined ? {} : { layout }),
  };
  function zoneAt(event: DragEvent<HTMLElement>): "beside" | "below" | "replace" {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width > 0 && event.clientX - rect.left > (rect.width * 2) / 3) return "beside";
    if (rect.height > 0 && event.clientY - rect.top > (rect.height * 2) / 3) return "below";
    return "replace";
  }
  function dropTool(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    const id = draggedTool;
    const zone = zoneAt(event);
    endDockToolDrag();
    setDropZone(undefined);
    if (id === undefined) return;
    if (zone === "beside") tiles?.onShowBeside(id);
    else if (zone === "below") tiles?.onShowBelow(id);
    else props.onSelectSurface(id);
  }
  /** The Browser's pages: its bar in a tile, a row at the top of its body alone. */
  function pagesRow(selectedId: string | undefined) {
    return (
      <div aria-label="Browser pages" className="dock-browser-pages" role="tablist">
        {browserTabs.map((page) => (
          <span className="dock-browser-pages__page content-tab" key={page.id}>
            <OctantButton
              aria-selected={page.id === selectedId}
              className="content-tab__select border-0 bg-transparent text-inherit hover:bg-transparent focus-visible:bg-transparent aria-expanded:bg-transparent"
              onClick={() => props.onSelectSurface(page.id)}
              role="tab"
              size="sm"
              type="button"
              variant="ghost"
            >
              <DockToolIcon surface="browser" />
              <span>{page.label}</span>
            </OctantButton>
            <IconButton
              className="content-tab__close text-muted-foreground"
              icon={X}
              label={`Close ${page.label}`}
              onClick={() => props.onCloseTab(page.id)}
            />
          </span>
        ))}
        <IconButton
          icon={Plus}
          label="New Browser page"
          onClick={() => props.onOpenTab("browser")}
        />
      </div>
    );
  }
  /**
   * The tool's panel. With pages, the row sits first in the body when the tool
   * is alone and in the tile's bar otherwise; the slot stays either way, so
   * the page below it keeps its place and is never remounted by the move.
   */
  function renderToolBody(
    tab: RightUtilityDockSurfaceDescriptor | RightUtilityDockTabDescriptor,
    selectedId: string | undefined,
    pages: boolean,
    rowInBody: boolean,
  ) {
    return pages ? (
      <>
        {rowInBody ? pagesRow(selectedId) : null}
        <div className="dock-browser-pages__page-body" key={tab.id}>
          {props.renderTab?.(dockTabDescriptor(tab)) ?? contents[dockTabSurface(tab).id]}
        </div>
      </>
    ) : (
      (props.renderTab?.(dockTabDescriptor(tab)) ?? contents[dockTabSurface(tab).id])
    );
  }
  /** Closes a tool as its strip tab's close does: the Browser closes every page. */
  function closeTool(tabId: string) {
    const surface = surfaceOfTab(tabId);
    if (surface !== undefined && root.current?.contains(document.activeElement) === true) {
      setRefocus({ surface });
    }
    if (browserTabs.some((tab) => tab.id === tabId)) {
      for (const tab of browserTabs) props.onCloseTab(tab.id);
      return;
    }
    props.onCloseTab(tabId);
  }
  function renderTile(tabId: string): DockTileContent | undefined {
    const tab = props.tabs.find((candidate) => candidate.id === tabId);
    if (tab === undefined) return undefined;
    const tool = dockTabSurface(tab);
    const available = tiles?.resolveSurface(tool.id) ?? { kind: "surface" };
    const pages = tool.id === "browser" && browserTabs.length > 1;
    const label = pages ? "Browser" : tab.label;
    const movable = (direction: DockTileMove) =>
      moveUtilityTile(placementState, tab.id, direction) !== placementState;
    return {
      key: pages ? "browser" : tab.id,
      label,
      surface: tool.id,
      barLeading: pages ? (
        pagesRow(tab.id)
      ) : (
        <>
          <DockToolIcon surface={tool.id} />
          <span className="dock-tile__name">{label}</span>
        </>
      ),
      moves: {
        left: movable("left"),
        right: movable("right"),
        up: movable("up"),
        down: movable("down"),
      },
      bodyClassName: `right-utility-dock__tool${pages ? " right-utility-dock__tool--pages" : ""}`,
      inset: tool.id === "plan" || tool.id === "delivery" || tool.id === "agents",
      children:
        available.kind === "surface" ? (
          renderToolBody(tab, tab.id, pages, !tiled)
        ) : (
          <ShellState
            message={unavailableMessage()}
            state="neutral"
            title={`${tool.label} is unavailable`}
          />
        ),
    };
  }
  const contents: Readonly<Partial<Record<RightUtilityDockSurfaceId, ReactNode>>> = {
    agents: props.agents,
    browser: props.browser,
    canvas: props.canvas,
    review: props.review,
    delivery: props.delivery,
    document: props.document,
    environment: props.environment,
    files: props.files,
    "ios-simulator": props.iosSimulator,
    "android-emulator": props.androidEmulator,
    desktop: props.desktop,
    debug: props.debug,
    vitals: props.vitals,
    plan: props.plan,
    "side-chat": props.sideChat,
    terminal: props.terminal,
    tests: props.tests,
  };

  const visibleStripTabs = tiled ? stripTabs.filter((tab) => !shownInStrip.has(tab.id)) : stripTabs;
  // "Show another tool" is for a dock with a tool on screen and room for one
  // more; at the caps it would only offer what is refused.
  const lastColumn = layout?.columns.at(-1);
  const capsFull =
    layout !== undefined &&
    layout.columns.length >= MAX_DOCK_TILE_COLUMNS &&
    (lastColumn?.tiles.length ?? 0) >= MAX_DOCK_TILES_PER_COLUMN;
  const onScreenInStrip = tiled
    ? shownInStrip
    : new Set(activeTabId === undefined ? [] : [stripIdOf(activeTabId)]);
  const browserOnScreen = [...onScreenInStrip].some((id) =>
    browserTabs.some((tab) => tab.id === id),
  );
  const showBeside =
    tiles === undefined ||
    tiles.narrow ||
    props.resolution.kind !== "surface" ||
    activeTab === undefined ||
    capsFull ? null : (
      <DockShowBesideMenu
        launchable={remaining.filter(
          (candidate) =>
            candidate.id !== "browser" || (!browserOnScreen && browserTabs.length === 0),
        )}
        // The menu's own focus return target disappears when the choice leaves
        // nothing more to offer, so the keyboard goes to the tool chosen.
        onOpen={(surface) => {
          setRefocus({ tab: surface });
          tiles.onOpenBeside(surface);
        }}
        onShowOpen={(stripId) => {
          setRefocus({ tab: stripId });
          tiles.onShowBeside(toolOf(stripId));
        }}
        open={stripTabs
          .filter((tab) => !onScreenInStrip.has(tab.id))
          .map((tab) => ({ id: tab.id, label: tab.label, surface: dockTabSurface(tab).id }))}
      />
    );

  return (
    <div
      className="right-utility-dock__surface"
      data-dock-surface={activeSurface?.id ?? "empty"}
      ref={root}
    >
      <header className="dock-head right-utility-dock__toolbar">
        <div className="right-utility-dock__tabs">
          {props.toolRow === undefined ? null : <DockToolButtons {...props.toolRow} />}
        </div>
        <div className="right-utility-dock__actions">
          {props.onClose === undefined ? null : (
            <IconButton
              icon={X}
              label="Close right sidebar"
              onClick={props.onClose}
              ref={props.closeButtonRef}
            />
          )}
        </div>
      </header>
      <div className="dock-body right-utility-dock__content">
        {props.toolsAwaitingThread !== undefined && props.resolution.kind !== "surface" ? (
          quickToolsProjectId === undefined ? (
            <ShellState state="neutral" title="Tools open once the task starts" />
          ) : (
            <StartQuickTools projectId={quickToolsProjectId} />
          )
        ) : props.resolution.kind === "closed" ? (
          <div className="dock-start">{props.overview}</div>
        ) : !tiled && props.resolution.kind === "unavailable" ? (
          <ShellState
            message={unavailableMessage()}
            state="neutral"
            title={`${activeSurface?.label ?? "Tool"} is unavailable`}
          />
        ) : activeTab === undefined ? null : (
          // One tile is the single-tool view: the same tree as several, so a
          // tool that gains or loses a neighbour is never remounted.
          <DockTiles
            focusedTabId={activeTabId}
            layout={
              tiled
                ? layout
                : { columns: [{ share: 1, tiles: [{ tabId: activeTab.id, share: 1 }] }] }
            }
            onCloseTile={closeTool}
            onFocusTile={props.onSelectSurface}
            onHideTile={(tabId) => {
              // From the tile's menu: focus is in a popup, so it is not "inside".
              const surface = surfaceOfTab(tabId);
              if (surface !== undefined) setRefocus({ surface });
              tiles?.onHideTile(tabId);
            }}
            onMoveTile={(tabId, direction) => tiles?.onMove(tabId, direction)}
            onResizeColumn={(index, shares) => tiles?.onResizeColumn(index, shares)}
            onResizeColumns={(shares) => tiles?.onResizeColumns(shares)}
            onShowTileAlone={(tabId) => tiles?.onShowAlone(tabId)}
            panelRef={toolPanel}
            renderTile={renderTile}
          />
        )}
        {draggedTool !== undefined && tiles !== undefined && !tiles.narrow ? (
          <div
            className="dock-tiles__drag-shield"
            onDragLeave={() => setDropZone(undefined)}
            onDragOver={(event) => {
              event.preventDefault();
              setDropZone(zoneAt(event));
            }}
            onDrop={dropTool}
          >
            {dropZone === undefined || dropZone === "replace" ? null : (
              <div
                aria-hidden="true"
                className="workspace-drop-overlay dock-tiles__drop"
                data-drop-edge={dropZone === "beside" ? "right" : "bottom"}
              >
                <span>{dropZone === "beside" ? "Show beside" : "Show below"}</span>
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function dockTabSurface(
  tab: RightUtilityDockSurfaceDescriptor | RightUtilityDockTabDescriptor,
): RightUtilityDockSurfaceDescriptor {
  return "surface" in tab ? tab.surface : tab;
}

function dockTabDescriptor(
  tab: RightUtilityDockSurfaceDescriptor | RightUtilityDockTabDescriptor,
): RightUtilityDockTabDescriptor {
  if ("surface" in tab) return tab;
  return { id: tab.id, label: tab.label, surface: tab };
}
