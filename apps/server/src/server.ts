import { createConversationInputRoutes } from "./attachments/conversationInputRoutes";
import type { ConversationInputOwner } from "./attachments/conversationInputTransfer";
import type {
  ConversationInputQuery,
  ConversationInputReceipt,
} from "@octant/contracts/conversation-inputs";
import { isToolAllowedByAllowlist } from "@octant/domain";
import { commandCredentialPostureAllowed } from "@octant/domain/command-credential-policy";
import { CommandCredentialBindings } from "./secretStores/commandCredentialBindings";
import { commandCredentialContext } from "./secretStores/commandCredentialContext";
import { commandCredentialRoutes } from "./secretStores/commandCredentialRoutes";
import { savedCredentialCommands } from "./secretStores/commandCredentialTools";
import {
  createCommandCredentialExecution,
  commandCredentialRecipientPin,
} from "./secretStores/commandCredentialExecution";
import {
  readCommandCredentialHistory,
  secretStoresJournal,
} from "./secretStores/secretStoresJournal";
import { makeSecretStoreBrokerClient } from "./secretStores/secretStoreBrokerClient";
import {
  decodeProjectId,
  decodeWindowId,
  decodeChatThreadId,
  decodeThreadRetentionThreadId,
  decodeWorkTurnRequestId,
  decodeCodeThreadId,
  decodeCodeOperationId,
  MAX_CODE_OPERATION_REPLAY_LIMIT,
} from "@octant/contracts";
import { randomUUID } from "node:crypto";
import { CredentialRequests } from "./credentials/credentialRequests";
import { createCredentialRequestRoutes } from "./credentials/credentialRequestRoutes";
import { registeredCredentialOperations } from "./credentials/credentialRequestTools";
import { createCredentialTool } from "./credentials/credentialTool";
import { createCodeToolHostPort } from "./credentials/codeToolHost";
import { OCTANT_CREDENTIAL_TOOL } from "@octant/contracts/credential-request";
import {
  startupFailedOutput,
  UNCLASSIFIED_STARTUP_FAILURE,
  withStartupFailureReason,
} from "./startupFailureReason";
import { Effect, Scope } from "effect";
import { WorkFileListingService } from "./work/workFileListingService";
import { WorkThreadService } from "./work/workThreadService";
import { WorkTurnService } from "./work/workTurnService";
import { makePublishedSnapshotSource } from "./publishedSnapshotSource";
import { assertReadableChatThread } from "./chat/chatService";
import { createThreadReadAuthority } from "./threadReadAuthority";
import type { PublishedSnapshotRunRequest, WindowId } from "@octant/contracts";
import { MAX_CHAT_ATTACHMENT_BYTES } from "./chat/chatAttachmentStore";
import { MAX_CODE_FILE_BODY_SIZE } from "./codeRoutes";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { CANVAS_PREVIEW_ASSET_FOLDER, CANVAS_PREVIEW_PAGE } from "./canvas/canvasPreviewRenderer";
import { healthResponse, hostActivity } from "./health";
import {
  Persistence,
  type PersistenceService,
  PersistenceStartupFailed,
} from "./persistence/persistenceService";
import { LatencyStatsProjection } from "./latencyStatsProjection";
import { HostHealthRecorder } from "./metrics/hostHealthRecorder";
import {
  isAllowedRendererOrigin,
  isForeignLoopbackOrigin,
  isLoopbackHostname,
} from "./shellRoutes";
import {
  createCodeThreadMentionDirectory,
  ThreadMentionService,
} from "./chat/threadMentionService";
import { FileMentionService } from "./fileMentionService";
import { listHosts } from "@octant/domain";
import { localHostDisplayName } from "./localHostDisplayName";
import { isPrivateListenerFailureCode, type PrivateListenerFailureCode } from "./privateListener";
import { type ConfiguredProviderDriverOptions, wireProviders } from "./wiring/providers";
import {
  type OctantServer,
  ServerStartupFailed,
  type StartOctantServerOptions,
} from "./wiring/serverShape";
import { wireAuthority } from "./wiring/authority";
import { wireAgentRuns } from "./wiring/agentRuns";
import { wireIntegrations } from "./wiring/integrations";
import { wireUsage } from "./wiring/usage";
import { wireComputerUse } from "./wiring/computerUse";
import { wireWorkspace } from "./wiring/workspace";
import { wireFoundations } from "./wiring/foundations";
import { wireHarnessState } from "./wiring/harnessState";
import { wireWorkRequestState } from "./wiring/workRequestState";
import { wireCode } from "./wiring/code";
import { wireBrowser } from "./wiring/browser";
import { wireCodeRuntime } from "./wiring/codeRuntime";
import { wireDevices } from "./wiring/devices";
import { wireCodeTooling } from "./wiring/codeTooling";
import { wireHarness } from "./wiring/harness";
import { wireChat } from "./wiring/chat";
import { wireWork } from "./wiring/work";
import { wireContinuation } from "./wiring/continuation";
import { wireZen } from "./wiring/zen";
import { wireContext } from "./wiring/context";
import { wireWorkFiles } from "./wiring/workFiles";
import { wireProviderCloudSessions } from "./wiring/providerCloudSessions";
import { wireCanvas } from "./wiring/canvas";
import { wireAutomation } from "./wiring/automation";
import { ROUTINE_HOST_SCOPE_ID } from "./routineHostScope";
import { wireBenchmarks, type BenchmarkThreadPurgeSlot } from "./wiring/benchmarks";
import { integrationEventSources } from "./integration/integrationEventSources";
import { wireThreadNotifications } from "./wiring/notifications";
import { wireWorkRequests } from "./wiring/workRequests";
import { wireRoutes } from "./wiring/routes";
import { wireRemote } from "./wiring/remote";
import { createAgentGrantRouteSlot } from "./agentAccess/agentGrantRoutes";
import { createThreadMoveHolds } from "./hub/threadMoveHolds";
import { createThreadMoveStateStore, heldThreadsOf } from "./hub/threadMoveStateStore";
import { wireReplica } from "./wiring/replica";

export { MAX_CHAT_ATTACHMENT_BYTES };

export { MAX_CODE_FILE_BODY_SIZE };

export {
  createRemoteRequestFacts,
  deriveRemoteSourceKey,
  classifyRemoteSourceClass,
  normalizePeerAddress,
  resetProcessRequestFactsSaltForTests,
} from "./remoteRequestFacts";

type InjectedStartOptions = StartOctantServerOptions & {
  readonly acquirePersistence: Effect.Effect<PersistenceService, PersistenceStartupFailed>;
};
export { admittedParentChatContext, createAgentRunControlWorkspace } from "./wiring/agentRuns";
export { sameCanvasSkillScope } from "./wiring/canvas";
export {
  createExistingWorktreeCodeCheckoutObservation,
  createExistingWorktreeCodeFileRootAuthority,
  deriveExistingWorktreeCheckoutId,
  plainFolderCheckoutIdentity,
} from "./wiring/code";
import { resolveWebAssetsPath } from "./wiring/computerUse";
export { resolveWebAssetsPath };
export { stableAppleRootId } from "./wiring/devices";
export { makeConfiguredProviderDriver, pathIsProjectConfined } from "./wiring/providers";
export {
  MAX_JSON_REQUEST_BODY_SIZE,
  MAX_REQUEST_BODY_SIZE,
  ServerStartupFailed,
} from "./wiring/serverShape";
export type {
  OctantServer,
  RemoteListenerTrust,
  RemoteSourceClass,
  RequestTransportFacts,
  Serve,
  ServeOptions,
  StartOctantServerOptions,
} from "./wiring/serverShape";

export function startOctantServer(
  options: InjectedStartOptions,
): Effect.Effect<OctantServer, PersistenceStartupFailed | ServerStartupFailed, Scope.Scope>;
export function startOctantServer(
  options: StartOctantServerOptions,
): Effect.Effect<
  OctantServer,
  PersistenceStartupFailed | ServerStartupFailed,
  Persistence | Scope.Scope
>;
export function startOctantServer(
  options: StartOctantServerOptions,
): Effect.Effect<
  OctantServer,
  PersistenceStartupFailed | ServerStartupFailed,
  Persistence | Scope.Scope
