import { decodeBrowserThreadId } from "@octant/contracts";
import { splitRepositoryName } from "../code/pullRequestLinkService";
import { MergedThreadPutAway } from "../code/mergedThreadPutAway";
import { DesignSystemFiles } from "../designSystems/designSystemFiles";
import { designSystemTurnContext } from "../designSystems/designSystemContext";
import {
  appToolThreadLevel,
  browserToolTransport,
  threadToolStepLimit,
  usageLimitFromReading,
} from "@octant/domain";
import { threadWorkingDirectoryCurrent } from "../threadWorkingDirectoryAuthority";
import type { ThreadMoveHolds } from "../hub/threadMoveHolds";
import { approvedWorkingFolderRoot } from "../approvedWorkingFolders";
import { rememberModelBinding } from "../browser/browserAppManagedTools";
import { projectForgeChoicesFor, standingMergeAllowanceFor } from "../code/standingMergeAllowance";
import { decodeComputerUseOwner } from "@octant/contracts/computer-use-plugin";
import { chosenAutoReviewer } from "@octant/domain/guardrail-policy";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  decodeCodeEvidenceContentId,
  decodeCodeFailure,
  decodeCodeOperationId,
  decodeProviderSessionId,
  RUNTIME_STARTED_TURN_PROMPT,
  decodeCodeRelativePath,
  decodeCodeThreadId,
  type CodeThreadId,
  decodeContextSubjectRef,
  decodeImageGenerationScopeId,
  decodeThreadWorkingDirectory,
  LOCAL_TOOL_HOST_ID,
  THREAD_RETENTION_EVENT_NAMES,
  type CodeOperationId,
  type CodeThread,
  type WindowId,
} from "@octant/contracts";
import type { NativeHarnessEditDiagnosticsPort } from "../harness/nativeHarnessTools";
import { Effect } from "effect";
import { createProductFeedbackTurnPort } from "../browser/productFeedbackTurnPort";
import { resolveThreadWorkingDirectory } from "../threadWorkingDirectoryAuthority";
import { attachWorkRequestRuntime } from "../work/workRequestRuntime";
import { CodeService, CodeServiceError } from "../code/codeService";
import {
  beginUnconfirmedStepSettlement,
  type CodeOperationRuntime,
  type CodeOperationRuntimeOptions,
  type CodeStoppedTurn,
  createCodeOperationRuntime,
} from "../code/codeOperationRuntime";
import { combineAppManagedToolSets } from "../providers/appManagedToolSet";
import { CodePlannerService } from "../code/codePlannerService";
import {
  CodeProjectPullRequestSwitchService,
  pullRequestAutoFixRoutes,
} from "../code/codeProjectPullRequestSwitchService";
import { PullRequestReviewerRegistry } from "../pullRequestReviewers/pullRequestReviewerRegistry";
import { createPullRequestReviewHostRuntime } from "../pullRequestReviewers/pullRequestReviewHostRuntime";
import { createPullRequestReviewRouteHandler } from "../pullRequestReviewers/pullRequestReviewRoutes";
import { PullRequestReviewService } from "../pullRequestReviewers/pullRequestReviewService";
import {
  SECOND_MODEL_PULL_REQUEST_REVIEWER_DISPLAY_NAME,
  SECOND_MODEL_PULL_REQUEST_REVIEWER_ID,
  createSecondModelPullRequestReviewer,
} from "../pullRequestReviewers/secondModelPullRequestReviewer";
import { SECOND_MODEL_PULL_REQUEST_REVIEWER_COMPONENT_ID } from "@octant/plugin-host/first-party-plugins";
import { isFirstPartyIntegrationEffective } from "../github/githubIntegrationEffective";
import type { PullRequestWatchPort } from "../code/pullRequestWatchPort";
import { createGhCommandPort } from "../code/ghPullRequestPort";
import { GhPullRequestSwitchPort } from "../code/ghPullRequestSwitchPort";
import { isRoutineHostScope, ROUTINE_HOST_SCOPE_ID } from "../routineHostScope";
import { saveGeneratedImageUnder, writeConfinedNewFileUnder } from "../image/generatedImageSave";
import { hostIconSetsUnder } from "../image/iconSetRenderer";
import { createThreadImageAgentTools } from "../image/imageAgentTools";
import { createThreadVideoAgentTools } from "../video/videoAgentTools";
import type { NarrationForTurn } from "../speech/narrationTool";
import type { TranscriptionForTurn } from "../speech/transcriptionTool";
import { attachedImageSources, workspaceImageSources } from "../image/threadImageSourcePorts";
import { INHERITED_MARK_REFUSAL } from "../context/inheritedExternalContentMark";
import {
  createCodeProfileSkillResolver,
  createStoredCodeProfileSkillTextLoader,
} from "../code/codeProfileSkillResolver";
import { MAX_CODE_OPERATION_REPLAY_LIMIT } from "../code/codeOperationEventStore";
import { CodeThreadMetadataService } from "../code/codeThreadMetadataService";
import {
  boardRuntimeActivityFromWorks,
  type CodeBoardThread,
  CodeThreadBoardService,
} from "../code/codeThreadBoardService";
import { CodeFollowUpService } from "../code/codeFollowUpService";
import { FailingChecksFollowUps } from "../code/failingChecksFollowUps";
import { RepositoryTestProcessPort } from "../code/repositoryTestProcessPort";
import { TerminalProcessPort } from "../code/terminalProcessPort";
import { terminalShellFor } from "../code/terminalShell";
import type { CodeRouteService } from "../codeRoutes";
import { GitMutationPort } from "../code/gitMutationPort";
import { codeThreadTurns } from "../code/codeForkPoint";
import { seedCodeForkHarnessSession } from "../harness/nativeHarnessFork";
import {
  githubReadToolSetIfEffective,
  linearReadToolSetIfEffective,
} from "../github/githubIntegrationEffective";
import { TerminalBrowserGrantService } from "../code/terminalBrowserGrantService";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import {
  createCodeThreadMentionDirectory,
  threadMentionContextResolver,
  sideChatReturnContextResolver,
  ThreadMentionService,
} from "../chat/threadMentionService";
import { fileMentionContextBlocks, FileMentionService } from "../fileMentionService";
import {
  codeSiblingThreadSource,
  codeSiblingThreadState,
} from "../siblingThreads/codeSiblingThreadSource";
import { CoordinatorService } from "../coordinator/coordinatorService";
import { createCoordinatorThreadDoneEvaluator } from "../coordinator/coordinatorDoneWhenEvidence";
import type { ThreadWakeupModePort } from "../wakeups/threadWakeupService";
import { createCoordinatorWakeJournal } from "../coordinator/coordinatorWakeJournal";
import { createCoordinatorCountStore } from "../coordinator/coordinatorCountStore";
import { coordinatorCandidateFacts } from "../coordinator/coordinatorWorkerFacts";
import { describeTurnImages, type ImageDescriber } from "../harness/imageDescription";
import { lookToolForThread } from "../image/lookTool";
import { providerTakesFileNatively, supportsConversationInput } from "./conversationInputs";
import { modelLabelOf } from "./imageDescriber";
import { createThreadsTools } from "../siblingThreads/siblingThreadTools";
import {
  readShieldWatcherLabels,
  readThreadExternalContentTaint,
} from "../context/externalContentTaintProjection";
import { CodeTurnDecisions } from "../turnDecisions/codeTurnDecisions";
import { createSideTaskTools } from "../sideTasks/sideTaskTools";
import {
  createReportFinishedTool,
  observeFolderFinishedDiff,
} from "../finishedReceipts/finishedReceiptTools";
import { isReplayedAndroidEvidence } from "../android/androidToolchainService";
import {
  clampTurnAccessPosture,
  browserTransferLimits,
  defaultShellSettings,
  isNativeHarnessDriverKind,
  projectExtraFolderRoots,
} from "@octant/domain";
import { createCanvasAgentTools } from "../canvas/canvasAgentTools";
import { type CodeWiring, stableCodeFileId } from "./code";
import {
  makeConfiguredAccountSessionCarrier,
  makeConfiguredProviderDriver,
  type ProvidersWiring,
} from "./providers";
import type { ServerStart } from "./serverShape";
import type { HarnessWiring } from "./harness";
import type { AuthorityWiring } from "./authority";
import type { FoundationsWiring } from "./foundations";
import type { AgentRunsWiring } from "./agentRuns";
import type { IntegrationsWiring } from "./integrations";
import type { ComputerUseWiring } from "./computerUse";
import type { WorkspaceWiring } from "./workspace";
import type { WorkRequestStateWiring } from "./workRequestState";
import type { HarnessStateWiring } from "./harnessState";
import type { DevicesWiring } from "./devices";
import type { BrowserWiring } from "./browser";
import type { CanvasWiring } from "./canvas";
import { sessionNativeSetup } from "../providers/providerNativeSetup";
import {
  launchCredentialsKey,
  providerCredentialPassThrough,
} from "../providers/providerOwnChannels";
import { resolveProviderTerminal } from "../providers/providerTerminal";
import { homedir } from "node:os";
import {
  backgroundSessionIdleLimitMs,
  providerToolCallPauseLimitMs,
  stalledTurnLimitMs,
} from "../providers/turnBudget";
import { OutlivingSessions, type RuntimeTurnStarter } from "../providers/outlivingSessions";
import { createCodeSessionRouteHandler } from "../code/codeSessionRoutes";
import { codeSessionKey, codeSessionTerms } from "../code/codeOperationRuntime";
import { stopKeptSessionsOfChangedCodeThreads } from "../code/codeKeptSessions";

export function withCodeOperationRuntime(
  service: CodeRouteService,
  runtime: CodeOperationRuntime,
): CodeRouteService {
  const readEvidenceBatch = runtime.readEvidenceBatch?.bind(runtime);
  return {
    bootstrap: (windowId) => service.bootstrap(windowId),
    navigation: (windowId) => service.navigation(windowId),
    read: (windowId, threadId) => service.read(windowId, threadId),
    execute: (windowId, command, signal, context) =>
      service.execute(windowId, command, signal, context),
    executeOperation: (windowId, command, options) => runtime.execute(windowId, command, options),
    inspectTerminal: (windowId, input) => runtime.inspectTerminal(windowId, input),
    ...(runtime.readProviderFileReview === undefined
      ? {}
      : { readProviderFileReview: runtime.readProviderFileReview.bind(runtime) }),
    watchTerminal: (windowId, input) => runtime.watchTerminal(windowId, input),
    subscribe: (windowId, threadId, afterSequence, signal) =>
      service.subscribe(windowId, threadId, afterSequence, signal),
    subscribeOperation: async function* (windowId, threadId, operationId, afterCursor) {
      const frames = await runtime.subscribe(windowId, threadId, operationId, afterCursor, 100);
      yield* frames;
    },
    conversation: (windowId, threadId, afterCursor, limit) =>
      runtime.conversation(windowId, threadId, afterCursor, limit),
    conversationWindow: (windowId, threadId, request) =>
      runtime.conversationWindow(windowId, threadId, request),
    readContent: (windowId, contentId) => service.readContent(windowId, contentId),
    readOperationContent: (windowId, threadId, operationId, contentId, admissionCurrent) =>
      runtime.readEvidence(
        windowId,
        threadId,
        operationId,
        decodeCodeEvidenceContentId(contentId),
        admissionCurrent,
      ),
    ...(readEvidenceBatch === undefined
      ? {}
      : {
          readOperationContents: (windowId, input, admissionCurrent) =>
            readEvidenceBatch(windowId, input, admissionCurrent),
        }),
    saveFile: (windowId, input, actor) => service.saveFile(windowId, input, actor),
    openFile: (windowId, input) => service.openFile(windowId, input),
    ...(service.resolveDesktopFileTarget === undefined
      ? {}
      : { resolveDesktopFileTarget: service.resolveDesktopFileTarget.bind(service) }),
    ...(service.readGitHistory === undefined
      ? {}
      : { readGitHistory: service.readGitHistory.bind(service) }),
    ...(service.listFiles === undefined ? {} : { listFiles: service.listFiles.bind(service) }),
    ...(service.readFile === undefined ? {} : { readFile: service.readFile.bind(service) }),
    ...(service.listTests === undefined ? {} : { listTests: service.listTests.bind(service) }),
    readRepositoryTestStatus: (windowId, input) =>
      runtime.readRepositoryTestStatus(windowId, input.threadId, input.checkoutId),
    ...(service.watchFiles === undefined ? {} : { watchFiles: service.watchFiles.bind(service) }),
    ...(service.searchFiles === undefined
      ? {}
      : { searchFiles: service.searchFiles.bind(service) }),
    ...(service.searchTranscript === undefined
      ? {}
      : { searchTranscript: service.searchTranscript.bind(service) }),
    ...(service.listSearchableThreads === undefined
      ? {}
      : { listSearchableThreads: service.listSearchableThreads.bind(service) }),
    ...(service.stageEvidence === undefined
      ? {}
      : { stageEvidence: service.stageEvidence.bind(service) }),
    ...(service.stageAttachment === undefined
      ? {}
      : { stageAttachment: service.stageAttachment.bind(service) }),
    ...(service.readAttachment === undefined
      ? {}
      : { readAttachment: service.readAttachment.bind(service) }),
    ...(service.discardAttachment === undefined
      ? {}
      : { discardAttachment: service.discardAttachment.bind(service) }),
    ...(service.mergeProjectPullRequest === undefined
      ? {}
      : { mergeProjectPullRequest: service.mergeProjectPullRequest.bind(service) }),
  };
}

export function withCodeBoard(
  service: CodeRouteService,
  queryBoard: NonNullable<CodeRouteService["queryBoard"]>,
): CodeRouteService {
  return {
    bootstrap: (windowId) => service.bootstrap(windowId),
    navigation: (windowId) => service.navigation(windowId),
    read: (windowId, threadId) => service.read(windowId, threadId),
    execute: (windowId, command, signal, context) =>
      service.execute(windowId, command, signal, context),
    subscribe: (windowId, threadId, afterSequence, signal) =>
      service.subscribe(windowId, threadId, afterSequence, signal),
    readContent: (windowId, contentId) => service.readContent(windowId, contentId),
    saveFile: (windowId, input, actor) => service.saveFile(windowId, input, actor),
    openFile: (windowId, input) => service.openFile(windowId, input),
    ...(service.resolveDesktopFileTarget === undefined
      ? {}
      : { resolveDesktopFileTarget: service.resolveDesktopFileTarget.bind(service) }),
    ...(service.readGitHistory === undefined
      ? {}
      : { readGitHistory: service.readGitHistory.bind(service) }),
    ...(service.listFiles === undefined ? {} : { listFiles: service.listFiles.bind(service) }),
    ...(service.readFile === undefined ? {} : { readFile: service.readFile.bind(service) }),
    ...(service.listTests === undefined ? {} : { listTests: service.listTests.bind(service) }),
    ...(service.readRepositoryTestStatus === undefined
      ? {}
      : { readRepositoryTestStatus: service.readRepositoryTestStatus.bind(service) }),
    ...(service.watchFiles === undefined ? {} : { watchFiles: service.watchFiles.bind(service) }),
    ...(service.searchFiles === undefined
      ? {}
      : { searchFiles: service.searchFiles.bind(service) }),
    ...(service.searchTranscript === undefined
      ? {}
      : { searchTranscript: service.searchTranscript.bind(service) }),
    ...(service.listSearchableThreads === undefined
      ? {}
      : { listSearchableThreads: service.listSearchableThreads.bind(service) }),
    queryBoard,
    ...(service.executeOperation === undefined
      ? {}
      : { executeOperation: service.executeOperation.bind(service) }),
    ...(service.inspectTerminal === undefined
      ? {}
      : { inspectTerminal: service.inspectTerminal.bind(service) }),
    ...(service.watchTerminal === undefined
      ? {}
      : { watchTerminal: service.watchTerminal.bind(service) }),
    ...(service.subscribeOperation === undefined
      ? {}
      : { subscribeOperation: service.subscribeOperation.bind(service) }),
    ...(service.conversation === undefined
      ? {}
      : { conversation: service.conversation.bind(service) }),
    ...(service.conversationWindow === undefined
      ? {}
      : { conversationWindow: service.conversationWindow.bind(service) }),
    ...(service.readOperationContent === undefined
      ? {}
      : { readOperationContent: service.readOperationContent.bind(service) }),
    ...(service.readOperationContents === undefined
      ? {}
      : { readOperationContents: service.readOperationContents.bind(service) }),
    ...(service.stageEvidence === undefined
      ? {}
      : { stageEvidence: service.stageEvidence.bind(service) }),
    ...(service.stageAttachment === undefined
      ? {}
      : { stageAttachment: service.stageAttachment.bind(service) }),
    ...(service.readAttachment === undefined
      ? {}
      : { readAttachment: service.readAttachment.bind(service) }),
    ...(service.discardAttachment === undefined
      ? {}
      : { discardAttachment: service.discardAttachment.bind(service) }),
    ...(service.mergeProjectPullRequest === undefined
      ? {}
      : { mergeProjectPullRequest: service.mergeProjectPullRequest.bind(service) }),
  };
}

