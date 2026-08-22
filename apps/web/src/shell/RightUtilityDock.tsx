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
  readonly browser?: ReactNode;
  readonly changes?: ReactNode;
  readonly files?: ReactNode;
  readonly iosSimulator?: ReactNode;
  readonly isNarrow: boolean;
  readonly launchableSurfaces: ReadonlyArray<RightUtilityDockSurfaceDescriptor>;
  readonly onClose: () => void;
  readonly onCloseTab: (surface: RightUtilityDockSurfaceId) => void;
  readonly onCommitWidth: (width: number) => void;
  readonly onOpenTab: (surface: RightUtilityDockSurfaceId) => void;
  readonly onPreviewWidth: (width: number) => void;
  readonly onSelectSurface: (surface: RightUtilityDockSurfaceId) => void;
  readonly open: boolean;
  readonly resolution: RightUtilityDockResolution;
  readonly restoreFocus?: RefObject<HTMLElement | null>;
  readonly sideChat?: ReactNode;
  readonly tabs: ReadonlyArray<RightUtilityDockSurfaceDescriptor>;
  readonly terminal?: ReactNode;
  readonly tests?: ReactNode;
  readonly thread?: ReactNode;
  readonly width: number;
}

export function RightUtilityDock(props: RightUtilityDockProps) {
  const closeButton = useRef<HTMLButtonElement>(null);

  if (!props.open) return null;

  // Only the narrow dock is a modal that nothing else can dismiss. Docked, the
  // window chrome's disclosure closes it, so the header carries no second
  // close of its own.
  const dismiss = props.isNarrow ? { closeButtonRef: closeButton, onClose: props.onClose } : {};
  const surface = (
    <RightUtilityDockSurface
      {...(props.browser === undefined ? {} : { browser: props.browser })}
      {...(props.changes === undefined ? {} : { changes: props.changes })}
      {...(props.files === undefined ? {} : { files: props.files })}
      {...(props.iosSimulator === undefined ? {} : { iosSimulator: props.iosSimulator })}
      launchableSurfaces={props.launchableSurfaces}
      onCloseTab={props.onCloseTab}
      onOpenTab={props.onOpenTab}
      onSelectSurface={props.onSelectSurface}
      resolution={props.resolution}
      {...(props.sideChat === undefined ? {} : { sideChat: props.sideChat })}
      tabs={props.tabs}
      {...(props.terminal === undefined ? {} : { terminal: props.terminal })}
      {...(props.tests === undefined ? {} : { tests: props.tests })}
      {...(props.thread === undefined ? {} : { thread: props.thread })}
      {...dismiss}
    />
  );

  if (props.isNarrow) {
    return (
      <OctantDialog
        initialFocus={closeButton}
        label={
          props.resolution.kind === "closed" ? "Right sidebar" : props.resolution.surface.label
        }
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
