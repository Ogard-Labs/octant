import type { OctantMode } from "@octant/contracts/modes";
import type { ProjectId } from "@octant/contracts/projects";
import { decodeChatThreadId } from "@octant/contracts/chat";
import { decodeCodeThreadId, type CodeThread } from "@octant/contracts/code";
import { decodeUtcTimestamp, decodeWorkThreadId, type WorkThread } from "@octant/contracts";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import { memo, useMemo } from "react";
import { buildAutomationEditorCatalog } from "../automation/automationEditorCatalog";
import { isChildPendingRequest } from "../pendingRequests/pendingRequests";
import type { InboxDecisionSource } from "../inbox/InboxView";
import type { buildInboxAttentionItems } from "../inbox/inboxModel";
import { inboxThreadProjectId } from "../inbox/inboxModel";
import { ProjectsDirectory } from "../projects/ProjectsDirectory";
import type { useProjectController } from "../projects/useProjectController";
import type { buildModelPickerGroups } from "@octant/domain";
import type { ReviewActionOutcome, ReviewPageProps } from "../review/ReviewPage";
import type { buildReviewEntries, ReviewEntry } from "../review/reviewModel";
import type { createReviewSource } from "../review/reviewSource";
import type { ArchivedThreadEntry } from "../shell/ArchiveView";
import type { OctantHostBridge } from "../shell/hostBridge";
import type { useShellController } from "../shell/useShellController";
import { WorkspaceRailLayers, type WorkspaceRailLayersProps } from "../shell/WorkspaceRailLayers";
import type { useWorkThreadNavigation } from "../work/useWorkThreadNavigation";
import type { CodeController } from "../code/useCodeController";
import type { createLaunchedShellClients } from "./createLaunchedShellClients";
import type { ShellActions } from "./shellActions";

type ProjectController = ReturnType<typeof useProjectController>;
type ShellController = ReturnType<typeof useShellController>;

