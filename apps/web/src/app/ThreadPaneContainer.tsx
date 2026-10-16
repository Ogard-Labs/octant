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

export interface ThreadPaneContainerProps {
  readonly actions: Pick<
    ShellActions,
    | "closeWorkspaceReaders"
    | "createChat"
    | "handleCreateChatProjectThread"
    | "handleCreateWorkThread"
    | "handleDraftCreateCodeThread"
    | "handleDraftCreateThread"
    | "handleSelectCreateHost"
    | "noteCanvasReferences"
    | "noteHandedOffDocument"
    | "onComputerUseSessionChange"
    | "openCanvasInSidebar"
    | "openCreatedFollowUp"
    | "openDraftInProject"
    | "openInbox"
    | "openLinkInApp"
    | "openProjectCreate"
    | "openReviewForThread"
    | "openSubagent"
    | "refuseUnlessCreatableDestination"
    | "resetNewTaskDraft"
    | "selectProjectPullRequestIdentity"
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
    | "setThreadStatsVisible"
    | "setUsageOpen"
    | "setWorkComposerSelection"
    | "spendRevealChatTurn"
    | "viewAllChatProjectThreads"
  >;
  readonly activeCodeThreadUsageFallback: Parameters<
    typeof ComposerContextMeterProvider
  >[0]["fallback"];
  readonly activeMode: OctantMode;
  readonly agentProfiles: ReturnType<typeof useAgentProfiles>;
  /** The dock's thread while a pane shows its shared Browser tool, else absent. */
  readonly browserToolThreadId?: string;
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
  readonly contextController: ReturnType<typeof useContextController>;
  readonly contextSubject: Parameters<typeof useContextController>[0]["subject"];
  readonly continueCards: ReturnType<typeof useContinueCards>;
  readonly controller: ShellController;
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
  readonly navigation: ShellNavigationModel;
  readonly pendingDraftBranch?: string;
  readonly pendingDraftPrompt?: string;
  readonly pendingIssue?: RepositoryIssueRow;
  readonly presentedLayout: NonNullable<ShellController["presentedLayout"]>;
  readonly projectController: ReturnType<typeof useProjectController>;
  readonly providerController: ProviderController;
  readonly providerReady: boolean;
  readonly revealChatTurn?: { readonly threadId: ChatThreadId; readonly turnId: ChatTurnId };
  readonly serverUrl: string;
  readonly settings: NonNullable<ShellController["settings"]>;
  readonly threadStatsSummary: ReturnType<typeof useThreadTurnMetrics>;
  readonly welcomeBackdrop?: ReactNode;
  readonly windowCapability: string;
  readonly workCreateThreadAvailable: boolean;
  readonly workNavigation: ReturnType<typeof useWorkThreadNavigation>;
  readonly workPromotionController: ReturnType<typeof useWorkPromotionController>;
  readonly workProviderGroups: ReturnType<typeof buildModelPickerGroups>;
  readonly workspace: NonNullable<ShellController["workspace"]>;
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
    agentProfiles,
    browserToolThreadId,
    chatController,
    chatReadCursorStore,
    codeBoardProjects,
    codeController,
    codeDefaultExecutionPolicy,
    codeProviderChoices,
    codeProviderGroups,
    codeThreadControllers,
    composerCompaction,
    contextController,
    contextSubject,
    continueCards,
    controller,
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
    navigation,
    pendingDraftBranch,
    pendingDraftPrompt,
    pendingIssue,
    presentedLayout,
    projectController,
    providerController,
    providerReady,
    revealChatTurn,
    serverUrl,
    settings,
    threadStatsSummary,
    welcomeBackdrop,
    windowCapability,
    workCreateThreadAvailable,
    workNavigation,
    workPromotionController,
    workProviderGroups,
    workspace,
    workspaceDrag,
    zen,
  } = props;
  const {
    closeWorkspaceReaders,
    createChat,
    handleCreateChatProjectThread,
    handleCreateWorkThread,
    handleDraftCreateCodeThread,
    handleDraftCreateThread,
    handleSelectCreateHost,
    noteCanvasReferences,
    noteHandedOffDocument,
    onComputerUseSessionChange,
    openCanvasInSidebar,
    openCreatedFollowUp,
    openDraftInProject,
    openInbox,
    openLinkInApp,
    openProjectCreate,
    openReviewForThread,
    openSubagent,
    refuseUnlessCreatableDestination,
    resetNewTaskDraft,
    selectProjectPullRequestIdentity,
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
    setThreadStatsVisible,
    setUsageOpen,
    setWorkComposerSelection,
    spendRevealChatTurn,
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
  const { liveThreadTitles, providerByThreadId, runningThreadIds } = navigation;
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
            onOpenUsage={() => void controller.openSettings({ section: "usage" })}
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
              greetingName={settings.userProfile.displayName}
              draftResetRevisions={draftResetRevisions}
              draftProjectSelection={draftProjectSelection}
              onDraftSelectProject={(mode, projectId) => {
                // Choosing a folder in the composer is the authority
                // transition, not a renderer preference: the window is
                // refused every Code command about a Project its
                // persisted workspace does not name. Re-opening the draft
                // with the Project records it on the surface the server
                // reads.
                const binding = controller.openDraftThread(mode, projectId).then((accepted) => {
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
                const binding = controller
                  .openDraftThread("chat", undefined, { unfiled: true })
                  .then((accepted) => {
                    if (accepted) {
                      setDraftProjectSelection(({ chat: _drop, ...rest }) => rest);
                    }
                  });
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
                void controller.openDraftThread(request.mode, request.projectId);
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
              memoryRevision={projectController.memoryRevision}
              onMemoryChanged={projectController.touchMemoryRevision}
              availabilityByProject={projectController.availabilityByProject}
              {...(props.hostBridge === undefined ? {} : { hostBridge: props.hostBridge })}
              folderBrowseClient={folderBrowseClient}
              githubClient={githubClient}
              githubCloneClient={githubCloneClient}
              hostId={createHostId}
              hidden={hidden}
              onActivatePane={(paneId) => void controller.activatePane(paneId)}
              tabActivation={controller.tabActivation}
              onClearFocus={() => void controller.clearFocus()}
              contentTabs={controller.contentTabs}
              onActivateContentTab={(paneId, tabId) =>
                void controller.activateContentTab(paneId, tabId)
              }
              onCloseContentTab={(paneId, tabId) => void controller.closeContentTab(paneId, tabId)}
              onClosePane={controller.closePane}
              onCommitResize={controller.commitSplitResize}
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
                void controller.openChatThread(threadId, title, projectId);
              }}
              onViewAllChatProjectThreads={viewAllChatProjectThreads}
              onOpenSideChat={(sidecar) => void controller.openSideChat(sidecar)}
              {...(activeMode === "chat" && draftCreating ? { chatWelcomeCreating: true } : {})}
              {...(activeMode === "chat" && draftError !== undefined
                ? { chatWelcomeError: draftError }
                : {})}
              providerReady={providerReady}
              {...(discoveryController.message === undefined
                ? {}
                : { providerBootstrapMessage: discoveryController.message })}
              onOpenDraftThread={(mode) => void controller.openDraftThread(mode)}
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
                void controller.openCodeSurface({
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
              onFocus={(paneId) => void controller.focusPane(paneId)}
              onCreateWorkThread={(projectId, draft, images, modelOptionValues) =>
                handleCreateWorkThread(projectId, draft, images, undefined, modelOptionValues)
              }
              onOpenWorkThread={(threadId, projectId) => {
                const thread = workNavigation.navigation.find(
                  (candidate) => candidate.threadId === String(threadId),
                );
                void controller.openWorkThread(
                  threadId,
                  thread?.title ?? "Task",
                  undefined,
                  projectId,
                );
              }}
              onArchiveProject={(projectId) => void projectController.setArchived(projectId, true)}
              onOpenCodeThread={(threadId, title, projectId) =>
                void controller.openCodeThread(threadId, title, undefined, projectId)
              }
              onOpenReview={(threadId) => openReviewForThread(String(threadId))}
              onSelectPullRequest={selectProjectPullRequestIdentity}
              onOpenPullRequests={() => setCodePullRequestsOpen(true)}
              onOpenCodeSurface={(kind, threadId, title, terminalId) =>
                void controller.openCodeSurface(
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
              onPreviewResize={controller.previewSplitResize}
              onRelinkProject={projectController.relink}
              onRenameProject={projectController.rename}
              onProjectColorChange={projectController.setColor}
              onProviderPolicyChange={projectController.setProviderPolicy}
              onWorkStatusFileChange={(projectId, enabled) =>
                projectController.setWorkStatusFile(projectId, enabled ? "enabled" : "disabled")
              }
              onSplitPane={(paneId, orientation, placement) =>
                void controller.splitPane(paneId, orientation, placement)
              }
              projects={projectController.allProjects}
              providerController={providerController}
              workspace={workspace}
              {...(controller.workspaceVersion === undefined
                ? {}
                : { workspaceVersion: controller.workspaceVersion })}
              mode={workspace.activeMode}
              {...(controller.crossContextOffer === undefined
                ? {}
                : {
                    crossContextOffer: {
                      message: controller.crossContextOffer.message,
                      canOpenInNewWindow:
                        controller.crossContextOffer.newWindowProjectId !== undefined &&
                        controller.canOpenCrossContextInNewWindow,
                    },
                  })}
              onOpenSurface={(surface, paneId, browserContextId) =>
                controller.openSurface(surface, paneId, browserContextId)
              }
              onRevealBrowserActivity={(input) => controller.revealBrowserActivity(input)}
              onOpenThreadBrowser={(input) => controller.openThreadBrowser(input)}
              {...(browserToolThreadId === undefined ? {} : { browserToolThreadId })}
              {...(browserAutomationClient === undefined
                ? {}
                : { onOpenLink: (request) => void openLinkInApp(request) })}
              environmentDockOpen={dockOpen && dockSurface === "environment"}
              onDismissCrossContextOffer={controller.dismissCrossContextOffer}
              onOpenCrossContextInNewWindow={() => void controller.openCrossContextInNewWindow()}
              projectClient={projectController.client}
              projectServerUrl={serverUrl}
              projectWindowCapability={windowCapability}
              previewClient={previewClient}
              canvasClient={canvasClient}
              imageGenerationClient={imageGenerationClient}
              {...(imageGenerationProfiles === undefined ? {} : { imageGenerationProfiles })}
              onOpenCanvasInSidebar={openCanvasInSidebar}
              onOpenCanvasReference={(card) => {
                const projectId = card.scope.workspace.projectId;
                if (projectId === null) return;
                void controller.openCanvas({
                  mode: card.scope.mode,
                  title: card.title,
                  canvasId: card.canvasId,
                  projectId,
                });
              }}
              onCanvasReferencesObserved={noteCanvasReferences}
              onThreadHandedOff={(threadId: string, outcome: ThreadHandOffOutcome) => {
                if (outcome.kind === "handed-off") {
                  noteHandedOffDocument("chat", threadId, outcome.canvasId);
                }
              }}
              onOpenCanvas={(entry) =>
                void controller.openCanvas({
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
              showProviderIcons={settings.showThreadProviderIcons}
              environmentNames={environmentNames}
              {...(projectController.activeProject === undefined
                ? {}
                : { draftProjectName: projectController.activeProject.name })}
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
                  void controller.openCodeThread(
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
              onChangeCodeNewThreadWorkspace={projectController.setCodeNewThreadWorkspace}
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
                return projectController.create(
                  mode,
                  name,
                  receiptId,
                  destinationHostId,
                  initializeGit,
                );
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
                return projectController.ensureDefault(mode, destinationHostId);
              }}
              {...(draftCreating ? { onDraftCreating: true } : {})}
              {...(draftError === undefined ? {} : { onDraftError: draftError })}
              {...(draftPendingMessage === undefined
                ? {}
                : { onDraftPendingMessage: draftPendingMessage })}
              onAttachFolder={() => openProjectCreate()}
              onOpenCodeSettings={() =>
                void controller.openSettings({
                  section: "code",
                  setting: "code-require-git",
                })
              }
              onOpenProviderSettings={() => void controller.openSettings({ section: "providers" })}
              onOpenSettings={() => void controller.openSettings()}
            />
          </ComposerContextMeterProvider>
        </OutputLimitContinueProvider>
      </ThreadStatsProvider>
    </AgentProfileNamesProvider>
  );
});
