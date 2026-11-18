import { OctantEmpty } from "../ui/base/OctantEmpty";
import { X } from "../ui/icons";
import { useContext, useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { DockShelf, type DockShelfEntry } from "./DockShelf";
import { DockTiles, type DockTileContent } from "./DockTiles";
import { DockToolButtons, type DockToolButtonsProps } from "./DockToolButtons";
import { registerDockDropTarget, useDraggedDockTool, type DockDragPoint } from "./dockToolDrag";
import { DockToolIcon } from "./dockToolIcons";
import { PageFavicon } from "./PageFavicon";
import { PanelTab, PanelTabStrip } from "./PanelTabs";
import { IconButton } from "./IconButton";
import {
  MINIMISABLE_DOCK_SURFACES,
  moveUtilityTile,
  placeUtilityTile,
  type DockTileLayout,
  type DockTileEdge,
  type DockTileMove,
  type ThreadUtilityDockState,
} from "./rightUtilityDockSelection";
import {
  splitEnvironmentStrip,
  storedColumnShares,
  storedTileShares,
} from "./dockEnvironmentStrip";
import {
  ENVIRONMENT_STRIP_WIDTH,
  type RightUtilityDockResolution,
  type RightUtilityDockSurfaceDescriptor,
  type RightUtilityDockSurfaceId,
  type RightUtilityDockTabDescriptor,
} from "./rightUtilityDockModel";

type PagedSurface = "browser" | "terminal";

/** The tools whose instances are pages in one tile: one tab each, plus a new one. */
const PAGED_SURFACES: Readonly<
  Record<PagedSurface, { readonly name: string; readonly label: string; readonly newLabel: string }>
> = {
  browser: { name: "Browser", label: "Browser pages", newLabel: "New Browser page" },
  terminal: { name: "Terminal", label: "Terminal sessions", newLabel: "New terminal" },
};

function isPagedSurface(surface: RightUtilityDockSurfaceId): surface is PagedSurface {
  return surface === "browser" || surface === "terminal";
}

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
  /**
   * The open tabs whose tool stands as a card on the shelf instead of in a
   * tile. The modal presentation draws no shelf, so there the tool is shown
   * as any other.
   */
  readonly minimised?: ReadonlyArray<string>;
  readonly onHideTile: (tabId: string) => void;
  /** Takes a Browser or Terminal tool out of view as a card on the shelf. */
  readonly onMinimise: (tabId: string) => void;
  readonly onMove: (tabId: string, direction: DockTileMove) => void;
  /** Takes a shown tile to an edge of another shown tile. */
  readonly onPlace: (tabId: string, targetTabId: string, edge: DockTileEdge) => void;
  /** Opens a tool and shows it beside the focused tile in one step. */
  readonly onResizeColumn: (columnIndex: number, shares: ReadonlyArray<number>) => void;
  readonly onResizeColumns: (shares: ReadonlyArray<number>) => void;
  readonly onShowAlone: (tabId: string) => void;
  readonly onShowBelow: (tabId: string) => void;
  readonly onShowBeside: (tabId: string) => void;
  /** The tools the bottom panel can hold; a pane of one of them can be dragged there. */
  readonly bottomSurfaces?: ReadonlyArray<RightUtilityDockSurfaceId>;
  /** Moves a tool to the bottom panel, as choosing it there does. */
  readonly onMoveToBottom?: (surface: RightUtilityDockSurfaceId) => void;
}

