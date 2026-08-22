import { X } from "lucide-react";
import type { ReactNode, Ref } from "react";
import { DockToolLaunchList, DockUtilityLauncher } from "./DockUtilityLauncher";
import { DockToolStrip } from "./DockToolStrip";
import { IconButton } from "./IconButton";
import { ShellState } from "./ShellState";
import type {
  RightUtilityDockResolution,
  RightUtilityDockSurfaceDescriptor,
  RightUtilityDockSurfaceId,
} from "./rightUtilityDockModel";

function unavailableMessage(): string {
  return "The active pane holds no compatible thread. Focus a thread pane to restore its tools.";
}

export interface RightUtilityDockSurfaceProps {
  readonly agents?: ReactNode;
  readonly browser?: ReactNode;
  readonly canvas?: ReactNode;
  readonly review?: ReactNode;
  readonly closeButtonRef?: Ref<HTMLButtonElement>;
  readonly delivery?: ReactNode;
  readonly files?: ReactNode;
  readonly iosSimulator?: ReactNode;
  readonly launchableSurfaces: ReadonlyArray<RightUtilityDockSurfaceDescriptor>;
  readonly onClose?: () => void;
  readonly onCloseTab: (surface: RightUtilityDockSurfaceId) => void;
  readonly onOpenTab: (surface: RightUtilityDockSurfaceId) => void;
  readonly onSelectSurface: (surface: RightUtilityDockSurfaceId) => void;
  readonly plan?: ReactNode;
  readonly resolution: RightUtilityDockResolution;
  readonly sideChat?: ReactNode;
  readonly tabs: ReadonlyArray<RightUtilityDockSurfaceDescriptor>;
  readonly terminal?: ReactNode;
  readonly tests?: ReactNode;
}

export function RightUtilityDockSurface(props: RightUtilityDockSurfaceProps) {
  const activeSurface = props.resolution.kind === "closed" ? undefined : props.resolution.surface;
  const remaining = props.launchableSurfaces.filter(
    (surface) => !props.tabs.some((tab) => tab.id === surface.id),
  );
  const contents: Readonly<Record<RightUtilityDockSurfaceId, ReactNode | undefined>> = {
    agents: props.agents,
    browser: props.browser,
    canvas: props.canvas,
    review: props.review,
    delivery: props.delivery,
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
        {props.tabs.length === 0 ? (
          <p className="right-utility-dock__identity">Tools</p>
        ) : (
          <DockToolStrip
            {...(activeSurface === undefined ? {} : { active: activeSurface.id })}
            onClose={props.onCloseTab}
            onSelect={props.onSelectSurface}
            tabs={props.tabs}
          />
        )}
        <div className="right-utility-dock__actions">
          {props.tabs.length === 0 ? null : (
            <DockUtilityLauncher onOpen={props.onOpenTab} surfaces={remaining} />
          )}
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
          <div className="dock-tool-launcher">
            <ShellState
              message="Open a thread-owned tool to work beside this pane."
              state="neutral"
              title="No tool open"
            />
            {props.launchableSurfaces.length === 0 ? null : (
              <div className="dock-tool-launcher__list">
                <DockToolLaunchList onOpen={props.onOpenTab} surfaces={props.launchableSurfaces} />
              </div>
            )}
          </div>
        ) : props.resolution.kind === "unavailable" ? (
          <ShellState
            message={unavailableMessage()}
            state="neutral"
            title={`${activeSurface?.label ?? "Tool"} has nothing to describe here`}
          />
        ) : (
          props.tabs.map((tab) => (
            <div
              hidden={tab.id !== activeSurface?.id}
              key={tab.id}
              className="right-utility-dock__tool"
            >
              {contents[tab.id]}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
