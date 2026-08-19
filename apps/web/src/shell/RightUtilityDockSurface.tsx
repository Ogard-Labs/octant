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
  readonly onClose: () => void;
  readonly navigator: ReactNode;
  readonly onSelectSurface: (surface: RightUtilityDockSurfaceId) => void;
  readonly projectMemory: ReactNode;
  readonly resolution: RightUtilityDockResolution;
}

export function RightUtilityDockSurface(props: RightUtilityDockSurfaceProps) {
  if (props.resolution.kind !== "surface") return null;

  const activeSurface = props.resolution.surface;
  return (
    <div className="right-utility-dock__surface" data-dock-surface={activeSurface.id}>
      <header className="right-utility-dock__toolbar">
        <div className="right-utility-dock__identity">
          <span>Utility dock</span>
          <h2>{activeSurface.label}</h2>
        </div>
        <div className="right-utility-dock__actions">
          <IconButton
            icon={X}
            label={`Close ${activeSurface.label}`}
            onClick={props.onClose}
            ref={props.closeButtonRef}
          />
        </div>
      </header>
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
      ) : null}
      <div className="right-utility-dock__content">
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
