import {
  startupFailedOutput,
  UNCLASSIFIED_STARTUP_FAILURE,
  withStartupFailureReason,
} from "./startupFailureReason";
import type {
  AndroidRpcEnvelope,
  AppleRpcEnvelope,
  CodeThreadId,
  ProviderInstance,
  ProviderModel,
  WindowId,
} from "@octant/contracts";
import { Effect, Scope } from "effect";
import { ChatService } from "./chat/chatService";
import { WorkFileListingService } from "./work/workFileListingService";
import { WorkThreadProjection } from "./work/workThreadProjection";
import { WorkThreadService } from "./work/workThreadService";
import { WorkTurnProjection } from "./work/workTurnProjection";
import { WorkTurnService } from "./work/workTurnService";
import { GoalLoopService } from "./goal/goalLoopService";
import { MAX_CHAT_ATTACHMENT_BYTES } from "./chat/chatAttachmentStore";
import { CodeOperationEventStore } from "./code/codeOperationEventStore";
import { MAX_CODE_FILE_BODY_SIZE } from "./codeRoutes";
import { healthResponse } from "./health";
import {
  Persistence,
  type PersistenceService,
  PersistenceStartupFailed,
} from "./persistence/persistenceService";
import {
  admittedParentCodeContext,
  type AdmittedParentCodeContextInput,
} from "./agentRun/agentRunParentContext";
import { ProviderRuntimeRegistry } from "./providers/providerRuntimeRegistry";
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
import { NativeHarnessRouter } from "./harness/nativeHarnessRouter";
import { NativeHarnessSessionStore } from "./harness/nativeHarnessSessionStore";
import { ServerBrowserAuthorityResolver } from "./browser/browserAuthorityResolver";
import { type AppleExecutionContext, AppleToolchainService } from "./apple/appleToolchainService";
import {
  type AndroidExecutionContext,
  AndroidToolchainService,
} from "./android/androidToolchainService";
import { listHosts } from "@octant/domain";
import { localHostDisplayName } from "./localHostDisplayName";
import { isPrivateListenerFailureCode, type PrivateListenerFailureCode } from "./privateListener";
import { createReplicaSyncStatusRouteHandler } from "./replica/replicaMembershipRoutes";
import { createSyncedArtifactRouteHandler } from "./replica/syncedArtifactRoutes";
import { createHostResourceRouteHandler } from "./hostResourceRoutes";
import { type ConfiguredProviderDriverOptions, wireProviders } from "./wiring/providers";
import {
  type OctantServer,
  ServerStartupFailed,
  type StartOctantServerOptions,
} from "./wiring/serverShape";
import type { LateBindings } from "./wiring/lateBindings";
import { wireAuthority } from "./wiring/authority";
import { wireAgentRuns } from "./wiring/agentRuns";
import { wireIntegrations } from "./wiring/integrations";
import { wireUsage } from "./wiring/usage";
import { wireComputerUse } from "./wiring/computerUse";
import { wireWorkspace } from "./wiring/workspace";
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
import { wireWorkRequests } from "./wiring/workRequests";
import { wireRoutes } from "./wiring/routes";
import { wireRemote } from "./wiring/remote";

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
export { resolveWebAssetsPath } from "./wiring/computerUse";
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
    const late: LateBindings = {
      browserToolApprovalService: { current: undefined },
      terminalBrowserGrants: { current: undefined },
      activeCodeService: { current: undefined },
      browserAutomationService: { current: undefined },
      projectBrowserService: { current: undefined },
      activeComputerUseRuntime: { current: undefined },
      activeComputerUseTools: { current: undefined },
      workRequestRuntime: { current: undefined },
      revokeShellWindow: { current: undefined },
      revokeQueuedMessages: { current: undefined },
      nativeHarnessComposition: { current: undefined },
      nativeHarnessSessions: { current: undefined },
      nativeHarnessObserver: { current: undefined },
      nativeHarnessLeadFallback: { current: undefined },
      nativeHarnessQuestions: { current: undefined },
      nativeHarnessApprovalStore: { current: undefined },
      agentRunInteractions: { current: undefined },
      snapshotCanvasImpl: {
        current: () => ({
          kind: "denied",
          message: "Canvas is unavailable on this host.",
        }),
      },
      revokeProjectPullRequests: { current: undefined },
      refreshStandaloneSkills: { current: async (): Promise<void> => undefined },
      managedWorktreeSourcePreview: {
        current: async () => ({
          kind: "failed",
          reason: "unavailable",
        }),
      },
      managedWorktreeRefsList: { current: async () => [] },
      managedCodeThreadCreation: {
        current: {
          prepare: async () => ({ status: "waiting" }),
          commit: async () => ({ status: "waiting" }),
          cleanup: async () => ({ status: "waiting" }),
        },
      },
      probeProviderForThreads: {
        current: async () => {
          throw new Error("Provider probing is unavailable during server startup.");
        },
      },
      observeRefreshedPullRequestRows: { current: undefined },
      codeOperationRuntime: { current: options.codeOperationRuntime },
      terminalProcessPort: { current: undefined },
      runningWorkTurnAccess: { current: undefined },
      zenAssistantTools: { current: undefined },
      canvasAgentToolPort: { current: undefined },
      purgeQueuedChatMessages: { current: undefined },
      observeWorkThreadRuntime: { current: undefined },
      workRequestService: { current: undefined },
      remoteListener: { current: undefined },
      currentRemoteGateway: { current: undefined },
    };

    const {
      agentRunParentAuthority,
      agentRunPersistence,
      androidInputGrants,
      bindingReceiptStore,
      browserCaptureStore,
      browserCaptures,
      browserModelBindings,
      codeApprovalStore,
      codeSessionAuthority,
      extensionToolApprovalService,
      isPairedDeviceScope,
      liveTurns,
      machineChangeFeed,
      onAgentRunExecutionAccepted,
      processAuthorityNow,
      requireBrowserAutomationService,
      requireBrowserToolApprovalService,
      simulatorInputGrants,
      unsubscribeMachineChanges,
      windowAuthorityStore,
    } = wireAuthority({
      late,
      browserAuthority: (): ServerBrowserAuthorityResolver => browserAuthority,
      persistence,
    });
    const {
      agentRunAdmission,
      agentRunChildWorktree,
      agentRunEligibleTargets,
      agentRunLiveConversations,
      agentRunOrchestration,
      agentRunProcessSupervisor,
      agentRunRoutes,
      agentRunSessionStore,
      agentRunSettingsRoutes,
      agentsManagedToolsFor,
      capacityScheduler,
      externalContentIngestionStore,
      managedWorktreeReceipts,
      nativeHarnessHooks,
      runtimeOutsideContentMarks,
      sideTasks,
      spendCeiling,
      spendCeilingHolder,
      threadAwaitsHarnessApproval,
      threadFollowUpSuggestions,
      turnMetrics,
    } = wireAgentRuns({
      late,
      agentRunPersistence,
      chatService: (): ChatService => chatService,
      codeBoardEventStore: (): CodeOperationEventStore => codeBoardEventStore,
      codeSessionAuthority,
      configuredDriverOptions: (): ConfiguredProviderDriverOptions => configuredDriverOptions,
      isProjectPolicyTargetAllowed: (): ((
        project: Exclude<
          ReturnType<PersistenceService["readProject"]>,
          undefined | { readonly type: "chat" }
        >,
        providerInstanceId: ProviderInstance["id"],
        modelId: ProviderModel["id"],
      ) => boolean) => isProjectPolicyTargetAllowed,
      nativeHarnessRouterLive: (): NativeHarnessRouter => nativeHarnessRouterLive,
      nativeHarnessSessionsLive: (): NativeHarnessSessionStore => nativeHarnessSessionsLive,
      onAgentRunExecutionAccepted,
      options,
      persistence,
      providerRuntimeRegistry: (): ProviderRuntimeRegistry => providerRuntimeRegistry,
      selectCodeConversation: (): ((
        threadId: CodeThreadId,
        options?: Pick<
          AdmittedParentCodeContextInput,
          "purpose" | "excludeOperationId" | "throughOperationId" | "afterOperationId" | "inherited"
        >,
      ) => ReturnType<typeof admittedParentCodeContext>) => selectCodeConversation,
      windowAuthorityStore,
      workThreadProjection: (): WorkThreadProjection => workThreadProjection,
      workTurnProjection: (): WorkTurnProjection => workTurnProjection,
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
      peekCreateFromIssueFramed,
      siblingThreadsService,
      threadOutsideContentMarks,
      toolEgressRules,
    } = yield* wireIntegrations({
      late,
      externalContentIngestionStore,
      options,
      persistence,
      windowAuthorityStore,
      workThreadProjection: (): WorkThreadProjection => workThreadProjection,
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
      launchSessionRoutes,
      machineChangeRoutes,
      stopComputerSettingsWatch,
      webAssets,
    } = wireComputerUse({
      late,
      browserAuthority: (): ServerBrowserAuthorityResolver => browserAuthority,
      externalContentIngestionStore,
      machineChangeFeed,
      options,
      persistence,
      processAuthorityNow,
      providerRuntimeRegistry: (): ProviderRuntimeRegistry => providerRuntimeRegistry,
      validationEventStore,
      windowAuthorityStore,
      workThreadProjection: (): WorkThreadProjection => workThreadProjection,
    });
    const {
      agentMessageRoutes,
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
      workThreadProjection,
    } = yield* wireWorkspace({
      late,
      agentMessageProjection,
      bindingReceiptStore,
      githubCapabilityService,
      githubIntegrationIsEffective,
      options,
      persistence,
      providerRuntimeRegistry: (): ProviderRuntimeRegistry => providerRuntimeRegistry,
      spendCeilingHolder,
      windowAuthorityStore,
      windowCanOpenThreadById: (): ((windowId: WindowId, threadId: string) => Promise<boolean>) =>
        windowCanOpenThreadById,
    });
    const {
      agentProfileRoutes,
      canAccessCodeProject,
      codeAttachments,
      codeBoardEventStore,
      codeCompletedThreadSource,
      codeEvidence,
      codeProjectAccess,
      codeService,
      codeTestDiscovery,
      codeWorkingDirectoryProbePath,
      environmentService,
      folderBrowseRoutes,
      folderBrowseService,
      isCodeProviderModelAllowed,
      isProjectPolicyTargetAllowed,
      projectPullRequestCadence,
      projectPullRequestService,
      projectRoutes,
      roots,
      selectCodeConversation,
      workAttachments,
    } = yield* wireCode({
      threadAwaitsHarnessApproval,
      late,
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
      extensionPackageStore,
      extensionRoutes,
      localUsageHistoryRoutes,
      nativeHarnessEndpoints,
      nativeHarnessTranscripts,
      probeProviderForThreads,
      providerDataDirectory,
      providerOAuthRoutes,
      providerRoutes,
      providerRuntimeRegistry,
      providerService,
      providerUsageLimitsRoutes,
      providerUsageLimitsService,
      refreshStandaloneSkills,
      resolveSelectedExtensions,
      reviewedModelManifest,
      skillDiscoveryService,
    } = yield* wireProviders({
      late,
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
      options,
      persistence,
      processAuthorityNow,
      version,
      windowAuthorityStore,
      workThreadProjection,
    });
    const {
      browserAuthority,
      browserAutomationService,
      browserToolApprovalService,
      liveProjectBrowsers,
      productFeedbackRoutes,
      productFeedbackService,
      projectBrowserService,
      windowHoldsProject,
    } = yield* wireBrowser({
      late,
      browserCaptures,
      codeEvidence,
      externalContentIngestionStore,
      options,
      persistence,
      projectService,
      providerDataDirectory,
      shellService,
      windowAuthorityStore,
      workThreadProjection,
    });
    const {
      baseRouteCodeService,
      codeOperationRuntime,
      codeTurnDecisions,
      routeCodeService,
      terminalProcessPort,
    } = yield* wireCodeRuntime({
      threadAwaitsHarnessApproval,
      late,
      agentMessageService,
      agentRunPersistence,
      agentsManagedToolsFor,
      androidInputGrants,
      androidToolchainService: (): AndroidToolchainService => androidToolchainService,
      appleToolchainService: (): AppleToolchainService => appleToolchainService,
      browserAuthority,
      canAccessCodeProject,
      codeApprovalStore,
      codeAttachments,
      codeBoardEventStore,
      codeBoardPlanProgressSource,
      codeEvidence,
      codeProjectAccess,
      codeService,
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
      recordAppleEvidence: (): ((
        evidence: import("@octant/contracts").AppleBuildEvidence,
        startedAt: string,
      ) => void) => recordAppleEvidence,
      requireBrowserAutomationService,
      requireBrowserToolApprovalService,
      resolveAndroidContext: (): ((
        windowId: WindowId,
        scope: {
          readonly authority: import("@octant/contracts").ToolActionAuthority;
          readonly threadId: import("@octant/contracts").CodeThreadId;
          readonly checkoutId: import("@octant/contracts").CodeCheckoutId;
        },
        envelope: AndroidRpcEnvelope,
      ) => Promise<AndroidExecutionContext | undefined>) => resolveAndroidContext,
      resolveAppleContext: (): ((
        windowId: WindowId,
        scope: {
          readonly authority: import("@octant/contracts").ToolActionAuthority;
          readonly threadId: import("@octant/contracts").CodeThreadId;
          readonly checkoutId: import("@octant/contracts").CodeCheckoutId;
        },
        envelope: AppleRpcEnvelope,
      ) => Promise<AppleExecutionContext | undefined>) => resolveAppleContext,
      resolveSelectedExtensions,
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
      androidToolchainRoutes,
      androidToolchainService,
      appleToolchainRoutes,
      appleToolchainService,
      recordAppleEvidence,
      resolveAndroidContext,
      resolveAppleContext,
    } = yield* wireDevices({
      androidInputGrants,
      codeOperationRuntime,
      codeSessionAuthority,
      persistence,
      projectService,
      providerDataDirectory,
      roots,
      simulatorInputGrants,
      windowAuthorityStore,
    });
    const {
      codeCheckoutOpenRoutes,
      codeExternalEditorRoutes,
      codeOperationApprovalRoutes,
      codeRoutes,
      localServerRoutes,
      projectTerminals,
      remoteServerGrantLocalRoutes,
      remoteServerGrants,
    } = yield* wireCodeTooling({
      canAccessCodeProject,
      codeOperationRuntime,
      codeWorkingDirectoryProbePath,
      managedWorktreeReceipts,
      options,
      persistence,
      projectRootPort,
      projectService,
      roots,
      routeCodeService,
      terminalProcessPort,
      windowAuthorityStore,
    });
    const {
      followUpCreation,
      followUpSuggestionRoutes,
      nativeHarnessApprovals,
      nativeHarnessComposition,
      nativeHarnessEgressRoutes,
      nativeHarnessQuestionsLive,
      nativeHarnessRouterLive,
      nativeHarnessRoutingRoutes,
      nativeHarnessSessionRoutes,
      nativeHarnessSessionsLive,
      researchRouter,
      sideTaskFirstMessage,
      sideTaskRoutes,
      threadWork,
    } = wireHarness({
      late,
      agentRunAdmission,
      agentRunEligibleTargets,
      agentRunOrchestration,
      agentRunParentAuthority,
      agentRunPersistence,
      codeOperationRuntime,
      codeSessionAuthority,
      configuredDriverOptions,
      contextHarness,
      externalContentIngestionStore,
      goalLoopService: (): GoalLoopService => goalLoopService,
      goalService,
      nativeHarnessEndpoints,
      persistence,
      providerDataDirectory,
      sideTasks,
      threadFollowUpSuggestions,
      toolEgressRules,
      windowAuthorityStore,
      workThreadProjection,
    });
    const {
      chatRoutes,
      chatService,
      codeThreadMentionDirectory,
      generatedImageStore,
      imageJobService,
      linkedThreadRoutes,
      navigatorAssistantBindings,
      scaffoldRoutes,
      threadCheckpointRoutes,
      threadMentionRoutes,
      threadMentionService,
      workspacePresetRoutes,
    } = yield* wireChat({
      threadAwaitsHarnessApproval,
      late,
      agentMessageProjection,
      agentMessageService,
      agentPluginMcpSessionManager,
      agentRunPersistence,
      agentsManagedToolsFor,
      browserCaptures,
      capacityScheduler,
      chatAttachmentStore,
      chatDataDirectory,
      codeService,
      computerToolsFor,
      computerUseTools,
      configuredDriverOptions,
      contextHarness,
      credentialResolver,
      environmentService,
      extensionActivationService,
      extensionApiService,
      extensionPackageStore,
      externalContentIngestionStore,
      githubIssueContextService,
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
      threadMessageQueue,
      threadMessageQueueRoutes,
      workArtifactProjection,
      workThreadService,
      workThreadServiceWithWorkflows,
      workTurnProjection,
      workTurnService,
      workflowService,
    } = yield* wireWork({
      late,
      agentRunPersistence,
      agentsManagedToolsFor,
      authorizeWorkThreadForWindow,
      browserAuthority,
      browserCaptures,
      browserModelBindings,
      canAccessCodeProject,
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
      requireBrowserAutomationService,
      requireBrowserToolApprovalService,
      resolveSelectedExtensions,
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
      workAttachments,
      workProjectStatusFiles,
      workProjectStatusReader,
      workThreadProjection,
    });
    yield* wireContinuation({
      agentRunOrchestration,
      agentRunParentAuthority,
      agentRunPersistence,
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
        late,
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
    const { browserAutomationRoutes, contextRoutes, windowCanOpenThread, windowCanOpenThreadById } =
      wireContext({
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
        requireBrowserToolApprovalService,
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
      artifactLibraryRoutes,
      artifactLibraryService,
      artifactMirrorRoutes,
      canvasCommentService,
      canvasRoutes,
      canvasService,
      replicaArtifactSync,
      resolveCanvasWorkspace,
      threadHandOffRoutes,
    } = wireCanvas({
      late,
      chatDataDirectory,
      configuredDriverOptions,
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
      threadExportService,
      threadOutsideContentMarks,
      windowAuthorityStore,
      workArtifactProjection,
      workThreadProjection,
    });
    const {
      automationNotificationRoutes,
      automationRoutes,
      automationScheduler,
      completedThreadArchiveSweep,
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
    const {
      fleetActivityRoutes,
      pendingRequestRoutes,
      sidebarBackgroundRoutes,
      workOverviewRoutes,
      workPromotionRoutes,
      workRequestRoutes,
      workThreadRoutes,
    } = wireWorkRequests({
      threadAwaitsHarnessApproval,
      late,
      agentRunPersistence,
      baseRouteCodeService,
      chatService,
      codeOperationRuntime,
      codeTurnDecisions,
      gitObservationPort,
      goalService,
      nativeHarnessApprovals,
      nativeHarnessQuestionsLive,
      nativeHarnessSessionsLive,
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
    const { authenticatedProductDispatch, dispatchMeasuredProductRoutes } = wireRoutes({
      agentMessageRoutes,
      agentProfileRoutes,
      agentRunRoutes,
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
      hostResourceRoutes: (): ReturnType<typeof createHostResourceRouteHandler> =>
        hostResourceRoutes,
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
      replicaSyncStatusRoutes: (): ReturnType<typeof createReplicaSyncStatusRouteHandler> =>
        replicaSyncStatusRoutes,
      scaffoldRoutes,
      shellRoutes,
      shipRoutes,
      sidebarBackgroundRoutes,
      sideTaskRoutes,
      speechRoutes,
      spendCeilingRoutes,
      syncedArtifactRoutes: (): ReturnType<typeof createSyncedArtifactRouteHandler> =>
        syncedArtifactRoutes,
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
      artifactSyncService,
      composeHostDiagnostics,
      externalContentRoutes,
      hostControlRoutes,
      hostResourceRoutes,
      localDeviceAdministrationRoutes,
      privateListenerAdministrationRoutes,
      privateListenerController,
      privateListenerSetting,
      providerCredentialRoutes,
      replicaMembershipRoutes,
      replicaMembershipService,
      replicaStoreSettingsRoutes,
      replicaSyncStatusRoutes,
      syncedArtifactRoutes,
    } = wireRemote({
      late,
      agentMessageService,
      artifactLibraryService,
      authenticatedProductDispatch,
      browserCaptureStore,
      canvasCommentService,
      canvasRoutes,
      canvasService,
      chatAttachmentStore,
      codeAttachments,
      codeProjectAccess,
      credentialBroker,
      credentialResolver,
      externalContentIngestionStore,
      folderBrowseService,
      generatedImageStore,
      options,
      persistence,
      providerDataDirectory,
      providerRuntimeRegistry,
      providerService,
      pushNotificationTokenStore,
      remoteServerGrants,
      replicaArtifactSync,
      resolveCanvasWorkspace,
      serve,
      startedAt,
      threadExportService,
      threadMessageQueue,
      toolEgressRules,
      version,
      webAssets,
      windowAuthorityStore,
      workAttachments,
      workThreadProjection,
    });

    let remoteListenerError: PrivateListenerFailureCode | undefined;
    // Retained so shutdown can settle warming before the runtime registry
    // closes: an acquisition that lands after `closeAll()` would leave a warm
    // runtime alive on its idle lease with nothing left to close it.
    let warmingProviders: Promise<void> = Promise.resolve();
    let stopArtifactSync: () => void = () => undefined;
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
                return healthResponse(version, options.instanceId, {
                  activeAgentCount: providerRuntimeRegistry.activeSessionTotal(),
                  attentionRequired: providerRuntimeRegistry.attentionRequired(),
                });
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
              if (url.pathname === "/api/hosts") {
                const origin = request.headers.get("origin");
                const headers = new Headers({ vary: "Origin" });
                if (
                  origin !== null &&
                  isAllowedRendererOrigin(origin, options.allowedRendererHttpOrigin)
                ) {
                  headers.set("access-control-allow-origin", origin);
                }
                return Response.json({ hosts: listHosts(localHostDisplayName()) }, { headers });
              }
              return (
                (await privateListenerAdministrationRoutes(request)) ??
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
              late.remoteListener.current = late.currentRemoteGateway.current?.listener();
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
          // A leave the host stopped in the middle of finishes its cleanup:
          // sync off and the device key deleted.
          void replicaMembershipService.finishLeaving().catch(() => undefined);
          return {
            url: localServer.url,
            ...(late.remoteListener.current === undefined
              ? {}
              : { remoteListener: late.remoteListener.current }),
            ...(remoteListenerError === undefined ? {} : { remoteListenerError }),
            diagnostics: composeHostDiagnostics,
            backup: (label = "manual") => persistence.createVerifiedBackup(label),
            stop: (closeActiveConnections = false) => {
              // R4: attempt both remote and local shutdowns even when one
              // throws synchronously. Both calls are wrapped in
              // Promise.resolve().then() so synchronous throws become
              // rejections that are captured and settled together. The first
              // deterministic failure (remote before local) is propagated.
              if (late.currentRemoteGateway.current === undefined) {
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
