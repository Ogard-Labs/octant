import type { ChatThreadId, ChatTurnId } from "@octant/contracts/chat";
import type { HostId } from "@octant/contracts/host";
import type { OctantMode } from "@octant/contracts/modes";
import type { ProjectId } from "@octant/contracts/projects";
import type {
  PermissionPersistence,
  ProviderExecutionPolicy,
  ProviderInstanceId,
  ProviderModelId,
} from "@octant/contracts/providers";
import type { ThreadHandOffOutcome } from "@octant/contracts/thread-hand-off";
import { decodeCodeThreadId } from "@octant/contracts/code";
import { decodeWorkThreadId } from "@octant/contracts";
import type {
  buildModelPickerGroups,
  CreateHostViewScope,
  listEligibleImageProfiles,
} from "@octant/domain";
import { memo, type ReactNode, type RefObject } from "react";
import type { useAgentProfiles } from "../agentProfile/useAgentProfiles";
import { AgentProfileNamesProvider } from "../agentProfile/AgentProfileNames";
import type { ChatController, createChatReadCursorStore } from "../chat/useChatController";
import type { CodeThreadControllerRegistry } from "../code/codeThreadControllers";
import type { CodeThreadProviderChoice } from "../code/codeThreadCreate";
import type { CodeController } from "../code/useCodeController";
import type { useContinueCards } from "../code/useContinueCards";
import { ComposerContextMeterShortcut } from "../context/ComposerContextMeter";
import {
  ComposerContextMeterProvider,
  type ComposerCompaction,
} from "../context/composerContextMeterScope";
import type { useContextController } from "../context/useContextController";
import type { RepositoryIssueRow } from "../github/readIssuesAcrossRepositories";
import type { useMachineChangeFeed } from "../polling/useMachineChangeFeed";
import type { useProjectController } from "../projects/useProjectController";
import type { useDiscoveryController } from "../providers/useDiscoveryController";
import type { ProviderController } from "../providers/useProviderController";
import { FIRST_PARTY_PLUGINS_EFFECTIVE } from "../shell/contributionRegistry";
import type { DraftThreadWorkspaceProps } from "../shell/DraftThreadWorkspace";
import type { OctantHostBridge } from "../shell/hostBridge";
import type { RightUtilityDockSurfaceId } from "../shell/rightUtilityDockModel";
import type { useShellController } from "../shell/useShellController";
import type { useWorkspaceSurfaceDrag } from "../shell/useWorkspaceTabDrag";
import { WorkspaceView, type WorkspaceViewProps } from "../shell/WorkspaceView";
import { ThreadStatsDetailDialog } from "../threadStats/ThreadStatsDetail";
import { ThreadStatsProvider } from "../threadStats/threadStatsScope";
import type { useThreadTurnMetrics } from "../threadStats/useThreadTurnMetrics";
import { OutputLimitContinueProvider } from "../transcript/outputLimitNote";
import type { useWorkPromotionController } from "../work/useWorkPromotionController";
import type { useWorkThreadNavigation } from "../work/useWorkThreadNavigation";
import type { useZenController } from "../zen/useZenController";
import type { createLaunchedShellClients } from "./createLaunchedShellClients";
import type { ShellActions } from "./shellActions";
import type { ShellNavigationModel } from "./shellNavigationModel";

type ShellController = ReturnType<typeof useShellController>;
type ProjectController = ReturnType<typeof useProjectController>;