/** What a card does with the dock around it, so the keyboard never falls to the page. */
export interface DockCardControls {
  /** Closes the page or shell the card stands for, as its tab's close does. */
  readonly onClose: () => void;
  readonly onHide: () => void;
  readonly onShow: () => void;
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
  readonly artifacts?: ReactNode;
  readonly onClose?: () => void;
  readonly onCloseTab: (tabId: string) => void;
  readonly onOpenTab: (surface: RightUtilityDockSurfaceId) => void;
  /** A Browser page's favicon as a `data:` URL, when the page has declared one. */
  readonly pageIcon?: (tabId: string) => string | undefined;
  /** What a Browser page shows: its title, else its host; absent before a page loads. */
  readonly pageTitle?: (tabId: string) => string | undefined;
  readonly onSelectSurface: (tabId: string) => void;
  /** What the dock shows above its tool launcher while no tool is chosen. */
  readonly overview?: ReactNode;
  readonly plan?: ReactNode;
  readonly resolution: RightUtilityDockResolution;
  /**
   * The cards at the foot of the dock, and how each is drawn. The surface owns
   * where the shelf stands and when it is absent; the cards' own reads belong
   * to whoever renders them.
   */
  readonly shelf?: {
    readonly entries: ReadonlyArray<DockShelfEntry>;
    /** The surface hands each card controls that keep the keyboard's place. */
    readonly renderCard: (entry: DockShelfEntry, controls: DockCardControls) => ReactNode;
    /** Brings the card's tool back. */
    readonly onShow: (tabId: string) => void;
    /** Takes the card away, leaving the tool open. */
    readonly onHide: (tabId: string) => void;
  };
  readonly sideChat?: ReactNode;
  readonly renderTab?: (tab: RightUtilityDockTabDescriptor) => ReactNode;
  readonly tabs: ReadonlyArray<RightUtilityDockSurfaceDescriptor | RightUtilityDockTabDescriptor>;
  readonly terminal?: ReactNode;
  readonly tests?: ReactNode;
  readonly tiles?: DockTileControls;
  /**
   * Whether the window holds two columns of tools side by side. Where it does
   * not, no pane or tool is offered a place beside another.
   */
  readonly columnsFit?: boolean;
  /**
   * The handle that sizes the tool columns. With the Environment strip open it
   * stands on the seam between the strip and the tools, so the strip is never
   * what a drag moves; without the strip the dock draws it on its own edge.
   */
  readonly toolResizeHandle?: ReactNode;
  /**
   * The row of tool buttons, given only where the dock is a drawer: the window
   * is inert behind it, so the row stands in the drawer's header. Docked, the
   * row lives in the thread pane's header and the dock has no head of its own
   * over its panes.
   */
  readonly toolRow?: DockToolButtonsProps;
}

