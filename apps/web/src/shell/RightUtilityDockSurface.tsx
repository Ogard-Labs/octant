import { X } from "lucide-react";
import type { ReactNode, Ref } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { IconButton } from "./IconButton";
import { ShellState } from "./ShellState";
import type {
  RightUtilityDockResolution,
  RightUtilityDockSurfaceDescriptor,
  RightUtilityDockSurfaceId,
  RightUtilityDockUnavailableReason,
} from "./rightUtilityDockModel";

/**
 * Names what the active pane is missing, rather than one message covering
 * every reason. A Project-scoped panel and a thread-scoped one go empty for
 * different reasons, and telling a reader to open a Project when what they
 * need is a thread sends them the wrong way.
 */
function unavailableMessage(reason: RightUtilityDockUnavailableReason): string {
  return reason === "thread-required"
    ? "The dock describes the active pane, and this pane holds no thread. Activate a pane with one to fill this panel again."
    : "The dock describes the active pane, and this pane has no compatible Project. Activate a pane with one to fill this panel again.";
}

export interface RightUtilityDockSurfaceProps {
  readonly availableSurfaces: ReadonlyArray<RightUtilityDockSurfaceDescriptor>;
  readonly closeButtonRef?: Ref<HTMLButtonElement>;
  readonly context: ReactNode;
  /**
   * Present only when nothing outside the dock can dismiss it. Docked beside
   * the workspace, the window chrome's disclosure already closes it, and a
   * second control with the same name sits within a few pixels of it.
   */
  readonly onClose?: () => void;
  readonly navigator: ReactNode;
  readonly onSelectSurface: (surface: RightUtilityDockSurfaceId) => void;
  readonly projectMemory: ReactNode;
  readonly resolution: RightUtilityDockResolution;
  readonly thread: ReactNode;
}

export function RightUtilityDockSurface(props: RightUtilityDockSurfaceProps) {
  if (props.resolution.kind === "closed") return null;

  const activeSurface = props.resolution.surface;
  const dismiss = props.onClose;
  return (
    <div className="right-utility-dock__surface" data-dock-surface={activeSurface.id}>
      <header className="dock-head right-utility-dock__toolbar">
        {/* The tabs name the surface. A heading above them repeated that name
            on its own line, under an eyebrow nobody outside the code calls a
            utility dock. */}
        {props.availableSurfaces.length > 1 ? (
          <nav aria-label="Utility dock surfaces" className="right-utility-dock__tabs">
            {props.availableSurfaces.map((surface) => (
              <OctantButton
                aria-pressed={surface.id === activeSurface.id}
                key={surface.id}
                onClick={() => props.onSelectSurface(surface.id)}
                type="button"
                variant="ghost"
              >
                {surface.label}
              </OctantButton>
            ))}
          </nav>
        ) : (
          <h2 className="right-utility-dock__identity">{activeSurface.label}</h2>
        )}
        {dismiss === undefined ? null : (
          <div className="right-utility-dock__actions">
            <IconButton
              icon={X}
              label={`Close ${activeSurface.label}`}
              onClick={dismiss}
              ref={props.closeButtonRef}
            />
          </div>
        )}
      </header>
      <div className="dock-body right-utility-dock__content">
        {/* An unavailable panel renders this state and nothing else: the
            previous pane's content must never stand in for a pane the panel
            cannot describe. */}
        {props.resolution.kind === "unavailable" ? (
          <ShellState
            message={unavailableMessage(props.resolution.reason)}
            state="neutral"
            title={`${activeSurface.label} has nothing to describe here`}
          />
        ) : (
          {
            context: props.context,
            "project-memory": props.projectMemory,
            navigator: props.navigator,
            thread: props.thread,
          }[activeSurface.id]
        )}
      </div>
    </div>
  );
}
