import type { OctantMode } from "@octant/contracts/modes";
import type { ProjectId } from "@octant/contracts";
import { memo, useMemo } from "react";
import type { OctantHostBridge, ResolvedSidebarMaterial } from "../shell/hostBridge";
import { WindowChrome } from "../shell/WindowChrome";
import type { WindowHistory } from "../shell/windowHistory";
import type { DockToolButtonsModel } from "../shell/dockToolButtonsModel";
import type { DockUtilityLauncherReference } from "../shell/DockUtilityLauncher";
import { useThreadBoardCard } from "../shell/useThreadBoardCard";
import type { ShellActions } from "./shellActions";

export interface WindowChromeContainerProps {
  readonly actions: Pick<
    ShellActions,
    | "addDockTab"
    | "loadCodeBoard"
    | "recoverZen"
    | "startNewThreadDraft"
    | "toggleBottomPanel"
    | "toggleDock"
    | "toggleDockTool"
    | "runDockToolMenu"
  >;
  readonly activeMode: OctantMode;
  readonly activeSurface: string;
  /** The Code thread on screen, whose checkout the band measures; absent for a draft or another mode. */
  readonly activeCodeThreadId?: string;
  readonly activeProjectId?: ProjectId;
  /** Moves when the host says the Code board changed, so the count is read again. */
  readonly codeBoardRevision: number;
  readonly bottomPanelAvailable: boolean;
  readonly bottomPanelPresentedOpen: boolean;
  readonly dockAvailable: boolean;
  /** The agent's Browser is live and has a card the closed dock is holding. */
  readonly dockBrowserActive: boolean;
  readonly dockPresentedOpen: boolean;
  /** Value-stable between renders; see the model in App. */
  readonly dockTools?: DockToolButtonsModel;
  /** The pull requests listed in More tools; stable between renders. */
  readonly dockReferences?: ReadonlyArray<DockUtilityLauncherReference>;
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
    dockBrowserActive,
    dockPresentedOpen,
    hostReservesTitlebarInset,
    isNarrow,
    material,
    presentedSidebarCollapsed,
    setSidebarCollapsed,
    sidebarRail,
    zenRecoveryNeeded,
  } = props;
  const codeThreadId = props.activeCodeThreadId;
  const codeProjectId = props.activeProjectId;
  const card = useThreadBoardCard({
    loadBoard: actions.loadCodeBoard,
    projectId: codeProjectId,
    threadId: codeThreadId ?? "",
    enabled: codeThreadId !== undefined && codeProjectId !== undefined,
    changeRevision: props.codeBoardRevision,
  });
  const observed = card?.changedFiles;
  // A stale observation may describe a tree the thread has since changed, so
  // the band says nothing rather than a number that could be wrong.
  const insertions =
    observed?.kind === "observed" && observed.freshness === "fresh"
      ? observed.insertions
      : undefined;
  const deletions =
    observed?.kind === "observed" && observed.freshness === "fresh"
      ? observed.deletions
      : undefined;
  const changes = useMemo(
    () =>
      insertions === undefined || deletions === undefined
        ? undefined
        : { insertions, deletions, onOpen: () => actions.addDockTab("review") },
    [insertions, deletions, actions],
  );
  return (
    <WindowChrome
      {...(changes === undefined ? {} : { changes })}
      activeSurface={activeSurface}
      bottomPanelAvailable={bottomPanelAvailable && !isNarrow}
      bottomPanelExpanded={bottomPanelPresentedOpen}
      dockAvailable={dockAvailable}
      // The modal dock draws no shelf, so a dot there would promise a card
      // that cannot be shown.
      dockBrowserActive={dockBrowserActive && !dockPresentedOpen && !isNarrow}
      dockExpanded={dockPresentedOpen}
      dockLabel="Right sidebar"
      {...(props.dockTools === undefined
        ? {}
        : {
            dockTools: props.dockTools,
            onToggleDockTool: actions.toggleDockTool,
            onDockToolMenuAction: actions.runDockToolMenu,
            ...(props.dockReferences === undefined ? {} : { dockReferences: props.dockReferences }),
          })}
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
      onToggleBottomPanel={actions.toggleBottomPanel}
      onToggleDock={actions.toggleDock}
      zenRecoveryNeeded={zenRecoveryNeeded}
    />
  );
});
