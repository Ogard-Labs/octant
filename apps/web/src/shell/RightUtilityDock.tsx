import { MAX_CONTEXT_SIDEBAR_WIDTH, MIN_CONTEXT_SIDEBAR_WIDTH } from "@octant/contracts/shell";
import { useRef, type ReactNode, type RefObject } from "react";
import { OctantDialog } from "../ui/base/OctantDialog";
import { RightUtilityDockSurface } from "./RightUtilityDockSurface";
import type { DockUtilityLauncherReference } from "./DockUtilityLauncher";
import { ShellResizeHandle } from "./ShellResizeHandle";
import type {
  RightUtilityDockResolution,
  RightUtilityDockSurfaceDescriptor,
  RightUtilityDockSurfaceId,
  RightUtilityDockTabDescriptor,
} from "./rightUtilityDockModel";

export interface RightUtilityDockProps {
  readonly activeTabId?: string;
  readonly agents?: ReactNode;
  readonly browser?: ReactNode;
  readonly canvas?: ReactNode;
  readonly review?: ReactNode;
  readonly delivery?: ReactNode;
  readonly document?: ReactNode;
  readonly files?: ReactNode;
  readonly iosSimulator?: ReactNode;
  readonly isNarrow: boolean;
  readonly launchableSurfaces: ReadonlyArray<RightUtilityDockSurfaceDescriptor>;
  readonly launchableReferences?: ReadonlyArray<DockUtilityLauncherReference>;
  readonly onClose: () => void;
  readonly onCloseTab: (tabId: string) => void;
  readonly onCommitWidth: (width: number) => void;
  readonly onOpenTab: (surface: RightUtilityDockSurfaceId) => void;
  readonly onPreviewWidth: (width: number) => void;
  readonly onSelectSurface: (tabId: string) => void;
  readonly open: boolean;
  readonly plan?: ReactNode;
  readonly resolution: RightUtilityDockResolution;
  readonly renderTab?: (tab: RightUtilityDockTabDescriptor) => ReactNode;
  readonly restoreFocus?: RefObject<HTMLElement | null>;
  readonly sideChat?: ReactNode;
  readonly tabs: ReadonlyArray<RightUtilityDockSurfaceDescriptor | RightUtilityDockTabDescriptor>;
  readonly terminal?: ReactNode;
  readonly tests?: ReactNode;
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
      {...(props.activeTabId === undefined ? {} : { activeTabId: props.activeTabId })}
      {...(props.agents === undefined ? {} : { agents: props.agents })}
      {...(props.browser === undefined ? {} : { browser: props.browser })}
      {...(props.canvas === undefined ? {} : { canvas: props.canvas })}
      {...(props.review === undefined ? {} : { review: props.review })}
      {...(props.delivery === undefined ? {} : { delivery: props.delivery })}
      {...(props.document === undefined ? {} : { document: props.document })}
      {...(props.files === undefined ? {} : { files: props.files })}
      {...(props.iosSimulator === undefined ? {} : { iosSimulator: props.iosSimulator })}
      launchableSurfaces={props.launchableSurfaces}
      {...(props.launchableReferences === undefined
        ? {}
        : { launchableReferences: props.launchableReferences })}
      onCloseTab={props.onCloseTab}
      onOpenTab={props.onOpenTab}
      onSelectSurface={props.onSelectSurface}
      {...(props.plan === undefined ? {} : { plan: props.plan })}
      resolution={props.resolution}
      {...(props.renderTab === undefined ? {} : { renderTab: props.renderTab })}
      {...(props.sideChat === undefined ? {} : { sideChat: props.sideChat })}
      tabs={props.tabs}
      {...(props.terminal === undefined ? {} : { terminal: props.terminal })}
      {...(props.tests === undefined ? {} : { tests: props.tests })}
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
