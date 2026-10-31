import type { ChatThreadId } from "@octant/contracts/chat";
import {
  decodeCodeThreadId,
  type CodeCheckoutId,
  type CodeBootstrap,
  type CodeThreadView,
} from "@octant/contracts/code";
import type { CodeProjectPullRequestDetailQuery } from "@octant/contracts";
import type { ContextInspectorSnapshot } from "@octant/contracts/context-rpc";
import type { OctantMode } from "@octant/contracts/modes";
import type { ProjectId } from "@octant/contracts/projects";
import type { ProviderInstanceId, ProviderModelId } from "@octant/contracts/providers";
import type { buildModelPickerGroups } from "@octant/domain";
import type { SideChatSidecar } from "@octant/contracts";
import { memo, useMemo } from "react";
import type { AgentRunViewRequest } from "../agents/AgentRunHierarchy";
import type { createChatReadCursorStore } from "../chat/useChatController";
import type { CodeController } from "../code/useCodeController";
import { composerContextOccupancy } from "../context/ComposerContextMeter";
import type { ComposerContextMeterProvider } from "../context/composerContextMeterScope";
import { ProjectReviewModule as DockProjectPullRequestReviewTool } from "../dockModules/ProjectReviewModule";
import {
  parseRepository,
  type useRepositoryPullRequests,
} from "../environment/useRepositoryPullRequests";
import type { AgentResultReviewRequest } from "../gitHistory/SavedAgentReview";
import type { ProviderController } from "../providers/useProviderController";
import { BottomUtilityPanel } from "../shell/BottomUtilityPanel";
import { DockThreadOverviewContent } from "../shell/DockThreadOverviewContent";
import { runningNowThreads } from "../shell/dockThreadOverviewModel";
import { remoteAccessAdministrationOf, type OctantHostBridge } from "../shell/hostBridge";
import { RightUtilityDock } from "../shell/RightUtilityDock";
import type {
  RightUtilityDockResolution,
  RightUtilityDockSurfaceDescriptor,
  RightUtilityDockSurfaceId,
} from "../shell/rightUtilityDockModel";
import {
  updateThreadUtilityTabBrowserContext,
  updateUtilityTabBrowserContext,
  type ThreadUtilityDockKey,
  type ThreadUtilityDockState,
  type ThreadUtilityDockTab,
} from "../shell/rightUtilityDockSelection";
import { ThreadUtilityDockContent } from "../shell/ThreadUtilityDockContent";
import type { useThreadUtilityPresentation } from "../shell/useThreadUtilityPresentation";
import type { describeUtilityTabs } from "../shell/utilityTabs";
import type { WrittenDocumentOffers } from "../shell/writtenDocuments";
import type { createLaunchedShellClients } from "./createLaunchedShellClients";
import type { ShellActions } from "./shellActions";
import type { ShellNavigationModel } from "./shellNavigationModel";

/** What the dock's thread overview says about the thread, selected down to the words it shows. */
export interface DockOverviewThread {
  readonly access: string | undefined;
  readonly modelId: ProviderModelId;
  readonly projectId: ProjectId;
  readonly providerInstanceId: ProviderInstanceId;
}

