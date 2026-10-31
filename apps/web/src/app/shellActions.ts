import type { EnvironmentSelection } from "@octant/client-runtime/environment-selection";
import type {
  CodeProjectPullRequestDetailObserved,
  CodeTerminalId,
  CodeProjectPullRequestDetailQuery,
  CodeProjectPullRequestMergeMethod,
  CodeProjectPullRequestMergeOutcome,
  CodeProjectPullRequestRow,
  LocalServerOpenTarget,
  RunningService,
  ThreadBoardPullRequestIdentity,
  WorkThread,
  WorkThreadCommand,
} from "@octant/contracts";
import type { ChatThreadId } from "@octant/contracts/chat";
import type { HostId } from "@octant/contracts/host";
import type { OctantMode } from "@octant/contracts/modes";
import type { ProjectId, ProjectSummary } from "@octant/contracts/projects";
import type {
  PermissionPersistence,
  PermissionMode,
  ProviderInstanceId,
  ProviderModelId,
  ProviderModelOptionValues,
} from "@octant/contracts/providers";
import type { PaneId } from "@octant/contracts/shell";
import type { UsageQueryFilter } from "@octant/contracts/usage-rpc";
import type { ZenSourceContext } from "@octant/contracts/zen";
import type { Dispatch, SetStateAction } from "react";
import type { AgentRunViewRequest } from "../agents/AgentRunHierarchy";
import type { ChatController } from "../chat/useChatController";
import type { CodeController } from "../code/useCodeController";
import type { RepositoryIssueRow } from "../github/readIssuesAcrossRepositories";
import type { AgentResultReviewRequest } from "../gitHistory/SavedAgentReview";
import type { ChildPendingRequest } from "../pendingRequests/pendingRequests";
import type { useProjectController } from "../projects/useProjectController";
import type { ReviewActionOutcome } from "../review/ReviewPage";
import type { ArchivedThreadEntry } from "../shell/ArchiveView";
import type { DockThreadOverviewContent } from "../shell/DockThreadOverviewContent";
import type { WrittenDocument } from "../shell/writtenDocuments";
import type { RightUtilityDockSurfaceId } from "../shell/rightUtilityDockModel";
import type { ThreadUtilityDockKey } from "../shell/rightUtilityDockSelection";
import type { useShellController } from "../shell/useShellController";
import type { useThreadUtilityPresentation } from "../shell/useThreadUtilityPresentation";
import type { VisibleMode } from "../shell/workKind";
import type { WorkspaceViewProps } from "../shell/WorkspaceView";
import type { useZenController } from "../zen/useZenController";

type ShellController = ReturnType<typeof useShellController>;
type ProjectController = ReturnType<typeof useProjectController>;
type ZenController = ReturnType<typeof useZenController>;
type ThreadUtilityPresentation = ReturnType<typeof useThreadUtilityPresentation>;

/**
 * Everything a shell surface can ask the shell to do. The shell defines these
 * against its own state on every render; the surfaces receive them through
 * `useStableActions`, so each one keeps its identity for the life of the
 * shell and a surface wrapped in `memo` is not re-rendered for a new closure.
 *
 * Controller methods are named for what they do to the product (a Code
 * thread's rest, a Project's colour), not for the controller that carries
 * them, because the surfaces do not know the controllers.
 */