> {
  if (!isLoopbackHostname(options.hostname)) {
    return Effect.fail(
      new ServerStartupFailed({
        category: "server-unavailable",
        message: "Octant only binds the local server to loopback.",
      }),
    );
  }
  return Effect.gen(function* () {
    const persistence = yield* options.acquirePersistence ?? Persistence;
    const status = persistence.status();
    if (status.state !== "current" || status.integrity !== "ok") {
      return yield* Effect.fail(
        new PersistenceStartupFailed({
          category: "recovery-required",
          message: "Octant storage requires recovery before startup.",
        }),
      );
    }
    const latencyStats = new LatencyStatsProjection();
    for (const fact of persistence.projectionCatchUp) {
      latencyStats.record("projection-catch-up", fact.durationMs);
    }
    const hostHealth = new HostHealthRecorder({
      path: join(persistence.dataDirectory, "host-health.sqlite3"),
      latencyWindow: () => latencyStats.takeWindow(),
      // The main file's size on disk, not page_count * page_size: in WAL mode
      // the page count includes pages that still live in the write-ahead log.
      databaseBytes: () => {
        const row = persistence.connection
          .prepare("SELECT file FROM pragma_database_list WHERE name = 'main'")
          .get();
        if (typeof row !== "object" || row === null || !("file" in row)) return undefined;
        if (typeof row.file !== "string" || row.file === "") return undefined;
        try {
          return statSync(row.file).size;
        } catch {
          return undefined;
        }
      },
    });
    const stopHostHealth = hostHealth.start();
    yield* Effect.addFinalizer(() => Effect.sync(stopHostHealth));

    const serve = options.serve;
    if (serve === undefined) {
      return yield* Effect.fail(
        new ServerStartupFailed({
          category: "server-unavailable",
          message: "Octant did not select a local server runtime.",
        }),
      );
    }
    const version = options.version ?? "0.0.0-dev";
    const startedAt = Date.now();

    const {
      conversationInputTransfer,
      browserAuthority,
      codeBoardEventStore,
      codeSessionConversation,
      codeEvidence,
      hostMemoryGuard,
      isProjectPolicyTargetAllowed,
      providerRuntimeRegistry,
      selectCodeConversation,
      workArtifactProjection,
      workThreadProjection,
      workTurnProjection,
      workTurnsCutOffByRestart,
    } = wireFoundations({ latencyStats, options, persistence });
    const {
      agentRunParentAuthority,
      agentRunRequestOwner,
      agentRunPersistence,
      agentRunsCutOffByRestart,
      androidInputGrants,
      automationEventStore,
      bindingReceiptStore,
      browserCaptureStore,
      browserCaptures,
      browserModelBindings,
      codeActiveTurns,
      codeApprovalStore,
      codeParentActiveTurn,
      codeSessionAuthority,
      extensionToolApprovalService,
      isPairedDeviceScope,
      liveTurns,
      machineChangeFeed,
      onAgentRunExecutionAccepted,
      onWindowRevoked,
      personMemory,
      personMemoryAccess,
      personMemoryRoutes,
      protectedFilesRoutes,
      processAuthorityNow,
      processAuthorityTime,
      routineProposalService,
      imageGenerationOffers,
      simulatorInputGrants,
      unsubscribeMachineChanges,
      windowAuthorityStore,
    } = wireAuthority({
      browserAuthority,
      options,
      persistence,
    });
    const {
      agentRunInteractions,
      serverConnection,
      serverProjectStore,
      serverRegistry,
      shieldHolder,
      nativeHarnessApprovals,
      nativeHarnessQuestions,
      nativeHarnessSessions,
      onHarnessQuestionAsked,
      onHarnessQuestionSettled,
      threadAwaitsHarnessQuestion,
    } = wireHarnessState({
      agentRunParentAuthority,
      agentRunRequestOwner,
      agentRunPersistence,
      persistence,
      workThreadProjection,
    });
    const {
      agentRunAdmission,
      agentRunChildWorktree,
      agentRunLiveConversations,
      agentRunOrchestration,
      agentRunProcessSupervisor,
      agentRunRouteDependencies,
      agentRunSessionStore,
      agentRunSettingsRoutes,
      agentsManagedToolsFor,
      capacityScheduler,
      contributeChildTools,
      coordinatorWorkersHolder,
      externalContentIngestionStore,
      managedWorktreeReceipts,
      nativeHarnessRouter,
      nativeHarnessRoutingStore,
      remoteDelegationHolder,
      runtimeOutsideContentMarks,
      sideTasks,
      spendCeiling,
      spendCeilingHolder,
      threadAwaitsHarnessApproval,
      threadFollowUpSuggestions,
      turnMetrics,
    } = wireAgentRuns({
      agentRunParentAuthority,
      agentRunPersistence,
      codeBoardEventStore,
      codeParentActiveTurn,
      codeSessionAuthority,
      configuredDriverOptions: (): ConfiguredProviderDriverOptions => configuredDriverOptions,
      isProjectPolicyTargetAllowed,
      nativeHarnessSessions,
      nativeHarnessApprovals,
      agentRunInteractions,
      onAgentRunExecutionAccepted,
      options,
      persistence,
      providerRuntimeRegistry,
      selectCodeConversation,
      windowAuthorityStore,
      workThreadProjection,
      workTurnProjection,
    });
    const {
      agentMessageProjection,
      agentMessageService,
      cacheStats,
      consumeCreateFromIssueFramed,
      gistConnection,
      githubAuthenticationPort,
      githubCapabilityService,
      githubCataloguePort,
      githubExtensionSnapshot,
      githubIntegrationIsEffective,
      githubIssueContextService,
      githubReadToolService,
      linearRoutineEventSources,
      githubRoutes,
      integrationRoutes,
      credentialOperations,
      linearIssueContextService,
      onGithubPullRequestsUnreadable,
      peekCreateFromIssueFramed,
      siblingThreadsService,
      terminalSessionImports,
      movedThreadHistory,
      terminalSessionRoutes,
      threadOutsideContentMarks,
      toolEgressRules,
      providerRuntimeNetwork,
      safeNetworkRoutes,
      safeNetworkStore,
    } = yield* wireIntegrations({
      managedWorktreeReceipts,
      codeActiveTurns,
      externalContentIngestionStore,
      options,
      persistence,
      shieldHolder,
      windowAuthorityStore,
      workThreadProjection,
    });
    const {
      diagnosticsExportRoutes,
      spendCeilingRoutes,
      usageDashboardRoutes,
      usageRoutes,
      validationEventStore,
      validationEvidenceRoutes,
      zenEventStore,
    } = wireUsage({
      cacheStats,
      hostHealth,
      latencyStats,
      persistence,
      spendCeilingHolder,
      turnMetrics,
      version,
      windowAuthorityStore,
    });
    const {
      computerToolsFor,
      computerUseProcess,
      computerUseRoutes,
      computerUseRuntime,
      computerUseTools,
      threadDesktopDestination,
      desktopPaneRoutes,
      desktopLeases,
      installDesktopPreviewRequest,
      desktopRecipeKeys,
      launchSessionRoutes,
      machineChangeRoutes,
      offeredDesktopProviders,
      stopComputerSettingsWatch,
      stopDesktopLeases,
      webAssets,
    } = wireComputerUse({
      onWindowRevoked,
      browserAuthority,
      externalContentIngestionStore,
      machineChangeFeed,
      managedWorktreeReceipts,
      options,
      persistence,
      processAuthorityNow,
      processAuthorityTime,
      providerRuntimeRegistry,
      validationEventStore,
      windowAuthorityStore,
      workThreadProjection,
    });
    // Which threads a move holds is shared by every mode's service and the
    // move routes, and rebuilt from the saved moves so a restart keeps them
    // held. The shell reads its departures too, to open a moved thread's
    // tombstone. Moves keep their state in the host's data folder.
    const threadMoveState = createThreadMoveStateStore(persistence.dataDirectory);
    const threadMoveHolds = createThreadMoveHolds(heldThreadsOf(threadMoveState.load()));
    const {
      authorizeWorkThreadForWindow,
      codeBoardPlanProgressSource,
      contextHarness,
      gitEnvironmentPort,
      gitObservationPort,
      githubCloneRoutes,
      githubRepositoryObservationPort,
      goalRoutes,
      goalService,
      managedCloneProcessPort,
      managedCloneService,
      planRoutes,
      projectBindingRoutes,
      projectMemoryAccess,
      projectRootPort,
      projectService,
      replyDetailRoutes,
      shellRoutes,
      shellService,
      shipRoutes,
      spendCeilingService,
      themeRoutes,
      workProjectStatusFiles,
      workProjectStatusReader,
    } = yield* wireWorkspace({
      isPairedDeviceScope,
      machineChangeFeed,
      onWindowRevoked,
      serverProjectStore,
      bindingReceiptStore,
      githubCapabilityService,
      githubIntegrationIsEffective,
      desktopRecipeKeys,
      offeredDesktopProviders,
      options,
      persistence,
      providerRuntimeRegistry,
      spendCeilingHolder,
      threadMoveState,
      windowAuthorityStore,
      workThreadProjection,
    });
    const {
      runningWorkTurnAccess,
      runningWorkTurnSandbox,
      runningWorkTurns,
      workRequestRuntime,
      workRequestService,
      workShieldHolder,
    } = wireWorkRequestState({
      persistence,
      workThreadProjection,
    });
    const {
      agentPluginMcpSessionManager,
      bindCodeToolHost,
      githubRoutineEventSources,
      chatAttachmentStore,
      chatDataDirectory,
      claudeResumeIdentityStore,
      codeThreadDrivers,
      configuredDriverOptions,
      credentialBroker,
      credentialResolver,
      discoveryRoutes,
      canvasExportWorkerOptions,
      extensionActivationService,
      extensionApiService,
      extensionLifecycleService,
      extensionPackageStore,
      extensionRoutes,
      providerToolingRoutes,
      generatedImageStore,
      imageJobService,
      localUsageHistoryRoutes,
      managedCodeThreadCreation,
      managedWorktreeRefsList,
      worktreePreparation,
      childWorktreeSources,
      resolveChildWorktree,
      managedWorktreeSourcePreview,
      nativeHarnessLeadFallback,
      nativeHarnessTranscripts,
      probeProviderForThreads,
      localPluginImportReceipts,
      providerDataDirectory,
      providerOAuthRoutes,
      providerRoutes,
      providerService,
      providerUsageLimitsRoutes,
      providerUsageLimitsService,
      refreshStandaloneSkills,
      resolveSelectedExtensions,
      effectiveSkills,
      pinnedExtensionIds,
      reviewedModelManifest,
      managedWorktreeService,
      skillDiscoveryService,
    } = yield* wireProviders({
      serverRegistry,
      providerRuntimeNetwork,
      providerRuntimeRegistry,
      workRequestRuntime,
      agentRunChildWorktree,
      agentRunProcessSupervisor,
      agentRunSessionStore,
      computerUseProcess,
      extensionToolApprovalService,
      externalContentIngestionStore,
      githubExtensionSnapshot,
      isPairedDeviceScope,
      latencyStats,
      managedWorktreeReceipts,
      nativeHarnessRouter,
      nativeHarnessSessions,
      options,
      persistence,
      processAuthorityNow,
      processAuthorityTime,
      version,
      windowAuthorityStore,
      workThreadProjection,
    });
    const {
      readHarnessProcessReceipts,
      beginGoogleCliChange,
      recoverGoogleCliCommands,
      credentialCommandProcess,
      benchmarkCheckCommands,
      prepareCredentialCommand,
      personMemorySweep,
      decisionReviewModelPort,
      runtimeForgeChanges,
      followUpCreation,
      restartContinuation,
      liftRestartRecovery,
      followUpSuggestionRoutes,
      nativeHarnessComposition,
      nativeHarnessEgressRoutes,
      nativeHarnessHooks,
      nativeHarnessRoutingRoutes,
      shieldServerRoutes,
      shieldServerStore,
      serverProjectRoutes,
      serverPreviewTunnels,
      nativeHarnessSessionRoutes,
      onHarnessPausedByPerson,
      onHarnessRecoveryLifted,
      researchRouter,
      sideTaskHost,
      sideTaskRoutes,
      hostShield,
      observeTurnEnded,
      threadWork,
    } = wireHarness({
      serverConnection,
      personMemory,
      safeNetworkStore,
      projectService,
      agentRunInteractions,
      serverProjectStore,
      serverRegistry,
      shieldHolder,
      codeEvidence,
      providerRuntimeRegistry,
      providerUsageLimitsService,
      spendCeiling,
      nativeHarnessApprovals,
      nativeHarnessQuestions,
      nativeHarnessSessions,
      agentRunParentAuthority,
      nativeHarnessRouter,
      nativeHarnessRoutingStore,
      codeBoardEventStore,
      codeParentActiveTurn,
      codeSessionAuthority,
      configuredDriverOptions,
      contextHarness,
      contributeChildTools,
      effectiveSkills,
      externalContentIngestionStore,
      goalService,
      nativeHarnessLeadFallback,
      nativeHarnessTranscripts,
      options,
      persistence,
      processAuthorityTime,
      providerDataDirectory,
      runningWorkTurnAccess,
      runningWorkTurnSandbox,
      sideTasks,
      threadFollowUpSuggestions,
      toolEgressRules,
      turnMetrics,
      windowAuthorityStore,
      workThreadProjection,
      workTurnProjection,
    });
    yield* Effect.promise(recoverGoogleCliCommands);
    const {
      agentProfileRoutes,
      archivedWorktreeRoutes,
      buildCodeService,
      diskCleanupRoutes,
      canAccessCodeProject,
      codeAttachments,
      codeFileWatch,
      codeProjectAccess,
      codeTestDiscovery,
      codeWorkingDirectoryProbePath,
      environmentService,
      folderBrowseRoutes,
      folderBrowseService,
      isCodeProviderModelAllowed,
      onPullRequestSnapshotRefreshed,
      projectPullRequestActionService,
      projectPullRequestCadence,
      projectPullRequestService,
      projectRoutes,
      roots,
      workAttachments,
    } = yield* wireCode({
      projectMemoryAccess,
      threadMoveHolds,
      serverConnection,
      serverProjectStore,
      codeBoardEventStore,
      codeEvidence,
      isProjectPolicyTargetAllowed,
      selectCodeConversation,
      managedCodeThreadCreation,
      managedWorktreeRefsList,
      managedWorktreeService,
      managedWorktreeSourcePreview,
      probeProviderForThreads,
      refreshStandaloneSkills,
      onGithubPullRequestsUnreadable,
      onWindowRevoked,
      threadAwaitsHarnessApproval,
      bindingReceiptStore,
      cacheStats,
      codeSessionAuthority,
      externalContentIngestionStore,
      gitEnvironmentPort,
      githubIssueContextService,
      gitObservationPort,
      linearIssueContextService,
      terminalSessionImports,
      liveTurns,
      machineChangeFeed,
      managedWorktreeReceipts,
      options,
      persistence,
      projectRootPort,
      projectService,
      windowAuthorityStore,
    });
    const {
      artifactLibraryRoutes,
      artifactLibraryService,
      artifactMirrorRoutes,
      canvasAgentToolPort,
      canvasCommentService,
      canvasNetworkAccess,
      canvasPublicShareService,
      canvasRoutes,
      canvasService,
      replicaArtifactSync,
      resolveCanvasWorkspace,
      snapshotCanvas,
    } = wireCanvas({
      // Work and Code are wired below; a request only arrives after startup.
      findPublishedSnapshot: (windowId: WindowId, request: PublishedSnapshotRunRequest) =>
        makePublishedSnapshotSource({
          workTurns: (window, threadId) => workTurnService.turns(window, threadId),
          ...(routeCodeService.conversation === undefined
            ? {}
            : { codeConversation: routeCodeService.conversation }),
        })(windowId, request),
      // The remote listener is wired below; a Canvas page's proxy reads its
      // name only when a page asks for a fetch, and never fetches from it.
      canvasNetworkOwnHosts: () => {
        const hostname = privateListenerController.status().hostname;
        return hostname === null ? [] : [hostname];
      },
      // A paired device reads a thread's Canvases under the same Open check
      // its own thread routes run: Chat's read rule, Work's and Code's reads.
      threadReadAuthority: (scopeId, thread) =>
        createThreadReadAuthority({
          chat: (threadId) => assertReadableChatThread(persistence, threadId),
          work: (scope, threadId) => workThreadService.read(scope, threadId),
          code: async (scope, threadId) => (await routeCodeService.read(scope, threadId)).thread,
        })(scopeId, thread),
      agentRunPersistence,
      browserCaptures,
      chatDataDirectory,
      contributeChildTools,
      extensionApiService,
      extensionActivationService,
      canvasExportWorkerOptions,
      folderBrowseService,
      gistConnection,
      githubIntegrationIsEffective,
      imageJobService,
      managedWorktreeReceipts,
      options,
      persistence,
      projectService,
      providerRuntimeRegistry,
      shellService,
      threadOutsideContentMarks,
      windowAuthorityStore,
      workArtifactProjection,
      workThreadProjection,
    });
    const {
      browserCredentialUseService,
      browserSessionGrants,
      browserUploadPermissions,
      browserDownloadPermissions,
      browserDelegatedChildren,
      bindTerminalBrowserSessions,
      terminalBrowserTools,
      routineBrowserTools,
      browserAutomationService,
      browserExtensionService,
      browserFlowService,
      browserFlows,
      browserProfileService,
      browserToolApprovalService,
      liveProjectBrowsers,
      productFeedbackRoutes,
      nativeBrowserPresentationRoutes,
      productFeedbackService,
      projectBrowserService,
      resolveFeedbackThread,
      windowHoldsProject,
    } = yield* wireBrowser({
      browserAuthority,
      providerRuntimeRegistry,
      contributeChildTools,
      agentRunInteractions,
      codeSessionAuthority,
      machineChangeFeed,
      onWindowRevoked,
      browserCaptures,
      codeEvidence,
      externalContentIngestionStore,
      options,
      persistence,
      processAuthorityTime,
      localPluginImportReceipts,
      providerDataDirectory,
      shellService,
      windowAuthorityStore,
      workThreadProjection,
    });
    const {
      androidToolchainService,
      appleToolchainService,
      bindDeviceApprovals,
      recordAppleEvidence,
    } = yield* wireDevices({
      androidInputGrants,
      codeSessionAuthority,
      persistence,
      projectService,
      providerDataDirectory,
      roots,
      simulatorInputGrants,
      windowAuthorityStore,
    });
    const {
      androidToolchainRoutes,
      appleToolchainRoutes,
      baseRouteCodeService,
      codeCompletedThreadSource,
      codeOperationRuntime,
      codeService,
      codeTurnDecisions,
      contributeCodeTools,
      coordinatorService,
      coordinatorWakes,
      routeCodeService,
      terminalProcessPort,
    } = yield* wireCodeRuntime({
      threadMoveHolds,
      codeSessionConversation,
      worktreePreparation,
      conversationInputTransfer,
      browserModelBindings,
      personMemoryAccess,
      serverConnection,
      serverProjectStore,
      shieldServerStore,
      hostShield,
      imageGenerationOffers,
      imageJobService,
      runtimeForgeChanges,
      onHarnessQuestionAsked,
      onHarnessQuestionSettled,
      onHarnessRecoveryLifted,
      workRequestRuntime,
      onPullRequestSnapshotRefreshed,
      onWindowRevoked,
      threadAwaitsHarnessApproval,
      agentMessageService,
      agentRunPersistence,
      agentsManagedToolsFor,
      coordinatorWorkersHolder,
      androidInputGrants,
      androidToolchainService,
      bindDeviceApprovals,
      buildCodeService,
      appleToolchainService,
      browserAuthority,
      canAccessCodeProject,
      canvasAgentToolPort,
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
      codeThreadMentionDirectory: (): ReturnType<typeof createCodeThreadMentionDirectory> =>
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
      fileMentionService: (): FileMentionService => fileMentionService,
      githubExtensionSnapshot,
      githubReadToolService,
      isCodeProviderModelAllowed,
      liveTurns,
      machineChangeFeed,
      nativeHarnessComposition,
      nativeHarnessHooks,
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
      projectService,
      providerDataDirectory,
      providerRuntimeRegistry,
      recordAppleEvidence,
      bindTerminalBrowserSessions,
      terminalBrowserTools,
      routineBrowserTools,
      browserAutomationService,
      browserFlows,
      browserToolApprovalService,
      resolveSelectedExtensions,
      pinnedExtensionIds,
      roots,
      runtimeOutsideContentMarks,
      selectCodeConversation,
      siblingThreadsService,
      sideTasks,
      simulatorInputGrants,
      spendCeiling,
      threadMentionService: (): ThreadMentionService => threadMentionService,
      threadOutsideContentMarks,
    });
    // Octant Shield's decisions show on the transcript beside the tool rows:
    // a Code thread's operation, or a Work thread's running turn, which takes
    // a decision only when it carries the call it was for. The runtimes that
    // own the transcripts are built after Shield.
    hostShield.showDecisionsWith((input) => {
      codeOperationRuntime?.recordShieldReview?.(input);
      if (input.requestId !== undefined) {
        workTurnService.recordShieldReview({
          threadId: input.threadId,
          requestId: input.requestId,
          toolName: input.toolName ?? "Approval",
          summary: input.summary,
          decision: input.decision,
        });
      }
    });
    workShieldHolder.port = hostShield;
    const {
      codeCheckoutOpenRoutes,
      codeExternalEditorRoutes,
      codeOperationApprovalRoutes,
      codeRoutes,
      debugConfigurationApprovals,
      debugService,
      languageServerApprovals,
      localServerRoutes,
      pairedMergeUnlockSlot,
      projectTerminals,
      remoteServerGrantLocalRoutes,
      remoteServerGrants,
    } = yield* wireCodeTooling({
      onWindowRevoked,
      desktopLeases,
      installDesktopPreviewRequest,
      workThreadProjection,
      agentRunPersistence,
      worktreePreparation,
      childWorktreeSources,
      resolveChildWorktree,
      browserAuthority,
      serverConnection,
      serverProjectStore,
      canAccessCodeProject,
      codeFileWatch,
      codeOperationRuntime,
      codeSessionAuthority,
      contributeCodeTools,
      codeWorkingDirectoryProbePath,
      extensionLifecycleService,
      extensionPackageStore,
      managedWorktreeReceipts,
      externalContentIngestionStore,
      options,
      persistence,
      projectRootPort,
      projectService,
      roots,
      routeCodeService,
      terminalProcessPort,
      toolEgressRules,
      version,
      windowAuthorityStore,
    });
    const {
      chatAttemptsCutOffByRestart,
      chatHiddenThreadIds,
      chatRoutes,
      chatService,
      codeThreadMentionDirectory,
      contributeChatTools,
      guardChatAttachmentPurge,
      linkedThreadRoutes,
      navigatorAssistantBindings,
      scaffoldRoutes,
      threadCheckpointRoutes,
      threadMentionRoutes,
      threadMentionService,
      workspacePresetRoutes,
    } = yield* wireChat({
      threadMoveHolds,
      conversationInputTransfer,
      personMemoryAccess,
      projectMemoryAccess,
      workRequestRuntime,
      threadAwaitsHarnessApproval,
      agentMessageProjection,
      agentMessageService,
      agentPluginMcpSessionManager,
      agentRunPersistence,
      agentsManagedToolsFor,
      browserCaptures,
      canvasAgentToolPort,
      capacityScheduler,
      chatAttachmentStore,
      chatDataDirectory,
      codeService,
      computerToolsFor,
      computerUseTools,
      configuredDriverOptions,
      contextHarness,
      environmentService,
      extensionActivationService,
      extensionApiService,
      extensionPackageStore,
      externalContentIngestionStore,
      githubIssueContextService,
      imageGenerationOffers,
      imageJobService,
      linearIssueContextService,
      liveTurns,
      machineChangeFeed,
      nativeHarnessComposition,
      nativeHarnessHooks,
      options,
      persistence,
      providerRuntimeRegistry,
      researchRouter,
      reviewedModelManifest,
      routeCodeService,
      runtimeOutsideContentMarks,
      shellService,
      sideTasks,
      skillDiscoveryService,
      spendCeiling,
      threadOutsideContentMarks,
      threadWork,
      windowAuthorityStore,
      workFileListingService: (): WorkFileListingService => workFileListingService,
      workThreadService: (): WorkThreadService => workThreadService,
      workTurnService: (): WorkTurnService => workTurnService,
    });
    const {
      fileMentionRoutes,
      fileMentionService,
      goalLoopRoutes,
      goalLoopService,
      threadExportRoutes,
      threadExportService,
      threadHandOffProvider,
      threadHandOffRoutes,
      threadMessageQueue,
      threadMessageQueueRoutes,
      observeWorkThreadRuntime,
      onWorkTurnCancelled,
      workThreadService,
      workThreadServiceWithWorkflows,
      workTurnService,
      workflowService,
    } = yield* wireWork({
      threadMoveHolds,
      conversationInputTransfer,
      codeBoardEventStore,
      personMemoryAccess,
      projectMemoryAccess,
      runtimeForgeChanges,
      nativeHarnessSessions,
      restartContinuation,
      guardChatAttachmentPurge,
      workTurnProjection,
      threadAwaitsHarnessApproval,
      threadAwaitsHarnessQuestion,
      workRequestRuntime,
      workRequestService,
      onWindowRevoked,
      onHarnessPausedByPerson,
      runningWorkTurns,
      agentRunPersistence,
      agentsManagedToolsFor,
      authorizeWorkThreadForWindow,
      automationEventStore,
      browserAuthority,
      browserCaptures,
      browserModelBindings,
      canAccessCodeProject,
      canvasAgentToolPort,
      canvasService,
      chatAttachmentStore,
      chatService,
      codeAttachments,
      codeService,
      codeSessionAuthority,
      codeWorkingDirectoryProbePath,
      computerToolsFor,
      computerUseTools,
      configuredDriverOptions,
      consumeCreateFromIssueFramed,
      contextHarness,
      externalContentIngestionStore,
      followUpCreation,
      githubIssueContextService,
      goalService,
      imageGenerationOffers,
      imageJobService,
      linearIssueContextService,
      terminalSessionImports,
      liveTurns,
      managedWorktreeReceipts,
      nativeHarnessComposition,
      nativeHarnessHooks,
      peekCreateFromIssueFramed,
      persistence,
      probeProviderForThreads,
      productFeedbackService,
      projectService,
      providerRuntimeRegistry,
      refreshStandaloneSkills,
      routineBrowserTools,
      browserAutomationService,
      browserFlows,
      browserToolApprovalService,
      resolveFeedbackThread,
      resolveCanvasWorkspace,
      resolveSelectedExtensions,
      pinnedExtensionIds,
      roots,
      routeCodeService,
      runtimeOutsideContentMarks,
      routineProposalService,
      sideTaskHost,
      sideTasks,
      siblingThreadsService,
      spendCeiling,
      threadMentionService,
      threadOutsideContentMarks,
      windowAuthorityStore,
      windowHoldsProject,
      workArtifactProjection,
      workAttachments,
      workProjectStatusFiles,
      workProjectStatusReader,
      workThreadProjection,
      serverConnection,
      serverProjectStore,
      shieldServerStore,
    });
    const { restartRecovery } = yield* wireContinuation({
      coordinatorService,
      coordinatorWakes,
      agentRunOrchestration,
      agentRunParentAuthority,
      agentRunPersistence,
      agentRunsCutOffByRestart,
      capacityScheduler,
      chatAttemptsCutOffByRestart,
      chatService,
      codeBoardEventStore,
      codeOperationRuntime,
      contextHarness,
      externalContentIngestionStore,
      goalLoopService,
      liftRestartRecovery,
      persistence,
      routeCodeService,
      threadMessageQueue,
      workThreadProjection,
      workTurnProjection,
      workTurnsCutOffByRestart,
      workTurnService,
    });
    const { navigatorAssistantRoutes, workTurnRoutes, zenBackgroundRoutes, zenRoutes, zenService } =
      wireZen({
        contributeChatTools,
        chatService,
        githubExtensionSnapshot,
        codeOperationRuntime,
        navigatorAssistantBindings,
        persistence,
        projectService,
        projectTerminals,
        providerDataDirectory,
        providerRuntimeRegistry,
        shellService,
        windowAuthorityStore,
        windowHoldsProject,
        workThreadProjection,
        workTurnService,
        zenEventStore,
      });
    const {
      agentMessageRoutes,
      browserAutomationRoutes,
      contextRoutes,
      idleCompactions,
      windowCanOpenThread,
      flowRuns,
    } = wireContext({
      onWindowRevoked,
      browserCredentialUseService,
      browserSessionGrants,
      browserUploadPermissions,
      browserDownloadPermissions,
      agentMessageProjection,
      browserModelBindings,
      browserAuthority,
      browserAutomationService,
      browserCaptures,
      browserExtensionService,
      browserFlowService,
      browserProfileService,
      canAccessCodeProject,
      capacityScheduler,
      chatService,
      codeOperationRuntime,
      codeSessionAuthority,
      codeSessionConversation,
      configuredDriverOptions,
      contextHarness,
      hostShield,
      liveProjectBrowsers,
      nativeHarnessHooks,
      observeTurnEnded,
      persistence,
      projectService,
      providerRuntimeRegistry,
      providerUsageLimitsService,
      browserToolApprovalService,
      routeCodeService,
      serverProjectStore,
      spendCeilingService,
      windowAuthorityStore,
      workThreadProjection,
      workThreadService,
      workTurnProjection,
      workTurnService,
    });
    const {
      imageRoutes,
      previewHandoffBridgeRoutes,
      previewRoutes,
      speechRoutes,
      workFileListingRoutes,
      workFileListingService,
      workMutationRoutes,
      workResearchProjection,
      workResearchRoutes,
    } = wireWorkFiles({
      credentialResolver,
      imageGenerationOffers,
      imageJobService,
      options,
      persistence,
      projectService,
      providerDataDirectory,
      routeCodeService,
      serverConnection,
      serverProjectStore,
      shellService,
      windowAuthorityStore,
      windowCanOpenThread,
      workArtifactProjection,
      workThreadProjection,
      workThreadService,
      workTurnProjection,
    });
    const {
      automationNotificationRoutes,
      automationRoutes,
      automationCommandService,
      automationScheduler,
      completedThreadArchiveSweep,
      hasPushStanding,
      hubPushHandoffSlot,
      pushComputerLabel,
      pushDeliveryTransport,
      pushGatewaySetting,
      pushNotificationTokenStore,
    } = wireAutomation({
      options,
      integrationEventSources: integrationEventSources([
        githubRoutineEventSources,
        linearRoutineEventSources,
      ]),
      automationEventStore,
      codeEvidence,
      codeBoardEventStore,
      agentRunOrchestration,
      externalContentIngestionStore,
      readHarnessProcessReceipts,
      capacityScheduler,
      chatService,
      codeCompletedThreadSource,
      contributeCodeTools,
      liveTurns,
      persistence,
      projectService,
      routeCodeService,
      routineProposalService,
      windowAuthorityStore,
      workThreadProjection,
      workTurnProjection,
      workThreadService,
      workThreadServiceWithWorkflows,
      workTurnService,
    });
    const benchmarkThreadPurge: BenchmarkThreadPurgeSlot = {};
    const { benchmarkRoutes, benchmarkRunner } = wireBenchmarks({
      canAccessCodeProject,
      awaitsPerson: (threadId) =>
        codeOperationRuntime?.turnAwaitsPerson?.(threadId) === true ||
        threadAwaitsHarnessApproval(threadId),
      // The oldest approval or question the thread's turn waits on: when it was
      // asked, from the journal, so a restart keeps counting from then, and what
      // it asks, for a cell that ends blocked.
      pendingApproval: async (threadId) => {
        const pending = await codeOperationRuntime?.pendingRequests?.(ROUTINE_HOST_SCOPE_ID);
        const oldest = (pending ?? [])
          .filter((request) => String(request.threadId) === threadId)
          .sort((left, right) =>
            String(left.requestedAt).localeCompare(String(right.requestedAt)),
          )[0];
        return oldest === undefined
          ? undefined
          : { since: String(oldest.requestedAt), summary: oldest.text };
      },
      codeEvidence,
      benchmarkCheckCommands,
      managedWorktreeReceipts,
      managedWorktreeService,
      roots,
      routeCodeService,
      chatService,
      personMemory,
      persistence,
      projectService,
      threadPurge: benchmarkThreadPurge,
      turnMetrics,
      windowAuthorityStore,
      ...(options.allowedRendererHttpOrigin === undefined
        ? {}
        : { allowedRendererHttpOrigin: options.allowedRendererHttpOrigin }),
    });
    const { threadNotifications } = yield* wireThreadNotifications({
      chatHiddenThreadIds,
      hasPushStanding,
      persistence,
      pushComputerLabel,
      pushDeliveryTransport,
      pushNotificationTokenStore,
      workThreadProjection,
    });
    const {
      designSystemRoutes,
      fleetActivityRoutes,
      pendingRequestRoutes,
      sidebarBackgroundRoutes,
      workOverviewRoutes,
      workPromotionRoutes,
      workRequestRoutes,
      workThreadRoutes,
    } = wireWorkRequests({
      decisionReviewModelPort,
      isProjectPolicyTargetAllowed,
      observeWorkThreadRuntime,
      workRequestService,
      agentRunPersistence,
      baseRouteCodeService,
      chatService,
      codeOperationRuntime,
      codeTurnDecisions,
      gitObservationPort,
      goalService,
      nativeHarnessApprovals,
      nativeHarnessQuestions,
      nativeHarnessSessions,
      persistence,
      projectService,
      providerDataDirectory,
      routeCodeService,
      windowAuthorityStore,
      workArtifactProjection,
      workflowService,
      workProjectStatusReader,
      workResearchProjection,
      workThreadProjection,
      workThreadService,
      workThreadServiceWithWorkflows,
      workTurnProjection,
    });
    const {
      artifactSyncService,
      replicaMembershipRoutes,
      replicaMembershipService,
      replicaStoreSettingsRoutes,
      replicaSyncStatusRoutes,
      syncedArtifactRoutes,
    } = wireReplica({
      artifactLibraryService,
      canvasCommentService,
      canvasService,
      externalContentIngestionStore,
      folderBrowseService,
      options,
      persistence,
      replicaArtifactSync,
      resolveCanvasWorkspace,
      windowAuthorityStore,
      workThreadProjection,
    });
    const commandBroker =
      options.credentialBrokerUrl === undefined || options.credentialBrokerToken === undefined
        ? undefined
        : makeSecretStoreBrokerClient({
            url: options.credentialBrokerUrl,
            token: options.credentialBrokerToken,
          });
    const commandJournal = secretStoresJournal({
      journal: persistence.journal,
      connection: persistence.connection,
      uuid: randomUUID,
      now: () => new Date().toISOString(),
    });
    const commands = new CommandCredentialBindings({
      // A request's three minutes run on the authority clock. The monotonic
      // timer it used before is CLOCK_MONOTONIC on Linux, which does not
      // count a suspend, so a suspended Linux host extended them.
      now: processAuthorityTime,
      uuid: randomUUID,
      canConfigure: (window, project) => {
        try {
          return (
            windowAuthorityStore.listWindowIds().some((id) => String(id) === window) &&
            canAccessCodeProject(decodeWindowId(window), decodeProjectId(project))
          );
        } catch {
          return false;
        }
      },
      context: commandCredentialContext({
        persistence,
        read: async (window, thread) => (await codeService.read(window, thread)).thread,
        roots,
        session: codeSessionAuthority,
        providerRevision: (thread) => {
          const provider = persistence.readProviderInstance(thread.providerInstanceId);
          return provider?.enabled === true && isCodeProviderModelAllowed(thread)
            ? provider.version
            : undefined;
        },
        windowCurrent: (window) =>
          windowAuthorityStore.listWindowIds().some((id) => String(id) === String(window)),
        runtime: codeOperationRuntime,
        canAccess: canAccessCodeProject,
      }),
      pin: commandCredentialRecipientPin(credentialCommandProcess),
      execute: createCommandCredentialExecution({
        process: credentialCommandProcess,
        broker: commandBroker,
        prepare: prepareCredentialCommand,
      }),
      record: (record) => commandJournal.record(record),
      records: readCommandCredentialHistory(persistence.journal),
    });
    onWindowRevoked((window) => commands.windowRevoked(String(window)));
    yield* Effect.addFinalizer(() => Effect.sync(() => commands.close()));
    const commandRoutes = commandCredentialRoutes(
      commands,
      windowAuthorityStore,
      options.allowedRendererHttpOrigin,
    );
    const credentialRequests = new CredentialRequests(
      commandBroker?.requestCardRead === undefined
        ? {}
        : { resolveLinked: commandBroker.requestCardRead },
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => credentialRequests.close()));
    yield* Effect.addFinalizer(() => Effect.sync(() => projectMemoryAccess.proposals.close()));
    // Plan reads Project memory and refuses every write to it.
    contributeCodeTools(({ windowId, thread, readThread }) =>
      projectMemoryAccess.toolsFor({
        windowId,
        mode: "code",
        threadId: String(thread.id),
        projectId: String(thread.projectId),
        writeRefusal: () =>
          (readThread()?.executionPolicy ?? thread.executionPolicy) === "plan"
            ? "Plan mode cannot change Project memory. Leave Plan mode to propose the change."
            : undefined,
      }),
    );
    const credentialRequestRoutes = createCredentialRequestRoutes(
      credentialRequests,
      windowAuthorityStore,
    );
    bindCodeToolHost(({ windowId, thread, contribution, toolName, current }) => {
      const providerVersion = persistence.readProviderInstance(thread.providerInstanceId)?.version;
      return createCodeToolHostPort({
        windowId: String(windowId),
        thread,
        contribution,
        toolName,
        credentialRequests,
        commands,
        operations: credentialOperations,
        readThread: () => {
          const stored = persistence.readCodeThread(thread.id);
          if (stored === undefined) return undefined;
          const effective = codeSessionAuthority.effectiveThread(windowId, stored);
          return codeOperationRuntime?.threadWithActiveTurnPosture?.(effective) ?? effective;
        },
        current: () =>
          current() &&
          providerVersion !== undefined &&
          persistence.readProviderInstance(thread.providerInstanceId)?.enabled === true &&
          persistence.readProviderInstance(thread.providerInstanceId)?.version ===
            providerVersion &&
          isCodeProviderModelAllowed(thread) &&
          canAccessCodeProject(windowId, thread.projectId) &&
          windowAuthorityStore.listWindowIds().some((id) => String(id) === String(windowId)),
      });
    });
    // One credential tool, composed from two sides that each keep their own
    // authority check: registered integration operations and saved commands.
    contributeCodeTools(({ windowId, thread, readThread }) => {
      const providerVersion = persistence.readProviderInstance(thread.providerInstanceId)?.version;
      const windowCurrent = () =>
        windowAuthorityStore.listWindowIds().some((id) => String(id) === String(windowId));
      return createCredentialTool({
        registered: registeredCredentialOperations({
          service: credentialRequests,
          windowId: String(windowId),
          thread,
          readThread,
          operations: credentialOperations,
          windowCurrent,
        }),
        saved: savedCredentialCommands({
          service: commands,
          windowId: String(windowId),
          threadId: String(thread.id),
          projectId: String(thread.projectId),
          current: () => {
            try {
              const current = readThread();
              return (
                current !== undefined &&
                providerVersion !== undefined &&
                persistence.readProviderInstance(current.providerInstanceId)?.enabled === true &&
                persistence.readProviderInstance(current.providerInstanceId)?.version ===
                  providerVersion &&
                isCodeProviderModelAllowed(current) &&
                windowCurrent() &&
                isToolAllowedByAllowlist(
                  current.toolConstraints ?? [],
                  OCTANT_CREDENTIAL_TOOL.name,
                ) &&
                JSON.stringify([
                  current.checkoutId,
                  current.bindingRevisionId,
                  current.providerInstanceId,
                  current.modelId,
                  current.profileId,
                  current.toolConstraints,
                ]) ===
                  JSON.stringify([
                    thread.checkoutId,
                    thread.bindingRevisionId,
                    thread.providerInstanceId,
                    thread.modelId,
                    thread.profileId,
                    thread.toolConstraints,
                  ]) &&
                current.lifecycle === "active" &&
                commandCredentialPostureAllowed(
                  (
                    codeOperationRuntime?.threadWithActiveTurnPosture?.(
                      codeSessionAuthority.effectiveThread(windowId, current),
                    ) ?? codeSessionAuthority.effectiveThread(windowId, current)
                  ).executionPolicy,
                ) &&
                canAccessCodeProject(windowId, current.projectId) &&
                String(current.projectId) === String(thread.projectId)
              );
            } catch {
              return false;
            }
          },
        }),
      });
    });
    const admittedInputReceipt = async (
      windowId: WindowId,
      query: ConversationInputQuery,
    ): Promise<
      | { readonly owner: ConversationInputOwner; readonly receipt: ConversationInputReceipt }
      | undefined
    > => {
      if (query.mode === "chat") {
        const view = chatService.read(decodeChatThreadId(query.threadId));
        const attempt = view.turns
          .flatMap((turn) => turn.attempts)
          .find((item) => String(item.id) === query.admissionId);
        return attempt?.inputReceipt?.snapshotId !== query.snapshotId
          ? undefined
          : {
              owner: {
                mode: "chat",
                threadId: query.threadId,
                projectId:
                  view.thread.projectId === undefined ? null : String(view.thread.projectId),
              },
              receipt: attempt.inputReceipt,
            };
      }
      if (query.mode === "work") {
        const result = await workTurnService.lookupFirstTurn(
          windowId,
          String(decodeWorkTurnRequestId(query.admissionId)),
        );
        if (
          result.kind !== "accepted" ||
          String(result.turn.threadId) !== query.threadId ||
          result.turn.inputReceipt?.snapshotId !== query.snapshotId
        )
          return undefined;
        return {
          owner: {
            mode: "work",
            threadId: query.threadId,
            projectId: String(result.turn.projectId),
          },
          receipt: result.turn.inputReceipt,
        };
      }
      if (codeOperationRuntime === undefined) return undefined;
      const threadId = decodeCodeThreadId(query.threadId);
      const frames = await codeOperationRuntime.subscribe(
        windowId,
        threadId,
        decodeCodeOperationId(query.admissionId),
        0,
        MAX_CODE_OPERATION_REPLAY_LIMIT,
      );
      const receipt = frames
        .flatMap((frame) =>
          (frame.event.kind === "context-handoff-attached" ||
            frame.event.kind === "fork-context-delivered") &&
          "inputReceipt" in frame.event &&
          frame.event.inputReceipt !== undefined
            ? [frame.event.inputReceipt]
            : [],
        )
        .find((item) => item.snapshotId === query.snapshotId);
      const thread = persistence.readCodeThread(threadId);
      return receipt === undefined || thread === undefined
        ? undefined
        : {
            owner: { mode: "code", threadId: query.threadId, projectId: String(thread.projectId) },
            receipt,
          };
    };
    const conversationInputRoutes = createConversationInputRoutes({
      windowAuthorityStore,
      read: async (windowId, query) => {
        const admitted = await admittedInputReceipt(windowId, query);
        if (admitted === undefined) return undefined;
        const manifest = await conversationInputTransfer.read(admitted.owner, admitted.receipt);
        const current = await admittedInputReceipt(windowId, query);
        return current === undefined || JSON.stringify(current) !== JSON.stringify(admitted)
          ? undefined
          : manifest;
      },
    });
    const cloudSessions = wireProviderCloudSessions({
      persistence,
      credentialResolver,
      codeProjectAccess,
      codeSessionAuthority,
      windowAuthorityStore,
      spendCeilingService,
      configuredDriverOptions,
      ...(options.allowedRendererHttpOrigin === undefined
        ? {}
        : { allowedRendererHttpOrigin: options.allowedRendererHttpOrigin }),
    });
    yield* Effect.addFinalizer(() => Effect.promise(() => cloudSessions.service.close()));
    const agentGrantRouteSlot = createAgentGrantRouteSlot();
    const { authenticatedProductDispatch, dispatchMeasuredProductRoutes } = wireRoutes({
      agentGrantRoutes: agentGrantRouteSlot.routes,
      conversationInputRoutes,
      providerCloudSessionRoutes: cloudSessions.routes,
      credentialRequestRoutes,
      agentMessageRoutes,
      agentProfileRoutes,
      archivedWorktreeRoutes,
      diskCleanupRoutes,
      agentRunRouteDependencies,
      agentRunSettingsRoutes,
      androidToolchainRoutes,
      appleToolchainRoutes,
      artifactLibraryRoutes,
      artifactMirrorRoutes,
      automationNotificationRoutes,
      automationRoutes,
      benchmarkRoutes,
      browserAutomationRoutes,
      canvasRoutes,
      chatRoutes,
      codeCheckoutOpenRoutes,
      codeExternalEditorRoutes,
      codeOperationApprovalRoutes,
      codeProjectAccess,
      codeRoutes,
      computerUseRoutes,
      desktopPaneRoutes,
      designSystemRoutes,
      contextRoutes,
      diagnosticsExportRoutes,
      discoveryRoutes,
      extensionRoutes,
      providerToolingRoutes,
      fileMentionRoutes,
      fleetActivityRoutes,
      folderBrowseRoutes,
      followUpSuggestionRoutes,
      githubCloneRoutes,
      githubRoutes,
      goalLoopRoutes,
      goalRoutes,
      imageRoutes,
      integrationRoutes,
      latencyStats,
      launchSessionRoutes,
      linkedThreadRoutes,
      localServerRoutes,
      localUsageHistoryRoutes,
      machineChangeRoutes,
      terminalSessionRoutes,
      nativeHarnessEgressRoutes,
      nativeHarnessRoutingRoutes,
      shieldServerRoutes,
      serverProjectRoutes,
      nativeHarnessSessionRoutes,
      navigatorAssistantRoutes,
      pendingRequestRoutes,
      planRoutes,
      previewHandoffBridgeRoutes,
      previewRoutes,
      safeNetworkRoutes,
      productFeedbackRoutes,
      nativeBrowserPresentationRoutes,
      projectBindingRoutes,
      projectRoutes,
      personMemoryRoutes,
      protectedFilesRoutes,
      providerOAuthRoutes,
      providerRoutes,
      providerUsageLimitsRoutes,
      remoteServerGrantLocalRoutes,
      replicaSyncStatusRoutes,
      scaffoldRoutes,
      replyDetailRoutes,
      shellRoutes,
      shipRoutes,
      sidebarBackgroundRoutes,
      sideTaskRoutes,
      snapshotCanvas,
      speechRoutes,
      spendCeilingRoutes,
      syncedArtifactRoutes,
      persistence,
      windowAuthorityStore,
      themeRoutes,
      threadCheckpointRoutes,
      threadExportRoutes,
      threadHandOffRoutes,
      threadMentionRoutes,
      threadMessageQueueRoutes,
      usageDashboardRoutes,
      usageRoutes,
      validationEvidenceRoutes,
      workFileListingRoutes,
      workMutationRoutes,
      workOverviewRoutes,
      workPromotionRoutes,
      workRequestRoutes,
      workResearchRoutes,
      workspacePresetRoutes,
      workThreadRoutes,
      workTurnRoutes,
      zenBackgroundRoutes,
      zenRoutes,
    });
    const {
      ownerBrowserControlService,
      composeHostDiagnostics,
      externalContentRoutes,
      hostControlRoutes,
      personQuitRoutes,
      supportBundleRoutes,
      delegationAdministrationRoutes,
      threadMoveAdministrationRoutes,
      hubAdministrationRoutes,
      localDeviceAdministrationRoutes,
      agentAccessAdministrationRoutes,
      privateListenerAdministrationRoutes,
      privateListenerController,
      privateListenerSetting,
      providerCredentialRoutes,
      secretStoresRoutes,
      remoteHost,
      threadRetention,
    } = wireRemote({
      restartRecovery,
      agentGrantRouteSlot,
      workRequestRuntime,
      workRequestService,
      chatService,
      browserCaptures,
      canvasService,
      imageJobService,
      liveTurns,
      managedWorktreeReceipts,
      movedThreadHistory,
      threadMoveHolds,
      threadMoveState,
      threadNotifications,
      beginGoogleCliChange,
      workThreadService,
      onSecretStoreLinkChange: () => commands.linkChanged(),
      browserUploadPermissions,
      browserDownloadPermissions,
      browserAutomationService,
      codeService,
      projectService,
      browserExtensionService,
      browserFlowService,
      browserProfileService,
      canvasNetworkAccess,
      canvasPublicShareService,
      threadExportService,
      threadHandOffProvider,
      agentMessageService,
      authenticatedProductDispatch,
      automationCommandService,
      automationScheduler,
      browserCaptureStore,
      personMemory,
      canvasRoutes,
      chatAttachmentStore,
      codeAttachments,
      hubPushHandoffSlot,
      pairedMergeUnlockSlot,
      pushGatewaySetting,
      codeProjectAccess,
      credentialBroker,
      credentialResolver,
      externalContentIngestionStore,
      extensionApiService,
      generatedImageStore,
      debugConfigurationApprovals,
      debugService,
      hostMemoryGuard,
      languageServerApprovals,
      nativeHarnessSessions,
      onWorkTurnCancelled,
      remoteDelegationHolder,
      options,
      persistence,
      providerDataDirectory,
      providerRuntimeRegistry,
      providerService,
      pushNotificationTokenStore,
      remoteServerGrants,
      serve,
      shellService,
      codeOperationRuntime,
      startedAt,
      threadMessageQueue,
      toolEgressRules,
      version,
      webAssets,
      windowAuthorityStore,
      workAttachments,
      workThreadProjection,
      workThreadServiceWithWorkflows,
      workTurnService,
      agentRunAdmission,
      agentRunOrchestration,
    });
    benchmarkThreadPurge.purge = async (threadId, mode) => {
      const outcome = await threadRetention.purge(
        {
          scope: {
            kind: "thread",
            mode,
            threadId: decodeThreadRetentionThreadId(threadId),
          },
          confirm: true,
        },
        "local-window",
      );
      if ("reason" in outcome) {
        return outcome.reason === "unknown-thread" ? "absent" : "failed";
      }
      return "purged";
    };

    yield* Effect.addFinalizer(() => Effect.promise(() => ownerBrowserControlService.close()));
    let remoteListenerError: PrivateListenerFailureCode | undefined;
    // Retained so shutdown can settle warming before the runtime registry
    // closes: an acquisition that lands after `closeAll()` would leave a warm
    // runtime alive on its idle lease with nothing left to close it.
    let warmingProviders: Promise<void> = Promise.resolve();
    let stopArtifactSync: () => void = () => undefined;
    let stopBenchmarkRunner: () => Promise<void> = () => Promise.resolve();
    let stopPublicShareSweep: () => void = () => undefined;
    return yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          const localServer = await serve({
            hostname: options.hostname,
            port: options.port,
            maxRequestBodySize: MAX_CHAT_ATTACHMENT_BYTES,
            fetch: async (request) => {
              const url = new URL(request.url);
              if (url.pathname === "/health") {
                return healthResponse(
                  version,
                  options.instanceId,
                  hostActivity(providerRuntimeRegistry),
                  existsSync(
                    join(
                      options.webAssetsPath ?? resolveWebAssetsPath(),
                      CANVAS_PREVIEW_ASSET_FOLDER,
                      CANVAS_PREVIEW_PAGE,
                    ),
                  ),
                );
              }
              // Every route below trusts a loopback Origin as the renderer, so a
              // page on another loopback port (a dev server a Code thread
              // started, say) is refused here before any route can reflect it
              // into CORS or mint local authority for it.
              if (
                isForeignLoopbackOrigin(
                  request.headers.get("origin"),
                  url,
                  options.allowedRendererHttpOrigin,
                )
              ) {
                return Response.json(
                  { category: "unauthorized", message: "Renderer origin is not allowed." },
                  { status: 403, headers: { vary: "Origin" } },
                );
              }
              // Intentionally pre-auth (like /health): returns static, non-sensitive
              // host identity so the UI can render the selector before capability exchange.
              // Only this loopback listener answers it; the private listener refuses
              // the route, so the host's platform reaches only a window on this host.
              if (url.pathname === "/api/hosts") {
                const origin = request.headers.get("origin");
                const headers = new Headers({ vary: "Origin" });
                if (
                  origin !== null &&
                  isAllowedRendererOrigin(origin, options.allowedRendererHttpOrigin)
                ) {
                  headers.set("access-control-allow-origin", origin);
                }
                return Response.json(
                  { hosts: listHosts(localHostDisplayName(), process.platform) },
                  { headers },
                );
              }
              return (
                (await privateListenerAdministrationRoutes(request)) ??
                (await hubAdministrationRoutes(request)) ??
                (await delegationAdministrationRoutes(request)) ??
                (await threadMoveAdministrationRoutes(request)) ??
                (await providerCredentialRoutes(request)) ??
                (await secretStoresRoutes(request)) ??
                (await commandRoutes(request)) ??
                (await localDeviceAdministrationRoutes(request)) ??
                (await agentAccessAdministrationRoutes(request)) ??
                (await personQuitRoutes(request)) ??
                (await hostControlRoutes(request)) ??
                (await supportBundleRoutes(request)) ??
                (await externalContentRoutes(request)) ??
                (await replicaStoreSettingsRoutes(request)) ??
                (await replicaMembershipRoutes(request)) ??
                (await dispatchMeasuredProductRoutes(request)) ??
                (await webAssets(request)) ??
                new Response("Not Found", { status: 404 })
              );
            },
          });
          // Warming keeps one idle runtime per enabled provider so the first
          // turn of a new thread does not pay provider startup. It starts only
          // once the listener binds, so a server that never serves leaves no
          // provider process behind, and it is background work: a provider that
          // refuses to start must not delay or fail startup.
          warmingProviders = providerService.warmEnabledProviders().catch(() => undefined);
          // Startup auto-enable: a launch-time private listener config (the
          // test/smoke seam) or else the listener the host last enabled from
          // its local administration channel is enabled through the controller
          // after the loopback listener binds. A failure fails closed with a
          // typed error code, keeps the remembered setting for the next start,
          // and never prevents the loopback listener from serving.
          const startupListenerConfig =
            options.remoteListener?.config ?? privateListenerSetting.load();
          if (startupListenerConfig !== undefined) {
            try {
              await privateListenerController.enable(startupListenerConfig);
              remoteHost.recordStartupListener();
            } catch (error) {
              remoteListenerError =
                error instanceof Error &&
                "code" in error &&
                isPrivateListenerFailureCode(error.code)
                  ? error.code
                  : "bind-failed";
            }
          }
          // The completed-thread timer starts only once the host is serving,
          // so a host that fails to bind never archives anything on its own,
          // and the stop below is registered before the first pass runs.
          completedThreadArchiveSweep.start();
          idleCompactions.start();
          stopBenchmarkRunner = benchmarkRunner.start();
          personMemorySweep.start();
          // The memory guard reads the last run's state before it overwrites
          // it, so the next-start notice survives a crash.
          await hostMemoryGuard.start();
          // Artifact sync pulls and drains its queue now and on an interval,
          // only once the host is serving; with sync off each pass returns
          // before any store call.
          stopArtifactSync = artifactSyncService.start();
          // Public links past their expiry give up their owner secrets, and
          // revokes still owed are retried, now and hourly.
          stopPublicShareSweep = canvasPublicShareService.start();
          // A leave the host stopped in the middle of finishes its cleanup:
          // sync off and the device key deleted.
          void replicaMembershipService.finishLeaving().catch(() => undefined);
          const remoteListener = remoteHost.listener();
          return {
            url: localServer.url,
            ...(remoteListener === undefined ? {} : { remoteListener }),
            ...(remoteListenerError === undefined ? {} : { remoteListenerError }),
            diagnostics: composeHostDiagnostics,
            backup: (label = "manual") => persistence.createVerifiedBackup(label),
            stop: (closeActiveConnections = false) => {
              // R4: attempt both remote and local shutdowns even when one
              // throws synchronously. Both calls are wrapped in
              // Promise.resolve().then() so synchronous throws become
              // rejections that are captured and settled together. The first
              // deterministic failure (remote before local) is propagated.
              if (remoteHost.gateway() === undefined) {
                return Promise.resolve(localServer.stop(closeActiveConnections));
              }
              const remoteStop = Promise.resolve().then(() => privateListenerController.disable());
              const localStop = Promise.resolve().then(() =>
                localServer.stop(closeActiveConnections),
              );
              return Promise.all([
                remoteStop.then(
                  () => undefined,
                  (error) => error,
                ),
                localStop.then(
                  () => undefined,
                  (error) => error,
                ),
              ]).then(([remoteError, localError]) => {
                if (remoteError !== undefined) throw remoteError;
                if (localError !== undefined) throw localError;
              });
            },
          } satisfies OctantServer;
        },
        catch: () =>
          new ServerStartupFailed({
            category: "server-unavailable",
            message: "Octant could not bind the local server.",
          }),
      }).pipe(Effect.onError(() => Effect.promise(() => cloudSessions.service.close()))),
      (server) =>
        Effect.promise(async () => {
          let shutdownFailure: unknown;
          try {
            windowAuthorityStore.revokeNativeLeases();
          } catch (error) {
            shutdownFailure = error;
          }
          try {
            const previewCleanup = await serverPreviewTunnels.close();
            if (previewCleanup.status === "unsettled") {
              shutdownFailure = new Error("Server Project preview cleanup could not be confirmed.");
            }
          } catch (error) {
            shutdownFailure = error;
          }
          let httpStop: void | Promise<void> = undefined;
          try {
            githubAuthenticationPort.close();
          } catch (error) {
            shutdownFailure = error;
          }
          try {
            githubCataloguePort.close();
          } catch (error) {
            shutdownFailure = error;
          }
          try {
            // Interrupt the Automation scheduler's timer fiber before the
            // journal connection goes away; a pass is one synchronous section,
            // so shutdown can never interrupt a partial occurrence claim.
            await automationScheduler.stop();
          } catch (error) {
            shutdownFailure ??= error;
          }
          try {
            projectPullRequestCadence.stop();
          } catch (error) {
            shutdownFailure ??= error;
          }
          // Aborts any check command still running, which ends its process group.
          try {
            await stopBenchmarkRunner();
          } catch (error) {
            shutdownFailure ??= error;
          }
          completedThreadArchiveSweep.stop();
          idleCompactions.stop();
          personMemorySweep.stop();
          personMemory.close();
          try {
            await hostMemoryGuard.stop();
          } catch (error) {
            shutdownFailure ??= error;
          }
          stopArtifactSync();
          stopPublicShareSweep();
          providerUsageLimitsService.stop();
          try {
            managedCloneService.close();
          } catch (error) {
            shutdownFailure = error;
          }
          try {
            managedCloneProcessPort.close();
          } catch (error) {
            shutdownFailure = error;
          }
          try {
            githubRepositoryObservationPort.close();
          } catch (error) {
            shutdownFailure = error;
          }
          try {
            // Drop process-local live transcripts before HTTP drain. Open
            // NDJSON subscribers would otherwise keep connections alive, and
            // Git observations must still abort without waiting for that drain.
            agentRunLiveConversations.close();
          } catch (error) {
            shutdownFailure ??= error;
          }
          try {
            httpStop = server.stop(true);
          } catch (error) {
            shutdownFailure = error;
          }
          try {
            // Stop admission first, then request owned cloud cancellation while
            // both the journal and provider transport are still available.
            await cloudSessions.service.close();
          } catch (error) {
            shutdownFailure ??= error;
          }
          try {
            unsubscribeMachineChanges();
            machineChangeFeed.close();
            workTurnService.closeLiveUpdates();
          } catch (error) {
            shutdownFailure = error;
          }
          try {
            await gitEnvironmentPort.close();
          } catch (error) {
            shutdownFailure ??= error;
          }
          skillDiscoveryService.stopWatching();
          try {
            await httpStop;
          } catch (error) {
            shutdownFailure ??= error;
          }
          try {
            await appleToolchainService.close();
            await androidToolchainService.close();
          } catch (error) {
            shutdownFailure ??= error;
          }
          try {
            await codeOperationRuntime?.close();
          } catch (error) {
            shutdownFailure ??= error;
          }
          try {
            await warmingProviders;
            await providerRuntimeRegistry.closeAll();
          } catch (error) {
            shutdownFailure ??= error;
          }
          try {
            zenService.close();
          } catch (error) {
            shutdownFailure ??= error;
          }
          try {
            flowRuns.close();
            projectBrowserService?.close();
            browserSessionGrants.close();
            browserUploadPermissions.close();
            browserDownloadPermissions.close();
            await browserDelegatedChildren.close();
            await browserAutomationService?.close();
          } catch (error) {
            shutdownFailure ??= error;
          }
          browserToolApprovalService?.close();
          imageGenerationOffers.close();
          try {
            stopComputerSettingsWatch();
            stopDesktopLeases();
            if (computerUseTools !== undefined) await computerUseTools.close();
            else await computerUseRuntime.close();
          } catch (error) {
            shutdownFailure ??= error;
          }
          try {
            await claudeResumeIdentityStore.close();
          } catch (error) {
            shutdownFailure ??= error;
          }
          try {
            await agentPluginMcpSessionManager.drainAll();
          } catch (error) {
            shutdownFailure ??= error;
          }
          if (shutdownFailure !== undefined) throw shutdownFailure;
        }),
    );
  });
}

export function fatalStartupOutput(error: unknown): string {
  const failure =
    error instanceof PersistenceStartupFailed || error instanceof ServerStartupFailed
      ? error
      : {
          category: "startup-failed",
          message: withStartupFailureReason(UNCLASSIFIED_STARTUP_FAILURE, error),
        };
  return startupFailedOutput(
    failure.category,
    failure.message,
    failure instanceof PersistenceStartupFailed ? failure.recovery : undefined,
  );
}
