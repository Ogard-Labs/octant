import type { WindowHistory } from "../shell/windowHistory";
import type { ContextHealth } from "@octant/contracts/context";
import type { OctantMode } from "@octant/contracts/modes";
import type { ProjectId } from "@octant/contracts/projects";
import { decodeChatThreadId, type ChatThreadId } from "@octant/contracts/chat";
import { decodeCodeThreadId, type CodeThreadId } from "@octant/contracts/code";
import { decodeProjectId, decodeUtcTimestamp, decodeWorkThreadId } from "@octant/contracts";
import type { EnvironmentSelection } from "@octant/client-runtime/environment-selection";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import { memo, useMemo, useState, type ReactNode } from "react";
import type {
  ChatController,
  ChatThreadRestOutcome,
  createChatReadCursorStore,
} from "../chat/useChatController";
import { deliverComposerThreadDrop } from "../chat/composerThreadDrop";
import { projectViewEnvironmentOptionsFromHosts } from "../code/codeProjectViewModel";
import type { CodeReadCursorStore, CodeThreadRestOutcome } from "../code/useCodeController";
import { mergeThreadRowActions } from "../projects/mergeThreadRowActions";
import { MoveThreadToProjectDialog } from "../projects/MoveThreadToProjectDialog";
import { ProjectSidebarSection } from "../projects/ProjectSidebarSection";
import type { ThreadRowActions } from "../projects/ThreadRowMenu";
import type { useProjectController } from "../projects/useProjectController";
import {
  FIRST_PARTY_PLUGINS_EFFECTIVE,
  resolveSidebarDestinationContributions,
} from "../shell/contributionRegistry";
import type { OctantHostBridge } from "../shell/hostBridge";
import type { SidebarNavigationDescriptorId } from "../shell/navigationModel";
import { openExternalUrl } from "../shell/openExternalUrl";
import {
  loadPluginSidebarDestinationAction,
  type SidebarDestinationActionContext,
} from "../shell/pluginSidebarDestinationRegistry";
import type { projectThreadsAccessForMode } from "../shell/shellModeRouting";
import { ShellSidebar, type ShellSidebarProps } from "../shell/ShellSidebar";
import type { countSidebarTiles } from "../shell/sidebarTileCounts";
import { githubPullRequestUrl } from "../threadBoard/githubPullRequestUrl";
import { exportThreadBundle, type resolveThreadExportClient } from "../thread/threadExport";
import {
  handOffThread,
  threadHandOffMessage,
  type resolveThreadHandOffClient,
} from "../thread/threadHandOff";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import type { useWorkThreadNavigation } from "../work/useWorkThreadNavigation";
import type { ShellActions } from "./shellActions";
import type { ShellNavigationModel } from "./shellNavigationModel";

type ProjectController = ReturnType<typeof useProjectController>;

