import { Plus, X } from "lucide-react";
import { useContext, useEffect, useRef, type ReactNode, type Ref } from "react";
import { DockUtilityLauncher, type DockUtilityLauncherReference } from "./DockUtilityLauncher";
import { DockToolIcon } from "./dockToolIcons";
import { DockToolStrip } from "./DockToolStrip";
import { IconButton } from "./IconButton";
import { OctantButton } from "../ui/base/OctantButton";
import { ShellState } from "./ShellState";
import { StartQuickTools, StartQuickToolsPlacementContext } from "./StartQuickTools";
import { MULTI_INSTANCE_DOCK_SURFACES } from "./rightUtilityDockModel";
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
  const toolPanel = useRef<HTMLDivElement>(null);
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
  const showPages = browserActive && browserTabs.length > 1;
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
    plan: props.plan,
    "side-chat": props.sideChat,
    terminal: props.terminal,
    tests: props.tests,
  };

  return (
    <div className="right-utility-dock__surface" data-dock-surface={activeSurface?.id ?? "empty"}>
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
                // Closing the Browser closes all its pages, as closing a
                // browser window does.
                if (tabId === browserRepresentative?.id) {
                  for (const tab of browserTabs) props.onCloseTab(tab.id);
                  return;
                }
                props.onCloseTab(tabId);
              }}
              onSelect={(tabId) => {
                focusOpenedTool.current = false;
                // The Browser entry keeps the page already showing.
                if (tabId === browserRepresentative?.id && browserActive) return;
                props.onSelectSurface(tabId);
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
        ) : props.resolution.kind === "unavailable" ? (
          <ShellState
            message={unavailableMessage()}
            state="neutral"
            title={`${activeSurface?.label ?? "Tool"} is unavailable`}
          />
        ) : activeTab === undefined ? null : (
          <div
            aria-label={showPages ? "Browser" : activeTab.label}
            key={showPages ? "browser" : activeTab.id}
            className={`right-utility-dock__tool${showPages ? " right-utility-dock__tool--pages" : ""}`}
            ref={toolPanel}
            role="region"
            tabIndex={-1}
            data-dock-inset={
              activeSurface?.id === "plan" ||
              activeSurface?.id === "delivery" ||
              activeSurface?.id === "agents"
                ? "true"
                : undefined
            }
          >
            {showPages ? (
              <>
                <div aria-label="Browser pages" className="dock-browser-pages" role="tablist">
                  {browserTabs.map((tab) => (
                    <span className="dock-browser-pages__page content-tab" key={tab.id}>
                      <OctantButton
                        aria-selected={tab.id === activeTabId}
                        className="content-tab__select border-0 bg-transparent text-inherit hover:bg-transparent focus-visible:bg-transparent aria-expanded:bg-transparent"
                        onClick={() => props.onSelectSurface(tab.id)}
                        role="tab"
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        <DockToolIcon surface="browser" />
                        <span>{tab.label}</span>
                      </OctantButton>
                      <IconButton
                        className="content-tab__close text-muted-foreground"
                        icon={X}
                        label={`Close ${tab.label}`}
                        onClick={() => props.onCloseTab(tab.id)}
                      />
                    </span>
                  ))}
                  <IconButton
                    icon={Plus}
                    label="New Browser page"
                    onClick={() => props.onOpenTab("browser")}
                  />
                </div>
                <div className="dock-browser-pages__page-body" key={activeTab.id}>
                  {props.renderTab?.(dockTabDescriptor(activeTab)) ??
                    contents[dockTabSurface(activeTab).id]}
                </div>
              </>
            ) : (
              (props.renderTab?.(dockTabDescriptor(activeTab)) ??
              contents[dockTabSurface(activeTab).id])
            )}
          </div>
        )}
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
