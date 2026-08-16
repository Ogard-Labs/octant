import { RefreshCw, X } from "lucide-react";
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
  readonly codeEnvironment: ReactNode;
  readonly context: ReactNode;
  readonly onClose: () => void;
  readonly onRefreshEnvironment?: () => Promise<void> | void;
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
          {activeSurface.id === "code-environment" && props.onRefreshEnvironment !== undefined ? (
            <IconButton
              icon={RefreshCw}
              label="Refresh Code environment"
              onClick={() => void props.onRefreshEnvironment?.()}
            />
          ) : null}
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
        {activeSurface.id === "context"
          ? props.context
          : activeSurface.id === "project-memory"
            ? props.projectMemory
            : activeSurface.id === "navigator"
              ? props.navigator
              : props.codeEnvironment}
      </div>
    </div>
  );
}