export interface SidebarContainerProps {
  readonly actions: Pick<
    ShellActions,
    | "archiveCodeThread"
    | "closeWorkspaceReaders"
    | "completeChatThread"
    | "completeCodeFollowUp"
    | "completeCodeThread"
    | "createChat"
    | "enterZen"
    | "handleSelectVisibleMode"
    | "markCodeFollowUp"
    | "markChatThreadRead"
    | "markCodeThreadRead"
    | "moveCodeThread"
    | "moveProject"
    | "noteHandedOffDocument"
    | "openAgentsCenter"
    | "openArchive"
    | "openArtifactLibrary"
    | "openAutomationCenter"
    | "openDraftInActiveProject"
    | "openDraftInProject"
    | "openGithubIssues"
    | "openImageLibrary"
    | "openHome"
    | "openInbox"
    | "openLinearIssues"
    | "openNavigator"
    | "openProjectContextHealth"
    | "openProjectCreate"
    | "openProjects"
    | "openPullRequests"
    | "openReview"
    | "openSelectedProject"
    | "openSettings"
    | "openSidebarList"
    | "openSkillsSettings"
    | "openThreadBoard"
    | "openThreadSearch"
    | "pinChatThreadInPane"
    | "pinCodeThread"
    | "pinCodeThreadInPane"
    | "pinWorkThreadInPane"
    | "renameCodeThread"
    | "reopenChatThread"
    | "reopenCodeThread"
    | "retryActiveModeThreads"
    | "retryChat"
    | "retryProjects"
    | "runWorkRestCommand"
    | "searchEveryThread"
    | "selectChatThread"
    | "selectCodeThread"
    | "selectMode"
    | "selectProjectPullRequestIdentity"
    | "selectWorkThread"
    | "setProjectArchived"
    | "setProjectColor"
    | "setThreadExportNotice"
    | "snoozeChatThread"
    | "snoozeCodeThread"
    | "tryWorkRestCommand"
    | "updateSettings"
    | "wakeChatThread"
    | "wakeCodeThread"
  >;
  readonly activeChatThreadId?: ChatThreadId;
  readonly activeCodeThreadId?: CodeThreadId;
  readonly activeMode: OctantMode;
  readonly activeProjectId?: ProjectId;
  readonly activeSidebarDestination?: SidebarNavigationDescriptorId;
  /** Whether the active pane shows its mode's start screen with no reader over it. */
  readonly homeActive: boolean;
  readonly activeWorkThreadId?: string;
  readonly allProjects: ProjectController["allProjects"];
  readonly archivedProjects: ProjectController["archivedProjects"];
  readonly availabilityByProject: ProjectController["availabilityByProject"];
  readonly chatErrorMessage?: string;
  readonly chatProjectThreadListRequest?: {
    readonly projectId: ProjectId;
    readonly sequence: number;
  };
  readonly chatReadCursorStore: ReturnType<typeof createChatReadCursorStore>;
  readonly chatStatus: ChatController["status"];
  readonly codeReadCursorStore: CodeReadCursorStore;
  readonly codeStatus: string;
  readonly contextHealthByProject: ReadonlyMap<ProjectId, ContextHealth>;
  readonly environmentSelection: EnvironmentSelection;
  readonly federatedHostStates: NonNullable<ShellSidebarProps["environments"]>["hostStates"];
  readonly githubIssuesReadAvailable: boolean;
  readonly hostBridge?: OctantHostBridge;
  readonly hostReservesTitlebarInset: boolean;
  readonly hosts: Parameters<typeof projectViewEnvironmentOptionsFromHosts>[0];
  readonly imageLibraryAvailable: boolean;
  readonly inboxCount: number;
  readonly linearIssuesRead: boolean;
  readonly navigation: ShellNavigationModel;
  readonly navigatorAvailable: boolean;
  readonly openSidebarThreadIds?: ReadonlyArray<string>;
  readonly projectErrorMessage?: string;
  readonly projectStatus: ProjectController["status"];
  readonly projects: ProjectController["projects"];
  readonly resolvedSidebarBackground: ShellSidebarProps["resolvedSidebarBackground"];
  readonly setEnvironmentSelection: (selection: EnvironmentSelection) => void;
  readonly setSidebarCollapsed: (collapsed: boolean) => void;
  readonly windowHistory: WindowHistory;
  readonly setSidebarFilterQuery: (query: string) => void;
  readonly settings: ShellSidebarProps["settings"];
  readonly shellBackdropCoversSidebar: boolean;
  readonly sidebarBackgroundFetcher: ShellSidebarProps["backgroundFetcher"];
  readonly sidebarFilterQuery: string;
  readonly sidebarListRequest?: {
    readonly view: "activity" | "completed";
    readonly sequence: number;
  };
  readonly sidebarRail: boolean;
  readonly sidebarRailBeside: boolean;
  /** Plan usage rings for the icon rail. */
  readonly railUsage?: ReactNode;
  readonly sidebarTileCounts: ReturnType<typeof countSidebarTiles>;
  readonly threadErrorMessage?: string;
  readonly threadExportClient: ReturnType<typeof resolveThreadExportClient>;
  readonly threadHandOffClient: ReturnType<typeof resolveThreadHandOffClient>;
  readonly threadStatus: ReturnType<typeof projectThreadsAccessForMode>["status"];
  readonly workStatus: ReturnType<typeof useWorkThreadNavigation>["status"];
  readonly workspace: ShellSidebarProps["workspace"];
}