export interface DockContainerProps {
  readonly actions: Pick<
    ShellActions,
    | "addDockTab"
    | "closeBottomPanel"
    | "closeBottomPanelTab"
    | "closeDock"
    | "closeDockTab"
    | "loadCodeBoard"
    | "mergeProjectPullRequest"
    | "openBottomTool"
    | "openCodeSurface"
    | "openDockTab"
    | "openLinkedProjectPullRequestThread"
    | "openPreview"
    | "openProjectPullRequestChat"
    | "openSettings"
    | "openSubagent"
    | "persistBottomPanelPresentation"
    | "selectChatThread"
    | "selectCodeThread"
    | "selectDockTab"
    | "selectProjectPullRequest"
    | "selectProjectPullRequestIdentity"
    | "selectWorkThread"
    | "setDockSidecarsByThread"
    | "setDockStatesByThread"
    | "setFallbackDockState"
    | "setPreviewBottomPanelHeight"
    | "setPreviewContextWidth"
    | "setRequestedAgentReview"
    | "setRequestedAgentView"
    | "setSelectedProjectPullRequest"
    | "openWrittenDocument"
    | "updateSettings"
  >;
  readonly activeBottomSurface?: RightUtilityDockSurfaceDescriptor;
  readonly activeCodeThreadUsageFallback: Parameters<
    typeof ComposerContextMeterProvider
  >[0]["fallback"];
  readonly activeMode: OctantMode;
  readonly activeProjectId?: ProjectId;
  readonly appleProjectPath?: string;
  readonly bottomPanelHeight: number;
  readonly bottomPanelOpen: boolean;
  readonly bottomPanelPresentation: ReturnType<
    typeof useThreadUtilityPresentation
  >["bottomPanelPresentation"];
  readonly bottomPanelPresentedOpen: boolean;
  readonly bottomPanelSurfaces: ReadonlyArray<RightUtilityDockSurfaceDescriptor>;
  readonly bottomPanelTabs: ReadonlyArray<RightUtilityDockSurfaceDescriptor>;
  readonly canvasRevisionsByThread: ReadonlyMap<ThreadUtilityDockKey, string>;
  readonly chatReadCursorStore: ReturnType<typeof createChatReadCursorStore>;
  readonly clients: ReturnType<typeof createLaunchedShellClients>;
  readonly codeNavigationRevision: number;
  readonly codeProviderGroups: ReturnType<typeof buildModelPickerGroups>;
  /**
   * The active Code thread's controller, handed over only while a tool that
   * reads it is on screen. The controller is a new object on every event of a
   * streaming turn; with the overview or nothing showing, no tool is mounted
   * to read it, and withholding it is what lets the dock sit still.
   */
  readonly codeThreadController?: CodeController;
  /** Settings › Code's diff layout, for the Review tool's default. */
  readonly codeDiffLayout?: CodeBootstrap["settings"]["defaultDiffLayout"];
  /** The active Code thread as its controller read it, only while a tool that shows it is open. */
  readonly codeThreadView?: CodeThreadView;
  readonly contextSnapshot?: ContextInspectorSnapshot;
  readonly displayedDockState: ThreadUtilityDockState;
  readonly dockPresentationWidth: number;
  readonly dockPresentedOpen: boolean;
  readonly dockPullRequests: ReturnType<typeof useRepositoryPullRequests>;
  readonly dockResolution: RightUtilityDockResolution;
  readonly dockSidecarsByThread: ReadonlyMap<ThreadUtilityDockKey, ChatThreadId>;
  readonly dockTabs: ReturnType<typeof describeUtilityTabs>;
  readonly dockThread?: {
    readonly mode: OctantMode;
    readonly threadId: string;
    readonly checkoutId?: CodeCheckoutId;
  };
  readonly dockThreadHost?: string;
  /** Whether the dock's thread runs on this computer rather than a paired one. */
  readonly dockThreadOnThisComputer: boolean;
  readonly dockThreadKey?: ThreadUtilityDockKey;
  readonly dockThreadProjectId?: ProjectId;
  readonly dockThreadRepository?: string;
  /**
   * Present while the active pane is a new Code task with no thread yet: the
   * tools its title band shows disabled until the task starts.
   */
  readonly dockToolsAwaitingThread?: ReadonlyArray<RightUtilityDockSurfaceDescriptor>;
  readonly hostBridge?: OctantHostBridge;
  readonly isNarrow: boolean;
  readonly launchableDockSurfaces: ReadonlyArray<RightUtilityDockSurfaceDescriptor>;
  readonly navigation: ShellNavigationModel;
  readonly now: number;
  readonly overviewThread?: DockOverviewThread;
  readonly projectNames: ReadonlyMap<string, string>;
  readonly projectPullRequestReviewOpen: boolean;
  /** Like `codeThreadController`: only while a tool is on screen. */
  readonly providerController?: ProviderController;
  readonly requestedAgentReview?: {
    readonly threadKey: string;
    readonly request: AgentResultReviewRequest;
  };
  readonly requestedAgentView?: {
    readonly threadKey: string;
    readonly view: AgentRunViewRequest;
  };
  readonly selectedProjectPullRequest?: CodeProjectPullRequestDetailQuery;
  readonly selectedProjectPullRequestKey?: string;
  readonly serverUrl: string;
  readonly windowCapability: string;
  readonly writtenDocumentsByThread: ReadonlyMap<ThreadUtilityDockKey, WrittenDocumentOffers>;
}

