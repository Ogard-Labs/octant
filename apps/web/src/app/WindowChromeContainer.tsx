import type { OctantMode } from "@octant/contracts/modes";
import { memo } from "react";
import type { OctantHostBridge, ResolvedSidebarMaterial } from "../shell/hostBridge";
import { WindowChrome } from "../shell/WindowChrome";
import type { ShellActions } from "./shellActions";

export interface WindowChromeContainerProps {
  readonly actions: Pick<
    ShellActions,
    "recoverZen" | "startNewThreadDraft" | "toggleBottomPanel" | "toggleDock"
  >;
  readonly activeMode: OctantMode;
  readonly activeSurface: string;
  readonly bottomPanelAvailable: boolean;
  readonly bottomPanelPresentedOpen: boolean;
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
}

/**
 * The window's top chrome: the active surface's title and the sidebar, dock
 * and bottom panel disclosures. Every input is a primitive or a stable
 * action, so a shell render that changed none of them leaves it alone.
 */
export const WindowChromeContainer = memo(function WindowChromeContainer(
  props: WindowChromeContainerProps,
) {
  const {
    actions,
    activeMode,
    activeSurface,
    bottomPanelAvailable,
    bottomPanelPresentedOpen,
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
      bottomPanelAvailable={bottomPanelAvailable && !isNarrow}
      bottomPanelExpanded={bottomPanelPresentedOpen}
      dockAvailable={dockAvailable}
      dockExpanded={dockPresentedOpen}
      dockLabel="Right sidebar"
      {...(props.hostBridge === undefined ? {} : { hostBridge: props.hostBridge })}
      isNarrow={isNarrow}
      material={material}
      nativeTitlebarInset={hostReservesTitlebarInset}
      {...(presentedSidebarCollapsed && !sidebarRail
        ? { onExpandSidebar: () => setSidebarCollapsed(false) }
        : {})}
      {...(presentedSidebarCollapsed && !sidebarRail
        ? {
            newThreadLabel: activeMode === "chat" ? "New chat" : "New task",
            onNewThread: () => actions.startNewThreadDraft(activeMode),
          }
        : {})}
      onRecoverZen={() => void actions.recoverZen()}
      onToggleBottomPanel={actions.toggleBottomPanel}
      onToggleDock={actions.toggleDock}
      zenRecoveryNeeded={zenRecoveryNeeded}
    />
  );
});