export type ShellActions = {
  readonly activateContentTab: ShellController["activateContentTab"];
  readonly activatePane: ShellController["activatePane"];
  readonly addDockTab: (surface: RightUtilityDockSurfaceId) => void;
  readonly addZenBrowser: (sourceContext: ZenSourceContext) => void;
  readonly addZenProjectTerminal: (projectId: ProjectId) => Promise<CodeTerminalId | undefined>;
  readonly addZenTerminal: (sourceContext: ZenSourceContext) => Promise<void>;
  readonly archiveCodeThread: CodeController["archiveThread"];
  readonly clearFocus: ShellController["clearFocus"];
  readonly closeBottomPanel: (restoreFocus?: boolean) => void;
  readonly closeBottomPanelTab: (surface: RightUtilityDockSurfaceId) => void;
  readonly closeContentTab: ShellController["closeContentTab"];
  readonly keepThreadTab: ShellController["keepThreadTab"];
  readonly arrangeSideBySide: ShellController["arrangeSideBySide"];
  readonly closeDock: () => void;
  readonly closeDockTab: (tabId: string) => void;
  readonly closePane: ShellController["closePane"];
  readonly closeWorkspaceReaders: () => void;
  readonly commitSplitResize: ShellController["commitSplitResize"];
  readonly completeChatThread: ChatController["completeThread"];
  readonly completeCodeFollowUp: CodeController["completeFollowUp"];
  readonly completeCodeThread: CodeController["completeThread"];
  readonly createChat: (
    prompt?: string,
    modelOptionValues?: ProviderModelOptionValues,
    paneId?: PaneId,
  ) => void;
  readonly createProject: ProjectController["create"];
  readonly dismissCrossContextOffer: ShellController["dismissCrossContextOffer"];
  readonly ensureDefaultProject: ProjectController["ensureDefault"];
  readonly enterZen: ZenController["enterZen"];
  readonly focusPane: ShellController["focusPane"];
  readonly handleCreateChatProjectThread: NonNullable<
    WorkspaceViewProps["onCreateChatProjectThread"]
  >;
  readonly handleCreateWorkThread: (
    projectId: ProjectId,
    prompt: string,
    images?: ReadonlyArray<File>,
    threadMentionIds?: ReadonlyArray<import("@octant/contracts").MentionableThreadId>,
    modelOptionValues?: ProviderModelOptionValues,
  ) => Promise<boolean>;
  readonly handleDraftCreateCodeThread: NonNullable<WorkspaceViewProps["onDraftCreateCodeThread"]>;
  readonly handleDraftCreateThread: NonNullable<WorkspaceViewProps["onDraftCreateThread"]>;
  readonly handleSelectCreateHost: NonNullable<WorkspaceViewProps["onSelectCreateHost"]>;
  readonly handleSelectVisibleMode: (mode: VisibleMode) => void;
  readonly loadCodeBoard: NonNullable<Parameters<typeof DockThreadOverviewContent>[0]["loadBoard"]>;
  readonly markChatThreadRead: ChatController["markThreadRead"];
  readonly markCodeFollowUp: CodeController["markFollowUp"];
  readonly markCodeThreadRead: CodeController["markThreadRead"];
  readonly mergeProjectPullRequest: (
    method: CodeProjectPullRequestMergeMethod,
    headSha: string,
  ) => Promise<CodeProjectPullRequestMergeOutcome>;
  readonly moveProject: ProjectController["move"];
  readonly noteCanvasReferences: NonNullable<WorkspaceViewProps["onCanvasReferencesObserved"]>;
  readonly noteHandedOffDocument: (mode: OctantMode, threadId: string, canvasId: string) => void;
  readonly onComputerUseSessionChange: NonNullable<
    WorkspaceViewProps["onComputerUseSessionChange"]
  >;
  readonly openAgentsCenter: () => void;
  readonly openArchive: () => void;
  readonly openArchivedThread: (entry: ArchivedThreadEntry) => void;
  readonly openArtifactLibrary: () => void;
  readonly openAutomationCenter: () => void;
  /** Opens the Automation Center with one routine selected. */
  readonly openRoutine: (automationId: string) => void;
  readonly openBottomTool: (surface: RightUtilityDockSurfaceId) => void;
  readonly openCanvas: ShellController["openCanvas"];
  readonly openCanvasInSidebar: NonNullable<WorkspaceViewProps["onOpenCanvasInSidebar"]>;
  readonly openChatThread: ShellController["openChatThread"];
  readonly openCodeSurface: ShellController["openCodeSurface"];
  readonly openCodeThread: ShellController["openCodeThread"];
  readonly openCreatedFollowUp: NonNullable<
    NonNullable<WorkspaceViewProps["followUpSuggestions"]>["onCreated"]
  >;
  readonly openCrossContextInNewWindow: ShellController["openCrossContextInNewWindow"];
  readonly openDockTab: (surface: RightUtilityDockSurfaceId, opener?: HTMLElement) => void;
  readonly openDraftInActiveProject: (mode: "work" | "code") => void;
  readonly openDraftInProject: (projectId: ProjectId) => Promise<void>;
  readonly openDraftThread: ShellController["openDraftThread"];
  readonly openGithubIssues: () => void;
  readonly openImageLibrary: () => void;
  /** Puts the active pane back on its mode's start screen. */
  readonly openHome: () => void;
  readonly openInbox: () => void;
  readonly openLinearIssues: () => void;
  readonly openLinkInApp: (
    request: Parameters<NonNullable<WorkspaceViewProps["onOpenLink"]>>[0],
  ) => Promise<void>;
  readonly openLinkedProjectPullRequestThread: (
    thread: CodeProjectPullRequestRow["linkedThreads"][number],
    projectId: CodeProjectPullRequestRow["projectId"],
  ) => void;
  readonly openNavigator: () => void;
  readonly openPreview: ShellController["openPreview"];
  readonly openProject: ShellController["openProject"];
  readonly openProjectContextHealth: (projectId: ProjectId) => Promise<void>;
  readonly openProjectCreate: (mode?: OctantMode) => void;
  readonly openProjectPullRequestChat: (detail: CodeProjectPullRequestDetailObserved) => void;
  readonly openProjects: () => void;
  readonly openPullRequests: () => void;
  readonly openReview: () => void;
  readonly openReviewForThread: (threadId: string) => void;
  readonly openRunningService: (
    service: RunningService,
    target: LocalServerOpenTarget,
  ) => Promise<void>;
  readonly openSelectedProject: (project: ProjectSummary) => Promise<void>;
  readonly openSettings: ShellController["openSettings"];
  readonly openSideChat: ShellController["openSideChat"];
  readonly openSidebarList: (view: "activity" | "completed") => void;
  readonly openSkillsSettings: () => void;
  readonly openSubagent: NonNullable<WorkspaceViewProps["onOpenSubagent"]>;
  readonly openSubagentRequest: (request: ChildPendingRequest) => void;
  readonly openSurface: ShellController["openSurface"];
  readonly openThreadBoard: () => void;
  readonly openThreadSearch: () => void;
  readonly openThreadBrowser: ShellController["openThreadBrowser"];
  readonly openWorkThread: ShellController["openWorkThread"];
  /** Opens one of the dock thread's outputs in the tool that shows it. */
  readonly openWrittenDocument: (document: WrittenDocument) => void;
  readonly persistBottomPanelPresentation: ThreadUtilityPresentation["persistBottomPanelPresentation"];
  readonly pinChatThreadInPane: (threadId: string) => void;
  readonly pinCodeThread: CodeController["pinThread"];
  readonly pinCodeThreadInPane: (threadId: string) => void;
  readonly pinWorkThreadInPane: (threadId: string) => void;
  readonly previewSplitResize: ShellController["previewSplitResize"];
  readonly recoverZen: ZenController["recoverZen"];
  readonly refuseUnlessCreatableDestination: (input: {
    readonly action: string;
    readonly requiredCapability?: string;
    readonly projectHostId?: HostId;
    readonly onRefuse: (reason: string) => void;
  }) => HostId | undefined;
  readonly relinkProject: ProjectController["relink"];
  readonly renameCodeThread: (threadId: string, title: string) => void;
  readonly renameProject: ProjectController["rename"];
  readonly reopenChatThread: ChatController["reopenThread"];
  readonly reopenCodeThread: CodeController["reopenThread"];
  readonly resetNewTaskDraft: (mode: OctantMode, paneId?: PaneId) => void;
  readonly retryActiveModeThreads: () => void;
  readonly retryChat: () => void;
  readonly retryProjects: () => void;
  readonly revealBrowserActivity: ShellController["revealBrowserActivity"];
  readonly runWorkRestCommand: (
    threadId: string,
    command: (expectedVersion: WorkThread["version"]) => WorkThreadCommand,
  ) => Promise<void>;
  readonly searchEveryThread: (query: string) => void;
  readonly selectChatThread: (threadId: string) => void;
  readonly selectCodeThread: (threadId: string) => void;
  readonly selectDockTab: (tabId: string) => void;
  readonly selectMode: (mode: OctantMode) => void;
  readonly selectProjectPullRequest: (row: CodeProjectPullRequestRow) => void;
  readonly selectProjectPullRequestIdentity: (identity: ThreadBoardPullRequestIdentity) => void;
  readonly selectWorkThread: (threadId: string) => void;
  readonly sendBackChatTurn: ChatController["sendBackTurn"];
  readonly sendBackCodeTurn: CodeController["sendBackTurn"];
  readonly setAgentsCenterOpen: Dispatch<SetStateAction<boolean>>;
  readonly setArchiveOpen: Dispatch<SetStateAction<boolean>>;
  readonly setArtifactLibraryOpen: Dispatch<SetStateAction<boolean>>;
  readonly setAutomationCenterOpen: Dispatch<SetStateAction<boolean>>;
  readonly setCodeBoardOpen: Dispatch<SetStateAction<boolean>>;
  readonly setCodeNewThreadWorkspace: ProjectController["setCodeNewThreadWorkspace"];
  readonly setCodePullRequestBackgroundRefresh: ProjectController["setCodePullRequestBackgroundRefresh"];
  readonly setCodePullRequestsOpen: Dispatch<SetStateAction<boolean>>;
  readonly setDockSidecarsByThread: Dispatch<
    SetStateAction<ReadonlyMap<ThreadUtilityDockKey, ChatThreadId>>
  >;
  readonly setDockStatesByThread: ThreadUtilityPresentation["setDockStatesByThread"];
  readonly setDraftError: Dispatch<SetStateAction<string | undefined>>;
  readonly setDraftPermissionMode: Dispatch<SetStateAction<PermissionMode | undefined>>;
  readonly setDraftModelId: Dispatch<SetStateAction<ProviderModelId | undefined>>;
  readonly setDraftPendingMessage: Dispatch<SetStateAction<string | undefined>>;
  readonly setDraftPermissionPersistence: Dispatch<
    SetStateAction<PermissionPersistence | undefined>
  >;
  readonly setDraftProjectSelection: Dispatch<
    SetStateAction<Partial<Readonly<Record<OctantMode, ProjectId>>>>
  >;
  readonly setDraftProviderInstanceId: Dispatch<SetStateAction<ProviderInstanceId | undefined>>;
  readonly setEnvironmentSelection: Dispatch<SetStateAction<EnvironmentSelection>>;
  readonly setFallbackDockState: ThreadUtilityPresentation["setFallbackDockState"];
  readonly setGithubIssuesOpen: Dispatch<SetStateAction<boolean>>;
  readonly setImageLibraryOpen: Dispatch<SetStateAction<boolean>>;
  readonly setInboxOpen: Dispatch<SetStateAction<boolean>>;
  readonly setLinearIssuesOpen: Dispatch<SetStateAction<boolean>>;
  readonly setPendingDraftBranch: Dispatch<SetStateAction<string | undefined>>;
  readonly setPendingDraftPrompt: Dispatch<SetStateAction<string | undefined>>;
  readonly setPendingIssue: Dispatch<SetStateAction<RepositoryIssueRow | undefined>>;
  readonly setPendingUsageFilter: Dispatch<SetStateAction<UsageQueryFilter | undefined>>;
  readonly setPreviewBottomPanelHeight: Dispatch<SetStateAction<number | undefined>>;
  readonly setPreviewContextWidth: Dispatch<SetStateAction<number | undefined>>;
  readonly setProjectArchived: ProjectController["setArchived"];
  readonly setProjectColor: ProjectController["setColor"];
  readonly setProjectProviderPolicy: ProjectController["setProviderPolicy"];
  readonly setProjectPermissionMode: ProjectController["setCodePermissionMode"];
  readonly setProjectBrandKit: ProjectController["setBrandKit"];
  readonly setProjectDesktopRecipe: ProjectController["setDesktopRecipe"];
  readonly setProjectActions: ProjectController["setActions"];
  readonly setProjectWorkStatusFile: ProjectController["setWorkStatusFile"];
  readonly setProjectWorkDeveloperTools: ProjectController["setWorkDeveloperTools"];
  readonly setProjectsListOpen: Dispatch<SetStateAction<boolean>>;
  readonly setRailPlaceholder: Dispatch<
    SetStateAction<{ readonly title: string; readonly message: string } | undefined>
  >;
  readonly setRequestedAgentReview: Dispatch<
    SetStateAction<
      { readonly threadKey: string; readonly request: AgentResultReviewRequest } | undefined
    >
  >;
  readonly setRequestedAgentView: Dispatch<
    SetStateAction<{ readonly threadKey: string; readonly view: AgentRunViewRequest } | undefined>
  >;
  readonly setReviewOpen: Dispatch<SetStateAction<boolean>>;
  readonly setSelectedProjectPullRequest: Dispatch<
    SetStateAction<CodeProjectPullRequestDetailQuery | undefined>
  >;
  readonly setThreadExportNotice: Dispatch<SetStateAction<string | undefined>>;
  readonly setThreadStatsVisible: (visible: boolean) => void;
  readonly setUsageOpen: Dispatch<SetStateAction<boolean>>;
  readonly setWorkBoardOpen: Dispatch<SetStateAction<boolean>>;
  readonly setWorkComposerSelection: Dispatch<
    SetStateAction<
      | { readonly providerInstanceId: ProviderInstanceId; readonly modelId: ProviderModelId }
      | undefined
    >
  >;
  readonly snoozeChatThread: ChatController["snoozeThread"];
  readonly snoozeCodeThread: CodeController["snoozeThread"];
  readonly spendRevealChatTurn: () => void;
  readonly splitPane: ShellController["splitPane"];
  readonly startNewThreadDraft: (mode: OctantMode) => void;
  readonly toggleBottomPanel: (opener: HTMLElement) => void;
  readonly toggleDock: (opener: HTMLElement) => void;
  readonly touchMemoryRevision: ProjectController["touchMemoryRevision"];
  readonly tryWorkRestCommand: (
    threadId: string,
    command: (expectedVersion: WorkThread["version"]) => WorkThreadCommand,
  ) => Promise<ReviewActionOutcome>;
  readonly updateSettings: ShellController["updateSettings"];
  readonly viewAllChatProjectThreads: NonNullable<
    WorkspaceViewProps["onViewAllChatProjectThreads"]
  >;
  readonly wakeChatThread: ChatController["wakeThread"];
  readonly wakeCodeThread: CodeController["wakeThread"];
};