export interface ThreadPaneContainerProps {
  readonly actions: Pick<
    ShellActions,
    | "activateContentTab"
    | "activatePane"
    | "clearFocus"
    | "closeContentTab"
    | "closePane"
    | "closeWorkspaceReaders"
    | "createChat"
    | "commitSplitResize"
    | "createProject"
    | "dismissCrossContextOffer"
    | "ensureDefaultProject"
    | "focusPane"
    | "handleCreateChatProjectThread"
    | "handleCreateWorkThread"
    | "handleDraftCreateCodeThread"
    | "handleDraftCreateThread"
    | "handleSelectCreateHost"
    | "noteCanvasReferences"
    | "noteHandedOffDocument"
    | "onComputerUseSessionChange"
    | "openCanvasInSidebar"
    | "openCanvas"
    | "openChatThread"
    | "openCodeSurface"
    | "openCodeThread"
    | "openCreatedFollowUp"
    | "openCrossContextInNewWindow"
    | "openDraftThread"
    | "openDraftInProject"
    | "openInbox"
    | "openSettings"
    | "openSideChat"
    | "openSurface"
    | "openThreadBrowser"
    | "openWorkThread"
    | "previewSplitResize"
    | "relinkProject"
    | "renameProject"
    | "revealBrowserActivity"
    | "openLinkInApp"
    | "openProjectCreate"
    | "openReviewForThread"
    | "openSubagent"
    | "refuseUnlessCreatableDestination"
    | "resetNewTaskDraft"
    | "selectProjectPullRequestIdentity"
    | "setCodeNewThreadWorkspace"
    | "setCodePullRequestsOpen"
    | "setDraftError"
    | "setDraftExecutionPolicy"
    | "setDraftModelId"
    | "setDraftPendingMessage"
    | "setDraftPermissionPersistence"
    | "setDraftProjectSelection"
    | "setDraftProviderInstanceId"
    | "setGithubIssuesOpen"
    | "setPendingDraftBranch"
    | "setPendingDraftPrompt"
    | "setPendingIssue"
    | "setPendingUsageFilter"
    | "setProjectArchived"
    | "setProjectColor"
    | "setProjectProviderPolicy"
    | "setProjectBrandKit"
    | "setProjectWorkStatusFile"
    | "setThreadStatsVisible"
    | "setUsageOpen"
    | "setWorkComposerSelection"
    | "spendRevealChatTurn"
    | "splitPane"
    | "touchMemoryRevision"
    | "viewAllChatProjectThreads"
  >;
  readonly activeCodeThreadUsageFallback: Parameters<
    typeof ComposerContextMeterProvider
  >[0]["fallback"];
  readonly activeProject: ProjectController["activeProject"];
  readonly activeMode: OctantMode;
  readonly agentProfiles: ReturnType<typeof useAgentProfiles>;
  readonly allProjects: ProjectController["allProjects"];
  readonly availabilityByProject: ProjectController["availabilityByProject"];
  /** The dock's thread while a pane shows its shared Browser tool, else absent. */
  readonly browserToolThreadId?: string;
  readonly canOpenCrossContextInNewWindow: boolean;
  readonly chatController: ChatController;
  readonly chatReadCursorStore: ReturnType<typeof createChatReadCursorStore>;
  readonly clients: ReturnType<typeof createLaunchedShellClients>;
  readonly codeBoardProjects: ReadonlyArray<{ readonly id: ProjectId; readonly name: string }>;
  readonly codeController: CodeController;
  readonly codeDefaultExecutionPolicy: ProviderExecutionPolicy;
  readonly codeProviderChoices: ReadonlyArray<CodeThreadProviderChoice>;
  readonly codeProviderGroups: ReturnType<typeof buildModelPickerGroups>;
  readonly codeThreadControllers: CodeThreadControllerRegistry;
  readonly composerCompaction: ComposerCompaction;
  readonly contentTabs: ShellController["contentTabs"];
  readonly contextController: ReturnType<typeof useContextController>;
  readonly contextSubject: Parameters<typeof useContextController>[0]["subject"];
  readonly continueCards: ReturnType<typeof useContinueCards>;
  readonly crossContextOffer: ShellController["crossContextOffer"];
  readonly createHostId: HostId;
  readonly createHostViewScope: CreateHostViewScope;
  readonly discoveryController: ReturnType<typeof useDiscoveryController>;
  readonly dockOpen: boolean;
  readonly dockSurface?: RightUtilityDockSurfaceId;
  readonly draftCreating: boolean;
  readonly draftError?: string;
  readonly draftExecutionPolicy?: ProviderExecutionPolicy;
  readonly draftPendingMessage?: string;
  readonly draftPermissionPersistence?: PermissionPersistence;
  readonly draftProjectBinding: RefObject<Promise<void> | undefined>;
  readonly draftProjectSelection: Partial<Readonly<Record<OctantMode, ProjectId>>>;
  readonly draftProviderGroups: ReturnType<typeof buildModelPickerGroups>;
  readonly draftResetRevisions: Readonly<Record<string, number>>;
  readonly effectiveDraftModelId?: ProviderModelId;
  readonly effectiveDraftProviderInstanceId?: ProviderInstanceId;
  readonly environmentNames: ReadonlyMap<string, string>;
  readonly githubClient: NonNullable<WorkspaceViewProps["githubClient"]>;
  readonly hidden: boolean;
  readonly homeStart?: DraftThreadWorkspaceProps["homeStart"];
  readonly hostBridge?: OctantHostBridge;
  readonly hosts: NonNullable<WorkspaceViewProps["hosts"]>;
  readonly imageGenerationProfiles?: ReturnType<typeof listEligibleImageProfiles>;
  readonly isNarrow: boolean;
  readonly lastSelectedHealthyHostId?: HostId;
  readonly linearClient: NonNullable<WorkspaceViewProps["linearClient"]>;
  readonly loadAssignedLinearIssues: NonNullable<
    NonNullable<WorkspaceViewProps["codeHome"]>["loadAssignedLinearIssues"]
  >;
  readonly loadOpenLinearIssues: NonNullable<
    NonNullable<WorkspaceViewProps["codeHome"]>["loadOpenLinearIssues"]
  >;
  readonly machineChanges: ReturnType<typeof useMachineChangeFeed>;
  readonly memoryRevision: number;
  readonly navigation: ShellNavigationModel;
  readonly pendingDraftBranch?: string;
  readonly pendingDraftPrompt?: string;
  readonly pendingIssue?: RepositoryIssueRow;
  readonly presentedLayout: NonNullable<ShellController["presentedLayout"]>;
  readonly projectClient: ProjectController["client"];
  readonly providerController: ProviderController;
  readonly providerReady: boolean;
  readonly revealChatTurn?: { readonly threadId: ChatThreadId; readonly turnId: ChatTurnId };
  readonly serverUrl: string;
  readonly settings: NonNullable<ShellController["settings"]>;
  readonly tabActivation: ShellController["tabActivation"];
  readonly threadStatsSummary: ReturnType<typeof useThreadTurnMetrics>;
  readonly welcomeBackdrop?: ReactNode;
  readonly windowCapability: string;
  readonly workCreateThreadAvailable: boolean;
  readonly workNavigation: ReturnType<typeof useWorkThreadNavigation>;
  readonly workPromotionController: ReturnType<typeof useWorkPromotionController>;
  readonly workProviderGroups: ReturnType<typeof buildModelPickerGroups>;
  readonly workspace: NonNullable<ShellController["workspace"]>;
  readonly workspaceVersion: ShellController["workspaceVersion"];
  readonly workspaceDrag: ReturnType<typeof useWorkspaceSurfaceDrag>;
  readonly zen: ReturnType<typeof useZenController>;
}

