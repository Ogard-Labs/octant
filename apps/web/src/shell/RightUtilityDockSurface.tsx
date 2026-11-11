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
import { DockShowBesideMenu } from "./DockShowBesideMenu";
import { DockUtilityLauncher, type DockUtilityLauncherReference } from "./DockUtilityLauncher";
import { DockToolIcon } from "./dockToolIcons";
import { DockToolStrip } from "./DockToolStrip";
import { IconButton } from "./IconButton";
import { OctantButton } from "../ui/base/OctantButton";
import { ShellState } from "./ShellState";
import { StartQuickTools, StartQuickToolsPlacementContext } from "./StartQuickTools";
import { MULTI_INSTANCE_DOCK_SURFACES } from "./rightUtilityDockModel";
import {
  MAX_DOCK_TILE_COLUMNS,
  MAX_DOCK_TILES_PER_COLUMN,
  showUtilityTabBelow,
  showUtilityTabBeside,
  type DockTileLayout,
  type ThreadUtilityDockState,
} from "./rightUtilityDockSelection";
import type { OctantMenuItem } from "../ui/base/OctantMenu";
import type {
  RightUtilityDockResolution,
  RightUtilityDockSurfaceDescriptor,
  RightUtilityDockSurfaceId,
  RightUtilityDockTabDescriptor,
} from "./rightUtilityDockModel";

function unavailableMessage(): string {
  return "The active pane holds no compatible thread. Focus a thread pane to restore its tools.";
}

/** Why a tool in the band cannot open yet while the pane's task has no thread. */
const TOOLS_AWAIT_TASK_START = "Available once the task starts";

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
  readonly launchableSurfaces: ReadonlyArray<RightUtilityDockSurfaceDescriptor>;
  readonly launchableReferences?: ReadonlyArray<DockUtilityLauncherReference>;
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
   * The active pane is a new Code task whose thread does not exist yet. The
   * band shows these tools disabled and the body says when they open, so the
   * dock keeps its place instead of closing and reopening around the first
   * message; nothing is launchable, so Add tool stays absent.
   */
  readonly toolsAwaitingThread?: ReadonlyArray<RightUtilityDockSurfaceDescriptor>;
}

