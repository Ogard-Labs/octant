import { MAX_CONTEXT_SIDEBAR_WIDTH, MIN_CONTEXT_SIDEBAR_WIDTH } from "@octant/contracts/shell";
import { useRef, type ReactNode, type RefObject } from "react";
import { OctantDialog } from "../ui/base/OctantDialog";
import { RightUtilityDockSurface } from "./RightUtilityDockSurface";
import { ShellResizeHandle } from "./ShellResizeHandle";
import type {
  RightUtilityDockResolution,
  RightUtilityDockSurfaceDescriptor,
  RightUtilityDockSurfaceId,
} from "./rightUtilityDockModel";

export interface RightUtilityDockProps {
  readonly availableSurfaces: ReadonlyArray<RightUtilityDockSurfaceDescriptor>;
  readonly codeEnvironment: ReactNode;
  readonly context: ReactNode;
  readonly isNarrow: boolean;
  readonly navigator: ReactNode;
  readonly onClose: () => void;
  readonly onCommitWidth: (width: number) => void;
  readonly onPreviewWidth: (width: number) => void;
  readonly onRefreshEnvironment?: () => Promise<void> | void;
  readonly onSelectSurface: (surface: RightUtilityDockSurfaceId) => void;
  readonly plan: ReactNode;
  readonly projectMemory: ReactNode;
  readonly resolution: RightUtilityDockResolution;
  readonly restoreFocus?: RefObject<HTMLElement | null>;
  readonly width: number;
}

export function RightUtilityDock(props: RightUtilityDockProps) {
  const closeButton = useRef<HTMLButtonElement>(null);

  if (props.resolution.kind !== "surface") return null;

  const surface = (
    <RightUtilityDockSurface
      availableSurfaces={props.availableSurfaces}
      closeButtonRef={closeButton}
      codeEnvironment={props.codeEnvironment}
      context={props.context}
      navigator={props.navigator}
      onClose={props.onClose}
      {...(props.onRefreshEnvironment === undefined
        ? {}
        : { onRefreshEnvironment: props.onRefreshEnvironment })}
      onSelectSurface={props.onSelectSurface}
      plan={props.plan}
      projectMemory={props.projectMemory}
      resolution={props.resolution}
    />
  );

  if (props.isNarrow) {
    return (
      <OctantDialog
        initialFocus={closeButton}
        label={props.resolution.surface.label}
        onClose={props.onClose}
        open
        popupId="right-utility-dock"
        {...(props.restoreFocus === undefined ? {} : { restoreFocus: props.restoreFocus })}
      >
        {surface}
      </OctantDialog>
    );
  }

  return (
    <aside
      aria-label="Right Utility Dock"
      className="right-utility-dock window-no-drag"
      id="right-utility-dock"
    >
      <ShellResizeHandle
        accessibleName="Resize utility dock"
        className="right-utility-dock__resize"
        edge="leading"
        maximum={MAX_CONTEXT_SIDEBAR_WIDTH}
        minimum={MIN_CONTEXT_SIDEBAR_WIDTH}
        onCommit={props.onCommitWidth}
        onPreview={props.onPreviewWidth}
        value={props.width}
      />
      {surface}
    </aside>
  );
}