/**
 * The thread pane: the split tree of panes with their threads, drafts, start
 * screens and Project overviews, under the providers that scope the context
 * meter, thread stats and agent profile names to the active thread.
 *
 * This is the surface a streaming turn is for, and it still takes the shell's
 * controllers whole (`WorkspaceView` reads them), which are new objects on
 * every shell render; so unlike the sidebar and the dock it re-renders with
 * the shell. Memoizing the controller hooks' return values would let the
 * `memo` here bail out too; that is a change to those hooks, not to this
 * container.
 */
export const ThreadPaneContainer = memo(function ThreadPaneContainer(
  props: ThreadPaneContainerProps,
) {
  const {
    actions,
    activeCodeThreadUsageFallback,
    activeMode,
    activeProject,
    agentProfiles,
    allProjects,
    availabilityByProject,
    browserToolThreadId,
    canOpenCrossContextInNewWindow,
    chatController,
    chatReadCursorStore,
    codeBoardProjects,
    codeController,
    codeDefaultExecutionPolicy,
    codeProviderChoices,
    codeProviderGroups,
    codeThreadControllers,
    composerCompaction,
    contentTabs,
    contextController,
    contextSubject,
    continueCards,
    crossContextOffer,
    createHostId,
    createHostViewScope,
    discoveryController,
    dockOpen,
    dockSurface,
    draftCreating,
    draftError,
    draftExecutionPolicy,
    draftPendingMessage,
    draftPermissionPersistence,
    draftProjectBinding,
    draftProjectSelection,
    draftProviderGroups,
    draftResetRevisions,
    effectiveDraftModelId,
    effectiveDraftProviderInstanceId,
    environmentNames,
    githubClient,
    hidden,
    homeStart,
    hosts,
    imageGenerationProfiles,
    isNarrow,
    lastSelectedHealthyHostId,
    linearClient,
    loadAssignedLinearIssues,
    loadOpenLinearIssues,
    machineChanges,
    memoryRevision,
    navigation,
    pendingDraftBranch,
    pendingDraftPrompt,
    pendingIssue,
    presentedLayout,
    projectClient,
    providerController,
    providerReady,
    revealChatTurn,
    serverUrl,
    settings,
    tabActivation,
    threadStatsSummary,
    welcomeBackdrop,
    windowCapability,
    workCreateThreadAvailable,
    workNavigation,
    workPromotionController,
    workProviderGroups,
    workspace,
    workspaceDrag,
    workspaceVersion,
    zen,
  } = props;
  const {
    activateContentTab,
    activatePane,
    clearFocus,
    closeContentTab,
    closePane,
    closeWorkspaceReaders,
    commitSplitResize,
    createChat,
    createProject,
    dismissCrossContextOffer,
    ensureDefaultProject,
    focusPane,
    handleCreateChatProjectThread,
    handleCreateWorkThread,
    handleDraftCreateCodeThread,
    handleDraftCreateThread,
    handleSelectCreateHost,
    noteCanvasReferences,
    noteHandedOffDocument,
    onComputerUseSessionChange,
    openCanvas,
    openCanvasInSidebar,
    openChatThread,
    openCodeSurface,
    openCodeThread,
    openCreatedFollowUp,
    openCrossContextInNewWindow,
    openDraftInProject,
    openDraftThread,
    openInbox,
    openLinkInApp,
    openProjectCreate,
    openReviewForThread,
    openSettings,
    openSideChat,
    openSubagent,
    openSurface,
    openThreadBrowser,
    openWorkThread,
    previewSplitResize,
    refuseUnlessCreatableDestination,
    relinkProject,
    renameProject,
    resetNewTaskDraft,
    revealBrowserActivity,
    selectProjectPullRequestIdentity,
    setCodeNewThreadWorkspace,
    setCodePullRequestsOpen,
    setDraftError,
    setDraftExecutionPolicy,
    setDraftModelId,
    setDraftPendingMessage,
    setDraftPermissionPersistence,
    setDraftProjectSelection,
    setDraftProviderInstanceId,
    setGithubIssuesOpen,
    setPendingDraftBranch,
    setPendingDraftPrompt,
    setPendingIssue,
    setPendingUsageFilter,
    setProjectArchived,
    setProjectColor,
    setProjectProviderPolicy,
    setProjectBrandKit,
    setProjectWorkStatusFile,
    setThreadStatsVisible,
    setUsageOpen,
    setWorkComposerSelection,
    spendRevealChatTurn,
    splitPane,
    touchMemoryRevision,
    viewAllChatProjectThreads,
  } = actions;
  const {
    agentRunClient,
    appleToolchainClient,
    browserAutomationClient,
    canvasClient,
    chatClient,
    computerUseClient,
    contextClient,
    extensionClient,
    folderBrowseClient,
    followUpSuggestionClient,
    githubCloneClient,
    goalClient,
    goalLoopClient,
    imageGenerationClient,
    nativeHarnessClient,
    planClient,
    previewClient,
    sideTaskClient,
    spendCeilingClient,
    usageDashboardClient,
    workMutationClient,
    workOverviewClient,
    workRequestClient,
    workResearchClient,
    workThreadClient,
    workTurnClient,
  } = props.clients;
  const { liveThreadTitles, needsPersonThreadIds, providerByThreadId, runningThreadIds } =
    navigation;
  return (
    <AgentProfileNamesProvider profiles={agentProfiles}>
      <ThreadStatsProvider
        lineVisible={settings.showThreadStats ?? true}
        onLineVisibleChange={setThreadStatsVisible}
        subjectKey={contextSubject?.aggregateId}
        summary={threadStatsSummary}
      >
        <OutputLimitContinueProvider
          mode={
            activeMode === "chat" || activeMode === "work" || activeMode === "code"
              ? activeMode
              : undefined
          }
          threadId={contextSubject?.aggregateId}
        >
          <ComposerContextMeterProvider
            busy={contextController.status === "updating"}
            compaction={composerCompaction}
            onOpenUsage={() => void openSettings({ section: "usage" })}
            onRebuild={() => void contextController.rebuild()}
            onSetExcluded={(entryId, excluded) =>
              void contextController.setExcluded(entryId, excluded)
            }
            onSetPinned={(entryId, pinned) => void contextController.setPinned(entryId, pinned)}
            status={contextController.status}
            {...(activeMode !== "code" || activeCodeThreadUsageFallback === undefined
              ? {}
              : { fallback: activeCodeThreadUsageFallback })}
            {...(contextController.snapshot === undefined
              ? {}
              : { snapshot: contextController.snapshot })}
            {...(contextSubject === undefined
              ? {}
              : {
                  subjectKey: `${contextSubject.aggregateType}:${contextSubject.aggregateId}`,
                })}
          >
            <ComposerContextMeterShortcut />
            <ThreadStatsDetailDialog />
            <WorkspaceView
              {...(contextClient === undefined ? {} : { contextClient })}
              {...(welcomeBackdrop === undefined ? {} : { welcomeBackdrop })}
              followUpSuggestions={{
                client: followUpSuggestionClient,
                sideTaskClient,
                onCreated: openCreatedFollowUp,
              }}
              draftResetRevisions={draftResetRevisions}
              draftProjectSelection={draftProjectSelection}
              onDraftSelectProject={(mode, projectId) => {
                // Choosing a folder in the composer is the authority
                // transition, not a renderer preference: the window is
                // refused every Code command about a Project its
                // persisted workspace does not name. Re-opening the draft
                // with the Project records it on the surface the server
                // reads.
                const binding = openDraftThread(mode, projectId).then((accepted) => {
                  if (accepted) {
                    if (mode === "code") {
                      setDraftPermissionPersistence(undefined);
                      // A branch handed in by Start a fix names a
                      // branch of the Project it came from.
                      setPendingDraftBranch(undefined);
                    }
                    setDraftProjectSelection((current) => ({
                      ...current,
                      [mode]: projectId,
                    }));
                  }
                });
                draftProjectBinding.current = binding;
                void binding.catch(() => undefined);
              }}
              onDraftSelectUnfiled={(mode) => {
                if (mode !== "chat") return;
                const binding = openDraftThread("chat", undefined, { unfiled: true }).then(
                  (accepted) => {
                    if (accepted) {
                      setDraftProjectSelection(({ chat: _drop, ...rest }) => rest);
                    }
                  },
                );
                draftProjectBinding.current = binding;
                void binding.catch(() => undefined);
              }}
              onNewThreadInProject={(projectId) => void openDraftInProject(projectId)}
              appleToolchainClient={appleToolchainClient}
              agentRunClient={agentRunClient}
              nativeHarnessClient={nativeHarnessClient}
              onOpenSubagent={openSubagent}
              onOpenAgents={openSubagent}
              chatClient={chatClient}
              chatController={chatController}
              chatReadCursorStore={chatReadCursorStore}
              {...(revealChatTurn === undefined ? {} : { revealChatTurn })}
              onChatTurnRevealed={spendRevealChatTurn}
              onPinTerminal={(request) => void zen.pinTerminal(request)}
              onPinCanvasInFocusZone={(request) => void zen.pinCanvas(request)}
              onStartPlanTask={(request) => {
                closeWorkspaceReaders();
                setDraftError(undefined);
                setDraftPendingMessage(undefined);
                resetNewTaskDraft(request.mode);
                setPendingDraftPrompt(request.prompt);
                void openDraftThread(request.mode, request.projectId);
              }}
              {...(pendingDraftPrompt === undefined
                ? {}
                : { draftPendingPrompt: pendingDraftPrompt })}
              onDraftPendingPromptConsumed={() => setPendingDraftPrompt(undefined)}
              onDockResearch={(request) =>
                void zen.dockResearch({
                  thread: {
                    threadId:
                      request.mode === "code"
                        ? decodeCodeThreadId(request.threadId)
                        : decodeWorkThreadId(request.threadId),
                    mode: request.mode,
                  },
                })
              }
              codeController={codeController}
              codeControllers={codeThreadControllers}
              extensionClient={extensionClient}
              workPromotionController={workPromotionController}
              codeProviderChoices={codeProviderChoices}
              openInApplications={settings.openInApplications}
              hosts={hosts}
              selectedCreateHostId={createHostId}
              createHostViewScope={createHostViewScope}
              {...(lastSelectedHealthyHostId === undefined ? {} : { lastSelectedHealthyHostId })}
              onSelectCreateHost={handleSelectCreateHost}
              {...(workspace.focusedPaneId === undefined
                ? {}
                : { focusedPaneId: workspace.focusedPaneId })}
              drag={workspaceDrag}
              layout={presentedLayout}
              memoryRevision={memoryRevision}
              onMemoryChanged={touchMemoryRevision}
              availabilityByProject={availabilityByProject}
              {...(props.hostBridge === undefined ? {} : { hostBridge: props.hostBridge })}
              folderBrowseClient={folderBrowseClient}
              githubClient={githubClient}
              githubCloneClient={githubCloneClient}
              hostId={createHostId}
              hidden={hidden}
              onActivatePane={(paneId) => void activatePane(paneId)}
              tabActivation={tabActivation}
              onClearFocus={() => void clearFocus()}
              contentTabs={contentTabs}
              onActivateContentTab={(paneId, tabId) => void activateContentTab(paneId, tabId)}
              onCloseContentTab={(paneId, tabId) => void closeContentTab(paneId, tabId)}
              onClosePane={closePane}
              onCommitResize={commitSplitResize}
              onCreateChat={createChat}
              onCreateChatProjectThread={handleCreateChatProjectThread}
              onOpenChatThread={(threadId, title, projectId) => {
                // A thread this window's sidebar controller has never seen
                // (a branch minted from a tab's own controller) must reach
                // navigation the same way a draft-created thread does:
                // through an authoritative bootstrap reload.
                if (!chatController.navigation.some((item) => item.threadId === String(threadId))) {
                  void chatController.refreshNavigation();
                }
                void openChatThread(threadId, title, projectId);
              }}
              onViewAllChatProjectThreads={viewAllChatProjectThreads}
              onOpenSideChat={(sidecar) => void openSideChat(sidecar)}
              {...(activeMode === "chat" && draftCreating ? { chatWelcomeCreating: true } : {})}
              {...(activeMode === "chat" && draftError !== undefined
                ? { chatWelcomeError: draftError }
                : {})}
              providerReady={providerReady}
              {...(discoveryController.message === undefined
                ? {}
                : { providerBootstrapMessage: discoveryController.message })}
              onOpenDraftThread={(mode) => void openDraftThread(mode)}
              workCreateThreadAvailable={workCreateThreadAvailable}
              workMutationClient={workMutationClient}
              workThreadClient={workThreadClient}
              workThreads={workNavigation.bootstrap?.threads ?? []}
              onWorkThreadUpdated={workNavigation.applyThread}
              workTurnClient={workTurnClient}
              workChangeRevision={machineChanges.workNavigation}
              workRequestClient={workRequestClient}
              workOverviewClient={workOverviewClient}
              workResearchClient={workResearchClient}
              goalClient={goalClient}
              goalLoopClient={goalLoopClient}
              planClient={planClient}
              onOpenCodeFile={({ threadId, relativePath }) => {
                void openCodeSurface({
                  kind: "code-file",
                  threadId,
                  title: relativePath,
                  relativePath,
                });
              }}
              usageDashboardClient={usageDashboardClient}
              spendCeilingClient={spendCeilingClient}
              onOpenUsageDashboard={(filter) => {
                setPendingUsageFilter(filter);
                setUsageOpen(true);
              }}
              browserAutomationClient={browserAutomationClient}
              computerUseClient={computerUseClient}
              onComputerUseSessionChange={onComputerUseSessionChange}
              isNarrow={isNarrow}
              onFocus={(paneId) => void focusPane(paneId)}
              onCreateWorkThread={(projectId, draft, images, modelOptionValues) =>
                handleCreateWorkThread(projectId, draft, images, undefined, modelOptionValues)
              }
              onOpenWorkThread={(threadId, projectId) => {
                const thread = workNavigation.navigation.find(
                  (candidate) => candidate.threadId === String(threadId),
                );
                void openWorkThread(threadId, thread?.title ?? "Task", undefined, projectId);
              }}
              onArchiveProject={(projectId) => void setProjectArchived(projectId, true)}
              onOpenCodeThread={(threadId, title, projectId) =>
                void openCodeThread(threadId, title, undefined, projectId)
              }
              onOpenReview={(threadId) => openReviewForThread(String(threadId))}
              onSelectPullRequest={selectProjectPullRequestIdentity}
              onOpenPullRequests={() => setCodePullRequestsOpen(true)}
              onOpenCodeSurface={(kind, threadId, title, terminalId) =>
                void openCodeSurface(
                  kind === "code-terminal"
                    ? {
                        kind,
                        threadId,
                        title,
                        ...(terminalId === undefined ? {} : { terminalId }),
                      }
                    : { kind, threadId, title },
                )
              }
              onPreviewResize={previewSplitResize}
              onRelinkProject={relinkProject}
              onRenameProject={renameProject}
              onProjectColorChange={setProjectColor}
              onProviderPolicyChange={setProjectProviderPolicy}
              onBrandKitChange={setProjectBrandKit}
              onWorkStatusFileChange={(projectId, enabled) =>
                setProjectWorkStatusFile(projectId, enabled ? "enabled" : "disabled")
              }
              onSplitPane={(paneId, orientation, placement) =>
                void splitPane(paneId, orientation, placement)
              }
              projects={allProjects}
              providerController={providerController}
              workspace={workspace}
              {...(workspaceVersion === undefined ? {} : { workspaceVersion: workspaceVersion })}
              mode={workspace.activeMode}
              {...(crossContextOffer === undefined
                ? {}
                : {
                    crossContextOffer: {
                      message: crossContextOffer.message,
                      canOpenInNewWindow:
                        crossContextOffer.newWindowProjectId !== undefined &&
                        canOpenCrossContextInNewWindow,
                    },
                  })}
              onOpenSurface={(surface, paneId, browserContextId) =>
                openSurface(surface, paneId, browserContextId)
              }
              onRevealBrowserActivity={(input) => revealBrowserActivity(input)}
              onOpenThreadBrowser={(input) => openThreadBrowser(input)}
              {...(browserToolThreadId === undefined ? {} : { browserToolThreadId })}
              {...(browserAutomationClient === undefined
                ? {}
                : { onOpenLink: (request) => void openLinkInApp(request) })}
              environmentDockOpen={dockOpen && dockSurface === "environment"}
              onDismissCrossContextOffer={dismissCrossContextOffer}
              onOpenCrossContextInNewWindow={() => void openCrossContextInNewWindow()}
              projectClient={projectClient}
              projectServerUrl={serverUrl}
              projectWindowCapability={windowCapability}
              previewClient={previewClient}
              canvasClient={canvasClient}
              imageGenerationClient={imageGenerationClient}
              {...(imageGenerationProfiles === undefined ? {} : { imageGenerationProfiles })}
              onOpenCanvasInSidebar={openCanvasInSidebar}
              onOpenCanvasReference={(card) =>
                void openCanvas({
                  mode: card.scope.mode,
                  title: card.title,
                  canvasId: card.canvasId,
                  // Null for a Canvas owned by a Chat thread outside a Project.
                  projectId: card.scope.workspace.projectId,
                })
              }
              onCanvasReferencesObserved={noteCanvasReferences}
              onThreadHandedOff={(threadId: string, outcome: ThreadHandOffOutcome) => {
                if (outcome.kind === "handed-off") {
                  noteHandedOffDocument("chat", threadId, outcome.canvasId);
                }
              }}
              onOpenCanvas={(entry) =>
                void openCanvas({
                  mode: entry.mode,
                  title: entry.title,
                  canvasId: entry.canvasId,
                  projectId: entry.projectId,
                })
              }
              draftProviderGroups={draftProviderGroups}
              codeProviderGroups={codeProviderGroups}
              workProviderGroups={workProviderGroups}
              liveThreadTitles={liveThreadTitles}
              providerByThreadId={providerByThreadId}
              runningThreadIds={runningThreadIds}
              waitingThreadIds={needsPersonThreadIds}
              showProviderIcons={settings.showThreadProviderIcons}
              environmentNames={environmentNames}
              {...(activeProject === undefined ? {} : { draftProjectName: activeProject.name })}
              {...(pendingDraftBranch === undefined ? {} : { draftBranchName: pendingDraftBranch })}
              {...(effectiveDraftProviderInstanceId === undefined
                ? {}
                : { draftSelectedProviderInstanceId: effectiveDraftProviderInstanceId })}
              {...(effectiveDraftModelId === undefined
                ? {}
                : { draftSelectedModelId: effectiveDraftModelId })}
              {...(activeMode === "code"
                ? {
                    draftDefaultExecutionPolicy: draftExecutionPolicy ?? codeDefaultExecutionPolicy,
                    draftDefaultPermissionPersistence:
                      draftPermissionPersistence ??
                      codeController.bootstrap?.settings.defaultPermissionPersistence ??
                      "current-session",
                  }
                : {})}
              onDraftSelectProvider={(selection) => {
                setDraftProviderInstanceId(selection.providerInstanceId);
                setDraftModelId(selection.modelId);
                if (activeMode === "work") {
                  setWorkComposerSelection({
                    providerInstanceId: selection.providerInstanceId,
                    modelId: selection.modelId,
                  });
                }
              }}
              onDraftExecutionPolicyChange={(policy, persistence) => {
                setDraftExecutionPolicy(policy);
                setDraftPermissionPersistence(persistence);
              }}
              onDraftCreateThread={handleDraftCreateThread}
              githubPluginEnabled={FIRST_PARTY_PLUGINS_EFFECTIVE.get("github-integration") === true}
              linearClient={linearClient}
              {...(homeStart === undefined ? {} : { homeStart })}
              codeHome={{
                continueCards,
                ...(pendingIssue === undefined ? {} : { pendingIssue }),
                onPendingIssueConsumed: () => setPendingIssue(undefined),
                loadAssignedLinearIssues,
                loadOpenLinearIssues,
                projectNames: new Map(
                  codeBoardProjects.map((project) => [String(project.id), project.name]),
                ),
                providerLabels: new Map(
                  codeProviderGroups.map((group) => [
                    String(group.instance.id),
                    group.instance.displayName,
                  ]),
                ),
                onOpenThread: (target) => {
                  const thread = codeController.bootstrap?.threads.find(
                    (candidate) => String(candidate.id) === String(target.threadId),
                  );
                  void openCodeThread(
                    target.threadId,
                    thread?.title ?? "Code thread",
                    undefined,
                    target.projectId,
                  );
                },
                onOpenInbox: openInbox,
                onOpenIssues: () => setGithubIssuesOpen(true),
              }}
              linearPluginEnabled={FIRST_PARTY_PLUGINS_EFFECTIVE.get("linear-integration") === true}
              onDraftCreateCodeThread={handleDraftCreateCodeThread}
              onChangeCodeNewThreadWorkspace={setCodeNewThreadWorkspace}
              draftCodeExecute={codeController.execute}
              onCreateProject={(mode, name, receiptId, initializeGit) => {
                const destinationHostId = refuseUnlessCreatableDestination({
                  action: "create-project",
                  requiredCapability: mode,
                  onRefuse: (reason) => setDraftError(reason),
                });
                if (destinationHostId === undefined) {
                  return Promise.resolve(undefined);
                }
                return createProject(mode, name, receiptId, destinationHostId, initializeGit);
              }}
              {...(settings.defaultFolder === undefined
                ? {}
                : { defaultFolder: settings.defaultFolder })}
              codeDefaultFolderThreads={
                codeController.bootstrap?.settings.requireGitRepository === false
              }
              onEnsureDefaultProject={(mode) => {
                const destinationHostId = refuseUnlessCreatableDestination({
                  action: "create-project",
                  requiredCapability: mode,
                  onRefuse: (reason) => setDraftError(reason),
                });
                if (destinationHostId === undefined) {
                  return Promise.resolve(undefined);
                }
                return ensureDefaultProject(mode, destinationHostId);
              }}
              {...(draftCreating ? { onDraftCreating: true } : {})}
              {...(draftError === undefined ? {} : { onDraftError: draftError })}
              {...(draftPendingMessage === undefined
                ? {}
                : { onDraftPendingMessage: draftPendingMessage })}
              onAttachFolder={() => openProjectCreate()}
              onOpenCodeSettings={() =>
                void openSettings({
                  section: "code",
                  setting: "code-require-git",
                })
              }
              onOpenProviderSettings={() => void openSettings({ section: "providers" })}
              onOpenImageSettings={() =>
                void openSettings({ section: "voice", setting: "custom-image-sources" })
              }
              onOpenSettings={() => void openSettings()}
            />
          </ComposerContextMeterProvider>
        </OutputLimitContinueProvider>
      </ThreadStatsProvider>
    </AgentProfileNamesProvider>
  );
});
