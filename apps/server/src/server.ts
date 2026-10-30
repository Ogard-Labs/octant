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
import type { PublishedSnapshotRunRequest, WindowId } from "@octant/contracts";
import { MAX_CHAT_ATTACHMENT_BYTES } from "./chat/chatAttachmentStore";
import { MAX_CODE_FILE_BODY_SIZE } from "./codeRoutes";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CANVAS_PREVIEW_ASSET_FOLDER, CANVAS_PREVIEW_PAGE } from "./canvas/canvasPreviewRenderer";
import { healthResponse } from "./health";
import {
  Persistence,
  type PersistenceService,
  PersistenceStartupFailed,
} from "./persistence/persistenceService";
import { LatencyStatsProjection } from "./latencyStatsProjection";
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
import { wireCanvas } from "./wiring/canvas";
import { wireAutomation } from "./wiring/automation";
import { wireThreadNotifications } from "./wiring/notifications";
import { wireWorkRequests } from "./wiring/workRequests";
import { wireRoutes } from "./wiring/routes";
import { wireRemote } from "./wiring/remote";
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
      browserAuthority,
      codeBoardEventStore,
      codeEvidence,
      isProjectPolicyTargetAllowed,
      providerRuntimeRegistry,
      selectCodeConversation,
      workArtifactProjection,
      workThreadProjection,
      workTurnProjection,
    } = wireFoundations({ latencyStats, options, persistence });
    const {
      agentRunParentAuthority,
      agentRunPersistence,
      androidInputGrants,
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
      processAuthorityNow,
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
      nativeHarnessApprovals,
      nativeHarnessQuestions,
      nativeHarnessSessions,
      onHarnessQuestionAsked,
      onHarnessQuestionSettled,
      threadAwaitsHarnessQuestion,
    } = wireHarnessState({
      agentRunParentAuthority,
      agentRunPersistence,
      persistence,
      workThreadProjection,
    });
    const {
      agentRunAdmission,
      agentRunChildWorktree,
      agentRunEligibleTargets,
      agentRunLiveConversations,
      agentRunOrchestration,
      agentRunProcessSupervisor,
      agentRunRouteDependencies,
      agentRunSessionStore,
      agentRunSettingsRoutes,
      agentsManagedToolsFor,
      capacityScheduler,
      contributeChildTools,
      externalContentIngestionStore,
      managedWorktreeReceipts,
      nativeHarnessRouter,
      nativeHarnessRoutingStore,
      remoteDelegation,
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
      githubRoutes,
      integrationRoutes,
      linearIssueContextService,
      onGithubPullRequestsUnreadable,
      peekCreateFromIssueFramed,
      siblingThreadsService,
      threadOutsideContentMarks,
      toolEgressRules,
    } = yield* wireIntegrations({
      externalContentIngestionStore,
      options,
      persistence,
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
      desktopPaneRoutes,
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
      providerRuntimeRegistry,
      validationEventStore,
      windowAuthorityStore,
      workThreadProjection,
    });
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
      projectRootPort,
      projectService,
      shellRoutes,
      shellService,
      shipRoutes,
      spendCeilingService,
      themeRoutes,
      workProjectStatusFiles,
      workProjectStatusReader,
    } = yield* wireWorkspace({
      onWindowRevoked,
      bindingReceiptStore,
      githubCapabilityService,
      githubIntegrationIsEffective,
      desktopRecipeKeys,
      offeredDesktopProviders,
      options,
      persistence,
      providerRuntimeRegistry,
      spendCeilingHolder,
      windowAuthorityStore,
      workThreadProjection,
    });
    const { runningWorkTurnAccess, runningWorkTurns, workRequestRuntime, workRequestService } =
      wireWorkRequestState({
        persistence,
        workThreadProjection,
      });
    const {
      agentPluginMcpSessionManager,
      chatAttachmentStore,
      chatDataDirectory,
      claudeResumeIdentityStore,
      codeThreadDrivers,
      configuredDriverOptions,
      credentialBroker,
      credentialResolver,
      discoveryRoutes,
      extensionActivationService,
      extensionApiService,
      extensionLifecycleService,
      extensionPackageStore,
      extensionRoutes,
      generatedImageStore,
      imageJobService,
      localUsageHistoryRoutes,
      managedCodeThreadCreation,
      managedWorktreeRefsList,
      managedWorktreeSourcePreview,
      nativeHarnessLeadFallback,
      nativeHarnessTranscripts,
      probeProviderForThreads,
      providerDataDirectory,
      providerOAuthRoutes,
      providerRoutes,
      providerService,
      providerUsageLimitsRoutes,
      providerUsageLimitsService,
      refreshStandaloneSkills,
      resolveSelectedExtensions,
      pinnedExtensionIds,
      reviewedModelManifest,
      skillDiscoveryService,
    } = yield* wireProviders({
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
      version,
      windowAuthorityStore,
      workThreadProjection,
    });
    const {
      followUpCreation,
      restartContinuation,
      followUpSuggestionRoutes,
      nativeHarnessComposition,
      nativeHarnessEgressRoutes,
      nativeHarnessHooks,
      nativeHarnessRoutingRoutes,
      nativeHarnessSessionRoutes,
      onHarnessPausedByPerson,
      onHarnessRecoveryLifted,
      researchRouter,
      sideTaskFirstMessage,
      sideTaskRoutes,
      threadWork,
    } = wireHarness({
      projectService,
      agentRunInteractions,
      nativeHarnessApprovals,
      nativeHarnessQuestions,
      nativeHarnessSessions,
      agentRunAdmission,
      agentRunEligibleTargets,
      agentRunOrchestration,
      agentRunParentAuthority,
      nativeHarnessRouter,
      nativeHarnessRoutingStore,
      remoteDelegation,
      agentRunPersistence,
      codeBoardEventStore,
      codeParentActiveTurn,
      codeSessionAuthority,
      configuredDriverOptions,
      contextHarness,
      contributeChildTools,
      externalContentIngestionStore,
      goalService,
      nativeHarnessLeadFallback,
      nativeHarnessTranscripts,
      persistence,
      providerDataDirectory,
      runningWorkTurnAccess,
      sideTasks,
      threadFollowUpSuggestions,
      toolEgressRules,
      turnMetrics,
      windowAuthorityStore,
      workThreadProjection,
      workTurnProjection,
    });
    const {
      agentProfileRoutes,
      buildCodeService,
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
      projectPullRequestCadence,
      projectPullRequestService,
      projectRoutes,
      roots,
      workAttachments,
    } = yield* wireCode({
      codeBoardEventStore,
      codeEvidence,
      isProjectPolicyTargetAllowed,
      selectCodeConversation,
      managedCodeThreadCreation,
      managedWorktreeRefsList,
      managedWorktreeSourcePreview,
      probeProviderForThreads,
      refreshStandaloneSkills,
      onGithubPullRequestsUnreadable,
      onWindowRevoked,
      threadAwaitsHarnessApproval,
      bindingReceiptStore,
      cacheStats,
      codeApprovalStore,
      codeSessionAuthority,
      externalContentIngestionStore,
      gitEnvironmentPort,
      githubIssueContextService,
      gitObservationPort,
      linearIssueContextService,
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
      agentRunPersistence,
      browserCaptures,
      chatDataDirectory,
      contributeChildTools,
      extensionApiService,
      folderBrowseService,
      gistConnection,
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
      browserAutomationService,
      browserToolApprovalService,
      liveProjectBrowsers,
      productFeedbackRoutes,
      productFeedbackService,
      projectBrowserService,
      windowHoldsProject,
    } = yield* wireBrowser({
      browserAuthority,
      machineChangeFeed,
      onWindowRevoked,
      browserCaptures,
      codeEvidence,
      externalContentIngestionStore,
      options,
      persistence,
      projectService,
      providerDataDirectory,
      shellService,
      windowAuthorityStore,
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
      routeCodeService,
      terminalProcessPort,
    } = yield* wireCodeRuntime({
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
      projectPullRequestCadence,
      projectPullRequestService,
      projectService,
      providerDataDirectory,
      providerRuntimeRegistry,
      recordAppleEvidence,
      browserAutomationService,
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
    const {
      codeCheckoutOpenRoutes,
      codeExternalEditorRoutes,
      codeOperationApprovalRoutes,
      codeRoutes,
      debugConfigurationApprovals,
      debugService,
      languageServerApprovals,
      localServerRoutes,
      projectTerminals,
      remoteServerGrantLocalRoutes,
      remoteServerGrants,
    } = yield* wireCodeTooling({
      browserAuthority,
      canAccessCodeProject,
      codeFileWatch,
      codeOperationRuntime,
      codeSessionAuthority,
      contributeCodeTools,
      codeWorkingDirectoryProbePath,
      extensionLifecycleService,
      extensionPackageStore,
      managedWorktreeReceipts,
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
      threadExportRoutes,
      threadExportService,
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
      imageJobService,
      linearIssueContextService,
      liveTurns,
      managedWorktreeReceipts,
      nativeHarnessComposition,
      nativeHarnessHooks,
      peekCreateFromIssueFramed,
      persistence,
      probeProviderForThreads,
      projectService,
      providerRuntimeRegistry,
      refreshStandaloneSkills,
      browserAutomationService,
      browserToolApprovalService,
      resolveCanvasWorkspace,
      resolveSelectedExtensions,
      pinnedExtensionIds,
      roots,
      routeCodeService,
      runtimeOutsideContentMarks,
      sideTaskFirstMessage,
      sideTasks,
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
    });
    yield* wireContinuation({
      agentRunOrchestration,
      agentRunParentAuthority,
      agentRunPersistence,
      capacityScheduler,
      chatService,
      contextHarness,
      externalContentIngestionStore,
      persistence,
      routeCodeService,
      workThreadProjection,
      workTurnProjection,
      workTurnService,
    });
    const { navigatorAssistantRoutes, workTurnRoutes, zenBackgroundRoutes, zenRoutes, zenService } =
      wireZen({
        contributeChatTools,
        chatService,
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
    const { agentMessageRoutes, browserAutomationRoutes, contextRoutes, windowCanOpenThread } =
      wireContext({
        agentMessageProjection,
        browserAuthority,
        browserAutomationService,
        browserCaptures,
        canAccessCodeProject,
        capacityScheduler,
        chatService,
        codeOperationRuntime,
        configuredDriverOptions,
        contextHarness,
        liveProjectBrowsers,
        nativeHarnessHooks,
        persistence,
        projectService,
        providerRuntimeRegistry,
        browserToolApprovalService,
        routeCodeService,
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
      imageJobService,
      options,
      persistence,
      projectService,
      providerDataDirectory,
      routeCodeService,
      shellService,
      windowAuthorityStore,
      windowCanOpenThread,
      workArtifactProjection,
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
      capacityScheduler,
      chatService,
      codeCompletedThreadSource,
      persistence,
      projectService,
      routeCodeService,
      windowAuthorityStore,
      workThreadProjection,
      workThreadService,
      workThreadServiceWithWorkflows,
      workTurnService,
    });
    yield* wireThreadNotifications({
      chatHiddenThreadIds,
      hasPushStanding,
      persistence,
      pushComputerLabel,
      pushDeliveryTransport,
      pushNotificationTokenStore,
      workThreadProjection,
    });
    const {
      fleetActivityRoutes,
      pendingRequestRoutes,
      sidebarBackgroundRoutes,
      workOverviewRoutes,
      workPromotionRoutes,
      workRequestRoutes,
      workThreadRoutes,
    } = wireWorkRequests({
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
    const { authenticatedProductDispatch, dispatchMeasuredProductRoutes } = wireRoutes({
      agentMessageRoutes,
      agentProfileRoutes,
      agentRunRouteDependencies,
      agentRunSettingsRoutes,
      androidToolchainRoutes,
      appleToolchainRoutes,
      artifactLibraryRoutes,
      artifactMirrorRoutes,
      automationNotificationRoutes,
      automationRoutes,
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
      contextRoutes,
      diagnosticsExportRoutes,
      discoveryRoutes,
      extensionRoutes,
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
      nativeHarnessEgressRoutes,
      nativeHarnessRoutingRoutes,
      nativeHarnessSessionRoutes,
      navigatorAssistantRoutes,
      pendingRequestRoutes,
      planRoutes,
      previewHandoffBridgeRoutes,
      previewRoutes,
      productFeedbackRoutes,
      projectBindingRoutes,
      projectRoutes,
      providerOAuthRoutes,
      providerRoutes,
      providerUsageLimitsRoutes,
      remoteServerGrantLocalRoutes,
      replicaSyncStatusRoutes,
      scaffoldRoutes,
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
      composeHostDiagnostics,
      externalContentRoutes,
      hostControlRoutes,
      delegationAdministrationRoutes,
      hubAdministrationRoutes,
      localDeviceAdministrationRoutes,
      privateListenerAdministrationRoutes,
      privateListenerController,
      privateListenerSetting,
      providerCredentialRoutes,
      remoteHost,
    } = wireRemote({
      canvasPublicShareService,
      threadExportService,
      agentMessageService,
      authenticatedProductDispatch,
      automationCommandService,
      automationScheduler,
      browserCaptureStore,
      canvasRoutes,
      chatAttachmentStore,
      codeAttachments,
      hubPushHandoffSlot,
      pushGatewaySetting,
      codeProjectAccess,
      credentialBroker,
      credentialResolver,
      externalContentIngestionStore,
      extensionApiService,
      generatedImageStore,
      debugConfigurationApprovals,
      debugService,
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
    });

    let remoteListenerError: PrivateListenerFailureCode | undefined;
    // Retained so shutdown can settle warming before the runtime registry
    // closes: an acquisition that lands after `closeAll()` would leave a warm
    // runtime alive on its idle lease with nothing left to close it.
    let warmingProviders: Promise<void> = Promise.resolve();
    let stopArtifactSync: () => void = () => undefined;
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
                  {
                    activeAgentCount: providerRuntimeRegistry.activeSessionTotal(),
                    attentionRequired: providerRuntimeRegistry.attentionRequired(),
                  },
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
                (await providerCredentialRoutes(request)) ??
                (await localDeviceAdministrationRoutes(request)) ??
                (await hostControlRoutes(request)) ??
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
      }),
      (server) =>
        Effect.promise(async () => {
          let shutdownFailure: unknown;
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
          completedThreadArchiveSweep.stop();
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
            projectBrowserService?.close();
            await browserAutomationService?.close();
          } catch (error) {
            shutdownFailure ??= error;
          }
          browserToolApprovalService?.close();
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
  return startupFailedOutput(failure.category, failure.message);
}
