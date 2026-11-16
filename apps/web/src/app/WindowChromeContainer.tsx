import type { OctantMode } from "@octant/contracts/modes";
import type { ProjectId } from "@octant/contracts";
import { createProjectClient, type ProjectClient } from "@octant/client-runtime/project-client";
import { memo, useCallback, useMemo } from "react";
import type { OctantHostBridge, ResolvedSidebarMaterial } from "../shell/hostBridge";
import { WindowChrome } from "../shell/WindowChrome";
import type { TitleBandChangesFacts } from "../shell/TitleBandChanges";
import type { WindowHistory } from "../shell/windowHistory";
import type { DockToolButtonsModel } from "../shell/dockToolButtonsModel";
import type { DockUtilityLauncherReference } from "../shell/DockUtilityLauncher";
import { useProjectCheckoutChanges } from "../shell/useProjectCheckoutChanges";
import type { ShellActions } from "./shellActions";

export interface WindowChromeContainerProps {
  readonly actions: Pick<
    ShellActions,
    | "addDockTab"
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
  /**
   * The window is on the Code start screen or a draft, where the band reads the
   * Project's own checkout because no thread has one yet.
   */
  readonly codeDraft?: boolean;
  /** A Code Project's reading is wanted only when the Project is one. */
  readonly activeProjectIsCode?: boolean;
  readonly projectClient?: ProjectClient;
  readonly serverUrl?: string;
  readonly windowCapability?: string;
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
  const draftChanges = props.codeDraft === true && codeThreadId === undefined;
  const projectClient = useMemo(
    () =>
      props.projectClient ??
      (props.serverUrl === undefined || props.windowCapability === undefined
        ? undefined
        : createProjectClient({
            baseUrl: props.serverUrl,
            fetch: globalThis.fetch,
            windowCapability: props.windowCapability,
          })),
    [props.projectClient, props.serverUrl, props.windowCapability],
  );
  const projectChanges = useProjectCheckoutChanges({
    client: projectClient,
    projectId: codeProjectId,
    enabled: draftChanges && activeMode === "code" && props.activeProjectIsCode === true,
    revision: props.codeBoardRevision,
  });
  const onOpenChanges = useCallback(() => actions.addDockTab("review"), [actions]);
  // The count stands in the band on a Code start screen only. In a thread it is
  // a row of Environment ("Uncommitted changes"), beside the actions that act on
  // it, and the band repeated it a few pixels above (maintainer request,
  // 2026-11-16). On the start screen a stale reading stays in meta ink and a
  // checkout not read yet holds its place with a dash, so the band never gains,
  // loses or resizes a control as the reading arrives; a Project with no Git
  // checkout shows nothing.
  const changes = useMemo((): TitleBandChangesFacts | undefined => {
    if (activeMode !== "code") return undefined;
    if (!draftChanges || props.activeProjectIsCode !== true) return undefined;
    if (projectChanges.status === "none") return undefined;
    if (projectChanges.status === "reading") return { updating: true, onOpen: onOpenChanges };
    return {
      ...(projectChanges.insertions === undefined ? {} : { insertions: projectChanges.insertions }),
      ...(projectChanges.deletions === undefined ? {} : { deletions: projectChanges.deletions }),
      updating: projectChanges.updating,
      onOpen: onOpenChanges,
    };
  }, [activeMode, draftChanges, props.activeProjectIsCode, projectChanges, onOpenChanges]);
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