/**
 * The left sidebar: mode buttons, count tiles, destinations, the Project tree
 * with its thread rows, and the profile row. It reads the shell's navigation
 * model and primitives, never a controller, so a streaming turn that moves
 * only a transcript leaves it alone; a row's menu acts through the shell's
 * actions, which keep their identity across renders.
 */
export const SidebarContainer = memo(function SidebarContainer(props: SidebarContainerProps) {
  const {
    actions,
    activeChatThreadId,
    activeCodeThreadId,
    activeMode,
    activeProjectId,
    activeSidebarDestination,
    activeWorkThreadId,
    allProjects,
    archivedProjects,
    availabilityByProject,
    chatErrorMessage,
    chatProjectThreadListRequest,
    chatReadCursorStore,
    chatStatus,
    codeReadCursorStore,
    codeStatus,
    contextHealthByProject,
    environmentSelection,
    federatedHostStates,
    githubIssuesReadAvailable,
    hostBridge,
    hostReservesTitlebarInset,
    hosts,
    imageLibraryAvailable,
    inboxCount,
    linearIssuesRead,
    navigation,
    navigatorAvailable,
    openSidebarThreadIds,
    projectErrorMessage,
    projectStatus,
    projects,
    resolvedSidebarBackground,
    setEnvironmentSelection,
    setSidebarCollapsed,
    setSidebarFilterQuery,
    settings,
    shellBackdropCoversSidebar,
    sidebarBackgroundFetcher,
    sidebarFilterQuery,
    sidebarListRequest,
    sidebarRail,
    sidebarRailBeside,
    homeActive,
    railUsage,
    sidebarTileCounts,
    threadErrorMessage,
    threadExportClient,
    threadHandOffClient,
    threadStatus,
    workStatus,
    workspace,
  } = props;
  const {
    createChat,
    enterZen,
    handleSelectVisibleMode,
    openAgentsCenter,
    openArchive,
    openArtifactLibrary,
    openAutomationCenter,
    openDraftInActiveProject,
    openDraftInProject,
    openImageLibrary,
    openHome,
    openInbox,
    openNavigator,
    openProjectContextHealth,
    openProjectCreate,
    openProjects,
    openReview,
    openSelectedProject,
    openSettings,
    openSidebarList,
    openSkillsSettings,
    openThreadSearch,
    renameCodeThread,
    retryActiveModeThreads,
    retryChat,
    retryProjects,
    searchEveryThread,
    selectCodeThread,
    selectMode,
    selectWorkThread,
    updateSettings,
  } = actions;
  const { codeProjectThreads, markedThreadGroups, withProviderMark, workProjectThreads } =
    navigation;

  // The thread whose Move to Project choice is open. Work and Code rows ask for
  // it from their right-click menu; the dialog lives here, beside the Project
  // list it reads, so the move never reaches through another surface.
  const [moveRequest, setMoveRequest] = useState<
    | {
        readonly mode: "work" | "code";
        readonly threadId: string;
        readonly title: string;
        readonly projectId: string;
      }
    | undefined
  >(undefined);

  // The plugin-contributed destinations act through the same overlay and board
  // openers the first-party rows use; resolved here, where the rows are drawn.
  const pluginSidebarDestinationActions = useMemo(() => {
    const context: SidebarDestinationActionContext = {
      closeOverlays: actions.closeWorkspaceReaders,
      openThreadBoard: actions.openThreadBoard,
      openPullRequests: actions.openPullRequests,
      openGithubIssues: actions.openGithubIssues,
      openLinearIssues: actions.openLinearIssues,
    };
    const resolved: Record<string, () => void> = {};
    for (const contribution of resolveSidebarDestinationContributions(
      activeMode,
      FIRST_PARTY_PLUGINS_EFFECTIVE,
    )) {
      if (contribution.entryPoint === undefined) continue;
      if (contribution.destinationId === "linear-issues" && !linearIssuesRead) continue;
      const result = loadPluginSidebarDestinationAction(contribution.entryPoint);
      if (result.kind !== "ready") continue;
      resolved[contribution.destinationId] = () => result.action(context);
    }
    return resolved;
  }, [actions, activeMode, linearIssuesRead]);

  // What a thread row offers on right-click, per mode. Export and Hand off
  // appear only where this window resolved a client for them, the same test
  // the chat thread-actions menu applies. A rest command runs from a row,
  // which has nowhere of its own to report a refusal, so the host's answer
  // reads where thread notices already appear.
  const rowActions = useMemo(() => {
    const exportThreadFromRow = (
      mode: OctantMode,
    ): ((threadId: string, title: string) => void) | undefined => {
      const client = threadExportClient;
      if (client === undefined) return undefined;
      return (threadId, title) => {
        actions.setThreadExportNotice(`Exporting ${title}…`);
        void exportThreadBundle(client, { mode, threadId, title }).then(
          actions.setThreadExportNotice,
        );
      };
    };
    const handOffThreadFromRow = (
      mode: OctantMode,
    ): ((threadId: string, title: string) => void) | undefined => {
      const client = threadHandOffClient;
      if (client === undefined) return undefined;
      return (threadId, title) => {
        actions.setThreadExportNotice(`Writing the hand-off document for ${title}…`);
        void handOffThread(client, { mode, threadId }).then((outcome) => {
          actions.setThreadExportNotice(threadHandOffMessage(outcome));
          if (outcome.kind === "handed-off") {
            actions.noteHandedOffDocument(mode, threadId, outcome.canvasId);
          }
        });
      };
    };
    const noteCodeThreadRest = (outcome: CodeThreadRestOutcome): void => {
      if (outcome.status === "refused") actions.setThreadExportNotice(outcome.message);
    };
    const noteChatThreadRest = (outcome: ChatThreadRestOutcome): void => {
      if (outcome.status === "refused") actions.setThreadExportNotice(outcome.message);
    };
    const exportCodeThread = exportThreadFromRow("code");
    const exportChatThread = exportThreadFromRow("chat");
    const exportWorkThread = exportThreadFromRow("work");
    const handOffCodeThread = handOffThreadFromRow("code");
    const handOffChatThread = handOffThreadFromRow("chat");
    const handOffWorkThread = handOffThreadFromRow("work");
    const code: ThreadRowActions = {
      ...(exportCodeThread === undefined ? {} : { onExportThread: exportCodeThread }),
      ...(handOffCodeThread === undefined ? {} : { onHandOffThread: handOffCodeThread }),
      onArchiveThread: (threadId) => void actions.archiveCodeThread(decodeCodeThreadId(threadId)),
      onCompleteThread: (threadId) =>
        void actions.completeCodeThread(decodeCodeThreadId(threadId)).then(noteCodeThreadRest),
      onReopenThread: (threadId) =>
        void actions.reopenCodeThread(decodeCodeThreadId(threadId)).then(noteCodeThreadRest),
      onSnoozeThread: (threadId, until) =>
        void actions.snoozeCodeThread(decodeCodeThreadId(threadId), until).then(noteCodeThreadRest),
      onWakeThread: (threadId) =>
        void actions.wakeCodeThread(decodeCodeThreadId(threadId)).then(noteCodeThreadRest),
      onCompleteFollowUp: (threadId) =>
        void actions.completeCodeFollowUp(decodeCodeThreadId(threadId)),
      onMarkFollowUp: (threadId) => void actions.markCodeFollowUp(decodeCodeThreadId(threadId)),
      onMarkThreadRead: (threadId) => actions.markCodeThreadRead(decodeCodeThreadId(threadId)),
      onMarkThreadUnread: (threadId) => codeReadCursorStore.unmark(decodeCodeThreadId(threadId)),
      onPinInPane: actions.pinCodeThreadInPane,
      onAttachAsContext: (threadId) => {
        void deliverComposerThreadDrop({ threadId });
      },
      onPinThread: (threadId, pinned) =>
        void actions.pinCodeThread(decodeCodeThreadId(threadId), pinned),
      onOpenPullRequest: actions.selectProjectPullRequestIdentity,
      onOpenPullRequestOnGithub: (identity) => {
        const url = githubPullRequestUrl(identity);
        if (url !== undefined) openExternalUrl(hostBridge, url);
      },
      onMoveToProject: (threadId, title, projectId) => {
        if (projectId !== undefined) setMoveRequest({ mode: "code", threadId, title, projectId });
      },
    };
    // List pin is a Code-only mark; pane placement is the window's split
    // tree, so Chat and Work get that without a list pin they cannot honor.
    const chat: ThreadRowActions = {
      ...(exportChatThread === undefined ? {} : { onExportThread: exportChatThread }),
      ...(handOffChatThread === undefined ? {} : { onHandOffThread: handOffChatThread }),
      onCompleteThread: (threadId) =>
        void actions.completeChatThread(decodeChatThreadId(threadId)).then(noteChatThreadRest),
      onReopenThread: (threadId) =>
        void actions.reopenChatThread(decodeChatThreadId(threadId)).then(noteChatThreadRest),
      onSnoozeThread: (threadId, until) =>
        void actions.snoozeChatThread(decodeChatThreadId(threadId), until).then(noteChatThreadRest),
      onWakeThread: (threadId) =>
        void actions.wakeChatThread(decodeChatThreadId(threadId)).then(noteChatThreadRest),
      onMarkThreadRead: (threadId) => actions.markChatThreadRead(decodeChatThreadId(threadId)),
      onMarkThreadUnread: (threadId) => chatReadCursorStore.unmark(decodeChatThreadId(threadId)),
      onPinInPane: actions.pinChatThreadInPane,
      onAttachAsContext: (threadId) => {
        void deliverComposerThreadDrop({ threadId });
      },
    };
    // Work has no controller of its own for thread metadata: a rest command
    // goes straight to the client with the version the sidebar last saw.
    const work: ThreadRowActions = {
      ...(exportWorkThread === undefined ? {} : { onExportThread: exportWorkThread }),
      ...(handOffWorkThread === undefined ? {} : { onHandOffThread: handOffWorkThread }),
      onCompleteThread: (threadId) =>
        void actions.runWorkRestCommand(threadId, (expectedVersion) => ({
          kind: "complete-work-thread",
          threadId: decodeWorkThreadId(threadId),
          expectedVersion,
        })),
      onReopenThread: (threadId) =>
        void actions.runWorkRestCommand(threadId, (expectedVersion) => ({
          kind: "reopen-work-thread",
          threadId: decodeWorkThreadId(threadId),
          expectedVersion,
        })),
      onSnoozeThread: (threadId, until) =>
        void actions.runWorkRestCommand(threadId, (expectedVersion) => ({
          kind: "snooze-work-thread",
          threadId: decodeWorkThreadId(threadId),
          expectedVersion,
          until: decodeUtcTimestamp(until),
        })),
      onWakeThread: (threadId) =>
        void actions.runWorkRestCommand(threadId, (expectedVersion) => ({
          kind: "wake-work-thread",
          threadId: decodeWorkThreadId(threadId),
          expectedVersion,
        })),
      onPinInPane: actions.pinWorkThreadInPane,
      onAttachAsContext: (threadId) => {
        void deliverComposerThreadDrop({ threadId });
      },
      onMoveToProject: (threadId, title, projectId) => {
        if (projectId !== undefined) setMoveRequest({ mode: "work", threadId, title, projectId });
      },
    };
    return { chat, code, work };
  }, [
    actions,
    chatReadCursorStore,
    codeReadCursorStore,
    hostBridge,
    threadExportClient,
    threadHandOffClient,
  ]);

  // Work lists Chat and Work threads and Projects together. Each row keeps its
  // own kind: selecting it opens it in its own mode, and its menu reaches its
  // own kind's commands.
  const workSide = activeMode === "chat" || activeMode === "work";
  const workSideProjects = useMemo(
    () =>
      allProjects.filter(
        (project) =>
          (project.type === "chat" || project.type === "work") && project.lifecycle === "active",
      ),
    [allProjects],
  );
  const workSideArchivedProjects = useMemo(
    () =>
      allProjects.filter(
        (project) =>
          (project.type === "chat" || project.type === "work") && project.lifecycle !== "active",
      ),
    [allProjects],
  );
  const workSideChatThreads = chatStatus === "ready" ? navigation.markedChatNavigation : undefined;
  const workSideRows = useMemo(() => {
    const chatThreads = workSideChatThreads ?? [];
    const chatThreadIds = new Set(chatThreads.map((thread) => thread.threadId));
    return {
      threads: [...chatThreads, ...navigation.workProjectThreads.map(navigation.withProviderMark)],
      select: (threadId: string) =>
        chatThreadIds.has(threadId)
          ? actions.selectChatThread(threadId)
          : actions.selectWorkThread(threadId),
      actions: mergeThreadRowActions(
        (threadId) => chatThreadIds.has(threadId),
        rowActions.chat,
        rowActions.work,
      ),
    };
  }, [actions, navigation, rowActions, workSideChatThreads]);
  const workSideThreads = workSideRows.threads;
  const selectWorkSideThread = workSideRows.select;
  const workSideRowActions = workSideRows.actions;
  const codeThreadRowActions = rowActions.code;
  const workThreadRowActions = rowActions.work;

  const moveThread = (request: NonNullable<typeof moveRequest>) => async (projectId: string) =>
    request.mode === "code"
      ? actions.moveCodeThread(decodeCodeThreadId(request.threadId), decodeProjectId(projectId))
      : actions.tryWorkRestCommand(request.threadId, (expectedVersion) => ({
          kind: "move-work-thread",
          threadId: decodeWorkThreadId(request.threadId),
          expectedVersion,
          projectId: decodeProjectId(projectId),
        }));

  return (
    <>
      <ShellSidebar
        {...(activeSidebarDestination === undefined
          ? {}
          : { activeDestination: activeSidebarDestination })}
        imageLibraryAvailable={imageLibraryAvailable}
        {...(federatedHostStates.length < 2
          ? {}
          : {
              environments: {
                hostStates: federatedHostStates,
                selection: environmentSelection,
                localHostId: String(LOCAL_HOST_ID),
                onSelectionChange: setEnvironmentSelection,
              },
            })}
        {...(activeMode === "chat"
          ? {
              ...(chatErrorMessage === undefined ? {} : { chatErrorMessage: chatErrorMessage }),
              ...(chatStatus === "ready" ? {} : { chatStatus: chatStatus }),
            }
          : {})}
        {...(activeMode === "chat"
          ? {
              chatNavigation: {
                actions: {
                  "new-chat": createChat,
                  inbox: openInbox,
                  agents: openAgentsCenter,
                  "artifact-library": openArtifactLibrary,
                  "image-library": openImageLibrary,
                  projects: openProjects,
                  plugins: openSkillsSettings,
                },
              },
            }
          : {})}
        {...(activeMode === "code"
          ? {
              codeNavigation: {
                actions: {
                  "new-code-thread": () => openDraftInActiveProject("code"),
                  inbox: openInbox,
                  agents: openAgentsCenter,
                  automations: openAutomationCenter,
                  "artifact-library": openArtifactLibrary,
                  "image-library": openImageLibrary,
                  projects: openProjects,
                  plugins: openSkillsSettings,
                  ...pluginSidebarDestinationActions,
                },
              },
            }
          : {})}
        {...(activeMode === "work"
          ? {
              workNavigation: {
                actions: {
                  "new-work-thread": () => openDraftInActiveProject("work"),
                  inbox: openInbox,
                  agents: openAgentsCenter,
                  automations: openAutomationCenter,
                  "artifact-library": openArtifactLibrary,
                  "image-library": openImageLibrary,
                  projects: openProjects,
                  plugins: openSkillsSettings,
                  ...pluginSidebarDestinationActions,
                },
              },
            }
          : {})}
        home={{ onOpen: openHome, active: homeActive }}
        onAddFolder={() => openProjectCreate()}
        onOpenArchive={openArchive}
        nativeHost={hostReservesTitlebarInset}
        navigatorAvailable={navigatorAvailable}
        onOpenSearch={openThreadSearch}
        onCollapseSidebar={() => setSidebarCollapsed(true)}
        history={props.windowHistory}
        onOpenNavigator={openNavigator}
        onOpenSettings={(deepLink) => void openSettings(deepLink)}
        onOpenZen={() => void enterZen()}
        onRetryChat={() => void retryChat()}
        onSelectMode={handleSelectVisibleMode}
        {...(githubIssuesReadAvailable ? { githubIssuesReadAvailable: true } : {})}
        inboxCount={inboxCount}
        countTiles={{
          ...sidebarTileCounts,
          // Chat has no board, so its Running tile opens the Activity feed,
          // where running threads lead.
          ...(activeMode === "chat" ? { onOpenRunning: () => openSidebarList("activity") } : {}),
          onOpenReview: openReview,
          onOpenDone: () => openSidebarList("completed"),
        }}
        {...(sidebarRailBeside
          ? { railBeside: { onOpenActivity: () => openSidebarList("activity") } }
          : {})}
        {...(railUsage === undefined ? {} : { railUsage })}
        {...(sidebarRail
          ? {
              rail: {
                onOpenActivity: () => openSidebarList("activity"),
                projects: (workSide ? workSideProjects : projects).map((project) => ({
                  id: String(project.id),
                  name: project.name,
                  active:
                    activeProjectId !== undefined && String(activeProjectId) === String(project.id),
                  onOpen: () => void openSelectedProject(project),
                })),
              },
            }
          : {})}
        threadFilter={{
          query: sidebarFilterQuery,
          onQueryChange: setSidebarFilterQuery,
          onSearchEverywhere: searchEveryThread,
        }}
        settings={settings}
        workspace={workspace}
        backgroundCoveredByWorkspace={shellBackdropCoversSidebar}
        resolvedSidebarBackground={resolvedSidebarBackground}
        backgroundFetcher={sidebarBackgroundFetcher}
        projectSection={
          <>
            {projectStatus === "loading" ? (
              <p className="project-nav__status" role="status">
                Loading Projects…
              </p>
            ) : projectStatus === "disconnected" ? (
              <OctantAlert className="project-nav__status" tone="warning">
                <span>{projectErrorMessage}</span>
                <OctantButton onClick={retryProjects} type="button" variant="secondary">
                  Retry
                </OctantButton>
              </OctantAlert>
            ) : (
              <ProjectSidebarSection
                projectViewsEnabled
                projectViewsMode={activeMode === "code" ? "code" : "work"}
                projectViewSwitcherPresentation={settings.projectViewSwitcherPresentation}
                onProjectViewSwitcherPresentationChange={(presentation) =>
                  void updateSettings({
                    projectViewSwitcherPresentation: presentation,
                  })
                }
                projectViewEnvironmentOptions={projectViewEnvironmentOptionsFromHosts(hosts)}
                activityMode={activeMode === "code" ? "code" : "work"}
                {...(sidebarFilterQuery === "" ? {} : { searchQuery: sidebarFilterQuery })}
                {...(sidebarListRequest === undefined ? {} : { listRequest: sidebarListRequest })}
                rowProperties={settings.sidebarRowProperties}
                onRowPropertiesChange={(sidebarRowProperties) => {
                  void updateSettings({ sidebarRowProperties });
                }}
                {...(activeProjectId === undefined ? {} : { activeProjectId })}
                {...(activeMode === "chat" && chatProjectThreadListRequest !== undefined
                  ? { expandProjectThreadsRequest: chatProjectThreadListRequest }
                  : {})}
                {...(activeSidebarDestination === undefined &&
                ((activeMode === "chat" &&
                  chatStatus === "ready" &&
                  activeChatThreadId !== undefined) ||
                  (activeMode === "code" &&
                    codeStatus === "ready" &&
                    activeCodeThreadId !== undefined) ||
                  (activeMode === "work" &&
                    workStatus === "ready" &&
                    activeWorkThreadId !== undefined))
                  ? {
                      activeThreadId:
                        activeMode === "code"
                          ? String(activeCodeThreadId)
                          : activeMode === "work"
                            ? String(activeWorkThreadId)
                            : String(activeChatThreadId),
                    }
                  : {})}
                {...(openSidebarThreadIds === undefined || openSidebarThreadIds.length === 0
                  ? {}
                  : { openThreadIds: openSidebarThreadIds })}
                archivedProjects={workSide ? workSideArchivedProjects : archivedProjects}
                availabilityByProject={availabilityByProject}
                contextHealthByProject={contextHealthByProject}
                onOpenContextHealth={(projectId) => void openProjectContextHealth(projectId)}
                {...(activeMode === "chat" && chatStatus === "ready"
                  ? {
                      addProjectLabel: "chat-project" as const,
                      onAddProject: () => openProjectCreate(),
                      unfiledLabel: "No Project" as const,
                    }
                  : {
                      onAddProject: () => openProjectCreate(),
                      unfiledLabel: "No Project" as const,
                    })}
                onArchive={(projectId) => void actions.setProjectArchived(projectId, true)}
                onColorChange={(projectId, color) => {
                  void actions.setProjectColor(projectId, color);
                }}
                onMove={(projectId, pinned) => void actions.moveProject(projectId, pinned)}
                {...(activeMode === "chat"
                  ? {
                      newThreadVerb: "chat" as const,
                      onNewThreadInProject: (projectId) => void openDraftInProject(projectId),
                    }
                  : activeMode === "code"
                    ? {
                        newThreadVerb: "thread" as const,
                        onNewThreadInProject: (projectId) => void openDraftInProject(projectId),
                      }
                    : activeMode === "work"
                      ? {
                          newThreadVerb: "thread" as const,
                          onNewThreadInProject: (projectId) => void openDraftInProject(projectId),
                        }
                      : {})}
                onReorder={(projectId, pinned, beforeProjectId, afterProjectId) =>
                  void actions.moveProject(projectId, pinned, beforeProjectId, afterProjectId)
                }
                onRestore={(projectId) => void actions.setProjectArchived(projectId, false)}
                onProjectOpen={openSelectedProject}
                {...(workSide
                  ? {
                      onSelectThread: selectWorkSideThread,
                      threadActions: workSideRowActions,
                      threads: workSideThreads,
                    }
                  : activeMode === "code"
                    ? {
                        onSelectThread: selectCodeThread,
                        threadActions: codeThreadRowActions,
                        onRenameThread: renameCodeThread,
                        ...(markedThreadGroups === undefined
                          ? codeStatus === "ready"
                            ? { threads: codeProjectThreads.map(withProviderMark) }
                            : {}
                          : { threadGroups: markedThreadGroups }),
                      }
                    : activeMode === "work"
                      ? {
                          onSelectThread: selectWorkThread,
                          threadActions: workThreadRowActions,
                          ...(markedThreadGroups === undefined
                            ? workStatus === "ready"
                              ? { threads: workProjectThreads.map(withProviderMark) }
                              : {}
                            : { threadGroups: markedThreadGroups }),
                        }
                      : {})}
                {...(activeMode === "chat"
                  ? {}
                  : {
                      threadStatus: threadStatus,
                      ...(threadErrorMessage === undefined
                        ? {}
                        : { threadErrorMessage: threadErrorMessage }),
                      onRetryThreads: retryActiveModeThreads,
                    })}
                projects={workSide ? workSideProjects : projects}
                {...(workSide &&
                workSideProjects.length === 0 &&
                allProjects.some(
                  (project) => project.type === "code" && project.lifecycle === "active",
                )
                  ? {
                      otherModeProjectsHint: {
                        message: "Your Projects are in Code.",
                        actionLabel: "Switch to Code",
                        onSwitch: () => selectMode("code"),
                      },
                    }
                  : {})}
              />
            )}
          </>
        }
      />
      {moveRequest === undefined ? null : (
        <MoveThreadToProjectDialog
          currentProjectId={moveRequest.projectId}
          mode={moveRequest.mode}
          onClose={() => setMoveRequest(undefined)}
          onMove={moveThread(moveRequest)}
          projects={allProjects}
          threadTitle={moveRequest.title}
        />
      )}
    </>
  );
});
