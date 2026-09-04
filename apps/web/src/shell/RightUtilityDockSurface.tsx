import { X } from "lucide-react";
import type { ReactNode, Ref } from "react";
import { DockUtilityLauncher } from "./DockUtilityLauncher";
import { DockToolIcon } from "./dockToolIcons";
import { DockToolStrip } from "./DockToolStrip";
import { IconButton } from "./IconButton";
import { OctantButton } from "../ui/base/OctantButton";
import { ShellState } from "./ShellState";
import type {
  RightUtilityDockResolution,
  RightUtilityDockSurfaceDescriptor,
  RightUtilityDockSurfaceId,
  RightUtilityDockTabDescriptor,
} from "./rightUtilityDockModel";

function unavailableMessage(): string {
  return "The active pane holds no compatible thread. Focus a thread pane to restore its tools.";
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
  readonly launchableSurfaces: ReadonlyArray<RightUtilityDockSurfaceDescriptor>;
  readonly onClose?: () => void;
  readonly onCloseTab: (tabId: string) => void;
  readonly onOpenTab: (surface: RightUtilityDockSurfaceId) => void;
  readonly onSelectSurface: (tabId: string) => void;
  readonly plan?: ReactNode;
  readonly resolution: RightUtilityDockResolution;
  readonly sideChat?: ReactNode;
  readonly renderTab?: (tab: RightUtilityDockTabDescriptor) => ReactNode;
  readonly tabs: ReadonlyArray<RightUtilityDockSurfaceDescriptor | RightUtilityDockTabDescriptor>;
  readonly terminal?: ReactNode;
  readonly tests?: ReactNode;
}

export function RightUtilityDockSurface(props: RightUtilityDockSurfaceProps) {
  const activeSurface = props.resolution.kind === "closed" ? undefined : props.resolution.surface;
  const activeTabId = props.activeTabId ?? activeSurface?.id;
  const activeTab = props.tabs.find((tab) => tab.id === activeTabId);
  const remaining = props.launchableSurfaces.filter(
    (surface) =>
      surface.id === "browser" ||
      surface.id === "terminal" ||
      !props.tabs.some((tab) => dockTabSurface(tab).id === surface.id),
  );
  const contents: Readonly<Record<RightUtilityDockSurfaceId, ReactNode | undefined>> = {
    agents: props.agents,
    browser: props.browser,
    canvas: props.canvas,
    review: props.review,
    delivery: props.delivery,
    document: props.document,
    environment: props.environment,
    files: props.files,
    "ios-simulator": props.iosSimulator,
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
            <span aria-hidden="true" className="right-utility-dock__title-spacer" />
          ) : (
            <DockToolStrip
              {...(activeTabId === undefined ? {} : { active: activeTabId })}
              onClose={props.onCloseTab}
              onSelect={props.onSelectSurface}
              tabs={props.tabs}
            />
          )}
          {/* With no tool open the body already lists every tool; a second
              entry point beside an empty strip is a control with nothing to
              add. */}
          {props.tabs.length === 0 ? null : (
            <DockUtilityLauncher onOpen={props.onOpenTab} surfaces={remaining} />
          )}
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
        {props.resolution.kind === "closed" ? (
          <DockWorkMap onOpen={props.onOpenTab} surfaces={props.launchableSurfaces} />
        ) : props.resolution.kind === "unavailable" ? (
          <ShellState
            message={unavailableMessage()}
            state="neutral"
            title={`${activeSurface?.label ?? "Tool"} has nothing to describe here`}
          />
        ) : activeTab === undefined ? null : (
          <div key={activeTab.id} className="right-utility-dock__tool">
            {props.renderTab?.(dockTabDescriptor(activeTab)) ??
              contents[dockTabSurface(activeTab).id]}
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

function DockWorkMap(props: {
  readonly onOpen: (surface: RightUtilityDockSurfaceId) => void;
  readonly surfaces: ReadonlyArray<RightUtilityDockSurfaceDescriptor>;
}) {
  return (
    <section aria-labelledby="dock-work-map-title" className="dock-work-map">
      <header className="dock-work-map__header">
        <h2 id="dock-work-map-title">Current work</h2>
        <p>Tools available for the active thread.</p>
      </header>
      {props.surfaces.length === 0 ? (
        <p className="dock-work-map__empty">This thread has no additional tools available.</p>
      ) : (
        <div className="dock-work-map__list">
          {props.surfaces.map((surface) => (
            <OctantButton
              aria-label={surface.label}
              className="dock-work-map__item"
              key={surface.id}
              onClick={() => props.onOpen(surface.id)}
              type="button"
              variant="ghost"
            >
              <DockToolIcon surface={surface.id} />
              <span className="dock-work-map__copy">
                <strong>{surface.label}</strong>
                <small>{workMapDetail(surface.id)}</small>
              </span>
            </OctantButton>
          ))}
        </div>
      )}
    </section>
  );
}

function workMapDetail(surface: RightUtilityDockSurfaceId): string {
  if (surface === "agents") return "Inspect and control child runs";
  if (surface === "environment") return "Inspect this thread's working context";
  if (surface === "browser") return "Inspect live web activity";
  if (surface === "canvas") return "Open the thread Canvas";
  if (surface === "review") return "Review checkout changes";
  if (surface === "delivery") return "Inspect the delivery target";
  if (surface === "files") return "Browse the active checkout";
  if (surface === "document") return "Read the document this thread wrote";
  if (surface === "ios-simulator") return "Open the active Simulator";
  if (surface === "plan") return "Inspect the current plan";
  if (surface === "side-chat") return "Ask about this thread";
  if (surface === "terminal") return "Open the repository shell";
  return "Run discovered repository tests";
}