export function RightUtilityDockSurface(props: RightUtilityDockSurfaceProps) {
  const activeSurface = props.resolution.kind === "closed" ? undefined : props.resolution.surface;
  const activeTabId = props.activeTabId ?? activeSurface?.id;
  const activeTab = props.tabs.find((tab) => tab.id === activeTabId);
  const quickToolsProjectId = useContext(StartQuickToolsPlacementContext)?.projectId;
  const remaining = props.launchableSurfaces.filter(
    (surface) =>
      MULTI_INSTANCE_DOCK_SURFACES.has(surface.id) ||
      !props.tabs.some((tab) => dockTabSurface(tab).id === surface.id),
  );
  // A tile that opens a tool is replaced by that tool, so the focus it held
  // would fall to the page. The opened tool takes it instead. Only a tile asks
  // for this: selecting a tab in the strip keeps focus on the tab.
  const toolPanel = useRef<HTMLElement>(null);
  const focusOpenedTool = useRef(false);
  const openedTabId = activeTab?.id;
  // Every open Browser is one Browser tool with pages, the way a browser
  // keeps its tabs inside its own window. As separate strip tabs, two Browsers
  // beside a Terminal and Environment crowded the title band with "Browser 1"
  // and "Browser 2"; the band now names the Browser once and the pages sit in
  // their own row inside it.
  const browserTabs = props.tabs.filter((tab) => dockTabSurface(tab).id === "browser");
  // The Browser keeps the first page's place in the strip, whichever page is
  // showing: standing in for the selected page, it moved past the Terminal and
  // back as pages were chosen.
  const browserRepresentative = browserTabs[0];
  const browserActive = activeTab !== undefined && dockTabSurface(activeTab).id === "browser";
  const stripTabs = props.tabs.flatMap((tab) => {
    if (dockTabSurface(tab).id !== "browser") return [tab];
    if (tab !== browserRepresentative) return [];
    return [browserTabs.length > 1 && "surface" in tab ? { ...tab, label: "Browser" } : tab];
  });
  const stripActive =
    browserActive && browserRepresentative !== undefined ? browserRepresentative.id : activeTabId;
  const tiles = props.tiles;
  const layout = tiles?.layout;
  // Tiles are drawn whenever a layout exists and the dock is not the narrow
  // modal, whatever the focused tool's own state: each tile resolves itself, so
  // one unavailable tool never takes the others off screen.
  const tiled = tiles !== undefined && layout !== undefined && !tiles.narrow;
  const shownIds: ReadonlyArray<string> = tiled
    ? layout.columns.flatMap((column) => column.tiles.map((tile) => tile.tabId))
    : [];
  // The strip names the Browser once, so its entry stands for whichever page
  // is shown, or for the first page when none is.
  const shownBrowserId = shownIds.find((id) => browserTabs.some((tab) => tab.id === id));
  const toolOf = (stripId: string) =>
    stripId === browserRepresentative?.id
      ? (shownBrowserId ?? (browserActive ? activeTabId : undefined) ?? stripId)
      : stripId;
  const shownInStrip = new Set(
    shownIds.map((id) =>
      browserTabs.some((tab) => tab.id === id) && browserRepresentative !== undefined
        ? browserRepresentative.id
        : id,
    ),
  );
  const [draggedTool, setDraggedTool] = useState<string>();
  const [dropZone, setDropZone] = useState<"beside" | "below" | "replace">();
  const root = useRef<HTMLDivElement>(null);
  // Hiding a tile or closing a tab unmounts the control that held keyboard
  // focus; the tab strip takes it, so the keyboard keeps its place.
  const [refocus, setRefocus] = useState<{ readonly tab?: string }>();
  useEffect(() => {
    if (refocus === undefined) return;
    const tabs = [...(root.current?.querySelectorAll<HTMLElement>("[data-dock-tab]") ?? [])];
    const target =
      refocus.tab === undefined
        ? tabs.find((tab) => tab.getAttribute("aria-selected") === "true")
        : tabs.find((tab) => tab.dataset.dockTab === refocus.tab);
    target?.focus();
    setRefocus(undefined);
  }, [refocus]);
  // A drag that ends where no dragend reaches (its source unmounted) must not
  // leave the drop target over the dock.
  useEffect(() => {
    if (draggedTool === undefined) return;
    const clear = () => {
      setDraggedTool(undefined);
      setDropZone(undefined);
    };
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
    };
  }, [draggedTool]);
  const focusInside = () => root.current?.contains(document.activeElement) === true;
  const stripIdOf = (tabId: string) =>
    browserTabs.some((tab) => tab.id === tabId) && browserRepresentative !== undefined
      ? browserRepresentative.id
      : tabId;
  const placementState: ThreadUtilityDockState = {
    tabs: props.tabs.map((tab) => ({ id: tab.id, surface: dockTabSurface(tab).id })),
    ...(activeTabId === undefined ? {} : { active: activeTabId }),
    ...(layout === undefined ? {} : { layout }),
  };
  function tabMenu(stripId: string): ReadonlyArray<OctantMenuItem> {
    if (tiles === undefined || tiles.narrow || props.resolution.kind !== "surface") return [];
    const id = toolOf(stripId);
    const items: OctantMenuItem[] = [];
    if (id !== activeTabId) {
      items.push(
        {
          label: "Show beside",
          value: "beside",
          disabled: showUtilityTabBeside(placementState, id) === placementState,
        },
        {
          label: "Show below",
          value: "below",
          disabled: showUtilityTabBelow(placementState, id) === placementState,
        },
      );
    }
    if (layout !== undefined && shownIds.includes(id)) {
      items.push(
        { label: "Show alone", value: "alone" },
        { label: "Hide from view", value: "hide" },
      );
    }
    return items;
  }
  function runTabMenu(stripId: string, value: string) {
    const id = toolOf(stripId);
    if (value === "beside") tiles?.onShowBeside(id);
    else if (value === "below") tiles?.onShowBelow(id);
    else if (value === "alone") tiles?.onShowAlone(id);
    else if (value === "hide") tiles?.onHideTile(id);
  }
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
    setDraggedTool(undefined);
    setDropZone(undefined);
    if (id === undefined) return;
    if (zone === "beside") tiles?.onShowBeside(id);
    else if (zone === "below") tiles?.onShowBelow(id);
    else props.onSelectSurface(id);
  }
  function renderToolBody(
    tab: RightUtilityDockSurfaceDescriptor | RightUtilityDockTabDescriptor,
    selectedId: string | undefined,
    pages: boolean,
  ) {
    return pages ? (
      <>
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
        <div className="dock-browser-pages__page-body" key={tab.id}>
          {props.renderTab?.(dockTabDescriptor(tab)) ?? contents[dockTabSurface(tab).id]}
        </div>
      </>
    ) : (
      (props.renderTab?.(dockTabDescriptor(tab)) ?? contents[dockTabSurface(tab).id])
    );
  }
  function renderTile(tabId: string): DockTileContent | undefined {
    const tab = props.tabs.find((candidate) => candidate.id === tabId);
    if (tab === undefined) return undefined;
    const tool = dockTabSurface(tab);
    const available = tiles?.resolveSurface(tool.id) ?? { kind: "surface" };
    const pages = tool.id === "browser" && browserTabs.length > 1;
    return {
      key: pages ? "browser" : tab.id,
      label: pages ? "Browser" : tab.label,
      surface: tool.id,
      bodyClassName: `right-utility-dock__tool${pages ? " right-utility-dock__tool--pages" : ""}`,
      inset: tool.id === "plan" || tool.id === "delivery" || tool.id === "agents",
      children:
        available.kind === "surface" ? (
          renderToolBody(tab, tab.id, pages)
        ) : (
          <ShellState
            message={unavailableMessage()}
            state="neutral"
            title={`${tool.label} is unavailable`}
          />
        ),
    };
  }
  useEffect(() => {
    if (!focusOpenedTool.current || openedTabId === undefined) return;
    focusOpenedTool.current = false;
    toolPanel.current?.focus();
  }, [openedTabId]);
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

  // "Show a tool beside" is for a dock with a tool on screen and room for one
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
        onOpen={tiles.onOpenBeside}
        onShowOpen={(stripId) => tiles.onShowBeside(toolOf(stripId))}
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
          {props.tabs.length === 0 ? (
            <DockQuickTools
              {...(props.toolsAwaitingThread === undefined
                ? {}
                : { disabledReason: TOOLS_AWAIT_TASK_START })}
              onOpen={(surface) => {
                focusOpenedTool.current = true;
                props.onOpenTab(surface);
              }}
              surfaces={props.toolsAwaitingThread ?? props.launchableSurfaces}
            />
          ) : (
            <DockToolStrip
              {...(stripActive === undefined ? {} : { active: stripActive })}
              onClose={(tabId) => {
                if (focusInside()) setRefocus({});
                // Closing the Browser closes all its pages, as closing a
                // browser window does.
                if (tabId === browserRepresentative?.id) {
                  for (const tab of browserTabs) props.onCloseTab(tab.id);
                  return;
                }
                props.onCloseTab(tabId);
              }}
              menuFor={tabMenu}
              onMenuAction={runTabMenu}
              onTabDragEnd={() => {
                setDraggedTool(undefined);
                setDropZone(undefined);
              }}
              onTabDragStart={(tabId) => setDraggedTool(toolOf(tabId))}
              shown={shownInStrip}
              onSelect={(tabId) => {
                focusOpenedTool.current = false;
                // The Browser entry keeps the page already showing, in the
                // focused tile or in a Browser tile that is not focused.
                const target = toolOf(tabId);
                if (tabId === browserRepresentative?.id && target === activeTabId) return;
                props.onSelectSurface(target);
              }}
              tabs={stripTabs}
            />
          )}
          {/* The title band offers a few tools by face; Add tool lists every
              other one, and the task's own pull requests. */}
          <DockUtilityLauncher
            onOpen={props.onOpenTab}
            surfaces={remaining}
            {...(props.launchableReferences === undefined
              ? {}
              : { references: props.launchableReferences })}
          />
        </div>
        <div className="right-utility-dock__actions">
          {showBeside}
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
            onFocusTile={props.onSelectSurface}
            onHideTile={(tabId) => {
              if (focusInside()) setRefocus({ tab: stripIdOf(tabId) });
              tiles?.onHideTile(tabId);
            }}
            onResizeColumn={(index, shares) => tiles?.onResizeColumn(index, shares)}
            onResizeColumns={(shares) => tiles?.onResizeColumns(shares)}
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