import {
  bindServerCodeTurn,
  serverCodeCheckoutRoot,
  serverProjectOf,
  serverThreadOf,
} from "../serverProjects/serverProjectThreads";
import type { GitService } from "../code/gitService";
import { createServerGitService } from "../serverProjects/serverGit";
import { transferServerAttachments } from "../serverProjects/serverAttachments";
import { serverTerminalLogin } from "../serverProjects/serverTerminal";
import { ServerCodeFiles } from "../serverProjects/serverCodeFiles";
import {
  createServerRepositoryTests,
  type ServerRepositoryTests,
} from "../serverProjects/serverTests";
import { serverPullRequestRepository } from "../serverProjects/serverWorktrees";
import { ServerRuntimeRecords } from "../serverProjects/serverRuntimeRecords";
import { privateListenerHostId } from "../remote/privateListenerHostIdentity";

export type CodeRuntimeDependencies = Pick<ServerStart, "options" | "persistence"> & {
  /** Sees images; absent on a host started without one. */
  readonly imageDescriber?: ImageDescriber;
  readonly narrationForTurn: NarrationForTurn;
  readonly transcriptionForTurn: TranscriptionForTurn;
} & Pick<
    HarnessStateWiring,
    "serverAttachmentCleanup" | "serverConnection" | "serverProjectStore"
  > &
  Pick<HarnessWiring, "shieldServerStore"> &
  Pick<
    AuthorityWiring,
    | "isPairedDeviceSessionCurrent"
    | "browserCaptures"
    | "browserModelBindings"
    | "agentRunPersistence"
    | "androidInputGrants"
    | "codeActiveTurns"
    | "codeApprovalStore"
    | "codeSessionAuthority"
    | "imageGenerationOffers"
    | "videoOffers"
    | "liveTurns"
    | "machineChangeFeed"
    | "onThreadArchived"
    | "onWindowRevoked"
    | "simulatorInputGrants"
    | "personMemoryAccess"
    | "octantInstructions"
    | "isPairedDeviceScope"
    | "isRestrictedDeviceScope"
    | "windowAuthorityStore"
  > &
  Pick<
    AgentRunsWiring,
    | "hostResourceBudget"
    | "agentsManagedToolsFor"
    | "coordinatorWorkersHolder"
    | "externalContentIngestionStore"
    | "managedWorktreeReceipts"
    | "nativeHarnessRoutingStore"
    | "runtimeOutsideContentMarks"
    | "sideTasks"
    | "finishedReceipts"
    | "spendCeiling"
    | "threadAwaitsHarnessApproval"
    | "turnMetrics"
  > &
  Pick<
    IntegrationsWiring,
    | "agentMessageService"
    | "consumeCreateFromIssueFramed"
    | "githubExtensionSnapshot"
    | "githubReadToolService"
    | "linearReadToolService"
    | "peekCreateFromIssueFramed"
    | "siblingThreadsService"
    | "threadOutsideContentMarks"
  > &
  Pick<ComputerUseWiring, "computerToolsFor" | "computerUseTools" | "threadDesktopDestination"> &
  Pick<
    WorkspaceWiring,
    | "codeBoardPlanProgressSource"
    | "contextHarness"
    | "gitObservationPort"
    | "goalService"
    | "keptImageChoices"
    | "keptVideoChoices"
    | "projectService"
  > &
  Pick<WorkRequestStateWiring, "workRequestRuntime"> &
  Pick<HarnessStateWiring, "onHarnessQuestionAsked" | "onHarnessQuestionSettled"> &
  Pick<
    DevicesWiring,
    | "androidToolchainService"
    | "appleToolchainService"
    | "bindDeviceApprovals"
    | "recordAppleEvidence"
  > &
  Pick<
    CodeWiring,
    | "buildCodeService"
    | "canAccessCodeProject"
    | "codeAttachments"
    | "codeProjectAccess"
    | "codeTestDiscovery"
    | "isCodeProviderModelAllowed"
    | "onPullRequestSnapshotRefreshed"
    | "bindPullRequestSwitchReconciler"
    | "pullRequestLinkService"
    | "projectPullRequestActionService"
    | "projectPullRequestCadence"
    | "projectPullRequestService"
    | "roots"
  > &
  Pick<
    ProvidersWiring,
    | "codeThreadDrivers"
    | "configuredDriverOptions"
    | "extensionApiService"
    | "extensionPackageStore"
    | "imageJobService"
    | "videoJobService"
    | "nativeHarnessTranscripts"
    | "probeProviderForThreads"
    | "providerAvailabilityMarks"
    | "providerUsageLimitsService"
    | "providerDataDirectory"
    | "verifyModelToolsOnFirstUse"
    | "resolveSelectedExtensions"
    | "pinnedExtensionIds"
    | "worktreePreparation"
  > &
  Pick<
    BrowserWiring,
    | "bindTerminalBrowserSessions"
    | "terminalBrowserTools"
    | "routineBrowserTools"
    | "browserAutomationService"
    | "browserFlows"
    | "browserToolApprovalService"
    | "productFeedbackService"
    | "resolveFeedbackThread"
  > &
  Pick<CanvasWiring, "canvasAgentToolPort" | "threadProjectAssetRoot"> &
  Pick<
    HarnessWiring,
    | "hostShield"
    | "nativeHarnessComposition"
    | "nativeHarnessHooks"
    | "onHarnessRecoveryLifted"
    | "runtimeForgeChanges"
  > & {
    /** Wired by wireChat; read only after startup. */
    readonly codeThreadMentionDirectory: () => ReturnType<typeof createCodeThreadMentionDirectory>;
    /** Wired by wireWork; read only after startup. */
    readonly fileMentionService: () => FileMentionService;
    /** Wired by wireChat; read only after startup. */
    readonly threadMentionService: () => ThreadMentionService;
  } & Pick<
    FoundationsWiring,
    | "conversationInputTransfer"
    | "browserAuthority"
    | "codeBoardEventStore"
    | "codeEvidence"
    | "isProjectPolicyTargetAllowed"
    | "providerRuntimeRegistry"
    | "selectCodeConversation"
    | "codeSessionConversation"
    | "threadWakeups"
    | "resolveThreadStrict"
  > & {
    /** Threads a move holds: frozen here while leaving, or arriving and not yet committed. */
    readonly threadMoveHolds: ThreadMoveHolds;
  };