export interface ReaderPagesContainerProps {
  readonly actions: Pick<
    ShellActions,
    | "closeWorkspaceReaders"
    | "completeChatThread"
    | "completeCodeThread"
    | "createChat"
    | "markChatThreadRead"
    | "markCodeThreadRead"
    | "openArchivedThread"
    | "openCanvas"
    | "openChatThread"
    | "openCodeThread"
    | "openDraftInActiveProject"
    | "openProject"
    | "openProjectCreate"
    | "openSelectedProject"
    | "openSettings"
    | "openSubagentRequest"
    | "openThreadBoard"
    | "openWorkThread"
    | "selectChatThread"
    | "selectCodeThread"
    | "selectProjectPullRequest"
    | "selectProjectPullRequestIdentity"
    | "selectWorkThread"
    | "sendBackChatTurn"
    | "sendBackCodeTurn"
    | "setAgentsCenterOpen"
    | "setArchiveOpen"
    | "setArtifactLibraryOpen"
    | "setAutomationCenterOpen"
    | "setCodeBoardOpen"
    | "setCodePullRequestBackgroundRefresh"
    | "setCodeAgentMerge"
    | "setCodePullRequestsOpen"
    | "setGithubIssuesOpen"
    | "setImageLibraryOpen"
    | "setInboxOpen"
    | "setLinearIssuesOpen"
    | "setPendingIssue"
    | "setProjectsListOpen"
    | "setRailPlaceholder"
    | "setReviewOpen"
    | "setSelectedProjectPullRequest"
    | "setWorkBoardOpen"
    | "snoozeChatThread"
    | "snoozeCodeThread"
    | "tryWorkRestCommand"
  >;
  readonly activeMode: OctantMode;
  readonly activeProjectId?: ProjectId;
  readonly agentsCenterVisible: boolean;
  readonly allProjects: ProjectController["allProjects"];
  readonly archiveOpen: boolean;
  readonly artifactLibraryOpen: boolean;
  readonly automationCenterVisible: boolean;
  readonly automationCenterFocusId?: string;
  readonly automationEditorCatalog: ReturnType<typeof buildAutomationEditorCatalog>;
  readonly availabilityByProject: ProjectController["availabilityByProject"];
  readonly boundCodeProjectId: ShellController["boundCodeProjectId"];
  readonly clients: ReturnType<typeof createLaunchedShellClients>;
  readonly codeBoardOpen: boolean;
  readonly codeBoardProjects: WorkspaceRailLayersProps["codeBoardProjects"];
  readonly codeNavigationRows: CodeController["navigation"];
  readonly codePullRequestsOpen: boolean;
  readonly codeProviderGroups: ReturnType<typeof buildModelPickerGroups>;
  readonly codeThreads: ReadonlyArray<CodeThread> | undefined;
  readonly environmentNames: ReadonlyMap<string, string>;
  readonly githubClient: WorkspaceRailLayersProps["githubClient"];
  readonly githubIssuesOpen: boolean;
  readonly githubIssuesReadAvailable: boolean;
  readonly hostBridge?: OctantHostBridge;
  readonly imageLibraryOpen: boolean;
  readonly imageProfiles: WorkspaceRailLayersProps["imageProfiles"];
  readonly inboxAttentionItems: ReturnType<typeof buildInboxAttentionItems>;
  readonly inboxOpen: boolean;
  readonly isNarrow: boolean;
  readonly linearClient: WorkspaceRailLayersProps["linearClient"];
  readonly linearIssuesOpen: boolean;
  readonly linearIssuesRead: boolean;
  readonly loadAssignedGithubWork: NonNullable<WorkspaceRailLayersProps["loadAssignedGithubWork"]>;
  readonly loadAssignedLinearIssues: NonNullable<
    WorkspaceRailLayersProps["loadAssignedLinearIssues"]
  >;
  /** The sum of every mode's navigation revision: when a turn starts or ends. */
  readonly navigationRevision: number;
  readonly now: number;
  readonly projectNames: ReadonlyMap<string, string>;
  readonly projects: ProjectController["projects"];
  readonly projectsListOpen: boolean;
  readonly railPlaceholder?: { readonly title: string; readonly message: string };
  readonly reviewEntries: ReturnType<typeof buildReviewEntries>;
  readonly reviewOpen: boolean;
  readonly reviewSource: ReturnType<typeof createReviewSource>;
  readonly selectedProjectPullRequestKey?: string;
  readonly serverUrl: string;
  readonly settings: NonNullable<ShellController["settings"]>;
  readonly windowCapability: string;
  readonly workBoardOpen: boolean;
  readonly workBoardProjects: WorkspaceRailLayersProps["workBoardProjects"];
  readonly workNavigationRows: ReturnType<typeof useWorkThreadNavigation>["navigation"];
  readonly workProviderGroups: ReturnType<typeof buildModelPickerGroups>;
  readonly workThreads: ReadonlyArray<WorkThread> | undefined;
  readonly workspace: NonNullable<ShellController["workspace"]>;
}

/**
 * The pages about many threads that cover the workspace: the Projects
 * directory, Inbox, Review, the Work and Code boards, pull requests, issues,
 * archive, the libraries and the Automation and Agents centers. Each is drawn
 * only while open; while all are closed this container renders their closed
 * state and a shell render that changed none of its inputs leaves it alone.
 */
