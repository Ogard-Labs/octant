import { X } from "lucide-react";
import type { ReactNode, Ref } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { IconButton } from "./IconButton";
import type {
  RightUtilityDockResolution,
  RightUtilityDockSurfaceDescriptor,
  RightUtilityDockSurfaceId,
} from "./rightUtilityDockModel";

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
}

export function RightUtilityDockSurface(props: RightUtilityDockSurfaceProps) {
  if (props.resolution.kind !== "surface") return null;

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
        {
          {
            context: props.context,
            "project-memory": props.projectMemory,
            navigator: props.navigator,
          }[activeSurface.id]
        }
      </div>
    </div>
  );
}