export function wireCodeRuntime(deps: CodeRuntimeDependencies) {
  const designSystemFiles = new DesignSystemFiles();
  const imageDescriber = deps.imageDescriber;
  const {
    threadWakeups,
    resolveThreadStrict,
    conversationInputTransfer,
    threadAwaitsHarnessApproval,
    agentMessageService,
    agentRunPersistence,
    agentsManagedToolsFor,
    coordinatorWorkersHolder,
    androidInputGrants,
    androidToolchainService,
    appleToolchainService,
    bindDeviceApprovals,
    browserAuthority,
    browserCaptures,
    browserModelBindings,
    bindTerminalBrowserSessions,
    terminalBrowserTools,
    routineBrowserTools,
    browserAutomationService,
    browserFlows,
    browserToolApprovalService,
    buildCodeService,
    canAccessCodeProject,
    canvasAgentToolPort,
    threadProjectAssetRoot,
    codeActiveTurns,
    codeApprovalStore,
    codeAttachments,
    codeBoardEventStore,
    codeBoardPlanProgressSource,
    codeEvidence,
    codeProjectAccess,
    codeSessionAuthority,
    codeTestDiscovery,
    codeThreadDrivers,
    codeThreadMentionDirectory,
    computerToolsFor,
    computerUseTools,
    threadDesktopDestination,
    configuredDriverOptions,
    consumeCreateFromIssueFramed,
    contextHarness,
    extensionApiService,
    extensionPackageStore,
    externalContentIngestionStore,
    fileMentionService,
    githubExtensionSnapshot,
    githubReadToolService,
    linearReadToolService,
    isCodeProviderModelAllowed,
    liveTurns,
    machineChangeFeed,
    hostShield,
    imageGenerationOffers,
    videoOffers,
    imageJobService,
    videoJobService,
    runtimeForgeChanges,
    nativeHarnessComposition,
    nativeHarnessHooks,
    onHarnessQuestionAsked,
    onHarnessQuestionSettled,
    onHarnessRecoveryLifted,
    onPullRequestSnapshotRefreshed,
    bindPullRequestSwitchReconciler,
    pullRequestLinkService,
    onThreadArchived,
    onWindowRevoked,
    nativeHarnessTranscripts,
    options,
    peekCreateFromIssueFramed,
    persistence,
    probeProviderForThreads,
    productFeedbackService,
    resolveFeedbackThread,
    projectPullRequestActionService,
    projectPullRequestCadence,
    projectPullRequestService,
    keptImageChoices,
    keptVideoChoices,
    projectService,
    providerDataDirectory,
    providerRuntimeRegistry,
    recordAppleEvidence,
    resolveSelectedExtensions,
    pinnedExtensionIds,
    worktreePreparation,
    roots,
    runtimeOutsideContentMarks,
    selectCodeConversation,
    codeSessionConversation,
    siblingThreadsService,
    serverAttachmentCleanup,
    serverConnection,
    serverProjectStore,
    shieldServerStore,
    sideTasks,
    finishedReceipts,
    gitObservationPort,
    goalService,
    simulatorInputGrants,
    spendCeiling,
    turnMetrics,
    threadMentionService,
    threadOutsideContentMarks,
    workRequestRuntime,
    personMemoryAccess,
    octantInstructions,
  } = deps;
  return Effect.gen(function* () {
    // The coordinator service is wired after the Code runtime that reports
    // stopped turns to it; a stop before then has no worker to move.
    const continueWorkerOnFallback: {
      current?: (
        threadId: CodeThreadId,
        availability: "usage-limit" | "down" | undefined,
        stopped: CodeStoppedTurn,
      ) => Promise<unknown>;
    } = {};
    // A host started with its own runtime uses it; otherwise it is built below.
    let codeOperationRuntime: CodeOperationRuntime | undefined = options.codeOperationRuntime;
    // Built after the operation runtime is: its checkout refresh callback
    // reads the service lazily, and a switch before it exists observes later.
    let builtCodeService: CodeService | undefined;
    // A Code session whose runtime keeps background work (a dev server, a
    // watch) outlives its turn; a turn the runtime starts by itself later is
    // opened through the thread's ordinary admission, below.
    let startCodeRuntimeTurn: RuntimeTurnStarter = () =>
      Promise.resolve({ status: "refused", message: "Code turns are unavailable on this host." });
    const runtimeStartedCodeTurns = new Set<string>();
    const outlivingCodeSessions = new OutlivingSessions({
      idleLimitMs: () =>
        backgroundSessionIdleLimitMs(
          persistence.readShellSettings()?.settings ?? defaultShellSettings(),
        ),
      startRuntimeTurn: (key) => startCodeRuntimeTurn(key),
      currentTerms: (key) => {
        if (!key.startsWith("code:")) return undefined;
        try {
          const thread = persistence.readCodeThread(decodeCodeThreadId(key.slice("code:".length)));
          return thread === undefined
            ? undefined
            : codeSessionTerms(thread, persistence.readProject(thread.projectId));
        } catch {
          return undefined;
        }
      },
      launchCredentials: (key, posture) => {
        let driverKind: string | undefined;
        try {
          const thread = persistence.readCodeThread(decodeCodeThreadId(key.slice("code:".length)));
          driverKind =
            thread === undefined
              ? undefined
              : persistence.readProviderInstance(thread.providerInstanceId)?.driverKind;
        } catch {
          driverKind = undefined;
        }
        return launchCredentialsKey(persistence.readShellSettings()?.settings, driverKind, posture);
      },
      onChanged: () => machineChangeFeed.publish(["thread-follow-ups"]),
      onError: (message, error) => console.error(`[live tasks] ${message}`, error),
    });
    // Every change to a Code thread or its Project passes through the journal
    // (a level or model change, a checkout rebind, an archive, a move, a
    // deletion; the Project's relink, archive or extra folders), so a kept
    // session started on terms the thread no longer has is stopped here
    // rather than from each command's path. Both projections are applied
    // inside the append, so they already hold the change.
    const unsubscribeKeptSessionTerms = persistence.journal.subscribeCommitted((append) => {
      void stopKeptSessionsOfChangedCodeThreads(append, {
        keeper: outlivingCodeSessions,
        readThread: (threadId) => persistence.readCodeThread(threadId),
        readProject: (projectId) => persistence.readProject(projectId),
      }).catch((error: unknown) =>
        console.error("[live tasks] A changed thread's session did not stop.", error),
      );
      if (append.events.some((event) => event.eventName === "shell.settings-replaced")) {
        void outlivingCodeSessions
          .stopSessionsWithChangedCredentials()
          .catch((error: unknown) =>
            console.error("[live tasks] A session with changed credentials did not stop.", error),
          );
      }
    });
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        unsubscribeKeptSessionTerms();
        await outlivingCodeSessions.close();
      }),
    );
    let pullRequestWatchService: PullRequestWatchPort | undefined;
    // Areas built after this one add tools to a Code turn here, as they do to
    // a Chat thread, so the runtime never holds the services behind them.
    const codeToolContributors: Array<
      NonNullable<CodeOperationRuntimeOptions["contributedTools"]>
    > = [];
    const contributeCodeTools = (
      contributor: NonNullable<CodeOperationRuntimeOptions["contributedTools"]>,
    ): void => {
      codeToolContributors.push(contributor);
    };
    let codeEditDiagnosticsFactory:
      | ((input: {
          readonly windowId: WindowId;
          readonly thread: CodeThread;
          readonly harnessRoot: string;
          readonly mainCheckoutRoot: string;
        }) => NativeHarnessEditDiagnosticsPort | undefined)
      | undefined;
    const registerCodeEditDiagnostics = (
      factory: (input: {
        readonly windowId: WindowId;
        readonly thread: CodeThread;
        readonly harnessRoot: string;
        readonly mainCheckoutRoot: string;
      }) => NativeHarnessEditDiagnosticsPort | undefined,
    ): void => {
      codeEditDiagnosticsFactory = factory;
    };
    // The few sets a server Project's turn is offered beside its server
    // tools: each acts only on this host's records, never on a folder here.
    const serverCodeToolContributors: Array<
      NonNullable<CodeOperationRuntimeOptions["serverTurnTools"]>
    > = [];
    const contributeServerCodeTools = (
      contributor: NonNullable<CodeOperationRuntimeOptions["serverTurnTools"]>,
    ): void => {
      serverCodeToolContributors.push(contributor);
    };
    // A routine's turn has nobody at a window to answer the image card, so it
    // is offered the tool only where its Project keeps a choice.
    contributeCodeTools(({ windowId, thread, readThread, folders, routineRun }) => {
      const checkoutRoot = folders[0];
      // The journaled level and the running one are both read and the
      // stricter wins, as for the save below.
      const level = () =>
        clampTurnAccessPosture({
          requested: readThread()?.executionPolicy ?? thread.executionPolicy,
          thread: persistence.readCodeThread(thread.id)?.executionPolicy ?? thread.executionPolicy,
        });
      const pinnedCheckout =
        checkoutRoot === undefined
          ? undefined
          : threadWorkingDirectoryCurrent(checkoutRoot, checkoutRoot);
      const currentRoot = () =>
        resolveCurrentCodeTurnRoot({
          thread,
          checkoutRoot,
          pinnedCheckout,
          readCodeThread: (id) => persistence.readCodeThread(id),
          readProject: (id) => persistence.readProject(id),
          threadProjectAssetRoot,
        });
      const speechTurnAllowed = () =>
        readThread()?.lifecycle === "active" &&
        (deps.isPairedDeviceScope(windowId)
          ? !deps.isRestrictedDeviceScope(windowId) &&
            codeProjectAccess.hasActiveCodeProject(thread.projectId)
          : deps.windowAuthorityStore.listWindowIds().includes(windowId) &&
            canAccessCodeProject(windowId, thread.projectId));
      const speechAttended =
        routineRun === undefined &&
        !isRoutineHostScope(windowId) &&
        !deps.isRestrictedDeviceScope(windowId) &&
        checkoutRoot !== undefined;
      const savePosture = () => {
        if (thread.executionPolicy === "plan") return "refuse" as const;
        const current = level();
        return current === "plan"
          ? ("refuse" as const)
          : current === "approval-gated"
            ? ("ask" as const)
            : ("allow" as const);
      };
      const transcription = !speechAttended
        ? undefined
        : deps.transcriptionForTurn({
            windowId,
            threadKind: "code-thread",
            scopeId: decodeImageGenerationScopeId(String(thread.id)),
            toolConstraints: () => readThread()?.toolConstraints ?? thread.toolConstraints ?? [],
            inPlan: () => thread.executionPolicy === "plan" || level() === "plan",
            root: currentRoot,
            allowed: speechTurnAllowed,
          });
      const narration = !speechAttended
        ? undefined
        : deps.narrationForTurn({
            windowId,
            threadKind: "code-thread",
            scopeId: decodeImageGenerationScopeId(String(thread.id)),
            toolConstraints: () => readThread()?.toolConstraints ?? thread.toolConstraints ?? [],
            posture: savePosture,
            root: currentRoot,
            allowed: speechTurnAllowed,
          });
      const codeImageSources = {
        latestAttachments: () =>
          codeAttachments === undefined
            ? []
            : attachedImageSources(
                codeBoardEventStore.latestPersonTurnAttachments(thread.id),
                (attachment) => codeAttachments.read(thread.id, attachment),
              ),
        ...workspaceImageSources({
          threadId: decodeBrowserThreadId(String(thread.id)),
          browserCaptures,
          root: currentRoot,
        }),
      };
      const savePostureForMedia = (): "refuse" | "ask" | "allow" => {
        const current = level();
        return current === "plan" ? "refuse" : current === "approval-gated" ? "ask" : "allow";
      };
      const images = createThreadImageAgentTools({
        windowId,
        unattended: isRoutineHostScope(windowId),
        threadKind: "code-thread",
        scopeId: decodeImageGenerationScopeId(String(thread.id)),
        offers: imageGenerationOffers,
        kept: keptImageChoices,
        fullAccess: () => level() === "full-access",
        jobs: imageJobService,
        imageSources: codeImageSources,
        listInstances: () => persistence.readProviderInstances(),
        readImageGenerationCustomSources: () =>
          (persistence.readShellSettings()?.settings ?? defaultShellSettings()).imageGeneration
            .customSources,
        defaultProfileInstanceId: () =>
          (persistence.readShellSettings()?.settings ?? defaultShellSettings()).imageGeneration
            .defaultProfileInstanceId,
        readsImages: () =>
          providerRuntimeRegistry
            .observedState(thread.providerInstanceId)
            ?.models.find((candidate) => String(candidate.id) === String(thread.modelId))
            ?.inputModalities.includes("image") === true,
        // A file edit at the turn's level, under the checkout the turn
        // works in. The stricter of the journaled and running postures
        // decides, so a session-only grant never lets this write through
        // without asking.
        ...(checkoutRoot === undefined
          ? {}
          : {
              save: {
                posture: savePostureForMedia,
                write: (relativePath: string, bytes: Uint8Array) =>
                  saveGeneratedImageUnder({ root: checkoutRoot, relativePath, bytes }),
              },
              ...hostIconSetsUnder(checkoutRoot, persistence.dataDirectory),
            }),
        // Plan changes nothing on the host or outside it, and a generation
        // calls a paid provider and stores the image.
        refusal: () =>
          (readThread()?.executionPolicy ?? thread.executionPolicy) === "plan"
            ? "Plan mode cannot generate images. Leave Plan mode to generate one."
            : undefined,
      });
      // Video follows the image rules: the same kept choice per Project, the
      // same Full access rule and the same save at the turn's level.
      const videos = createThreadVideoAgentTools({
        windowId,
        unattended: isRoutineHostScope(windowId),
        threadKind: "code-thread",
        scopeId: decodeImageGenerationScopeId(String(thread.id)),
        offers: videoOffers,
        kept: keptVideoChoices,
        fullAccess: () => level() === "full-access",
        jobs: videoJobService,
        recordExternalContentIngestion: (input) => externalContentIngestionStore.record(input),
        defaultProfileInstanceId: () =>
          (persistence.readShellSettings()?.settings ?? defaultShellSettings()).videoGeneration
            .defaultProfileInstanceId,
        imageSources: codeImageSources,
        imageJobs: imageJobService,
        ...(checkoutRoot === undefined
          ? {}
          : {
              save: {
                posture: savePostureForMedia,
                write: (relativePath: string, bytes: Uint8Array) =>
                  writeConfinedNewFileUnder({ root: checkoutRoot, relativePath, bytes }),
              },
            }),
        refusal: () =>
          (readThread()?.executionPolicy ?? thread.executionPolicy) === "plan"
            ? "Plan mode cannot make video clips. Leave Plan mode to make one."
            : undefined,
      });
      return combineAppManagedToolSets(images, videos, narration, transcription);
    });
    // Sees images: a thread whose model cannot read images may ask for one
    // to be described, from its own attachments or its own folder.
    contributeCodeTools(({ thread, folders }) => {
      const describer = imageDescriber;
      if (describer === undefined) return undefined;
      return lookToolForThread({
        describer,
        threadId: String(thread.id),
        threadType: "code-thread",
        projectId: thread.projectId,
        threadModel: modelLabelOf(
          { persistence, providerRuntimeRegistry },
          thread.providerInstanceId,
          thread.modelId,
        ),
        // The same test an attached image meets, so a thread that cannot
        // take an image from Octant can always ask for one to be described.
        readsImages: supportsConversationInput(
          providerRuntimeRegistry.observedState(thread.providerInstanceId),
          String(thread.modelId),
          "image/png",
        ),
        attachment: async (attachmentId) => {
          const reference = codeBoardEventStore.turnAttachmentOfThread(thread.id, attachmentId);
          if (reference === undefined || codeAttachments === undefined) return undefined;
          const bytes = await codeAttachments.read(thread.id, reference);
          return { name: reference.displayName, mediaType: reference.mediaType, bytes };
        },
        folder: folders[0],
        recordExternalContentIngestion: (input) => externalContentIngestionStore.record(input),
        uuid: randomUUID,
      });
    });
    contributeCodeTools(({ windowId, thread }) =>
      personMemoryAccess.toolsFor({
        mode: "code",
        threadId: String(thread.id),
        projectId: String(thread.projectId),
        createdAt: thread.createdAt,
        windowId,
      }),
    );
    contributeCodeTools(({ windowId, thread, readThread, folders, operationId, askPerson }) => {
      const readPosture = () =>
        clampTurnAccessPosture({
          requested: readThread()?.executionPolicy ?? thread.executionPolicy,
          thread: persistence.readCodeThread(thread.id)?.executionPolicy ?? thread.executionPolicy,
        });
      const folder = folders[0];
      const shell = nativeHarnessComposition.shellForCode({
        windowId: String(windowId),
        threadId: String(thread.id),
        projectId: String(thread.projectId),
      });
      return createReportFinishedTool({
        mode: "code",
        threadId: String(thread.id),
        projectId: String(thread.projectId),
        ...(operationId === undefined ? {} : { turnId: operationId }),
        readPosture,
        toolConstraints: thread.toolConstraints,
        profileDisplayName: thread.profileDisplayName,
        ...(folder === undefined ? {} : { folder }),
        ...(folders.length > 1 ? { extraFolders: folders.slice(1) } : {}),
        ...(shell === undefined ? {} : { shell }),
        askPerson,
        readGoal: () => goalService.read(String(thread.id)).goal ?? undefined,
        observeDiff: (signal) =>
          observeFolderFinishedDiff({ folder, git: gitObservationPort, signal }),
        store: finishedReceipts,
        uuid: randomUUID,
        clock: () => new Date().toISOString(),
      });
    });
    const {
      androidToolchainRoutes,
      appleToolchainRoutes,
      resolveAndroidContext,
      resolveAppleContext,
    } = bindDeviceApprovals({
      validateAppleApproval: (windowId, request) =>
        codeOperationRuntime?.validateAppleApproval(windowId, request),
      validateAndroidApproval: (windowId, request) =>
        codeOperationRuntime?.validateAndroidApproval(windowId, request),
    });
    let terminalProcessPort: TerminalProcessPort | undefined;
    if (codeOperationRuntime === undefined && options.codeService === undefined) {
      terminalProcessPort = new TerminalProcessPort({
        receiptDirectory: join(providerDataDirectory, "code", "terminal-receipts"),
        shellStateDirectory: join(providerDataDirectory, "code", "terminal-shell"),
      });
      const repositoryTestProcessPort = new RepositoryTestProcessPort({
        resourceBudget: deps.hostResourceBudget,
        receiptDirectory: join(providerDataDirectory, "code", "test-receipts"),
      });
      // A scaffold generator downloads what it writes, so it gets its own
      // private work directory and is pointed at it for every package cache.
      // Nothing it fetches lands in the user's own caches, and the confinement
      // still writes only the checkout and this directory.
      const scaffoldWorkDirectory = join(providerDataDirectory, "code", "scaffold-work");
      const scaffoldProcessPort = new RepositoryTestProcessPort({
        resourceBudget: deps.hostResourceBudget,
        receiptDirectory: join(providerDataDirectory, "code", "scaffold-receipts"),
        temporaryDirectory: scaffoldWorkDirectory,
      });
      const rootProbePath = decodeCodeRelativePath("package.json");
      // A confined commit cannot read the user's global gitconfig, so the
      // host's own profile is the identity a checkout without local config
      // falls back to. Read it per call: the profile is editable while the
      // server runs, and a restart is too high a price for a name.
      const serverGitServices = new Map<string, GitService>();
      const serverTestServices = new Map<string, ServerRepositoryTests>();
      // A run whose host id cannot be read still records its programs, under
      // a tag of its own: its sweeps then reach only what this run started.
      const unnamedRunHostId = randomUUID();
      const serverRuntimeRecords = new ServerRuntimeRecords({
        connection: serverConnection,
        hostId: () => {
          try {
            return String(
              privateListenerHostId({
                connection: persistence.connection,
                dataDirectory: persistence.dataDirectory,
                identityFiles: options.serverIdentityFiles,
              }),
            );
          } catch {
            return unnamedRunHostId;
          }
        },
      });
      const gitMutationPort = new GitMutationPort(undefined, {
        commitIdentity: () => {
          const profile = persistence.readShellSettings()?.settings.userProfile;
          // The profile's fields are independent: a name without an address
          // still completes a checkout that has an address but no name. The
          // port merges per field and refuses only when the combination
          // cannot name an author at all.
          return {
            ...(profile?.displayName === undefined ? {} : { name: profile.displayName }),
            ...(profile?.email === undefined ? {} : { email: profile.email }),
          };
        },
      });
      // A grant lets a provider CLI the person types into one thread terminal
      // drive that thread's Browser. It is served from this host's memory only,
      // through the same Browser, approval, and authority services a managed
      // turn uses, and the terminal's own running state is read live.
      const grants = new TerminalBrowserGrantService({
        readThread: persistence.readCodeThread,
        canAccessProject: canAccessCodeProject,
        delegatedBrowserTools: terminalBrowserTools,
        terminalIsRunning: (terminalId) => {
          try {
            return codeOperationRuntime?.terminals?.attach(String(terminalId)).status === "running";
          } catch {
            return false;
          }
        },
        browser: {
          resolveAuthority: (threadId, mode) => browserAuthority.resolve(threadId, mode),
          automation: {
            inspectThread: (windowId, threadId) =>
              browserAutomationService.inspectThread(windowId, threadId),
            create: (input) => browserAutomationService.create(input),
            act: (input) => browserAutomationService.act(input),
            releaseThread: (windowId, threadId) =>
              browserAutomationService.releaseThread(windowId, threadId),
            holdForAsk: (windowId, threadId) =>
              browserAutomationService.holdForAsk(windowId, threadId),
          },
          approvals: browserToolApprovalService,
        },
        ...(options.terminalLauncher === undefined ? {} : { launcher: options.terminalLauncher }),
        journal: persistence.journal,
        personActor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
        hostActor: { kind: "system", actorId: OCTANT_LOCAL_ACTOR_ID },
        uuid: randomUUID,
        clock: () => new Date().toISOString(),
      });
      const unbindTerminalSessions = bindTerminalBrowserSessions({
        current: (grantId) => grants.currentSessionTarget(grantId),
        targets: () => grants.sessionTargets(),
      });
      yield* Effect.addFinalizer(() => Effect.sync(unbindTerminalSessions));
      onWindowRevoked((windowId) => grants.revokeWindow(windowId));
      onWindowRevoked((windowId) => codeOperationRuntime?.revokeTerminalStreams(windowId));
      onThreadArchived((threadId) => codeOperationRuntime?.withdrawThreadAsks?.(threadId));
      const unsubscribeTerminalBrowserGrants = persistence.journal.subscribeCommitted((append) => {
        for (const event of append.events) {
          if (
            event.eventName === "code.thread-updated@1" &&
            event.aggregateType === "code-thread"
          ) {
            // An archive or completion ends the grants a thread holds at once;
            // the next call would find it too, but the record should not wait.
            const thread = persistence.readCodeThread(decodeCodeThreadId(event.aggregateId));
            if (thread?.lifecycle !== "active") {
              grants.threadSettled(event.aggregateId, "thread-archived");
            } else if (thread.completedAt !== undefined) {
              grants.threadSettled(event.aggregateId, "thread-completed");
            }
          } else if (event.eventName === THREAD_RETENTION_EVENT_NAMES.threadPurged) {
            const purged = event.payload as {
              readonly mode?: unknown;
              readonly threadId?: unknown;
            };
            if (purged.mode === "code" && typeof purged.threadId === "string") {
              grants.threadSettled(purged.threadId, "thread-deleted");
            }
          }
        }
      });
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          unsubscribeTerminalBrowserGrants();
          await grants.close();
        }),
      );
      codeOperationRuntime = createCodeOperationRuntime({
        pullRequestLinks: pullRequestLinkService,
        stalledTurnLimitMs: (turn) =>
          stalledTurnLimitMs(
            persistence.readShellSettings()?.settings ?? defaultShellSettings(),
            turn,
          ),
        toolStepLimit: (fullAccess) =>
          threadToolStepLimit({
            fullAccess,
            settings: persistence.readShellSettings()?.settings ?? defaultShellSettings(),
          }),
        providerToolCallPauseLimitMs: () =>
          providerToolCallPauseLimitMs(
            persistence.readShellSettings()?.settings ?? defaultShellSettings(),
          ),
        moveHold: (threadId) => deps.threadMoveHolds.isHeld({ mode: "code", threadId }),
        // A branch switch moves the checkout's journaled head; the service
        // exists only after this runtime does, so the callback reads it lazily.
        checkoutObserved: async (checkoutId, head) => {
          const service = builtCodeService;
          if (service instanceof CodeService) service.noteCheckoutHead(checkoutId, head);
          // The only caller is a completed branch switch: a managed worktree
          // records the verified branch the host just landed it on so cleanup
          // still recognises the worktree it owns. Its `branchIntent` — the
          // branch the receipt may delete — never moves with it.
          if (head.kind === "branch") {
            const checkout = persistence.readCodeCheckout(checkoutId);
            if (checkout?.kind === "managed-worktree") {
              await deps.managedWorktreeReceipts.recordVerifiedBranch(
                String(checkout.ownershipReceiptId),
                head.name,
                head.oid,
              );
            }
          }
        },
        verifyModelToolsOnFirstUse: deps.verifyModelToolsOnFirstUse,
        prepareWorktree: async (thread, root, current) => {
          const checkout = persistence.readCodeCheckout(thread.checkoutId);
          if (checkout?.kind !== "managed-worktree") return undefined;
          const context = await worktreePreparation.context({
            receiptId: String(checkout.ownershipReceiptId),
            threadId: String(thread.id),
            checkoutId: String(checkout.id),
            projectId: String(thread.projectId),
            root,
            executionPolicy: thread.executionPolicy,
            current: () =>
              current() && persistence.readCodeThread(thread.id)?.lifecycle === "active",
          });
          return context === undefined
            ? "Worktree setup ownership is unavailable."
            : worktreePreparation.ensure(context);
        },
        conversationInputTransfer,
        shield: hostShield,
        octantInstructionBlocks: ({ thread, orchestrates }) =>
          octantInstructions.contextBlocks({ projectId: String(thread.projectId), orchestrates }),
        personMemoryBlock: ({ thread, windowId }) =>
          personMemoryAccess.blockFor({
            mode: "code",
            threadId: String(thread.id),
            projectId: String(thread.projectId),
            createdAt: thread.createdAt,
            windowId,
          }),
        projectMemoryEntries: (thread) =>
          persistence.readProjectMemory(thread.projectId).active.map((entry) => entry.content),
        designSystemContext: ({ thread, root, extraFolders }) => {
          const project = persistence.readProject(thread.projectId);
          const choice = project?.type === "chat" ? undefined : project?.designSystem;
          // A choice names a file under the Project's own folder; a worktree
          // holds the same path under its own root.
          const worktreeChoice =
            choice?.kind === "file" &&
            project?.type !== "chat" &&
            choice.folder === project?.binding.canonicalRoot
              ? { ...choice, folder: root }
              : choice;
          return designSystemTurnContext(designSystemFiles, {
            main: root,
            extra: extraFolders,
            projectName: project?.name ?? "",
            ...(worktreeChoice === undefined ? {} : { choice: worktreeChoice }),
          });
        },
        chosenAutoReviewer: (thread) => {
          const project = persistence.readProject(thread.projectId);
          return chosenAutoReviewer({
            project: project?.type === "code" ? project : undefined,
            settings: persistence.readCodeSettings()?.settings,
          });
        },
        liveTurns,
        activeTurns: codeActiveTurns,
        terminalBrowserGrants: grants,
        providerTerminal: ({ thread, shell, strict }) =>
          resolveProviderTerminal({
            instance: persistence.readProviderInstance(thread.providerInstanceId),
            hostEnvironment: process.env,
            homeDirectory: homedir(),
            credentialPassThrough: (driverKind) =>
              providerCredentialPassThrough(persistence.readShellSettings()?.settings, driverKind),
            platform: process.platform,
            shell,
            strict,
            mode: "code",
            executionPolicy: thread.executionPolicy,
            fullAccessSandbox: thread.fullAccessSandbox,
            ...(configuredDriverOptions.acpHome === undefined
              ? {}
              : { acpHome: configuredDriverOptions.acpHome }),
          }),
        onPendingRequestWithdrawn: () => machineChangeFeed.publish(["code-navigation"]),
        gitMutationPort,
        agentRuns: agentRunPersistence,
        resolveSelectedExtensions,
        pinnedExtensionIds,
        threadDesktopDestination,
        computerUseTools: ({ windowId, thread, destination, ask }) =>
          computerToolsFor(
            decodeComputerUseOwner({
              windowId,
              threadId: thread.id,
              mode: "code",
              providerInstanceId: thread.providerInstanceId,
              modelId: thread.modelId,
              executionPolicy: thread.executionPolicy,
              ...(destination === undefined ? {} : { leaseId: destination.leaseId }),
            }),
            ask,
            appToolThreadLevel(thread),
          ),
        spendCeiling,
        terminalProcessPort,
        repositoryTestProcessPort,
        scaffoldProcess: {
          execute: (input, signal) => scaffoldProcessPort.execute(input, signal),
          environment: {
            BUN_INSTALL_CACHE_DIR: join(scaffoldWorkDirectory, "bun-cache"),
            npm_config_cache: join(scaffoldWorkDirectory, "npm-cache"),
            TMPDIR: scaffoldWorkDirectory,
          },
        },
        repositoryTestDiscovery: codeTestDiscovery,
        attachments: codeAttachments,
        persistence: {
          journal: persistence.journal,
          readCodeThread: persistence.readCodeThread,
          readCodeCheckout: persistence.readCodeCheckout,
          readCodeRuntimeWorkAggregateVersion: persistence.readCodeRuntimeWorkAggregateVersion,
          readCodeRuntimeWorks: persistence.readCodeRuntimeWorks,
          readCodeThreadsWithUnconfirmedRemoteSteps:
            persistence.readCodeThreadsWithUnconfirmedRemoteSteps,
          readReviewFinding: persistence.readCodeReviewFinding,
          readReviewFindings: persistence.readCodeReviewFindings,
        },
        probeProvider: (instanceId) => probeProviderForThreads(instanceId),
        isProviderModelAllowed: (thread) =>
          isCodeProviderModelAllowed({
            projectId: thread.projectId,
            providerInstanceId: thread.providerInstanceId,
            modelId: thread.modelId,
          }),
        windowAccess: {
          canAccessProject: canAccessCodeProject,
          currentProjectAccess: (windowId, projectId) =>
            codeProjectAccess.standingAuthority(projectId, () =>
              canAccessCodeProject(windowId, projectId),
            ),
          standingAuthority: (turnProjectId, run) =>
            codeProjectAccess.standingAuthority(turnProjectId, run),
          retainProjectAccess: (windowId) => codeProjectAccess.retain(windowId),
        },
        resolveCheckoutRoot: async (windowId, thread, checkout, signal) => {
          // A remote root names a folder on another machine, never one here:
          // a server Project's is named, never resolved, and only the turn's
          // server tools act on it. Any other remote root resolves nothing.
          if (checkout.kind === "remote-root")
            return serverCodeCheckoutRoot(serverProjectStore, thread);
          const root = await roots.resolve(windowId, thread, checkout, rootProbePath, signal);
          if (root === undefined) return undefined;
          const project = persistence.readProject(thread.projectId);
          if (project?.type !== "code") return undefined;
          const selectedRoot = approvedWorkingFolderRoot(
            project,
            thread.workingFolderId,
            root.rootPath,
          );
          if (selectedRoot === undefined) return undefined;
          const workingDirectory = await resolveThreadWorkingDirectory(
            selectedRoot,
            thread.workingDirectory ?? decodeThreadWorkingDirectory("."),
          );
          const directoryCurrent = threadWorkingDirectoryCurrent(selectedRoot, workingDirectory);
          return {
            checkoutRoot: root.rootPath,
            rootIdentity: root.rootIdentity,
            rootCurrent: () => {
              const latest = persistence.readProject(thread.projectId);
              return (
                directoryCurrent() &&
                root.current?.() !== false &&
                latest?.type === "code" &&
                approvedWorkingFolderRoot(latest, thread.workingFolderId, root.rootPath) ===
                  selectedRoot
              );
            },
            workingDirectory,
            shell: terminalShellFor({
              platform: process.platform,
              windowsShell: persistence.readCodeSettings()?.settings.windowsTerminalShell,
            }),
            credentialReferences: [],
            environment: {},
          };
        },
        readProviderInstance: (id) => persistence.readProviderInstance(id),
        resolveProviderDriver: (thread) => {
          const instance = persistence.readProviderInstance(thread.providerInstanceId);
          if (instance === undefined || !instance.enabled) return undefined;
          try {
            const key = String(thread.id);
            const retained = codeThreadDrivers.get(key);
            if (
              retained?.instanceId === String(instance.id) &&
              retained.version === instance.version
            )
              return retained.driver;
            const driver = attachWorkRequestRuntime(
              makeConfiguredProviderDriver(instance, configuredDriverOptions),
              () => workRequestRuntime,
            );
            codeThreadDrivers.set(key, {
              instanceId: String(instance.id),
              version: instance.version,
              driver,
            });
            return driver;
          } catch {
            return undefined;
          }
        },
        agents: (input) =>
          agentsManagedToolsFor({
            windowId: String(input.windowId),
            parentThreadId: String(input.thread.id),
            mode: "code",
            projectId: input.thread.projectId,
            ...(input.ask === undefined ? {} : { ask: input.ask }),
          }),
        nativeHarnessTools: (input) => {
          const editDiagnostics = codeEditDiagnosticsFactory?.({
            windowId: input.windowId,
            thread: input.thread,
            harnessRoot: input.checkoutRoot,
            mainCheckoutRoot: input.mainCheckoutRoot ?? input.checkoutRoot,
          });
          return nativeHarnessComposition.forCode({
            ...input,
            ...(editDiagnostics === undefined ? {} : { editDiagnostics }),
          });
        },
        holdsServerThread: (thread) => serverProjectOf(serverProjectStore, thread) !== undefined,
        transferServerAttachments: (thread, files) => {
          const place = serverThreadOf(serverProjectStore, thread);
          const address =
            place === undefined
              ? undefined
              : serverProjectStore.addressOf(String(place.project.id));
          return transferServerAttachments({
            connection: serverConnection,
            server: address?.kind === "address" ? address.server : undefined,
            threadId: String(thread.id),
            files,
            guard: serverAttachmentCleanup.guardTransfer,
          });
        },
        serverTerminalLogin: (thread) => {
          const place = serverThreadOf(serverProjectStore, thread);
          if (place === undefined) return undefined;
          const address = serverProjectStore.addressOf(String(place.project.id));
          return address.kind === "address"
            ? serverTerminalLogin(serverConnection, address.server, place.folder)
            : undefined;
        },
        serverGit: (thread) => {
          const project = serverProjectOf(serverProjectStore, thread);
          if (project === undefined) return undefined;
          const projectId = String(project.id);
          if (serverProjectStore.addressOf(projectId).kind !== "address") return undefined;
          // One service per Project, so its Git changes queue one after
          // another as a local checkout's do.
          let git = serverGitServices.get(projectId);
          if (git === undefined) {
            git = createServerGitService({
              connection: serverConnection,
              // Read each call, so a server removed mid-operation refuses the next command.
              server: () => {
                const address = serverProjectStore.addressOf(projectId);
                return address.kind === "address" ? address.server : undefined;
              },
              commitIdentity: () => {
                const profile = persistence.readShellSettings()?.settings.userProfile;
                return {
                  ...(profile?.displayName === undefined ? {} : { name: profile.displayName }),
                  ...(profile?.email === undefined ? {} : { email: profile.email }),
                };
              },
            });
            serverGitServices.set(projectId, git);
          }
          return git;
        },
        serverRepositoryTests: (thread) => {
          // The thread's folder there: the Project's own, or its own worktree.
          const place = serverThreadOf(serverProjectStore, thread);
          if (place === undefined) return undefined;
          const project = place.project;
          const projectId = String(project.id);
          if (serverProjectStore.addressOf(projectId).kind !== "address") return undefined;
          // One per folder, so a run can be cancelled from any request.
          const key = `${projectId}\0${place.folder}`;
          let tests = serverTestServices.get(key);
          if (tests === undefined) {
            const server = () => {
              const address = serverProjectStore.addressOf(projectId);
              return address.kind === "address" ? address.server : undefined;
            };
            tests = createServerRepositoryTests({
              connection: serverConnection,
              server: () => {
                const address = server();
                return address === undefined
                  ? undefined
                  : { ...address, serverId: String(project.serverId) };
              },
              root: place.folder,
              files: new ServerCodeFiles({
                connection: serverConnection,
                server,
                root: place.folder,
                clock: () => new Date().toISOString(),
              }),
              record: (record) => shieldServerStore.recordServerCommand(record),
              now: () => new Date().toISOString(),
              newId: randomUUID,
            });
            serverTestServices.set(key, tests);
          }
          return tests;
        },
        serverCodeTurn: (input) =>
          serverProjectOf(serverProjectStore, input.thread) === undefined
            ? undefined
            : bindServerCodeTurn(
                {
                  store: serverProjectStore,
                  connection: serverConnection,
                  composition: nativeHarnessComposition,
                  runtimes: serverRuntimeRecords,
                  record: (record) => shieldServerStore.recordServerCommand(record),
                },
                input,
              ),
        readProject: (projectId) => persistence.readProject(projectId),
        readProjectExtraFolders: (projectId) => {
          const project = persistence.readProject(projectId);
          return project === undefined || project.type === "chat"
            ? []
            : projectExtraFolderRoots(project);
        },
        nativeHarness: nativeHarnessHooks,
        onProviderTurnRequested: (threadId) => {
          if (codeService instanceof CodeService) codeService.noteProviderTurnRequested(threadId);
        },
        onUsageLimitStop: async (threadId, stopped) => {
          if (codeService instanceof CodeService)
            await codeService.handOffAfterUsageLimit(threadId);
          // A coordinator's worker may carry on with its role's next model;
          // the person's own hand-off above goes first and then rules it out.
          await continueWorkerOnFallback.current?.(threadId, "usage-limit", stopped);
        },
        onProviderStop: async (threadId, availability, stopped) => {
          await continueWorkerOnFallback.current?.(threadId, availability, stopped);
        },
        // The agent's ask to plan, or to leave Plan, changes the level the way
        // the person's own level menu does, for the window that approved it.
        changeThreadLevel: async ({ windowId, threadId, executionPolicy, planReturnPolicy }) => {
          const thread = persistence.readCodeThread(threadId);
          if (thread === undefined) return false;
          const result = await codeService.execute(windowId, {
            kind: "change-code-thread-access",
            threadId,
            expectedVersion: thread.version,
            executionPolicy,
            permissionPersistence: thread.permissionPersistence,
            ...(planReturnPolicy === undefined ? {} : { planReturnPolicy }),
          });
          return (
            result.kind === "thread-updated" && result.thread.executionPolicy === executionPolicy
          );
        },
        supportsAppManagedTools: (thread) => {
          const observed = providerRuntimeRegistry.observedState(thread.providerInstanceId);
          return (
            browserToolTransport(observed, String(thread.modelId), appToolThreadLevel(thread)) ===
            true
          );
        },
        supportsAcpClientCapabilities: (thread) =>
          providerRuntimeRegistry.observedState(thread.providerInstanceId)?.capabilities
            .acpClientCapabilities === "supported",
        accountSessionCarrier: makeConfiguredAccountSessionCarrier(
          (instanceId) => persistence.readProviderInstance(instanceId),
          configuredDriverOptions,
        ),
        supportsModelSwitch: (thread) =>
          providerRuntimeRegistry.observedState(thread.providerInstanceId)?.capabilities
            .modelSwitch === "supported",
        supportsSessionRollback: (thread) =>
          providerRuntimeRegistry.observedState(thread.providerInstanceId)?.capabilities
            .sessionRollback === "supported",
        compactionRunning: (threadId) =>
          contextHarness.compactionRunning(
            decodeContextSubjectRef({ aggregateType: "code-thread", aggregateId: threadId }),
          ),
        sessionCompactions: {
          record: ({ threadId, ...input }) => {
            contextHarness.recordAutomaticCompaction({
              subject: decodeContextSubjectRef({
                aggregateType: "code-thread",
                aggregateId: threadId,
              }),
              ...input,
            });
          },
          compactedAfter: (threadId, globalSequence) =>
            contextHarness.sessionCompactedAfter(
              decodeContextSubjectRef({ aggregateType: "code-thread", aggregateId: threadId }),
              globalSequence,
            ),
        },
        handoverSummary: (thread) =>
          contextHarness.handoverSummary(
            decodeContextSubjectRef({
              aggregateType: "code-thread",
              aggregateId: String(thread.id),
            }),
            () => codeSessionConversation(thread.id) ?? [],
          ),
        providerSwitchContext: ({ thread, excludeOperationId, inheritedFrom, purpose }) =>
          selectCodeConversation(thread.id, {
            purpose: purpose ?? "provider-switch",
            excludeOperationId: String(excludeOperationId),
            ...(inheritedFrom === undefined
              ? {}
              : {
                  inherited: {
                    threadId: inheritedFrom.source.id,
                    throughOperationId: inheritedFrom.throughOperationId,
                    externalContentIngested: readThreadExternalContentTaint(
                      persistence.connection,
                      String(inheritedFrom.source.id),
                    ).externalContentIngested,
                  },
                }),
          }),
        ...(imageDescriber === undefined
          ? {}
          : {
              describeImages: ({ thread, images, signal }) =>
                describeTurnImages(imageDescriber, {
                  signal,
                  scope: { threadId: String(thread.id), threadType: "code-thread" },
                  projectId: thread.projectId,
                  threadModel: modelLabelOf(
                    { persistence, providerRuntimeRegistry },
                    thread.providerInstanceId,
                    thread.modelId,
                  ),
                  images,
                }),
            }),
        supportsAttachments: (thread) => {
          const observed = providerRuntimeRegistry.observedState(thread.providerInstanceId);
          if (observed?.capabilities.nativeAttachments !== "supported") return false;
          // Provider-level support only says some model reads images. A turn
          // goes to one model, so the thread's own model has to be that one.
          return observed.models.some(
            (model) =>
              String(model.id) === String(thread.modelId) &&
              model.inputModalities.includes("image"),
          );
        },
        takesFileNatively: (thread, mediaType) =>
          providerTakesFileNatively(
            persistence.readProviderInstance(thread.providerInstanceId)?.driverKind,
            providerRuntimeRegistry.observedState(thread.providerInstanceId),
            String(thread.modelId),
            mediaType,
          ),
        routineBrowserTools: ({ thread, readThread, routineRun }) =>
          routineBrowserTools({
            routineRun,
            turnLevel: appToolThreadLevel(thread),
            threadId: decodeBrowserThreadId(String(thread.id)),
            currentAuthority: () =>
              readThread() === undefined
                ? undefined
                : browserAuthority.resolve(decodeBrowserThreadId(String(thread.id)), "code"),
            currentModelId: () => {
              const current = readThread();
              return current === undefined || current.executionPolicy !== thread.executionPolicy
                ? undefined
                : String(current.modelId);
            },
          }),
        browserAutomation: {
          runScript: (input) => browserAutomationService.runScript(input),
          resolveAuthority: (threadId, mode) => browserAuthority.resolve(threadId, mode),
          inspectThread: (windowId, threadId) =>
            browserAutomationService.inspectThread(windowId, threadId),
          create: (input) => browserAutomationService.create(input),
          act: (input) => browserAutomationService.act(input),
          saveDownload: (input) => browserAutomationService.saveDownload(input),
          releaseThread: (windowId, threadId) =>
            browserAutomationService.releaseThread(windowId, threadId),
          holdForPerson: (windowId, threadId) =>
            browserAutomationService.holdForPerson(windowId, threadId),
          holdForAsk: (windowId, threadId) =>
            browserAutomationService.holdForAsk(windowId, threadId),
          takeBack: (windowId, threadId) => browserAutomationService.takeBack(windowId, threadId),
          snapshotRefs: (windowId, threadId) =>
            browserAutomationService.snapshotRefs(windowId, threadId),
        },
        browserFlows,
        browserProfiles: {
          approvals: browserToolApprovalService,
          readBinding: (contextId) => browserModelBindings.get(contextId),
          rememberBinding: (contextId, binding) =>
            rememberModelBinding(browserModelBindings, contextId, binding),
          forgetBinding: (contextId) => {
            browserModelBindings.delete(contextId);
          },
        },
        browserTransferApprovals: browserToolApprovalService,
        browserUploadFileCountLimit: () =>
          (persistence.readShellSettings()?.settings ?? defaultShellSettings())
            .browserUploadFileCountLimit,
        browserUploadFileLimitBytes: () =>
          browserTransferLimits(persistence.readShellSettings()?.settings ?? defaultShellSettings())
            .maxFileBytes,
        // A paired device is not at the computer a saved download would land on.
        browserDownloadRefusal: (windowId) =>
          browserToolApprovalService.isPairedDevice(windowId)
            ? "download-needs-this-computer"
            : undefined,
        browserSignIn: {
          // A routine's or subagent's turn has nobody to sign in, and a
          // hub-introduced/restricted device cannot hold the Browser page.
          refusal: (windowId) =>
            browserToolApprovalService.isUnattendedScope(windowId)
              ? "sign-in-needs-a-person"
              : browserToolApprovalService.isRestrictedDevice(windowId)
                ? "sign-in-needs-this-computer"
                : undefined,
          request: (input) => browserToolApprovalService.request(input),
        },
        // The agent's Apple capability resolves its execution context through
        // exactly the resolver the workbench route uses, so a tool call and a
        // click are the same request to the same policy.
        appleToolchain: {
          resolveAuthority: (_windowId, thread) => ({
            hostId: LOCAL_TOOL_HOST_ID,
            mode: "code" as const,
            projectId: thread.projectId,
            providerInstanceId: thread.providerInstanceId,
            extension: { kind: "core" as const },
          }),
          discover: async (windowId, request) => {
            const context = await resolveAppleContext(
              windowId,
              {
                authority: request.authority,
                threadId: request.threadId,
                checkoutId: request.checkoutId,
              },
              { kind: "apple-discovery-request", request },
            );
            if (context === undefined) return undefined;
            return await appleToolchainService.discover(request, context);
          },
          execute: async (windowId, request) => {
            const startedAt = new Date().toISOString();
            const context = await resolveAppleContext(
              windowId,
              {
                authority: request.authority,
                threadId: request.threadId,
                checkoutId: request.checkoutId,
              },
              { kind: "apple-action-request", request },
            );
            if (context === undefined) return undefined;
            const evidence = await appleToolchainService.execute(request, context);
            // An agent's shutdown closes a Simulator to every thread, and its
            // input keeps a live grant open, the same as the pane's.
            simulatorInputGrants.settle(String(windowId), request, evidence, context);
            await recordAppleEvidence(evidence, startedAt);
            return evidence;
          },
          readScreenshot: async (windowId, scope, reference) => {
            const context = await resolveAppleContext(windowId, scope, {
              kind: "apple-snapshot-request",
              authority: scope.authority,
              threadId: scope.threadId,
              checkoutId: scope.checkoutId,
            });
            if (context === undefined) return undefined;
            const artifact = await appleToolchainService.readScreenshotArtifact(reference, context);
            return artifact.kind === "found" ? artifact.bytes : undefined;
          },
          readLog: async (windowId, scope, reference) => {
            const context = await resolveAppleContext(windowId, scope, {
              kind: "apple-snapshot-request",
              authority: scope.authority,
              threadId: scope.threadId,
              checkoutId: scope.checkoutId,
            });
            if (context === undefined) return undefined;
            return await appleToolchainService.readLogArtifact(reference, context);
          },
          snapshot: async (windowId, scope) => {
            const context = await resolveAppleContext(windowId, scope, {
              kind: "apple-snapshot-request",
              authority: scope.authority,
              threadId: scope.threadId,
              checkoutId: scope.checkoutId,
            });
            return context === undefined ? undefined : appleToolchainService.snapshot(context);
          },
          requestPaneOpen: async (windowId, scope, simulatorId) => {
            const context = await resolveAppleContext(windowId, scope, {
              kind: "apple-snapshot-request",
              authority: scope.authority,
              threadId: scope.threadId,
              checkoutId: scope.checkoutId,
            });
            if (context === undefined) return undefined;
            return appleToolchainService.requestPaneOpen(context, simulatorId);
          },
          inputGrantIsOpen: (windowId, threadId, simulatorId) =>
            simulatorInputGrants.isOpen({
              windowId: String(windowId),
              threadId: String(threadId),
              simulatorId: String(simulatorId),
            }),
        },
        androidToolchain: {
          resolveAuthority: (_windowId, thread) => ({
            hostId: LOCAL_TOOL_HOST_ID,
            mode: "code" as const,
            projectId: thread.projectId,
            providerInstanceId: thread.providerInstanceId,
            extension: { kind: "core" as const },
          }),
          discover: async (windowId, request) => {
            const context = await resolveAndroidContext(
              windowId,
              {
                authority: request.authority,
                threadId: request.threadId,
                checkoutId: request.checkoutId,
              },
              { kind: "android-discovery-request", request },
            );
            if (context === undefined) return undefined;
            return await androidToolchainService.discover(request, context);
          },
          execute: async (windowId, request) => {
            const context = await resolveAndroidContext(
              windowId,
              {
                authority: request.authority,
                threadId: request.threadId,
                checkoutId: request.checkoutId,
              },
              { kind: "android-action-request", request },
            );
            if (context === undefined) return undefined;
            const evidence = await androidToolchainService.execute(request, context);
            if (!isReplayedAndroidEvidence(evidence)) {
              androidInputGrants.settle(
                String(windowId),
                { kind: request.kind, simulatorId: request.emulatorId },
                evidence,
                context,
              );
            }
            return evidence;
          },
          readScreenshot: async (windowId, scope, reference) => {
            const context = await resolveAndroidContext(windowId, scope, {
              kind: "android-snapshot-request",
              authority: scope.authority,
              threadId: scope.threadId,
              checkoutId: scope.checkoutId,
            });
            if (context === undefined) return undefined;
            const artifact = await androidToolchainService.readScreenshotArtifact(
              reference,
              context,
            );
            return artifact.kind === "found" ? artifact.bytes : undefined;
          },
          readLog: async (windowId, scope, reference) => {
            const context = await resolveAndroidContext(windowId, scope, {
              kind: "android-snapshot-request",
              authority: scope.authority,
              threadId: scope.threadId,
              checkoutId: scope.checkoutId,
            });
            if (context === undefined) return undefined;
            return await androidToolchainService.readLogArtifact(reference, context);
          },
          snapshot: async (windowId, scope) => {
            const context = await resolveAndroidContext(windowId, scope, {
              kind: "android-snapshot-request",
              authority: scope.authority,
              threadId: scope.threadId,
              checkoutId: scope.checkoutId,
            });
            return context === undefined ? undefined : androidToolchainService.snapshot(context);
          },
          requestPaneOpen: async (windowId, scope, emulatorId) => {
            const context = await resolveAndroidContext(windowId, scope, {
              kind: "android-snapshot-request",
              authority: scope.authority,
              threadId: scope.threadId,
              checkoutId: scope.checkoutId,
            });
            if (context === undefined) return undefined;
            return androidToolchainService.requestPaneOpen(context, emulatorId);
          },
          inputGrantIsOpen: (windowId, threadId, emulatorId) =>
            androidInputGrants.isOpen({
              windowId: String(windowId),
              threadId: String(threadId),
              simulatorId: String(emulatorId),
            }),
        },
        credentialResolver: { resolve: async () => undefined },
        resolveSideChatReturns: sideChatReturnContextResolver(
          () => threadMentionService(),
          threadOutsideContentMarks,
        ),
        resolveThreadMentionContext: threadMentionContextResolver(
          () => threadMentionService(),
          threadOutsideContentMarks,
        ),
        resolveFileMentionContext: async ({ fileMentionPaths, windowId, threadId, checkoutId }) =>
          fileMentionContextBlocks(fileMentionService(), {
            windowId,
            scope: { mode: "code", threadId, checkoutId },
            paths: fileMentionPaths,
          }),
        takeProductFeedbackForTurn: createProductFeedbackTurnPort({
          service: productFeedbackService,
          resolveScope: (windowId, threadId) => {
            const scope = resolveFeedbackThread(windowId, threadId);
            return scope?.mode === "code" ? scope : undefined;
          },
        }),
        peekIssueContextFramed: peekCreateFromIssueFramed,
        consumeIssueContextFramed: consumeCreateFromIssueFramed,
        // Where a run comes home to: the directory the thread's Project binds.
        // A run on a managed worktree works in a sibling tree; the merge lands
        // in the person's own checkout, and only the Project knows where that
        // is.
        resolveBaseCheckoutRoot: async (thread) => {
          const project = persistence.readProject(thread.projectId);
          return project?.type === "code" && project.lifecycle === "active"
            ? project.binding.canonicalRoot
            : undefined;
        },
        forkContext: ({ source, throughOperationId, targetContextLimitTokens }) =>
          selectCodeConversation(source.id, {
            purpose: "fork",
            throughOperationId,
            ...(targetContextLimitTokens === undefined ? {} : { targetContextLimitTokens }),
          }),
        forkMergeBackContext: ({ fork, afterOperationId, throughOperationId }) =>
          selectCodeConversation(fork.id, {
            purpose: "fork-merge-back",
            throughOperationId,
            ...(afterOperationId === undefined ? {} : { afterOperationId }),
          }),
        nativeTurnAnchor: (threadId, operationId) => {
          let decoded: CodeOperationId;
          try {
            decoded = decodeCodeOperationId(operationId);
          } catch {
            return undefined;
          }
          return codeBoardEventStore.nativeTurnAnchor(threadId, decoded);
        },
        forkProviderSession: (input) =>
          seedCodeForkHarnessSession(
            {
              transcripts: nativeHarnessTranscripts,
              harnessDriverKind: (instanceId) => {
                const instance = persistence.readProviderInstance(instanceId);
                return instance !== undefined && isNativeHarnessDriverKind(instance.driverKind)
                  ? instance.driverKind
                  : undefined;
              },
              // The copied session holds every turn that ran on it, rewound
              // ones too, so turns are placed in it by the order they ran.
              sourceTurns: (threadId) =>
                codeThreadTurns((page) => codeBoardEventStore.conversation(page), threadId, {
                  includeRewound: true,
                }),
              sourceConversations: (threadId) =>
                codeBoardEventStore.providerConversationsOfTurns(threadId),
            },
            input,
          ),
        resolveProfileSkills: createCodeProfileSkillResolver({
          snapshot: () => extensionApiService.snapshot(),
          loadSkillText: createStoredCodeProfileSkillTextLoader({
            snapshot: () => extensionApiService.snapshot(),
            readVerifiedComponentText: async (target) =>
              extensionPackageStore.readVerifiedComponentText(target, target.componentId),
          }),
        }),
        githubReadTools: ({ windowId, thread, readThread }) =>
          githubReadToolSetIfEffective(githubExtensionSnapshot.read(), () =>
            githubReadToolService.createToolSet({ windowId, thread, readThread }),
          ),
        linearReadTools: ({ windowId, thread, readThread }) =>
          linearReadToolSetIfEffective(githubExtensionSnapshot.read(), () =>
            linearReadToolService.createToolSet({
              windowId,
              thread,
              readThread,
              readProjectLinearTarget: () => {
                const project = persistence.readProject(thread.projectId);
                return project?.type === "code" ? project.linearTarget : undefined;
              },
            }),
          ),
        contributedTools: (input) =>
          codeToolContributors.length === 0
            ? undefined
            : combineAppManagedToolSets(
                ...codeToolContributors.map((contribute) => contribute(input)),
              ),
        serverTurnTools: (input) =>
          serverCodeToolContributors.length === 0
            ? undefined
            : combineAppManagedToolSets(
                ...serverCodeToolContributors.map((contribute) => contribute(input)),
              ),
        // The facts come from the host's own records on every call. The
        // Code runtime, the decision reader, and the mention directory are
        // declared later in this startup; a turn runs only after they exist.
        threads: ({ windowId, thread, readPosture, planner }) =>
          createThreadsTools({
            mode: "code",
            windowId,
            service: siblingThreadsService,
            source: codeSiblingThreadSource(
              {
                threads: () => persistence.readCodeThreads(),
                thread: (threadId) => persistence.readCodeThread(threadId),
                runtimeWorks: (threadId) => persistence.readCodeRuntimeWorks(threadId),
                turnAwaitsPerson: (threadId) =>
                  codeOperationRuntime?.turnAwaitsPerson?.(String(threadId)) === true ||
                  threadAwaitsHarnessApproval(String(threadId)),
                decisionPending: (candidate) =>
                  codeTurnDecisions.forThread(candidate) !== undefined,
                mentions: {
                  readTranscript: async (readerWindowId, threadId, options) =>
                    await codeThreadMentionDirectory().readTranscript(
                      readerWindowId,
                      threadId,
                      options,
                    ),
                },
              },
              windowId,
            ),
            callerThreadId: String(thread.id),
            toolConstraints: thread.toolConstraints ?? [],
            profileDisplayName: thread.profileDisplayName ?? "the bound profile",
            readPosture,
            messaging: agentMessageService,
            ...(planner === undefined ? {} : { planner }),
            coordinator: {
              levelOf: (threadId) => coordinatorService.levelOf(threadId),
              start: (input) => coordinatorService.start(input),
            },
            recordExternalContentIngestion: (input) => externalContentIngestionStore.record(input),
            uuid: randomUUID,
            strict: () => resolveThreadStrict(String(thread.id)),
            readsPerTurn: () =>
              (persistence.readShellSettings()?.settings ?? defaultShellSettings())
                .siblingThreadReadsPerTurn,
            waitsPerTurn: () =>
              (persistence.readShellSettings()?.settings ?? defaultShellSettings())
                .siblingThreadWaitsPerTurn,
          }),
        isCoordinatorThread: (threadId) => coordinatorService.isCoordinator(threadId),
        coordinatorContext: (threadId) => coordinatorService.contextFor(threadId),
        carryAgentMessages: (threadId) => agentMessageService.carryIntoTurn(threadId),
        confirmAgentMessagesDelivered: (messageIds) =>
          agentMessageService.confirmDelivered(messageIds),
        sideTasks: ({ windowId, thread, operationId, planner }) =>
          createSideTaskTools({
            store: sideTasks,
            threadId: String(thread.id),
            mode: "code",
            projectId: thread.projectId,
            turnId: operationId,
            suggestedBy: thread,
            uuid: randomUUID,
            clock: () => new Date().toISOString(),
            ...(planner === undefined ? {} : { planner: { port: planner, windowId } }),
            toolConstraints: thread.toolConstraints ?? [],
            profileDisplayName: thread.profileDisplayName ?? "the bound profile",
          }),
        canvas: ({ windowId, thread }) =>
          createCanvasAgentTools({
            windowId,
            mode: "code",
            thread: {
              id: String(thread.id),
              projectId: String(thread.projectId),
              providerInstanceId: thread.providerInstanceId,
              modelId: thread.modelId,
            },
            port: canvasAgentToolPort,
          }),
        recordExternalContentIngestion: (input) => externalContentIngestionStore.record(input),
        resolvePullRequestLineNotesAuthorship: async ({ projectId, source, signal }) => {
          const pullRequestAuthor = projectPullRequestService.observedAuthor({
            projectId,
            repositoryOwner: source.repositoryOwner,
            repositoryName: source.repositoryName,
            number: source.number,
          });
          if (pullRequestAuthor === undefined) {
            return { pullRequestAuthor: undefined, viewerLogin: undefined };
          }
          const viewerLogin = await projectPullRequestService.observeViewerLogin(signal);
          return { pullRequestAuthor, viewerLogin };
        },
        outsideContentMarks: runtimeOutsideContentMarks,
        forgeChanges: runtimeForgeChanges,
        readThreadExternalContentTaint: (threadId) =>
          readThreadExternalContentTaint(persistence.connection, String(threadId)),
        resolveStrict: (threadId) => resolveThreadStrict(String(threadId)),
        resolveProviderCapabilities: (thread) =>
          providerRuntimeRegistry.observedState(thread.providerInstanceId)?.capabilities,
        // A Code session hands its runtime's wake-ups to the host's schedule.
        resolveThreadWakeups: (thread) =>
          threadWakeups.service?.forSession("code", String(thread.id)),
        outlivingSessions: outlivingCodeSessions,
        isRuntimeStartedTurn: (operationId) => runtimeStartedCodeTurns.delete(operationId),
        resolveProviderNativeSetup: (thread) =>
          sessionNativeSetup(
            {
              ...persistence,
              readStrict: (threadId) => resolveThreadStrict(threadId),
            },
            {
              providerInstanceId: thread.providerInstanceId,
              projectId: thread.projectId,
              threadId: String(thread.id),
              mode: "code",
              executionPolicy: thread.executionPolicy,
            },
          ),
        // The planner's board read and board offers resolve their designation
        // on every call through the services declared after this runtime; the closures run only once a
        // turn is live, well after startup finishes wiring them.
        planner: {
          isPlannerThread: (threadId) => codePlannerService.isPlannerThread(threadId),
          board: async (windowId, threadId) => {
            const scope = codePlannerService.boardScope(threadId);
            if (scope.status === "refused") return scope;
            const queryBoard = routeCodeService.queryBoard;
            if (queryBoard === undefined) {
              return {
                status: "refused",
                reason: "planner-unavailable",
                message: "The Code Thread Board is unavailable on this host.",
              };
            }
            // The planner reads the same server-authoritative board read-model
            // the UI queries, scoped strictly to its own Project. No GitHub
            // call happens here; cached PR facts arrive with their freshness.
            const board = await queryBoard(windowId, {
              version: 1,
              projectIds: [scope.projectId],
            });
            return { status: "ok", board };
          },
          propose: async (_windowId, threadId, draft) =>
            codePlannerService.propose(threadId, draft),
        },
        resolvePullRequestTarget: async (threadId) => {
          const thread = persistence.readCodeThread(threadId);
          if (thread === undefined) return undefined;
          const threadLinks = pullRequestLinkService.listForThread(threadId);
          const matchingLink =
            threadLinks.find(
              (link) =>
                link.headBranch !== undefined &&
                link.headBranch === thread.deliveryTarget.branchIntent,
            ) ?? (threadLinks.length === 1 ? threadLinks[0] : undefined);
          const baseRepository =
            matchingLink !== undefined
              ? `${matchingLink.repositoryOwner}/${matchingLink.repositoryName}`
              : await serverPullRequestRepository(
                  { store: serverProjectStore, connection: serverConnection },
                  thread,
                );
          const owner = matchingLink?.headOwner ?? baseRepository.split("/")[0];
          if (owner === undefined || owner.length === 0) return undefined;
          return {
            authorization: "confirmed-delivery-target",
            baseRepository,
            baseBranch: thread.deliveryTarget.proposedBaseBranch,
            head: `${owner}:${thread.deliveryTarget.branchIntent}`,
          };
        },
        standingMergeAllowance: (thread) => {
          const run = persistence.automationProjection.runForThread(String(thread.id));
          return standingMergeAllowanceFor({
            thread,
            project: persistence.readProject(thread.projectId),
            run,
            routine:
              run === undefined
                ? undefined
                : persistence.automationProjection.getDefinition(run.automationId),
          });
        },
        projectForgeChoices: (thread) =>
          projectForgeChoicesFor(persistence.readProject(thread.projectId)),
        // The switch service wakes threads through this runtime, so it is
        // built after it; a watch asked for before then is unavailable.
        pullRequestWatch: {
          watch: async (input) =>
            pullRequestWatchService === undefined
              ? { status: "unavailable", reason: "unavailable" }
              : pullRequestWatchService.watch(input),
          unwatch: async (input) =>
            pullRequestWatchService === undefined
              ? { status: "not-watching" }
              : pullRequestWatchService.unwatch(input),
        },
        reviewFiles: {
          resolve: (input) => {
            const reference = persistence.readCodeFileReference(input.fileId);
            if (
              reference === undefined ||
              reference.id !== stableCodeFileId(input.threadId, input.checkoutId, input.path) ||
              reference.threadId !== input.threadId ||
              reference.checkoutId !== input.checkoutId ||
              reference.digest !== input.digest
            ) {
              return undefined;
            }
            return {
              threadId: input.threadId,
              checkoutId: input.checkoutId,
              path: input.path,
              digest: input.digest,
            };
          },
        },
        evidence: {
          put: (content, metadata) => codeEvidence.put(content, metadata),
          read: async (reference) => codeEvidence.read(reference),
        },
        actor: { kind: "system", actorId: OCTANT_LOCAL_ACTOR_ID },
        clock: () => new Date().toISOString(),
        uuid: randomUUID,
        approvalStore: codeApprovalStore,
        sessionAuthority: codeSessionAuthority,
        ...(options.ghExecutable === undefined ? {} : { ghExecutable: options.ghExecutable }),
      });
    }
    const { codeCompletedThreadSource, codeService } = buildCodeService(codeOperationRuntime);
    builtCodeService = codeService instanceof CodeService ? codeService : undefined;
    yield* Effect.promise(() => codeOperationRuntime?.reconcile?.() ?? Promise.resolve());
    // A push or pull request step a restart left unknown is settled by looking
    // at the remote now, as the host, rather than when a person next opens
    // that thread's Git or pull request tab. Persistence has already marked
    // such steps ambiguous; the look runs in the background so a slow or
    // unreachable remote never holds start-up, and stops with the server.
    const unconfirmedStepLook = beginUnconfirmedStepSettlement(
      codeOperationRuntime,
      ROUTINE_HOST_SCOPE_ID,
    );
    yield* Effect.addFinalizer(() => Effect.promise(() => unconfirmedStepLook.stop()));
    // Code threads already have an inline question surface; the same question
    // shows there so the answer can come from the thread itself.
    onHarnessQuestionAsked(({ threadId, mode, question }) => {
      if (mode !== "code" || question.source !== undefined) return;
      codeOperationRuntime?.raiseHarnessQuestion?.({
        threadId,
        questionId: String(question.id),
        prompt: question.prompt,
        ...(question.questionnaire === undefined ? {} : { questionnaire: question.questionnaire }),
        options: question.options,
      });
    });
    // Settled anywhere (another surface, expiry, cancellation): the inline
    // copy goes too, so Code never lists or accepts an answer to it.
    // Recovery settles its orphaned turns before a continuation can be queued.
    onHarnessRecoveryLifted(({ threadId, mode }) => {
      if (mode === "code") codeOperationRuntime?.settleCutOffTurns?.(threadId);
    });
    onHarnessQuestionSettled((input) => codeOperationRuntime?.withdrawHarnessQuestion?.(input));
    const baseRouteCodeService: CodeRouteService =
      codeOperationRuntime === undefined
        ? codeService
        : withCodeOperationRuntime(codeService, codeOperationRuntime);
    // A finished Code turn that closed with an ask, read back from the journal
    // so the board and every attention surface agree after a restart.
    const codeTurnDecisions = new CodeTurnDecisions({
      threads: async (windowId) => (await baseRouteCodeService.navigation(windowId)).threads,
      admitsTurn: async (windowId, thread) =>
        (await codeOperationRuntime?.admitsTurn?.(windowId, thread)) === true,
      runtimeWorks: (threadId) => persistence.readCodeRuntimeWorks(threadId),
      replay: (input) => {
        try {
          const replay = codeBoardEventStore.replay({
            ...input,
            limit: MAX_CODE_OPERATION_REPLAY_LIMIT,
          });
          return replay.status === "ok" ? replay.frames : undefined;
        } catch {
          return undefined;
        }
      },
      readEvidence: (reference) => codeEvidence.read(reference),
    });
    // The Code Thread Board composes the journal-rebuildable operational
    // metadata projection with live runtime works. Local Git worktree
    // observation still degrades to unavailable here when the checkout cannot
    // be observed; GitHub is never called. Cached PR evidence comes from the
    // operation journal, labeled with freshness, and cannot independently
    // satisfy a delivery target when stale.
    const codeThreadMetadataService = new CodeThreadMetadataService({
      git: { observe: () => ({ status: "unavailable" }) },
      history: {
        read: (threadId) => codeBoardEventStore.summaryForThread(threadId),
      },
      pullRequestLinks: pullRequestLinkService,
    });
    // Puts a Code thread away once its pull request merged, read from the same
    // cached projection the board shows. Only the in-process service can act
    // as the host; an injected route service is a test double and gets none.
    const hostCodeService = builtCodeService;
    const mergedThreadPutAway =
      hostCodeService === undefined
        ? undefined
        : new MergedThreadPutAway({
            threads: () => persistence.readCodeThreads(),
            projectExists: (projectId) => persistence.readProject(projectId) !== undefined,
            metadata: codeThreadMetadataService,
            cachedMerges: (threadId) =>
              projectPullRequestService.mergedPullRequestsForThread(String(threadId)),
            decisionPending: (thread) => codeTurnDecisions.forThread(thread) !== undefined,
            samePullRequest: (projectId, left, right) => {
              if (left.number !== right.number) return false;
              const leftRepository = splitRepositoryName(left.baseRepository);
              const rightRepository = splitRepositoryName(right.baseRepository);
              return leftRepository !== undefined && rightRepository !== undefined
                ? pullRequestLinkService.areSameRepository(
                    projectId,
                    leftRepository,
                    rightRepository,
                  )
                : left.baseRepository === right.baseRepository;
            },
            putAway: (threadId, merges, samePullRequest) =>
              hostCodeService.putAwayMergedThread(threadId, merges, samePullRequest),
            enabled: () =>
              (persistence.readShellSettings()?.settings ?? defaultShellSettings())
                .putAwayThreadsWhenDone,
          });
    // Persistent Code follow-up. Follow-up is a durable user
    // obligation independent of unread and runtime status; it reuses the
    // mode-neutral `thread-follow-up` aggregate so a single normalized model
    // spans Chat, Work, and Code.
    const codeFollowUpService = new CodeFollowUpService({
      persistence,
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
    });
    // The Project planner: one designated Code thread per Code Project that
    // may read the Project's board and propose work. A confirmed proposal
    // creates its thread through the ordinary creation command path below;
    // the planner has no creation authority of its own. Only the host's own
    // CodeService takes the host-only mark a thread confirmed from a marked
    // planner starts with; a route service a host was given instead has no
    // such input, so a confirm that needs the mark is refused there rather
    // than creating the thread unmarked.
    const codePlannerService = new CodePlannerService({
      persistence,
      coordinatorsPerProject: () =>
        (persistence.readShellSettings()?.settings ?? defaultShellSettings())
          .coordinatorsPerProject,
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
      canAccessProject: canAccessCodeProject,
      createThread: async (windowId, creation, signal, executionContext) => {
        if (codeService instanceof CodeService) {
          let creationStarted = false;
          try {
            return await codeService.execute(windowId, creation, signal, {
              ...executionContext,
              onCreationBoundary: () => {
                creationStarted = true;
              },
            });
          } catch (error) {
            if (
              !creationStarted &&
              codeService.execute === CodeService.prototype.execute &&
              error instanceof CodeServiceError
            )
              return { kind: "creation-not-started", failure: error.failure };
            throw error;
          }
        }
        if (executionContext.inheritedMark !== undefined) {
          return {
            kind: "creation-not-started",
            failure: decodeCodeFailure({
              category: "unavailable",
              message: INHERITED_MARK_REFUSAL,
            }),
          };
        }
        return codeService.execute(windowId, creation, signal);
      },
      isMarkedWithOutsideContent: (threadId) =>
        readThreadExternalContentTaint(persistence.connection, threadId).externalContentIngested,
      // Use Builder instead re-runs the coordinator's model choice; the
      // coordinator service is wired just below.
      rechooseAsBuilder: (coordinatorThreadId, filters) =>
        coordinatorService.rechooseAsBuilder(coordinatorThreadId, filters),
    });
    // Merge when ready, Auto-fix, and coordinator done-when checks. The forge
    // calls run through the host's own `gh`; with none installed every check
    // answers unavailable.
    const pullRequestSwitchForge = (() => {
      if (options.ghExecutable === undefined) return undefined;
      try {
        return new GhPullRequestSwitchPort({
          command: createGhCommandPort({ ghPath: options.ghExecutable }),
        });
      } catch {
        return undefined;
      }
    })();
    const coordinatorDoneWhenAbort = new AbortController();
    const doneWhenSignal = () =>
      AbortSignal.any([coordinatorDoneWhenAbort.signal, AbortSignal.timeout(15_000)]);
    const doneWhenProbePath = decodeCodeRelativePath("package.json");
    const isCoordinatorDoneWhenThreadDone = createCoordinatorThreadDoneEvaluator({
      readThread: (threadId) => persistence.readCodeThread(threadId),
      readCheckout: (checkoutId) => persistence.readCodeCheckout(checkoutId),
      projectExists: (projectId) => persistence.readProject(projectId) !== undefined,
      resolveCheckoutRoot: async (thread, checkout, signal) => {
        const resolved = await roots.resolve(
          ROUTINE_HOST_SCOPE_ID,
          thread,
          checkout,
          doneWhenProbePath,
          signal,
        );
        return resolved?.rootPath;
      },
      git: gitObservationPort,
      history: { read: (threadId) => codeBoardEventStore.summaryForThread(threadId) },
      pullRequestLinks: pullRequestLinkService,
      ...(pullRequestSwitchForge === undefined
        ? {}
        : {
            observePullRequest: (request, signal) =>
              pullRequestSwitchForge.observe(request, signal, {
                failures: false,
                activity: false,
              }),
          }),
      createSignal: doneWhenSignal,
    });
    // Coordinator threads and message wakes (docs/design/coordinator-threads.md):
    // a worker is created through the ordinary Code command path and started,
    // like a wake turn, as an agent-initiated host turn under the routine host
    // scope, so every approval it raises waits for a person.
    const coordinatorWakes = createCoordinatorWakeJournal({
      journal: persistence.journal,
      connection: persistence.connection,
      clock: () => new Date().toISOString(),
    });
    const coordinatorService = new CoordinatorService({
      messageWakeDefaults: () => {
        const settings = persistence.readShellSettings()?.settings ?? defaultShellSettings();
        return { wakesPerHour: settings.messageWakesPerHour, rounds: settings.messageWakeRounds };
      },
      readThread: (threadId) => persistence.readCodeThread(decodeCodeThreadId(threadId)),
      readThreads: () => persistence.readCodeThreads(),
      readProject: (projectId) => persistence.readProject(projectId),
      readSettings: () => persistence.readCodeSettings()?.settings,
      isDesignatedPlanner: (threadId) =>
        codePlannerService.isPlannerThread(decodeCodeThreadId(threadId)),
      isMarked: (threadId) =>
        readThreadExternalContentTaint(persistence.connection, threadId).externalContentIngested,
      threadState: (threadId) => {
        const thread = persistence.readCodeThread(decodeCodeThreadId(threadId));
        if (thread === undefined) return undefined;
        return codeSiblingThreadState(thread, {
          runtimeWorks: (id) => persistence.readCodeRuntimeWorks(id),
          turnAwaitsPerson: (id) =>
            codeOperationRuntime?.turnAwaitsPerson?.(String(id)) === true ||
            threadAwaitsHarnessApproval(String(id)),
          decisionPending: (candidate) => codeTurnDecisions.forThread(candidate) !== undefined,
        }).state;
      },
      latestTurnId: (threadId) => {
        const latest = persistence
          .readCodeRuntimeWorks(decodeCodeThreadId(threadId))
          .filter(({ work }) => work.kind === "provider-turn")
          .at(-1);
        return latest === undefined ? undefined : String(latest.work.id);
      },
      providerKnown: (providerInstanceId) =>
        persistence
          .readProviderInstances()
          .some((instance) => String(instance.id) === providerInstanceId),
      // Workers choose their model from the person's roles: Settings, with
      // the Project's own choice per role on top.
      readRoles: (projectId) => ({
        host: deps.nativeHarnessRoutingStore.host().configuration,
        project: deps.nativeHarnessRoutingStore.projectOverride(projectId)?.configuration,
      }),
      candidateFacts: (project, candidate) =>
        coordinatorCandidateFacts(
          {
            readProviderInstance: (id) => persistence.readProviderInstance(id),
            observedState: (id) => providerRuntimeRegistry.observedState(id),
            catalogModel: (providerInstanceId, modelId) =>
              persistence
                .readProviderCatalog?.(providerInstanceId)
                ?.models.find((model) => String(model.id) === modelId),
            isTargetAllowed: (target, providerInstanceId, modelId) =>
              deps.isProjectPolicyTargetAllowed(target, providerInstanceId, modelId),
            availability: (providerInstanceId) =>
              deps.providerAvailabilityMarks.read(providerInstanceId),
            usageReading: (providerInstanceId) =>
              usageLimitFromReading(
                deps.providerUsageLimitsService
                  .snapshot()
                  .entries.find((entry) => String(entry.providerInstanceId) === providerInstanceId),
                Date.now(),
              ),
          },
          project,
          candidate,
        ),
      ...(imageDescriber === undefined
        ? {}
        : {
            seesImagesAvailable: (project) =>
              imageDescriber.available({ projectId: project.id, threadModel: "The builder" })
                .kind === "available",
          }),
      markProviderDown: (providerInstanceId) =>
        deps.providerAvailabilityMarks.markDown(providerInstanceId),
      // The host moves a worker whose first request failed before any work as
      // the host, like the usage-limit hand-off, never as the person.
      moveWorkerToModel: async (worker, model, choice) => {
        if (!(codeService instanceof CodeService)) return "refused";
        const moved = await codeService.execute(
          ROUTINE_HOST_SCOPE_ID,
          {
            kind: "change-code-thread-provider",
            threadId: worker.id,
            expectedVersion: worker.version,
            providerInstanceId: model.providerInstanceId,
            modelId: model.modelId,
          },
          undefined,
          {
            actor: { kind: "system", actorId: OCTANT_LOCAL_ACTOR_ID },
            coordinatorChoice: choice,
          },
        );
        return moved.kind === "thread-updated" ? "moved" : "refused";
      },
      firstTurnFailedBeforeWork: (workerId, operationId) => {
        const threadId = decodeCodeThreadId(workerId);
        const works = persistence.readCodeRuntimeWorks(threadId);
        // Any other work (a file, a terminal, a test) is work done; earlier
        // provider turns are the first requests the host already moved past.
        if (
          works.length === 0 ||
          works.some(({ work }) => work.kind !== "provider-turn" || work.state !== "failed") ||
          String(works.at(-1)?.work.id) !== operationId
        )
          return false;
        const recovered = codeBoardEventStore.providerSessionForThread(
          threadId,
          decodeCodeOperationId(operationId),
        );
        // Only the session this turn opened, and only when its own request
        // failed for availability before any text or tool call.
        return (
          recovered.status === "ok" &&
          recovered.session !== undefined &&
          String(recovered.sessionOperationId) === operationId &&
          deps.providerAvailabilityMarks.failedBeforeOutput(String(recovered.session.sessionId))
        );
      },
      executeCode: async (windowId, command, executionContext) => {
        if (!(codeService instanceof CodeService)) {
          throw new Error("Coordinators need the host's own Code service.");
        }
        return await codeService.execute(windowId, command, undefined, executionContext);
      },
      startHostTurn: async (threadId, prompt) => {
        const thread = persistence.readCodeThread(threadId);
        if (
          thread === undefined ||
          baseRouteCodeService.stageEvidence === undefined ||
          baseRouteCodeService.executeOperation === undefined
        ) {
          return { status: "refused", message: "Code turns are unavailable on this host." };
        }
        const staged = await baseRouteCodeService.stageEvidence(
          ROUTINE_HOST_SCOPE_ID,
          threadId,
          prompt,
        );
        const operationId = randomUUID();
        const result = await baseRouteCodeService.executeOperation(ROUTINE_HOST_SCOPE_ID, {
          kind: "start-provider-turn",
          operationId: decodeCodeOperationId(operationId),
          threadId,
          checkoutId: thread.checkoutId,
          sessionId: decodeProviderSessionId(randomUUID()),
          prompt: staged,
        });
        return result.kind === "provider-turn-state" &&
          (result.state === "running" || result.state === "waiting" || result.state === "completed")
          ? { status: "started", operationId }
          : {
              status: "refused",
              message:
                result.kind === "provider-turn-state" && result.failure !== undefined
                  ? result.failure.message
                  : "The turn was not admitted.",
            };
      },
      propose: (coordinatorThreadId, draft, workerOptions) => {
        const outcome = codePlannerService.proposeForCoordinator(
          coordinatorThreadId,
          draft,
          workerOptions,
        );
        return outcome.status === "proposed"
          ? { status: "proposed", proposalId: String(outcome.proposal.id) }
          : outcome;
      },
      counts: createCoordinatorCountStore(persistence.connection),
      wakes: coordinatorWakes,
      observePullRequest: async (target, readOptions) => {
        if (pullRequestSwitchForge === undefined) return { status: "unavailable" };
        return await pullRequestSwitchForge.observePullRequestCondition(
          {
            owner: target.repositoryOwner,
            name: target.repositoryName,
            number: target.number,
          },
          readOptions,
          doneWhenSignal(),
        );
      },
      isThreadDone: isCoordinatorDoneWhenThreadDone,
      uuid: randomUUID,
      now: () => Date.now(),
      onError: (message, error) => console.error(`[coordinators] ${message}`, error),
    });
    const unsubscribeCoordinator = persistence.journal.subscribeCommitted((append) =>
      coordinatorService.onCommittedEvents(append.events),
    );
    coordinatorWorkersHolder.read = (threadId) => coordinatorService.workersOf(threadId);
    continueWorkerOnFallback.current = (threadId, availability, stopped) =>
      coordinatorService.continueOnFallback(String(threadId), availability, stopped);
    coordinatorService.startSweeping();
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        unsubscribeCoordinator();
        coordinatorDoneWhenAbort.abort();
        coordinatorService.stop();
      }),
    );
    // A wake-up's turn starts the way a message wake's does: an
    // agent-initiated host turn under the routine host scope, at the
    // thread's own posture, through the ordinary turn admission. A thread
    // working or waiting on the person is busy, and the wake-up waits for it.
    const startHostCodeTurn = async (
      threadId: string,
      prompt: string,
      origin: "host" | "runtime",
    ): Promise<
      | { readonly status: "started"; readonly turnId: string }
      | { readonly status: "busy" }
      | { readonly status: "refused"; readonly message: string }
    > => {
      const id = decodeCodeThreadId(threadId);
      const thread = persistence.readCodeThread(id);
      if (
        thread === undefined ||
        baseRouteCodeService.stageEvidence === undefined ||
        baseRouteCodeService.executeOperation === undefined
      ) {
        return { status: "refused", message: "Code turns are unavailable on this host." };
      }
      const state = codeSiblingThreadState(thread, {
        runtimeWorks: (candidate) => persistence.readCodeRuntimeWorks(candidate),
        turnAwaitsPerson: (candidate) =>
          codeOperationRuntime?.turnAwaitsPerson?.(String(candidate)) === true ||
          threadAwaitsHarnessApproval(String(candidate)),
        decisionPending: (candidate) => codeTurnDecisions.forThread(candidate) !== undefined,
      }).state;
      if (state !== "idle") return { status: "busy" };
      const staged = await baseRouteCodeService.stageEvidence(ROUTINE_HOST_SCOPE_ID, id, prompt);
      const operationId = randomUUID();
      // The runtime's own turn attaches to what its kept session already
      // runs. The runtime reads the mark once, when it launches the turn.
      if (origin === "runtime") runtimeStartedCodeTurns.add(operationId);
      let result: Awaited<ReturnType<typeof baseRouteCodeService.executeOperation>>;
      try {
        result = await baseRouteCodeService.executeOperation(ROUTINE_HOST_SCOPE_ID, {
          kind: "start-provider-turn",
          operationId: decodeCodeOperationId(operationId),
          threadId: id,
          checkoutId: thread.checkoutId,
          sessionId: decodeProviderSessionId(randomUUID()),
          prompt: staged,
        });
      } catch (error) {
        runtimeStartedCodeTurns.delete(operationId);
        throw error;
      }
      if (
        result.kind === "provider-turn-state" &&
        (result.state === "running" || result.state === "waiting" || result.state === "completed")
      )
        return { status: "started", turnId: operationId };
      runtimeStartedCodeTurns.delete(operationId);
      return {
        status: "refused",
        message:
          result.kind === "provider-turn-state" && result.failure !== undefined
            ? result.failure.message
            : "The turn was not admitted.",
      };
    };
    const codeThreadWakeupPort: ThreadWakeupModePort = {
      threadOpen: (threadId) => {
        try {
          const thread = persistence.readCodeThread(decodeCodeThreadId(threadId));
          return thread !== undefined && thread.lifecycle !== "archived";
        } catch {
          return false;
        }
      },
      startTurn: (threadId, prompt) => startHostCodeTurn(threadId, prompt, "host"),
    };
    // The runtime's own turn runs at the thread's level as the host, like a
    // wake-up's; its prompt is never sent, it records why the turn exists.
    startCodeRuntimeTurn = async (key) => {
      if (!key.startsWith("code:")) {
        return { status: "refused", message: "That session is not a Code thread's." };
      }
      const outcome = await startHostCodeTurn(
        key.slice("code:".length),
        RUNTIME_STARTED_TURN_PROMPT,
        "runtime",
      );
      return outcome.status === "started" ? { status: "started" } : outcome;
    };
    // A linked pull request's checks turning red is a user obligation, not an
    // agent event: every snapshot refresh feeds the durable follow-up marker on
    // the owning thread. Read-only toward GitHub; only an explicit completion
    // clears the marker.
    const failingChecksFollowUps = new FailingChecksFollowUps({
      followUps: codeFollowUpService,
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
    });
    onPullRequestSnapshotRefreshed((rows) => {
      void failingChecksFollowUps.observe(rows);
    });
    const boardRouteCodeService: CodeRouteService = withCodeBoard(
      baseRouteCodeService,
      async (windowId, query) => {
        const bootstrap = await baseRouteCodeService.bootstrap(windowId);
        const projects = await projectService.bootstrap(windowId);
        const projectById = new Map(
          projects.active.map((project) => [String(project.id), project] as const),
        );
        const checkoutById = new Map(
          bootstrap.checkouts.map((checkout) => [String(checkout.id), checkout] as const),
        );
        const plannerThreadIds = new Set((bootstrap.plannerThreadIds ?? []).map(String));
        const boardThreads: CodeBoardThread[] = bootstrap.threads
          // A coordinator is never a board card: it has no delivery and no
          // Done. The designated planner reads as a coordinator, so it is left
          // out too.
          .filter(
            (thread) =>
              thread.lifecycle !== "archived" &&
              thread.completedAt === undefined &&
              thread.coordinator !== true &&
              !(
                thread.coordinatorThreadId === undefined && plannerThreadIds.has(String(thread.id))
              ),
          )
          .map((thread) => {
            const project = projectById.get(String(thread.projectId));
            return {
              thread,
              project: { id: thread.projectId, name: project?.name ?? thread.title },
              checkout: checkoutById.get(String(thread.checkoutId)),
              // A temporarily missing Project projection keeps the thread visible
              // in a recovery state instead of dropping the card.
              projectProjectionPresent: project !== undefined,
              // Follow-up is the durable, journal-rebuildable obligation.
              // Client unread is overlaid by each renderer and never stored on
              // the server card.
              followUp: codeFollowUpService.read(thread.id).followUp?.state === "open",
            };
          });
        const board = new CodeThreadBoardService({
          threads: { list: () => boardThreads },
          metadata: codeThreadMetadataService,
          runtime: {
            observe: (threadId) => {
              const thread = persistence.readCodeThread(threadId);
              return {
                ...boardRuntimeActivityFromWorks(persistence.readCodeRuntimeWorks(threadId), {
                  turnParkedOnPerson:
                    codeOperationRuntime?.turnAwaitsPerson?.(String(threadId)) === true ||
                    threadAwaitsHarnessApproval(String(threadId)),
                }),
                decisionPending:
                  thread !== undefined && codeTurnDecisions.forThread(thread) !== undefined,
              };
            },
          },
          pullRequests: {
            snapshot: () => projectPullRequestService.boardSnapshot(windowId),
          },
          planProgress: codeBoardPlanProgressSource,
          finishedReceipts: {
            read: (threadId) => finishedReceipts.boardMark(String(threadId)),
          },
          outsideContent: {
            read: (threadId) => {
              if (
                !readThreadExternalContentTaint(persistence.connection, String(threadId))
                  .externalContentIngested
              ) {
                return undefined;
              }
              return readShieldWatcherLabels(persistence.connection, String(threadId)).length > 0
                ? "flagged"
                : "read";
            },
          },
          clock: () => new Date().toISOString(),
        });
        return board.query(query);
      },
    );
    // Merge when ready and Auto-fix reuse `pullRequestSwitchForge` created above.
    const pullRequestSwitchService = new CodeProjectPullRequestSwitchService({
      localWindows: () => deps.windowAuthorityStore.listWindowIds(),
      limits: () => {
        const settings = persistence.readShellSettings()?.settings ?? defaultShellSettings();
        return {
          watchWakes: settings.pullRequestWatchWakeLimit,
          watchDays: settings.pullRequestWatchDays,
          autoFixAttempts: settings.autoFixAttemptsPerFailure,
        };
      },
      authority: projectPullRequestService,
      pullRequestLinks: pullRequestLinkService,
      forge: pullRequestSwitchForge ?? {
        readAutoMergeSettings: async () => ({ status: "unavailable", reason: "unavailable" }),
        enableAutoMerge: async () => ({ status: "unavailable", reason: "unavailable" }),
        disableAutoMerge: async () => ({ status: "unavailable", reason: "unavailable" }),
        observe: async () => ({ status: "unavailable" }),
      },
      threads: {
        inspect: (threadId) => {
          const thread = persistence.readCodeThread(threadId);
          if (
            thread === undefined ||
            thread.lifecycle !== "active" ||
            thread.completedAt !== undefined
          ) {
            return { status: "gone" };
          }
          const compacting = contextHarness.compactionRunning(
            decodeContextSubjectRef({ aggregateType: "code-thread", aggregateId: threadId }),
          );
          return {
            status: "available",
            turnActive:
              compacting ||
              persistence
                .readCodeRuntimeWorks(threadId)
                .some(
                  ({ work }) =>
                    work.kind === "provider-turn" &&
                    (work.state === "running" ||
                      work.state === "waiting" ||
                      work.state === "ambiguous"),
                ),
          };
        },
        markOutsideContent: (threadId, contentReference, sourceLabel) => {
          const marked = externalContentIngestionStore.record({
            threadId,
            provenance: { origin: "external-content", sourceLabel },
            contentReference,
            correlationId: randomUUID(),
            authorized: true,
          });
          return marked.kind === "recorded" || marked.kind === "already-recorded";
        },
        // The same host path a routine's follow-up and a child's result take:
        // the thread's own access level and approvals apply to the turn.
        startTurn: async (threadId, text) => {
          const thread = persistence.readCodeThread(threadId);
          const stage = boardRouteCodeService.stageEvidence;
          const execute = boardRouteCodeService.executeOperation;
          if (thread === undefined || stage === undefined || execute === undefined) return false;
          const prompt = await stage(ROUTINE_HOST_SCOPE_ID, threadId, text);
          const result = await execute(ROUTINE_HOST_SCOPE_ID, {
            kind: "start-provider-turn",
            operationId: decodeCodeOperationId(randomUUID()),
            threadId,
            checkoutId: thread.checkoutId,
            sessionId: decodeProviderSessionId(randomUUID()),
            prompt,
          });
          return (
            result.kind === "provider-turn-state" &&
            (result.state === "running" ||
              result.state === "waiting" ||
              result.state === "completed")
          );
        },
        readFollowUp: (threadId) => codeFollowUpService.read(threadId).followUp,
        notifyPerson: async (threadId, reason) => {
          const view = codeFollowUpService.read(threadId);
          await codeFollowUpService.observeTrigger({
            threadId,
            sourceEventId: randomUUID(),
            sourceSequence:
              Math.max(
                view.followUp?.triggerSequence ?? 0,
                view.followUp?.acknowledgedThroughSequence ?? 0,
              ) + 1,
            reason,
            origin: "automatic",
            triggeredAt: new Date().toISOString(),
          });
        },
      },
      journal: persistence.journal,
      uuid: randomUUID,
    });
    pullRequestWatchService = pullRequestSwitchService;
    bindPullRequestSwitchReconciler(pullRequestSwitchService);
    // Host-local and idle-free: the forge is read only while a switch or a watch is on.
    const pullRequestSwitchAbort = new AbortController();
    const pullRequestSwitchTimer = setInterval(() => {
      if (!pullRequestSwitchService.watching) return;
      pullRequestSwitchService
        .tick(pullRequestSwitchAbort.signal)
        .catch((error: unknown) => console.error("[pull-request-switches] pass failed", error));
    }, 60_000);
    pullRequestSwitchTimer.unref?.();
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        clearInterval(pullRequestSwitchTimer);
        pullRequestSwitchAbort.abort();
      }),
    );
    const codeTurnCancelledListeners = new Set<(threadId: string) => void>();
    const onCodeTurnCancelled = (listener: (threadId: string) => void): void => {
      codeTurnCancelledListeners.add(listener);
    };
    const boardExecuteOperation =
      boardRouteCodeService.executeOperation?.bind(boardRouteCodeService);
    const routeCodeService: CodeRouteService = {
      ...boardRouteCodeService,
      readFollowUp: (_windowId, threadId) => codeFollowUpService.read(threadId),
      executeFollowUp: (_windowId, command) => codeFollowUpService.execute(command),
      readPlanner: (windowId, projectId) => codePlannerService.readView(windowId, projectId),
      executePlanner: (windowId, command, actor) =>
        codePlannerService.execute(windowId, command, actor),
      executePlannerProposal: (windowId, command, signal, actor) =>
        codePlannerService.resolveProposal(windowId, command, signal, actor),
      queryProjectPullRequests: async (windowId, query) =>
        pullRequestSwitchService.withBabysitProgress(
          await projectPullRequestService.query(windowId, query),
        ),
      refreshProjectPullRequests: async (windowId, command, signal) => {
        const view = await projectPullRequestService.refresh(
          windowId,
          command,
          signal ?? new AbortController().signal,
        );
        // A fresh explicit refresh proves gh works again; it is one of the
        // two documented signals that restart a cadence stopped by an
        // unauthorized observation.
        if (view.freshness.status === "fresh") {
          projectPullRequestCadence.noteExplicitRefreshSucceeded();
        }
        return pullRequestSwitchService.withBabysitProgress(view);
      },
      queryProjectPullRequestDetail: (windowId, query) =>
        projectPullRequestService.queryDetail(windowId, query),
      refreshProjectPullRequestDetail: (windowId, command, signal) =>
        projectPullRequestService.refreshDetail(
          windowId,
          command,
          signal ?? new AbortController().signal,
        ),
      // A paired phone or web client merges under the same head and
      // required-check rules as the desktop window; it must also carry the
      // person's confirmation, which the service enforces.
      mergeProjectPullRequest: (windowId, command, signal, caller, actor) =>
        projectPullRequestService.merge(
          windowId,
          command,
          signal ?? new AbortController().signal,
          caller,
          actor,
        ),
      mergeProjectPullRequestStack: (windowId, command, signal, caller, actor) =>
        projectPullRequestActionService.mergeStack(windowId, command, signal, caller, actor),
      actOnProjectPullRequest: (windowId, command, signal, caller, actor) =>
        projectPullRequestActionService.act(windowId, command, signal, caller, actor),
      readProjectPullRequestActionContext: (windowId, query, signal, caller) =>
        projectPullRequestActionService.readContext(windowId, query, signal, caller),
      ...pullRequestAutoFixRoutes(pullRequestSwitchService, deps.isPairedDeviceSessionCurrent),
      setProjectPullRequestMergeWhenReady: (windowId, command, signal, caller, actor) =>
        pullRequestSwitchService.setMergeWhenReady(windowId, command, caller, signal, actor),
      noteComposerActivity: (_windowId, activity) =>
        pullRequestSwitchService.noteComposerActivity(activity.threadId),
      // A person's Stop that interrupts a Code turn is told to hosts composed
      // after Code (delegation to another member), as a Work turn's Stop is.
      ...(boardExecuteOperation === undefined
        ? {}
        : {
            executeOperation: async (windowId, command, options) => {
              const result = await boardExecuteOperation(windowId, command, options);
              if (
                command.kind === "cancel-provider-turn" &&
                result.kind === "provider-turn-state" &&
                result.state === "interrupted"
              ) {
                for (const listener of codeTurnCancelledListeners)
                  listener(String(command.threadId));
              }
              return result;
            },
          }),
    };
    // A Code thread's live tasks are read and stopped by a window that can
    // open the thread on this host; a paired device does not see them yet.
    const codeSessionRoutes = createCodeSessionRouteHandler({
      windowAuthorityStore: deps.windowAuthorityStore,
      canOpenThread: (windowId, threadId) => {
        const device = deps.isPairedDeviceScope(windowId);
        if (device && deps.isRestrictedDeviceScope(windowId)) return false;
        try {
          const thread = persistence.readCodeThread(threadId);
          if (thread === undefined) return false;
          return device
            ? codeProjectAccess.hasActiveCodeProject(thread.projectId)
            : canAccessCodeProject(windowId, thread.projectId);
        } catch {
          return false;
        }
      },
      liveTasks: (threadId) => outlivingCodeSessions.liveTasks(codeSessionKey(threadId)),
      stopLiveTasks: (threadId) => outlivingCodeSessions.stopThread(codeSessionKey(threadId)),
      // A window here or the host's own paired device is the person; the
      // host acting for a routine or a hub-introduced device is not.
      isPerson: (windowId) =>
        !isRoutineHostScope(windowId) && !deps.isRestrictedDeviceScope(windowId),
      nativeSessions: () => codeOperationRuntime?.nativeSessions,
    });
    const pullRequestReviewers = new PullRequestReviewerRegistry();
    pullRequestReviewers.register({
      reviewerId: SECOND_MODEL_PULL_REQUEST_REVIEWER_ID,
      displayName: SECOND_MODEL_PULL_REQUEST_REVIEWER_DISPLAY_NAME,
      activation: () => {
        const effective = isFirstPartyIntegrationEffective(
          extensionApiService.snapshot(),
          SECOND_MODEL_PULL_REQUEST_REVIEWER_COMPONENT_ID,
          { missingRow: "effective" },
        );
        return { installed: true, trusted: true, enabled: effective };
      },
      reviewer: createSecondModelPullRequestReviewer(),
    });
    const pullRequestReviewHost = createPullRequestReviewHostRuntime({
      ghExecutable: options.ghExecutable,
      providerDataDirectory,
      connection: persistence.connection,
      journal: persistence.journal,
      readProviderInstances: () => persistence.readProviderInstances(),
      observedProviderState: (instanceId) => providerRuntimeRegistry.observedState(instanceId),
      isProviderModelAllowed: isCodeProviderModelAllowed,
      createDriver: (instance) => makeConfiguredProviderDriver(instance, configuredDriverOptions),
      executeOperation: async (windowId, command) => {
        const execute = boardRouteCodeService.executeOperation;
        if (execute === undefined) {
          throw new Error("Code operation runtime is unavailable.");
        }
        return execute(windowId, command);
      },
      readOperationEvidence: async (windowId, threadId, operationId, contentId) => {
        const read = boardRouteCodeService.readOperationContent;
        if (read === undefined) {
          throw new Error("Code operation evidence is unavailable.");
        }
        const evidence = await read(windowId, threadId, operationId, contentId);
        return { text: new TextDecoder().decode(evidence.bytes) };
      },
      resolveReviewTarget: async (windowId, input, admissionCurrent) => {
        const resolve = codeOperationRuntime?.resolveReviewTarget;
        if (resolve === undefined) {
          throw new Error("Code review target resolver is unavailable.");
        }
        return resolve(windowId, input, admissionCurrent);
      },
      retainPullRequestDiff: async (windowId, input) => {
        const retain = codeOperationRuntime?.retainPullRequestDiff;
        if (retain === undefined) {
          throw new Error("Code pull request diff retainer is unavailable.");
        }
        return retain(windowId, input);
      },
      createFinding: async (input, actor) => {
        const create = codeOperationRuntime?.createReviewFinding;
        if (create === undefined) {
          throw new Error("Code review finding writer is unavailable.");
        }
        return create(ROUTINE_HOST_SCOPE_ID, input, undefined, actor);
      },
      spendCeiling,
      turnMetrics,
    });
    const pullRequestReviewService = new PullRequestReviewService({
      registry: pullRequestReviewers,
      journal: persistence.journal,
      authority: {
        canAccessProject: (windowId, projectId) => canAccessCodeProject(windowId, projectId),
        authorizePullRequest: (windowId, target) =>
          projectPullRequestService.authorizePullRequest(windowId, target),
      },
      threads: {
        readThread: (threadId) => persistence.readCodeThread(threadId),
        isWorkerTurnActive: (threadId) => {
          const compacting = contextHarness.compactionRunning(
            decodeContextSubjectRef({ aggregateType: "code-thread", aggregateId: threadId }),
          );
          return (
            compacting ||
            persistence
              .readCodeRuntimeWorks(threadId)
              .some(
                ({ work }) =>
                  work.kind === "provider-turn" &&
                  (work.state === "running" ||
                    work.state === "waiting" ||
                    work.state === "ambiguous"),
              )
          );
        },
        isStrict: (threadId) => resolveThreadStrict(String(threadId)),
        maxStrictHandBackAttempts: () =>
          (persistence.readShellSettings()?.settings ?? defaultShellSettings())
            .autoFixAttemptsPerFailure,
        markOutsideContent: (threadId, contentReference, sourceLabel) => {
          const marked = externalContentIngestionStore.record({
            threadId,
            provenance: { origin: "external-content", sourceLabel },
            contentReference,
            correlationId: randomUUID(),
            authorized: true,
          });
          return marked.kind === "recorded" || marked.kind === "already-recorded";
        },
        startWorkerTurn: async (threadId, text) => {
          const thread = persistence.readCodeThread(threadId);
          const stage = boardRouteCodeService.stageEvidence;
          const execute = boardRouteCodeService.executeOperation;
          if (thread === undefined || stage === undefined || execute === undefined) return false;
          const prompt = await stage(ROUTINE_HOST_SCOPE_ID, threadId, text);
          const result = await execute(ROUTINE_HOST_SCOPE_ID, {
            kind: "start-provider-turn",
            operationId: decodeCodeOperationId(randomUUID()),
            threadId,
            checkoutId: thread.checkoutId,
            sessionId: decodeProviderSessionId(randomUUID()),
            prompt,
          });
          return (
            result.kind === "provider-turn-state" &&
            (result.state === "running" ||
              result.state === "waiting" ||
              result.state === "completed")
          );
        },
        notifyPerson: async (threadId, reason) => {
          const view = codeFollowUpService.read(threadId);
          await codeFollowUpService.observeTrigger({
            threadId,
            sourceEventId: randomUUID(),
            sourceSequence:
              Math.max(
                view.followUp?.triggerSequence ?? 0,
                view.followUp?.acknowledgedThroughSequence ?? 0,
              ) + 1,
            reason,
            origin: "automatic",
            triggeredAt: new Date().toISOString(),
          });
        },
      },
      runtime: pullRequestReviewHost.runtime,
      uuid: randomUUID,
    });
    onPullRequestSnapshotRefreshed((rows) => {
      void pullRequestReviewHost
        .observeSnapshotRows(pullRequestReviewService, rows)
        .catch((error: unknown) => console.error("[pull-request-reviews] pass failed", error));
    });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        pullRequestReviewService.dispose();
      }),
    );
    const pullRequestReviewRoutes = createPullRequestReviewRouteHandler({
      service: pullRequestReviewService,
      windowAuthorityStore: deps.windowAuthorityStore,
    });
    return {
      androidToolchainRoutes,
      appleToolchainRoutes,
      baseRouteCodeService,
      codeSessionRoutes,
      codeCompletedThreadSource,
      codeOperationRuntime,
      codeService,
      codeTurnDecisions,
      mergedThreadPutAway,
      contributeCodeTools,
      registerCodeEditDiagnostics,
      contributeServerCodeTools,
      coordinatorService,
      coordinatorWakes,
      codeThreadWakeupPort,
      pullRequestReviewers,
      pullRequestReviewRoutes,
      pullRequestReviewService,
      routeCodeService,
      onCodeTurnCancelled,
      terminalProcessPort,
    };
  });
}