/** The tools the title band offers before any is open, in this order. */
const QUICK_TOOLS: ReadonlyArray<RightUtilityDockSurfaceId> = [
  "environment",
  "terminal",
  "browser",
  "files",
  "ios-simulator",
  "android-emulator",
];

/**
 * The title band's tools while none is open: Environment by name, the rest as
 * icons, so the band reads the same before and after a tool opens and the
 * tools a thread reaches for most are one click away. A tool this thread
 * cannot open is left out rather than shown dead. The one exception is a task
 * whose thread does not exist yet: its tools are shown disabled with the
 * reason, because they are about to exist and leaving them out made the band
 * empty, then full, around the first message.
 */
function DockQuickTools(props: {
  /** Spoken and hover explanation for tools the reader cannot open yet. */
  readonly disabledReason?: string;
  readonly onOpen: (surface: RightUtilityDockSurfaceId) => void;
  readonly surfaces: ReadonlyArray<RightUtilityDockSurfaceDescriptor>;
}) {
  const available = QUICK_TOOLS.flatMap((id) => {
    const surface = props.surfaces.find((candidate) => candidate.id === id);
    return surface === undefined ? [] : [surface];
  });
  return (
    <div aria-label="Quick tools" className="dock-quick-tools" role="group">
      {available.map((surface) => (
        <OctantButton
          aria-description={props.disabledReason}
          aria-label={`Open ${surface.label}`}
          className="dock-quick-tools__tool window-no-drag"
          data-labelled={surface.id === "environment" ? "true" : undefined}
          disabled={props.disabledReason !== undefined}
          key={surface.id}
          onClick={() => props.onOpen(surface.id)}
          size="sm"
          title={props.disabledReason ?? surface.label}
          type="button"
          variant="ghost"
        >
          <DockToolIcon surface={surface.id} />
          {surface.id === "environment" ? <span>{surface.label}</span> : null}
        </OctantButton>
      ))}
    </div>
  );
}