export function RightUtilityDockSurface(props: RightUtilityDockSurfaceProps) {
  const activeSurface = props.resolution.kind === "closed" ? undefined : props.resolution.surface;
  const activeTabId = props.activeTabId ?? activeSurface?.id;
  const activeTab = props.tabs.find((tab) => tab.id === activeTabId);
  const toolPanel = useRef<HTMLElement>(null);
  // Every open Browser is one Browser tool with pages, the way a browser
  // keeps its tabs inside its own window: the title band's Browser button names
  // it once, and the pages sit in a row of their own inside it.
  const browserTabs = props.tabs.filter((tab) => dockTabSurface(tab).id === "browser");
  const pagedTabs = (surface: PagedSurface) =>
    surface === "browser"
      ? browserTabs
      : props.tabs.filter((tab) => dockTabSurface(tab).id === surface);
  const tiles = props.tiles;
  const layout = tiles?.layout;
  // Tiles are drawn whenever a layout exists and the dock is not the narrow
  // modal, whatever the focused tool's own state: each tile resolves itself, so
  // one unavailable tool never takes the others off screen.
  const tiled = tiles !== undefined && layout !== undefined && !tiles.narrow;
  // The shelf is the modal presentation's one omission: there is no room, and
  // the state is kept for the dock that has.
  const shelfDrawn = tiles !== undefined && !tiles.narrow;
  const shelfEntries = shelfDrawn ? (props.shelf?.entries ?? []) : [];
  const split = splitEnvironmentStrip({
    tabs: props.tabs.map((tab) => ({ id: tab.id, surface: dockTabSurface(tab).id })),
    ...(activeTabId === undefined ? {} : { active: activeTabId }),
    ...(layout === undefined ? {} : { layout }),
    ...(tiles?.minimised === undefined ? {} : { minimised: tiles.minimised }),
  });
  // Environment is a strip of its own beside the tool columns, never a tile
  // among them, so it keeps its width whatever opens or closes beside it.
  const environmentTab =
    split.environmentTabId === undefined
      ? undefined
      : props.tabs.find((tab) => tab.id === split.environmentTabId);
  const strip = environmentTab !== undefined && shelfDrawn;
  const drag = useDraggedDockTool();
  // A tool dragged from its button in the title band; a pane dragged by its
  // bar lands among the tiles, which take it themselves.
  const draggedTool = drag?.source === "button" ? drag.tabId : undefined;
  const dropShield = useRef<HTMLDivElement>(null);
  const [dropZone, setDropZone] = useState<"beside" | "below" | "replace">();
  const root = useRef<HTMLDivElement>(null);
  // Hiding a tile or closing a tool unmounts the control that held keyboard
  // focus; the tool's button in the title band takes it, so the keyboard keeps
  // its place.
  const [refocus, setRefocus] = useState<{
    readonly surface?: RightUtilityDockSurfaceId;
    /** A tool that became a card: its card's first control takes the focus. */
    readonly card?: RightUtilityDockSurfaceId;
  }>();
  useEffect(() => {
    if (refocus === undefined) return;
    if (refocus.card !== undefined) {
      // The card mounts a beat after the tool leaves its tile. Focus goes to it
      // only while it is still free: on the page body, or in the menu that
      // closes; anywhere the person has since put it, it stays.
      const wantedCard = refocus.card;
      const takeCard = () => {
        const card = root.current?.querySelector<HTMLElement>(
          `[data-dock-card="${wantedCard}"] .dock-mini-card__action`,
        );
        const current = document.activeElement;
        const free =
          current === null ||
          current === document.body ||
          current.closest('[role="menu"]') !== null;
        if (card?.isConnected === true && free && current !== card) card.focus();
      };
      const cardTimers = [0, 60, 250].map((delay) => setTimeout(takeCard, delay));
      return () => {
        for (const timer of cardTimers) clearTimeout(timer);
      };
    }
    const buttonOf = (surface: RightUtilityDockSurfaceId | undefined) =>
      surface === undefined
        ? undefined
        : // Every thread pane of a split has the tool's button: the focused
          // pane's is the one the dock belongs to.
          (document.querySelector<HTMLElement>(
            `.workspace-pane[data-active="true"] [data-dock-tool="${surface}"]`,
          ) ??
          document.querySelector<HTMLElement>(`[data-dock-tool="${surface}"]`) ??
          undefined);
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
  useEffect(() => {
    if (draggedTool === undefined) setDropZone(undefined);
  }, [draggedTool]);
  const surfaceOfTab = (tabId: string): RightUtilityDockSurfaceId | undefined => {
    const tab = props.tabs.find((candidate) => candidate.id === tabId);
    return tab === undefined ? undefined : dockTabSurface(tab).id;
  };
  const placementState: ThreadUtilityDockState = {
    tabs: props.tabs.map((tab) => ({ id: tab.id, surface: dockTabSurface(tab).id })),
    ...(activeTabId === undefined ? {} : { active: activeTabId }),
    ...(layout === undefined ? {} : { layout }),
    ...(tiles?.minimised === undefined || tiles.minimised.length === 0
      ? {}
      : { minimised: [...tiles.minimised] }),
  };
  /** The part of the dock body the pointer is over, or undefined outside it. */
  const zoneAt = useRef<(point: DockDragPoint) => "beside" | "below" | "replace" | undefined>(
    () => undefined,
  );
  zoneAt.current = (point) => {
    const rect = dropShield.current?.getBoundingClientRect();
    if (
      rect === undefined ||
      point.clientX < rect.left ||
      point.clientX > rect.right ||
      point.clientY < rect.top ||
      point.clientY > rect.bottom
    )
      return undefined;
    const sideways = props.columnsFit !== false;
    if (sideways && rect.width > 0 && point.clientX - rect.left > (rect.width * 2) / 3)
      return "beside";
    if (rect.height > 0 && point.clientY - rect.top > (rect.height * 2) / 3) return "below";
    return "replace";
  };
  const dropTool = useRef<(id: string, zone: "beside" | "below" | "replace") => void>(
    () => undefined,
  );
  dropTool.current = (id, zone) => {
    if (zone === "beside") tiles?.onShowBeside(id);
    else if (zone === "below") tiles?.onShowBelow(id);
    else props.onSelectSurface(id);
  };
  useEffect(
    () =>
      registerDockDropTarget({
        over: (dragged, point) => {
          if (dragged.source !== "button") return;
          setDropZone(point === undefined ? undefined : zoneAt.current(point));
        },
        drop: (dragged, point) => {
          if (dragged.source !== "button") return false;
          const zone = zoneAt.current(point);
          if (zone === undefined) return false;
          dropTool.current(dragged.tabId, zone);
          return true;
        },
      }),
    [],
  );
  /**
   * A paged tool's pages (the Browser's pages, the Terminal's sessions) are its
   * pane's bar, alone or among tiles. Every Browser and Terminal has the row,
   * one page included, so a page never loses its tab. A Browser page is named
   * for what it shows (the page's title, else its host, "New tab" before a
   * page loads); "Browser 1" and "Browser 2" told two pages apart by nothing.
   */
  function pagesRow(surface: PagedSurface, selectedId: string | undefined) {
    const paged = PAGED_SURFACES[surface];
    const pages = pagedTabs(surface);
    return (
      <PanelTabStrip
        className="dock-browser-pages"
        label={paged.label}
        newTabLabel={paged.newLabel}
        onNewTab={() => props.onOpenTab(surface)}
        selectedId={selectedId}
      >
        {pages.map((page) => {
          const favicon = surface === "browser" ? props.pageIcon?.(page.id) : undefined;
          const label =
            surface === "browser" ? (props.pageTitle?.(page.id) ?? "New tab") : page.label;
          // The close button names the tab as the tab reads, never "Browser 2".
          return (
            <PanelTab
              closeLabel={`Close ${label}`}
              icon={
                surface === "browser" ? (
                  <PageFavicon src={favicon} />
                ) : (
                  <DockToolIcon surface={surface} />
                )
              }
              id={page.id}
              key={page.id}
              label={label}
              onClose={() => props.onCloseTab(page.id)}
              title={label}
              onSelect={() => props.onSelectSurface(page.id)}
              roving={
                page.id === (pages.some((tab) => tab.id === selectedId) ? selectedId : pages[0]?.id)
              }
              selected={page.id === selectedId}
            />
          );
        })}
      </PanelTabStrip>
    );
  }
  /**
   * The tool's panel. A paged tool's page is keyed by its tab, so choosing
   * another page replaces only the page.
   */
  function renderToolBody(
    tab: RightUtilityDockSurfaceDescriptor | RightUtilityDockTabDescriptor,
    pages: PagedSurface | undefined,
  ) {
    return pages !== undefined ? (
      <>
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
    const pages = isPagedSurface(tool.id) ? tool.id : undefined;
    const label = pages === undefined ? tab.label : PAGED_SURFACES[pages].name;
    const movable = (direction: DockTileMove) =>
      moveUtilityTile(placementState, tab.id, direction) !== placementState;
    return {
      key: pages ?? tab.id,
      label,
      surface: tool.id,
      barLeading:
        pages !== undefined ? (
          pagesRow(pages, tab.id)
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
      bodyClassName: `right-utility-dock__tool${pages === undefined ? "" : " right-utility-dock__tool--pages"}`,
      minimisable: shelfDrawn && MINIMISABLE_DOCK_SURFACES.has(tool.id),
      inset: tool.id === "plan" || tool.id === "delivery" || tool.id === "agents",
      children:
        available.kind === "surface" ? (
          renderToolBody(tab, pages)
        ) : (
          <OctantEmpty
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
    artifacts: props.artifacts,
    plan: props.plan,
    "side-chat": props.sideChat,
    terminal: props.terminal,
    tests: props.tests,
  };

  const toolbar = (
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
  );
  // The tiles for what the tool columns show; the stored layout, or the one
  // focused tool as a single tile.
  const tilesNode = (
    <DockTiles
      focusedTabId={activeTabId}
      layout={
        strip
          ? (split.toolLayout ?? { columns: [] })
          : tiled
            ? (layout ?? { columns: [] })
            : {
                columns: [{ share: 1, tiles: [{ tabId: activeTab?.id ?? "", share: 1 }] }],
              }
      }
      onCloseTile={closeTool}
      onFocusTile={props.onSelectSurface}
      onHideTile={(tabId) => {
        // From the tile's menu: focus is in a popup, so it is not "inside".
        const surface = surfaceOfTab(tabId);
        if (surface !== undefined) setRefocus({ surface });
        tiles?.onHideTile(tabId);
      }}
      onMinimiseTile={(tabId) => {
        const surface = surfaceOfTab(tabId);
        if (surface !== undefined) setRefocus({ card: surface });
        tiles?.onMinimise(tabId);
      }}
      onMoveTile={(tabId, direction) => tiles?.onMove(tabId, direction)}
      canPlaceTile={(tabId, targetTabId, edge) => {
        // A drop that would leave the tiles where they are is no placement.
        const order = (state: ThreadUtilityDockState) =>
          JSON.stringify(
            state.layout?.columns.map((column) => column.tiles.map((tile) => tile.tabId)),
          );
        return (
          order(placeUtilityTile(placementState, tabId, targetTabId, edge)) !==
          order(placementState)
        );
      }}
      onPlaceTile={(tabId, targetTabId, edge) => tiles?.onPlace(tabId, targetTabId, edge)}
      {...(props.columnsFit === undefined ? {} : { columnsFit: props.columnsFit })}
      {...(tiles?.onMoveToBottom === undefined || tiles.narrow
        ? {}
        : {
            bottomPanel: {
              accepts: (tabId: string) => {
                const surface = surfaceOfTab(tabId);
                return surface !== undefined && (tiles.bottomSurfaces ?? []).includes(surface);
              },
              onMove: (tabId: string) => {
                const surface = surfaceOfTab(tabId);
                if (surface !== undefined) tiles.onMoveToBottom?.(surface);
              },
            },
          })}
      onResizeColumn={(index, shares) => {
        if (!strip) return tiles?.onResizeColumn(index, shares);
        const stored = storedTileShares(placementState, split, index, shares);
        if (stored !== undefined) tiles?.onResizeColumn(stored.column, stored.shares);
      }}
      onResizeColumns={(shares) => {
        if (!strip) return tiles?.onResizeColumns(shares);
        const stored = storedColumnShares(placementState, split, shares);
        if (stored !== undefined) tiles?.onResizeColumns(stored);
      }}
      onShowTileAlone={(tabId) => tiles?.onShowAlone(tabId)}
      panelRef={toolPanel}
      renderTile={renderTile}
    />
  );
  const dragShield =
    draggedTool !== undefined && tiles !== undefined && !tiles.narrow ? (
      <div className="dock-tiles__drag-shield" ref={dropShield}>
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
    ) : null;
  const shelfNode =
    shelfEntries.length === 0 || props.shelf === undefined ? null : (
      <DockShelf
        entries={shelfEntries}
        renderCard={(entry) =>
          props.shelf?.renderCard(entry, {
            // The card unmounts as the tool is restored; the tool's button
            // in the row takes the focus the card held.
            onShow: () => {
              setRefocus({ surface: entry.surface });
              props.shelf?.onShow(entry.tabId);
            },
            // A closed tool leaves no button open, so the keyboard goes to
            // the same place a hidden card sends it.
            onClose: () => {
              setRefocus({ surface: entry.surface });
              props.onCloseTab(entry.tabId);
            },
            // A card that goes away hands the keyboard to the tool's button.
            onHide: () => {
              setRefocus({ surface: entry.surface });
              props.shelf?.onHide(entry.tabId);
            },
          })
        }
      />
    );

  if (strip) {
    const environmentAvailable = tiles?.resolveSurface("environment") ?? { kind: "surface" };
    return (
      <div
        className="right-utility-dock__surface right-utility-dock__surface--strip"
        data-dock-lead="tiles"
        data-dock-surface={activeSurface?.id ?? "empty"}
        ref={root}
      >
        <section
          aria-label="Environment"
          className="dock-env-strip"
          data-shelf={shelfEntries.length === 0 ? undefined : "true"}
          style={{ width: ENVIRONMENT_STRIP_WIDTH }}
        >
          <div className="right-utility-dock__tool dock-env-strip__body">
            {environmentAvailable.kind === "surface" ? (
              renderToolBody(environmentTab, undefined)
            ) : (
              <OctantEmpty
                message={unavailableMessage()}
                state="neutral"
                title="Environment is unavailable"
              />
            )}
            {/* Minimised Browsers and terminals flow after the last section
                as live previews, rather than standing pinned to the foot. */}
            {shelfNode}
          </div>
        </section>
        {split.toolTabIds.length === 0 ? null : (
          // No spacer over the tiles: a pane's bar is as tall as the title
          // band and stands in it, on the thread header's line.
          <div className="dock-tool-column">
            {props.toolResizeHandle}
            <div className="dock-body right-utility-dock__content">
              {tilesNode}
              {dragShield}
            </div>
          </div>
        )}
      </div>
    );
  }

  // Docked, a pane's bar stands in the title band, on the thread header's
  // line, so the tiles start at the dock's top. Everything else the dock shows
  // (its overview, a notice) starts under the
  // band, and the drawer keeps its own head with the tool row and Close.
  const tilesLead =
    tiles !== undefined &&
    !tiles.narrow &&
    props.resolution.kind !== "closed" &&
    !(!tiled && props.resolution.kind === "unavailable") &&
    activeTab !== undefined;
  return (
    <div
      className="right-utility-dock__surface"
      data-dock-lead={tilesLead ? "tiles" : undefined}
      data-dock-surface={activeSurface?.id ?? "empty"}
      ref={root}
    >
      {tilesLead ? null : toolbar}
      <div
        className="dock-body right-utility-dock__content"
        data-shelf={shelfEntries.length === 0 ? undefined : "true"}
      >
        {props.resolution.kind === "closed" ? (
          <div className="dock-start">{props.overview}</div>
        ) : !tiled && props.resolution.kind === "unavailable" ? (
          <div className="right-utility-dock__tool" data-dock-state="true">
            <OctantEmpty
              message={unavailableMessage()}
              state="neutral"
              title={`${activeSurface?.label ?? "Tool"} is unavailable`}
            />
          </div>
        ) : activeTab === undefined ? null : (
          // One tile is the single-tool view: the same tree as several, so a
          // tool that gains or loses a neighbour is never remounted.
          tilesNode
        )}
        {dragShield}
        {shelfNode}
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