const NO_DOCK_REFERENCES: ReadonlyArray<never> = [];

/**
 * The right utility dock and the bottom utility panel: the thread's tools,
 * its overview when no tool is chosen, and the pull-request review. Both read
 * selected facts about the dock's thread rather than the thread's controller,
 * so a streaming turn re-renders them only while a tool that shows the turn
 * is open.
 */
export const DockContainer = memo(function DockContainer(props: DockContainerProps) {
  const {
    actions,
    activeBottomSurface,
    activeCodeThreadUsageFallback,
    activeMode,
    activeProjectId,
    appleProjectPath,
    bottomPanelHeight,
    bottomPanelOpen,
    bottomPanelPresentation,
    bottomPanelPresentedOpen,
    bottomPanelSurfaces,
    bottomPanelTabs,
    canvasRevisionsByThread,
    chatReadCursorStore,
    codeNavigationRevision,
    codeProviderGroups,
    codeThreadController,
    codeDiffLayout,
    codeThreadView,
    contextSnapshot,
    displayedDockState,
    dockPresentationWidth,
    dockPresentedOpen,
    dockPullRequests,
    dockResolution,
    dockSidecarsByThread,
    dockTabs,
    dockThread,
    dockThreadHost,
    dockThreadKey,
    dockThreadOnThisComputer,
    dockThreadProjectId,
    dockThreadRepository,
    dockToolsAwaitingThread,
    isNarrow,
    launchableDockSurfaces,
    navigation,
    now,
    overviewThread,
    projectNames,
    projectPullRequestReviewOpen,
    providerController,
    requestedAgentReview,
    requestedAgentView,
    selectedProjectPullRequest,
    selectedProjectPullRequestKey,
    serverUrl,
    windowCapability,
    writtenDocumentsByThread,
  } = props;
  const {
    agentRunClient,
    agentRunSettingsClient,
    androidToolchainClient,
    appleToolchainClient,
    browserAutomationClient,
    canvasClient,
    chatClient,
    codeClient,
    nativeHarnessClient,
    planClient,
    shipClient,
  } = props.clients;

  // The pull requests the active Code thread is already about, offered where a
  // reader adds a tab. Read from the same catalogue the Environment panel uses,
  // so the two never disagree.
  // This computer's listener, administered only from the desktop app's own
  // window; the host refuses these actions for a paired client, which never
  // holds the bridge.
  const hostBridge = props.hostBridge;
  const remoteAccessAdministration = useMemo(
    () => remoteAccessAdministrationOf(hostBridge),
    [hostBridge],
  );

  const launchableDockReferences = useMemo(() => {
    const dockRepository = parseRepository(dockThreadRepository);
    if (
      dockPullRequests.status !== "ready" ||
      dockRepository === undefined ||
      dockThreadProjectId === undefined
    ) {
      return NO_DOCK_REFERENCES;
    }
    return dockPullRequests.rows.slice(0, 5).map((row) => ({
      id: String(row.url),
      label: `#${String(row.number)} ${row.title}`,
      detail: `${dockRepository.owner}/${dockRepository.name}`,
      onOpen: () =>
        actions.selectProjectPullRequestIdentity({
          projectId: dockThreadProjectId,
          repositoryOwner: dockRepository.owner,
          repositoryName: dockRepository.name,
          number: row.number,
        }),
    }));
  }, [actions, dockPullRequests, dockThreadProjectId, dockThreadRepository]);

  function threadUtility(surface: RightUtilityDockSurfaceId, utilityTab?: ThreadUtilityDockTab) {
    if (dockThread === undefined || dockThreadKey === undefined) return null;
    if (providerController === undefined) return null;
    // Each dock module owns its readiness: a terminal or file tool does not
    // wait on the transcript, and gating every utility on it made those panels
    // show "Loading thread" for work they never read.
    const sidecarThreadId = dockSidecarsByThread.get(dockThreadKey);
    const writtenDocument = writtenDocumentsByThread.get(dockThreadKey)?.current;
    const writtenDocumentPath = writtenDocument?.kind === "file" ? writtenDocument.path : undefined;
    const writtenCanvasId =
      writtenDocument?.kind === "canvas" ? writtenDocument.canvasId : undefined;
    const canvasRevision = canvasRevisionsByThread.get(dockThreadKey);
    return (
      <ThreadUtilityDockContent
        key={`${dockThreadKey}:${utilityTab?.id ?? surface}`}
        agentRunClient={agentRunClient}
        agentRunSettingsClient={agentRunSettingsClient}
        onReviewAgentChanges={(request) => {
          if (String(request.packet.parentThreadId) !== dockThread.threadId) return;
          actions.setSelectedProjectPullRequest(undefined);
          actions.openDockTab("review");
          actions.setRequestedAgentReview({ threadKey: dockThreadKey, request });
        }}
        {...(requestedAgentReview?.threadKey === dockThreadKey
          ? {
              requestedAgentReview: requestedAgentReview.request,
              onAgentReviewBack: () => {
                actions.openSubagent(String(requestedAgentReview.request.packet.runId));
                actions.setRequestedAgentReview(undefined);
              },
            }
          : {})}
        {...(requestedAgentView?.threadKey === dockThreadKey
          ? {
              requestedAgentView: requestedAgentView.view,
              onAgentViewRequestHandled: () => actions.setRequestedAgentView(undefined),
            }
          : {})}
        nativeHarnessClient={nativeHarnessClient}
        {...(appleProjectPath === undefined ? {} : { appleProjectPath })}
        appleToolchainClient={appleToolchainClient}
        androidToolchainClient={androidToolchainClient}
        {...(browserAutomationClient === undefined ? {} : { browserAutomationClient })}
        {...(utilityTab?.browserContextId === undefined
          ? {}
          : { browserContextId: utilityTab.browserContextId })}
        canvasClient={canvasClient}
        chatClient={chatClient}
        chatReadCursorStore={chatReadCursorStore}
        codeClient={codeClient}
        onSelectProjectPullRequest={actions.selectProjectPullRequest}
        onOpenWorkFile={(request) => {
          void actions.openPreview({
            mode: "work",
            title: request.displayName,
            targetId: request.targetId,
            projectId: request.projectId,
            hostId: request.hostId,
            targetKind: "file",
            opaqueRef: request.opaqueRef,
            displayName: request.displayName,
          });
        }}
        {...(dockThread.mode === "code" && codeThreadController !== undefined
          ? { codeController: codeThreadController }
          : {})}
        {...(dockThread.mode === "code" && codeThreadView !== undefined ? { codeThreadView } : {})}
        {...(codeDiffLayout === undefined ? {} : { codeDiffLayout })}
        codeProviderGroups={codeProviderGroups}
        {...(props.hostBridge === undefined ? {} : { hostBridge: props.hostBridge })}
        planClient={planClient}
        shipClient={shipClient}
        {...(writtenDocumentPath === undefined ? {} : { writtenDocumentPath })}
        {...(writtenCanvasId === undefined ? {} : { writtenCanvasId })}
        {...(canvasRevision === undefined ? {} : { canvasRevision })}
        onOpenFile={(relativePath) => {
          if (dockThread.mode !== "code") return;
          void actions.openCodeSurface({
            kind: "code-file",
            threadId: decodeCodeThreadId(dockThread.threadId),
            title: relativePath,
            relativePath,
          });
        }}
        onBrowserContextCreated={(contextId) => {
          if (utilityTab === undefined || utilityTab.surface !== "browser") return;
          if (dockThreadKey === undefined) {
            actions.setFallbackDockState((current) =>
              updateUtilityTabBrowserContext(current, utilityTab.id, contextId),
            );
          } else {
            actions.setDockStatesByThread((current) =>
              updateThreadUtilityTabBrowserContext(
                current,
                dockThreadKey,
                utilityTab.id,
                contextId,
              ),
            );
          }
        }}
        onSidecarOpened={(sidecar: SideChatSidecar) => {
          actions.setDockSidecarsByThread((current) => {
            if (current.get(dockThreadKey) === sidecar.sidecarThreadId) return current;
            const next = new Map(current);
            next.set(dockThreadKey, sidecar.sidecarThreadId);
            return next;
          });
        }}
        providerController={providerController}
        serverUrl={serverUrl}
        {...(selectedProjectPullRequestKey === undefined ? {} : { selectedProjectPullRequestKey })}
        {...(sidecarThreadId === undefined ? {} : { sidecarThreadId })}
        subject={{
          mode: dockThread.mode,
          threadId: dockThread.threadId,
          ...(dockThread.checkoutId === undefined ? {} : { checkoutId: dockThread.checkoutId }),
          ...(activeProjectId === undefined ? {} : { projectId: activeProjectId }),
        }}
        surface={surface}
        {...(utilityTab === undefined ? {} : { utilityTabId: utilityTab.id })}
        windowCapability={windowCapability}
      />
    );
  }

  // Optional client methods are bound here so the review keeps them as props
  // only where the host offers the switches.
  const projectPullRequestSwitchActions = {
    ...(codeClient.queryProjectPullRequestSwitches === undefined
      ? {}
      : { loadSwitches: codeClient.queryProjectPullRequestSwitches.bind(codeClient) }),
    ...(codeClient.setProjectPullRequestMergeWhenReady === undefined
      ? {}
      : { setMergeWhenReady: codeClient.setProjectPullRequestMergeWhenReady.bind(codeClient) }),
    ...(codeClient.setProjectPullRequestAutoFix === undefined
      ? {}
      : { setAutoFix: codeClient.setProjectPullRequestAutoFix.bind(codeClient) }),
  };

  function bottomToolContent(surface: RightUtilityDockSurfaceId) {
    if (surface === "review" && projectPullRequestReviewOpen && selectedProjectPullRequest) {
      return (
        <DockProjectPullRequestReviewTool
          key={`${String(selectedProjectPullRequest.projectId)}:${selectedProjectPullRequest.repositoryOwner}/${selectedProjectPullRequest.repositoryName}#${selectedProjectPullRequest.number}`}
          load={(query) => codeClient.queryProjectPullRequestDetail(query)}
          onMerge={actions.mergeProjectPullRequest}
          {...projectPullRequestSwitchActions}
          onOpenChat={actions.openProjectPullRequestChat}
          onOpenLinkedThread={(thread) =>
            actions.openLinkedProjectPullRequestThread(thread, selectedProjectPullRequest.projectId)
          }
          query={selectedProjectPullRequest}
          refresh={(command) => codeClient.refreshProjectPullRequestDetail(command)}
        />
      );
    }
    return threadUtility(surface);
  }

  // The overview shows only while no tool is chosen, so its facts are gathered
  // from rows the window already holds.
  const dockOverview = (() => {
    if (!dockPresentedOpen || dockResolution.kind !== "closed") return undefined;
    if (dockThread === undefined) return undefined;
    // Chat's Agents-only dock has no Work or Code thread overview.
    const mode = activeMode;
    if (mode === "chat") return undefined;
    const thread = overviewThread;
    const projectName =
      thread === undefined ? undefined : projectNames.get(String(thread.projectId));
    const occupancy = composerContextOccupancy({
      snapshot: contextSnapshot,
      fallback: mode === "code" ? activeCodeThreadUsageFallback : undefined,
    });
    const codeRow =
      mode === "code"
        ? navigation.codeProjectThreads.find((row) => row.threadId === dockThread.threadId)
        : undefined;
    return (
      <DockThreadOverviewContent
        boardRevision={codeNavigationRevision}
        {...(occupancy === undefined
          ? {}
          : { context: { label: occupancy.label, percent: occupancy.percent } })}
        {...(codeRow?.checkoutChip === undefined
          ? {}
          : { branchFallback: codeRow.checkoutChip.label })}
        {...(dockThreadHost === undefined ? {} : { host: dockThreadHost })}
        loadBoard={actions.loadCodeBoard}
        mode={mode}
        onOpenEnvironment={() => actions.addDockTab("environment")}
        onOpenReview={() => actions.addDockTab("review")}
        onOpenRunning={(running) => {
          if (running.mode === "chat") actions.selectChatThread(running.threadId);
          else if (running.mode === "work") actions.selectWorkThread(running.threadId);
          else actions.selectCodeThread(running.threadId);
        }}
        projectId={thread?.projectId}
        projectName={projectName}
        agentRunClient={agentRunClient}
        documents={
          dockThreadKey === undefined
            ? undefined
            : writtenDocumentsByThread.get(dockThreadKey)?.documents
        }
        now={now}
        onOpenDocument={actions.openWrittenDocument}
        onOpenRemoteAccessSettings={() => void actions.openSettings({ section: "remote-access" })}
        onOpenSubagent={actions.openSubagent}
        {...(dockThreadOnThisComputer && remoteAccessAdministration !== undefined
          ? { remoteAccess: remoteAccessAdministration }
          : {})}
        serverUrl={serverUrl}
        windowCapability={windowCapability}
        running={runningNowThreads({
          rows: {
            chat: navigation.markedChatNavigation,
            work: navigation.workProjectThreads,
            code: navigation.codeProjectThreads,
          },
          active: { mode, threadId: dockThread.threadId },
          projectNames,
          now,
        })}
        threadId={dockThread.threadId}
        // Only a worktree Octant made is a worktree to the person: the
        // Project's own folder also carries a chip (as an existing checkout).
        worktree={codeRow?.checkoutChip?.checkoutKind === "managed-worktree"}
      />
    );
  })();

  return (
    <>
      <RightUtilityDock
        {...(displayedDockState.active === undefined
          ? {}
          : { activeTabId: displayedDockState.active })}
        agents={
          bottomPanelOpen && activeBottomSurface?.id === "agents"
            ? undefined
            : threadUtility("agents")
        }
        browser={
          bottomPanelOpen && activeBottomSurface?.id === "browser"
            ? undefined
            : threadUtility("browser")
        }
        canvas={
          bottomPanelOpen && activeBottomSurface?.id === "canvas"
            ? undefined
            : threadUtility("canvas")
        }
        document={
          bottomPanelOpen && activeBottomSurface?.id === "document"
            ? undefined
            : threadUtility("document")
        }
        review={
          bottomPanelOpen &&
          activeBottomSurface?.id === "review" ? undefined : projectPullRequestReviewOpen &&
            selectedProjectPullRequest !== undefined ? (
            <DockProjectPullRequestReviewTool
              key={`${String(selectedProjectPullRequest.projectId)}:${selectedProjectPullRequest.repositoryOwner}/${selectedProjectPullRequest.repositoryName}#${selectedProjectPullRequest.number}`}
              load={(query) => codeClient.queryProjectPullRequestDetail(query)}
              onMerge={actions.mergeProjectPullRequest}
              {...projectPullRequestSwitchActions}
              onOpenChat={actions.openProjectPullRequestChat}
              onOpenLinkedThread={(thread) =>
                actions.openLinkedProjectPullRequestThread(
                  thread,
                  selectedProjectPullRequest.projectId,
                )
              }
              query={selectedProjectPullRequest}
              refresh={(command) => codeClient.refreshProjectPullRequestDetail(command)}
            />
          ) : (
            threadUtility("review")
          )
        }
        delivery={
          bottomPanelOpen && activeBottomSurface?.id === "delivery"
            ? undefined
            : threadUtility("delivery")
        }
        isNarrow={isNarrow}
        files={
          bottomPanelOpen && activeBottomSurface?.id === "files"
            ? undefined
            : threadUtility("files")
        }
        iosSimulator={
          bottomPanelOpen && activeBottomSurface?.id === "ios-simulator"
            ? undefined
            : threadUtility("ios-simulator")
        }
        androidEmulator={
          bottomPanelOpen && activeBottomSurface?.id === "android-emulator"
            ? undefined
            : threadUtility("android-emulator")
        }
        desktop={threadUtility("desktop")}
        debug={threadUtility("debug")}
        launchableSurfaces={launchableDockSurfaces}
        launchableReferences={launchableDockReferences}
        onClose={actions.closeDock}
        onCloseTab={actions.closeDockTab}
        onCommitWidth={(width) => {
          actions.setPreviewContextWidth(width);
          void actions.updateSettings({ contextSidebarWidth: width });
        }}
        onPreviewWidth={actions.setPreviewContextWidth}
        onOpenTab={actions.addDockTab}
        onSelectSurface={actions.selectDockTab}
        open={dockPresentedOpen}
        overview={dockOverview}
        plan={
          bottomPanelOpen && activeBottomSurface?.id === "plan" ? undefined : threadUtility("plan")
        }
        resolution={dockResolution}
        renderTab={(descriptor) => {
          const utilityTab = displayedDockState.tabs.find((tab) => tab.id === descriptor.id);
          if (utilityTab === undefined) return null;
          if (utilityTab.surface === "environment") {
            return threadUtility("environment", utilityTab);
          }
          if (
            utilityTab.surface === "review" &&
            projectPullRequestReviewOpen &&
            selectedProjectPullRequest !== undefined
          ) {
            return (
              <DockProjectPullRequestReviewTool
                key={`${String(selectedProjectPullRequest.projectId)}:${selectedProjectPullRequest.repositoryOwner}/${selectedProjectPullRequest.repositoryName}#${selectedProjectPullRequest.number}`}
                load={(query) => codeClient.queryProjectPullRequestDetail(query)}
                onMerge={actions.mergeProjectPullRequest}
                {...projectPullRequestSwitchActions}
                onOpenChat={actions.openProjectPullRequestChat}
                onOpenLinkedThread={(thread) =>
                  actions.openLinkedProjectPullRequestThread(
                    thread,
                    selectedProjectPullRequest.projectId,
                  )
                }
                query={selectedProjectPullRequest}
                refresh={(command) => codeClient.refreshProjectPullRequestDetail(command)}
              />
            );
          }
          return threadUtility(utilityTab.surface, utilityTab);
        }}
        sideChat={
          bottomPanelOpen && activeBottomSurface?.id === "side-chat"
            ? undefined
            : threadUtility("side-chat")
        }
        {...(dockToolsAwaitingThread === undefined
          ? {}
          : { toolsAwaitingThread: dockToolsAwaitingThread })}
        {...(bottomPanelOpen && activeBottomSurface?.id === "terminal"
          ? {}
          : { terminal: threadUtility("terminal") })}
        tests={
          bottomPanelOpen && activeBottomSurface?.id === "tests"
            ? undefined
            : threadUtility("tests")
        }
        tabs={dockTabs}
        width={dockPresentationWidth}
      />
      {bottomPanelPresentedOpen && activeBottomSurface !== undefined ? (
        <BottomUtilityPanel
          activeSurface={activeBottomSurface}
          content={bottomToolContent(activeBottomSurface.id)}
          height={bottomPanelHeight}
          launchableSurfaces={bottomPanelSurfaces}
          onClose={(surface) =>
            surface === undefined
              ? actions.closeBottomPanel()
              : actions.closeBottomPanelTab(surface)
          }
          onCommitHeight={(height) => {
            actions.setPreviewBottomPanelHeight(undefined);
            actions.persistBottomPanelPresentation({
              ...bottomPanelPresentation,
              height,
              open: true,
            });
          }}
          onOpenTool={actions.openBottomTool}
          onPreviewHeight={actions.setPreviewBottomPanelHeight}
          tabs={bottomPanelTabs}
        />
      ) : null}
    </>
  );
});