export const ReaderPagesContainer = memo(function ReaderPagesContainer(
  props: ReaderPagesContainerProps,
) {
  const {
    actions,
    activeMode,
    activeProjectId,
    agentsCenterVisible,
    allProjects,
    archiveOpen,
    artifactLibraryOpen,
    automationCenterVisible,
    automationCenterFocusId,
    automationEditorCatalog,
    availabilityByProject,
    boundCodeProjectId,
    codeBoardOpen,
    codeBoardProjects,
    codeNavigationRows,
    codePullRequestsOpen,
    codeProviderGroups,
    codeThreads,
    environmentNames,
    githubClient,
    githubIssuesOpen,
    githubIssuesReadAvailable,
    imageLibraryOpen,
    imageProfiles,
    inboxAttentionItems,
    inboxOpen,
    isNarrow,
    linearClient,
    linearIssuesOpen,
    linearIssuesRead,
    loadAssignedGithubWork,
    loadAssignedLinearIssues,
    navigationRevision,
    now,
    projectNames,
    projects,
    projectsListOpen,
    railPlaceholder,
    reviewEntries,
    reviewOpen,
    reviewSource,
    selectedProjectPullRequestKey,
    serverUrl,
    settings,
    windowCapability,
    workBoardOpen,
    workBoardProjects,
    workNavigationRows,
    workProviderGroups,
    workThreads,
    workspace,
  } = props;
  const { openProjectCreate, openSelectedProject } = actions;
  const {
    agentMessageClient,
    agentRunClient,
    automationClient,
    automationNotificationClient,
    chatClient,
    codeClient,
    imageGenerationClient,
    pendingRequestClient,
    workRequestClient,
    workThreadClient,
    workTurnClient,
  } = props.clients;
  const answerClients = useMemo(
    () => ({ chatClient, codeClient, workRequestClient, workTurnClient }),
    [chatClient, codeClient, workRequestClient, workTurnClient],
  );

  // The Inbox answers the decisions finished turns asked with the same
  // reader and send clients as the Needs you card; a remote window has none.
  const inboxDecisions = useMemo<InboxDecisionSource | undefined>(
    () =>
      pendingRequestClient === undefined
        ? undefined
        : {
            answerClients,
            feedRevision: navigationRevision,
            modes: DECISION_MODES,
            now,
            onOpenThread: (request) => {
              actions.setInboxOpen(false);
              if (isChildPendingRequest(request)) actions.openSubagentRequest(request);
              else if (request.mode === "work") actions.selectWorkThread(String(request.threadId));
              else if (request.mode === "code") actions.selectCodeThread(String(request.threadId));
              else actions.selectChatThread(String(request.threadId));
            },
            pendingRequestClient,
            projectNames,
            settings,
            workspace,
          },
    [
      actions,
      answerClients,
      navigationRevision,
      now,
      pendingRequestClient,
      projectNames,
      settings,
      workspace,
    ],
  );

  // The Review page acts through each thread's own host command, the same one
  // its sidebar row uses, but asks for the host's answer as a value: the page
  // shows a refusal beside the thread it concerns instead of in a shared
  // notice. Each mode keeps its own command, so a Chat thread never reaches a
  // Work or Code command.
  const reviewPageProps = useMemo<ReviewPageProps | undefined>(
    () =>
      reviewOpen
        ? {
            entries: reviewEntries,
            source: reviewSource,
            changeRevision: navigationRevision,
            now,
            onClose: () => actions.setReviewOpen(false),
            ...(inboxDecisions === undefined ? {} : { decisions: inboxDecisions }),
            codeProjectAccess: {
              boundProjectId:
                boundCodeProjectId === undefined ? undefined : String(boundCodeProjectId),
              onOpenProject: (entry: ReviewEntry) => {
                const project = allProjects.find(
                  (candidate) => String(candidate.id) === entry.projectId,
                );
                if (project === undefined || project.lifecycle !== "active") return;
                // Binds the window without closing the page, so the person stays in review.
                void actions.openProject(project.id, "code", project.name);
              },
            },
            onOpen: (entry: ReviewEntry) => {
              if (entry.mode === "chat") actions.selectChatThread(entry.threadId);
              else if (entry.mode === "work") actions.selectWorkThread(entry.threadId);
              else actions.selectCodeThread(entry.threadId);
            },
            onComplete: (entry: ReviewEntry): Promise<ReviewActionOutcome> => {
              if (entry.mode === "code") {
                return actions.completeCodeThread(decodeCodeThreadId(entry.threadId));
              }
              if (entry.mode === "chat") {
                return actions.completeChatThread(decodeChatThreadId(entry.threadId));
              }
              return actions.tryWorkRestCommand(entry.threadId, (expectedVersion) => ({
                kind: "complete-work-thread",
                threadId: decodeWorkThreadId(entry.threadId),
                expectedVersion,
              }));
            },
            onSnooze: (entry: ReviewEntry, until: string): Promise<ReviewActionOutcome> => {
              if (entry.mode === "code") {
                return actions.snoozeCodeThread(decodeCodeThreadId(entry.threadId), until);
              }
              if (entry.mode === "chat") {
                return actions.snoozeChatThread(decodeChatThreadId(entry.threadId), until);
              }
              return actions.tryWorkRestCommand(entry.threadId, (expectedVersion) => ({
                kind: "snooze-work-thread",
                threadId: decodeWorkThreadId(entry.threadId),
                expectedVersion,
                until: decodeUtcTimestamp(until),
              }));
            },
            onSendBack: (entry: ReviewEntry, prompt: string): Promise<ReviewActionOutcome> => {
              if (entry.mode === "code") {
                return actions.sendBackCodeTurn(decodeCodeThreadId(entry.threadId), prompt);
              }
              if (entry.mode === "chat") {
                return actions.sendBackChatTurn(decodeChatThreadId(entry.threadId), prompt);
              }
              return Promise.resolve({
                status: "refused",
                message:
                  "A Work thread takes its follow-up from its own composer. Open it to continue.",
              });
            },
            onMarkSeen: (entry: ReviewEntry) => {
              if (entry.mode === "code")
                actions.markCodeThreadRead(decodeCodeThreadId(entry.threadId));
              else if (entry.mode === "chat") {
                actions.markChatThreadRead(decodeChatThreadId(entry.threadId));
              }
            },
          }
        : undefined,
    [
      actions,
      allProjects,
      boundCodeProjectId,
      inboxDecisions,
      navigationRevision,
      now,
      reviewEntries,
      reviewOpen,
      reviewSource,
    ],
  );

  const archiveEntries = useMemo<ReadonlyArray<ArchivedThreadEntry>>(
    () => [
      ...(workThreads ?? [])
        .filter((thread) => thread.lifecycle === "archived")
        .map((thread) => ({
          mode: "work" as const,
          threadId: String(thread.id),
          title: thread.title,
          ...(thread.projectId === undefined ? {} : { projectId: String(thread.projectId) }),
          updatedAt: thread.updatedAt,
        })),
      ...(codeThreads ?? [])
        .filter((thread) => thread.lifecycle === "archived")
        .map((thread) => ({
          mode: "code" as const,
          threadId: String(thread.id),
          title: thread.title,
          projectId: String(thread.projectId),
          updatedAt: thread.updatedAt,
        })),
    ],
    [codeThreads, workThreads],
  );
  const archiveProjects = useMemo(
    () => allProjects.map((project) => ({ id: String(project.id), name: project.name })),
    [allProjects],
  );

  return (
    <>
      {projectsListOpen ? (
        <div className="projects-page-layer">
          <ProjectsDirectory
            availabilityByProject={availabilityByProject}
            onAddProject={() => openProjectCreate()}
            onBack={() => actions.setProjectsListOpen(false)}
            onOpenProject={(project) => void openSelectedProject(project)}
            projects={allProjects}
            {...(activeProjectId === undefined ? {} : { selectedProjectId: activeProjectId })}
          />
        </div>
      ) : null}
      <WorkspaceRailLayers
        {...(railPlaceholder === undefined ? {} : { railPlaceholder })}
        onDismissRailPlaceholder={() => actions.setRailPlaceholder(undefined)}
        inboxOpen={inboxOpen}
        {...(reviewPageProps === undefined ? {} : { reviewPage: reviewPageProps })}
        onCloseInbox={() => actions.setInboxOpen(false)}
        inboxAttentionItems={inboxAttentionItems}
        {...(inboxDecisions === undefined ? {} : { inboxDecisions })}
        onOpenInboxThread={(signal) => {
          actions.setInboxOpen(false);
          const signalProjectId = inboxThreadProjectId(signal);
          if (signal.source === "chat") {
            void actions.openChatThread(
              decodeChatThreadId(signal.threadId),
              signal.title,
              signalProjectId,
            );
            return;
          }
          if (signal.source === "work") {
            void actions.openWorkThread(
              decodeWorkThreadId(signal.threadId),
              signal.title,
              undefined,
              signalProjectId,
            );
            return;
          }
          void actions.openCodeThread(
            decodeCodeThreadId(signal.threadId),
            signal.title,
            undefined,
            signalProjectId,
          );
        }}
        // Chat has no board: asking for one there opens a layer that
        // hides the workspace and renders nothing in its place.
        {...(activeMode === "chat"
          ? {}
          : {
              onOpenBoard: () => {
                actions.closeWorkspaceReaders();
                actions.openThreadBoard();
              },
            })}
        {...(githubIssuesReadAvailable ? { loadAssignedGithubWork } : {})}
        {...(linearIssuesRead
          ? {
              loadAssignedLinearIssues,
              onOpenLinearIssues: () => {
                actions.setInboxOpen(false);
                actions.setLinearIssuesOpen(true);
              },
            }
          : {})}
        codeBoardOpen={codeBoardOpen}
        codePullRequestsOpen={codePullRequestsOpen}
        githubIssuesOpen={githubIssuesOpen}
        githubClient={githubClient}
        linearIssuesOpen={linearIssuesOpen}
        linearClient={linearClient}
        onCloseLinearIssues={() => actions.setLinearIssuesOpen(false)}
        workBoardOpen={workBoardOpen}
        activeMode={activeMode}
        codeClient={codeClient}
        workThreadClient={workThreadClient}
        codeBoardProjects={codeBoardProjects}
        workBoardProjects={workBoardProjects}
        onCloseCodeBoard={() => actions.setCodeBoardOpen(false)}
        onCloseCodePullRequests={() => {
          actions.setCodePullRequestsOpen(false);
          actions.setSelectedProjectPullRequest(undefined);
        }}
        onCloseGithubIssues={() => actions.setGithubIssuesOpen(false)}
        onStartThreadFromIssue={(issue) => {
          actions.setPendingIssue(issue);
          actions.setGithubIssuesOpen(false);
          actions.openDraftInActiveProject("code");
        }}
        onSelectProjectPullRequest={actions.selectProjectPullRequest}
        onSelectBoardPullRequest={actions.selectProjectPullRequestIdentity}
        pullRequestBackgroundRefresh={{
          enabledFor: (projectId) =>
            projects.some(
              (project) =>
                String(project.id) === String(projectId) &&
                project.type === "code" &&
                project.pullRequestBackgroundRefresh === "enabled",
            ),
          setEnabled: (projectId, enabled) =>
            actions.setCodePullRequestBackgroundRefresh(
              projectId,
              enabled ? "enabled" : "disabled",
            ),
        }}
        agentMerge={{
          enabledFor: (projectId) =>
            projects.some(
              (project) =>
                String(project.id) === String(projectId) &&
                project.type === "code" &&
                project.agentMerge === "enabled",
            ),
          setEnabled: (projectId, enabled) =>
            actions.setCodeAgentMerge(projectId, enabled ? "enabled" : "disabled"),
        }}
        {...(selectedProjectPullRequestKey === undefined ? {} : { selectedProjectPullRequestKey })}
        onCloseWorkBoard={() => actions.setWorkBoardOpen(false)}
        unreadThreadIds={
          new Set(
            (activeMode === "work" ? workNavigationRows : codeNavigationRows)
              .filter((thread) => thread.unread === true)
              .map((thread) => String(thread.threadId)),
          )
        }
        providerLabels={
          new Map(
            (activeMode === "work" ? workProviderGroups : codeProviderGroups).map((group) => [
              String(group.instance.id),
              group.instance.displayName,
            ]),
          )
        }
        boardPendingRequests={{
          answerClients: { chatClient, codeClient, workRequestClient, workTurnClient },
          feedRevision: navigationRevision,
          now,
          onOpenSubagent: actions.openSubagentRequest,
          pendingRequestClient,
          settings,
          workspace,
        }}
        providerKinds={
          new Map(
            (activeMode === "work" ? workProviderGroups : codeProviderGroups).map((group) => [
              String(group.instance.id),
              String(group.instance.driverKind),
            ]),
          )
        }
        onOpenCodeBoardThread={(target) => {
          const thread = codeThreads?.find(
            (candidate) => String(candidate.id) === String(target.threadId),
          );
          actions.setCodeBoardOpen(false);
          actions.setCodePullRequestsOpen(false);
          actions.setGithubIssuesOpen(false);
          void actions.openCodeThread(
            target.threadId,
            thread?.title ?? "Code thread",
            undefined,
            target.projectId,
          );
        }}
        onOpenWorkBoardThread={(target) => {
          const thread = workThreads?.find(
            (candidate) => String(candidate.id) === String(target.threadId),
          );
          actions.setWorkBoardOpen(false);
          void actions.openWorkThread(
            target.threadId,
            thread?.title ?? "Task",
            undefined,
            target.projectId,
          );
        }}
        archiveOpen={archiveOpen}
        archiveChatClient={chatClient}
        archiveEntries={archiveEntries}
        archiveProjects={archiveProjects}
        onCloseArchive={() => actions.setArchiveOpen(false)}
        onOpenArchivedThread={actions.openArchivedThread}
        artifactLibraryOpen={artifactLibraryOpen}
        onCloseArtifactLibrary={() => actions.setArtifactLibraryOpen(false)}
        imageLibraryOpen={imageLibraryOpen}
        onCloseImageLibrary={() => actions.setImageLibraryOpen(false)}
        imageGenerationClient={imageGenerationClient}
        imageProfiles={imageProfiles}
        onOpenImageSettings={() =>
          void actions.openSettings({ section: "voice", setting: "custom-image-sources" })
        }
        onCreateArtifact={() => {
          // An artifact carries the thread it was made in, so there
          // is nowhere to put one that has no origin. Starting a
          // thread is what "new artifact" means here.
          actions.setArtifactLibraryOpen(false);
          actions.createChat();
        }}
        onOpenArtifact={(entry) => {
          actions.setArtifactLibraryOpen(false);
          void actions.openCanvas({
            mode: entry.mode,
            title: entry.title,
            canvasId: entry.canvasId,
            // An entry that names no Project is a Chat Canvas owned by its
            // thread; its tab opens under the same rule the shell restores it.
            projectId: entry.projectId ?? null,
          });
        }}
        serverUrl={serverUrl}
        windowCapability={windowCapability}
        automationCenterVisible={automationCenterVisible}
        {...(automationCenterFocusId === undefined ? {} : { automationCenterFocusId })}
        automationEditorCatalog={automationEditorCatalog}
        automationClient={automationClient}
        environmentNames={environmentNames}
        localHostId={String(LOCAL_HOST_ID)}
        isNarrow={isNarrow}
        notificationClient={automationNotificationClient}
        onCloseAutomationCenter={() => actions.setAutomationCenterOpen(false)}
        onOpenAutomationThread={(target) => {
          actions.setAutomationCenterOpen(false);
          if (target.mode === "chat") {
            void actions.openChatThread(decodeChatThreadId(target.threadId), target.title);
          } else if (target.mode === "code") {
            void actions.openCodeThread(decodeCodeThreadId(target.threadId), target.title);
          } else {
            void actions.openWorkThread(decodeWorkThreadId(target.threadId), target.title);
          }
        }}
        agentsCenterVisible={agentsCenterVisible}
        agentRunClient={agentRunClient}
        agentMessageClient={agentMessageClient}
        projectNames={projectNames}
        onCloseAgentsCenter={() => actions.setAgentsCenterOpen(false)}
        onOpenAgentsThread={(target) => {
          actions.setAgentsCenterOpen(false);
          if (target.mode === "chat") {
            void actions.openChatThread(decodeChatThreadId(target.threadId), target.title);
            return;
          }
          if (target.mode === "code") {
            void actions.openCodeThread(
              decodeCodeThreadId(target.childThreadId ?? target.threadId),
              target.title,
            );
            return;
          }
          void actions.openWorkThread(decodeWorkThreadId(target.threadId), target.title);
        }}
        onOpenAgentsCanvas={(tab) => {
          actions.setAgentsCenterOpen(false);
          void actions.openCanvas(tab);
        }}
      />
    </>
  );
});

/**
 * The Inbox reads the requests it lists from every mode: only Work and Code
 * turns ask decisions, but the agent's own approval waits in any of the three.
 * One array, so a read is not redone per render.
 */
const DECISION_MODES: ReadonlyArray<OctantMode> = ["chat", "work", "code"];