export type CodeRuntimeWiring = Effect.Effect.Success<ReturnType<typeof wireCodeRuntime>>;

/**
 * Resolves the active working folder for a Code turn's host media tools from
 * the thread's checkout (existing worktree or managed linked worktree),
 * approved extra folder, and pinned physical directory identity.
 */
export async function resolveCurrentCodeTurnRoot(input: {
  readonly thread: Pick<CodeThread, "id" | "projectId">;
  readonly checkoutRoot: string | undefined;
  readonly pinnedCheckout?: (() => boolean) | undefined;
  readonly readCodeThread: ServerStart["persistence"]["readCodeThread"];
  readonly readProject: ServerStart["persistence"]["readProject"];
  readonly threadProjectAssetRoot: CanvasWiring["threadProjectAssetRoot"];
}): Promise<string | undefined> {
  if (input.checkoutRoot === undefined) return undefined;
  const current = input.readCodeThread(input.thread.id);
  const checkout = await input.threadProjectAssetRoot({
    mode: "code",
    threadId: String(input.thread.id),
    projectId: String(input.thread.projectId),
  });
  const project = input.readProject(input.thread.projectId);
  if (checkout === undefined || current === undefined || project?.type !== "code") {
    return undefined;
  }
  const selected = approvedWorkingFolderRoot(project, current.workingFolderId, checkout);
  if (selected === undefined) return undefined;
  const root = await resolveThreadWorkingDirectory(
    selected,
    current.workingDirectory ?? decodeThreadWorkingDirectory("."),
  ).catch(() => undefined);
  return root === input.checkoutRoot && input.pinnedCheckout?.() !== false ? root : undefined;
}
