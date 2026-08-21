import { X } from "lucide-react";
import type { ReactNode, Ref } from "react";
import { DockUtilityLauncher } from "./DockUtilityLauncher";
import { IconButton } from "./IconButton";
import { ShellState } from "./ShellState";
import type {
  RightUtilityDockResolution,
  RightUtilityDockSurfaceDescriptor,
  RightUtilityDockSurfaceId,
  RightUtilityDockUnavailableReason,
} from "./rightUtilityDockModel";

function unavailableMessage(reason: RightUtilityDockUnavailableReason): string {
  return reason === "thread-required"
    ? "The active pane holds no compatible thread. Focus a thread pane to restore its sidebar tabs."
    : "The active pane has no compatible Project for this sidebar tab.";
}

export interface RightUtilityDockSurfaceProps {
  readonly browser?: ReactNode;
  readonly changes?: ReactNode;
  readonly closeButtonRef?: Ref<HTMLButtonElement>;
  readonly context: ReactNode;
  readonly files?: ReactNode;
  readonly iosSimulator?: ReactNode;
  readonly launchableSurfaces: ReadonlyArray<RightUtilityDockSurfaceDescriptor>;
  readonly navigator: ReactNode;
  readonly onClose?: () => void;
  readonly onCloseTab: (surface: RightUtilityDockSurfaceId) => void;
  readonly onOpenTab: (surface: RightUtilityDockSurfaceId) => void;
  readonly onSelectSurface: (surface: RightUtilityDockSurfaceId) => void;
  readonly projectMemory: ReactNode;
  readonly resolution: RightUtilityDockResolution;
  readonly sideChat?: ReactNode;
  readonly summary: ReactNode;
  readonly tabs: ReadonlyArray<RightUtilityDockSurfaceDescriptor>;
  readonly terminal?: ReactNode;
  readonly tests?: ReactNode;
  readonly thread?: ReactNode;
}

export function RightUtilityDockSurface(props: RightUtilityDockSurfaceProps) {
  const activeSurface = props.resolution.kind === "closed" ? undefined : props.resolution.surface;
  return (
    <div className="right-utility-dock__surface" data-dock-surface={activeSurface?.id ?? "empty"}>
      <header className="dock-head right-utility-dock__toolbar">
        <div aria-label="Open utility tabs" className="right-utility-dock__tabs" role="tablist">
          <div className="right-utility-dock__tab-scroll">
            {props.tabs.map((surface) => (
              <span className="right-utility-dock__tab" key={surface.id}>
                <button
                  aria-selected={surface.id === activeSurface?.id}
                  className="right-utility-dock__tab-select window-no-drag"
                  onClick={() => props.onSelectSurface(surface.id)}
                  role="tab"
                  tabIndex={surface.id === activeSurface?.id ? 0 : -1}
                  type="button"
                >
                  {surface.label}
                </button>
                <IconButton
                  className="right-utility-dock__tab-close"
                  icon={X}
                  label={`Close ${surface.label} tab`}
                  onClick={() => props.onCloseTab(surface.id)}
                />
              </span>
            ))}
          </div>
          <DockUtilityLauncher onOpen={props.onOpenTab} surfaces={props.launchableSurfaces} />
        </div>
        {props.onClose === undefined ? null : (
          <IconButton
            icon={X}
            label="Close right sidebar"
            onClick={props.onClose}
            ref={props.closeButtonRef}
          />
        )}
      </header>
      <div className="right-utility-dock__summary">{props.summary}</div>
      <div className="dock-body right-utility-dock__content">
        {props.resolution.kind === "closed" ? (
          <ShellState
            message="Use Add utility tab to open a thread tool here."
            state="neutral"
            title="No utility open"
          />
        ) : props.resolution.kind === "unavailable" ? (
          <ShellState
            message={unavailableMessage(props.resolution.reason)}
            state="neutral"
            title={`${activeSurface?.label ?? "Utility"} has nothing to describe here`}
          />
        ) : (
          {
            context: props.context,
            "project-memory": props.projectMemory,
            navigator: props.navigator,
            "side-chat": props.sideChat,
            browser: props.browser,
            files: props.files,
            changes: props.changes,
            terminal: props.terminal,
            tests: props.tests,
            "ios-simulator": props.iosSimulator,
            thread: props.thread,
          }[props.resolution.surface.id]
        )}
      </div>
    </div>
  );
}
