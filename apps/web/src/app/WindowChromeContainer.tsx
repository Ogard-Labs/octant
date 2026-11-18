import type { OctantMode } from "@octant/contracts/modes";
import { memo } from "react";
import type { OctantHostBridge, ResolvedSidebarMaterial } from "../shell/hostBridge";
import { WindowChrome } from "../shell/WindowChrome";
import type { WindowHistory } from "../shell/windowHistory";
import type { ShellActions } from "./shellActions";

export interface WindowChromeContainerProps {
  readonly actions: Pick<ShellActions, "recoverZen" | "startNewThreadDraft" | "toggleDock">;
  readonly activeMode: OctantMode;
  readonly activeSurface: string;
  readonly dockAvailable: boolean;
  readonly dockPresentedOpen: boolean;
  readonly hostBridge?: OctantHostBridge;
  readonly hostReservesTitlebarInset: boolean;
  readonly isNarrow: boolean;
  readonly material: ResolvedSidebarMaterial;
  readonly presentedSidebarCollapsed: boolean;
  readonly setSidebarCollapsed: (collapsed: boolean) => void;
  readonly sidebarRail: boolean;
  readonly zenRecoveryNeeded: boolean;
  /** Stable between moves; see useWindowHistory. */
  readonly windowHistory: WindowHistory;
}

/**
 * The window's top chrome: the sidebar and the narrow window's dock disclosure. A
 * thread's tool buttons are not here; they stand in its pane's header. Every
 * input is a primitive or a stable action, so a shell render that changed none
 * of them leaves it alone.
 */
export const WindowChromeContainer = memo(function WindowChromeContainer(
  props: WindowChromeContainerProps,
) {
  const {
    actions,
    activeMode,
    activeSurface,
    dockAvailable,
    dockPresentedOpen,
    hostReservesTitlebarInset,
    isNarrow,
    material,
    presentedSidebarCollapsed,
    setSidebarCollapsed,
    sidebarRail,
    zenRecoveryNeeded,
  } = props;
  return (
    <WindowChrome
      activeSurface={activeSurface}
      dockAvailable={dockAvailable}
      dockExpanded={dockPresentedOpen}
      dockLabel="Right sidebar"
      {...(props.hostBridge === undefined ? {} : { hostBridge: props.hostBridge })}
      isNarrow={isNarrow}
      material={material}
      nativeTitlebarInset={hostReservesTitlebarInset}
      {...(presentedSidebarCollapsed
        ? { onExpandSidebar: () => setSidebarCollapsed(false), history: props.windowHistory }
        : {})}
      {...(presentedSidebarCollapsed && !sidebarRail
        ? {
            newThreadLabel: activeMode === "chat" ? "New chat" : "New task",
            onNewThread: () => actions.startNewThreadDraft(activeMode),
          }
        : {})}
      onRecoverZen={() => void actions.recoverZen()}
      onToggleDock={actions.toggleDock}
      zenRecoveryNeeded={zenRecoveryNeeded}
    />
  );
});
