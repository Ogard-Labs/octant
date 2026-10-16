import { observedRpcLatency, slowRequestRoute, withServerTiming } from "../latencyStatsProjection";
import { createAuthenticatedProductDispatch } from "../authenticatedProductRoutes";
import { compareRemoteForwardListToClassifier } from "../remoteForwardListClassifierGate";
import { createReplicaSyncStatusRouteHandler } from "../replica/replicaMembershipRoutes";
import { createSyncedArtifactRouteHandler } from "../replica/syncedArtifactRoutes";
import { createHostResourceRouteHandler } from "../hostResourceRoutes";
import type { ServerStart } from "./serverShape";
import type { AgentRunsWiring } from "./agentRuns";
import type { IntegrationsWiring } from "./integrations";
import type { UsageWiring } from "./usage";
import type { ComputerUseWiring } from "./computerUse";
import type { WorkspaceWiring } from "./workspace";
import type { CodeWiring } from "./code";
import type { ProvidersWiring } from "./providers";
import type { BrowserWiring } from "./browser";
import type { DevicesWiring } from "./devices";
import type { CodeToolingWiring } from "./codeTooling";
import type { HarnessWiring } from "./harness";
import type { ChatWiring } from "./chat";
import type { WorkWiring } from "./work";
import type { ZenWiring } from "./zen";
import type { ContextWiring } from "./context";
import type { WorkFilesWiring } from "./workFiles";
import type { CanvasWiring } from "./canvas";
import type { AutomationWiring } from "./automation";
import type { WorkRequestsWiring } from "./workRequests";

export type RoutesDependencies = Pick<ServerStart, "latencyStats"> &
  Pick<AgentRunsWiring, "agentRunRoutes" | "agentRunSettingsRoutes"> &
  Pick<IntegrationsWiring, "githubRoutes" | "integrationRoutes"> &
  Pick<
    UsageWiring,
    | "diagnosticsExportRoutes"
    | "spendCeilingRoutes"
    | "usageDashboardRoutes"
    | "usageRoutes"
    | "validationEvidenceRoutes"
  > &
  Pick<ComputerUseWiring, "computerUseRoutes" | "launchSessionRoutes" | "machineChangeRoutes"> &
  Pick<
    WorkspaceWiring,
    | "githubCloneRoutes"
    | "goalRoutes"
    | "planRoutes"
    | "projectBindingRoutes"
    | "shellRoutes"
    | "shipRoutes"
    | "themeRoutes"
  > &
  Pick<
    CodeWiring,
    "agentProfileRoutes" | "codeProjectAccess" | "folderBrowseRoutes" | "projectRoutes"
  > &
  Pick<
    ProvidersWiring,
    | "discoveryRoutes"
    | "extensionRoutes"
    | "localUsageHistoryRoutes"
    | "providerOAuthRoutes"
    | "providerRoutes"
    | "providerUsageLimitsRoutes"
  > &
  Pick<BrowserWiring, "productFeedbackRoutes"> &
  Pick<DevicesWiring, "androidToolchainRoutes" | "appleToolchainRoutes"> &
  Pick<
    CodeToolingWiring,
    | "codeCheckoutOpenRoutes"
    | "codeExternalEditorRoutes"
    | "codeOperationApprovalRoutes"
    | "codeRoutes"
    | "localServerRoutes"
    | "remoteServerGrantLocalRoutes"
  > &
  Pick<
    HarnessWiring,
    | "followUpSuggestionRoutes"
    | "nativeHarnessEgressRoutes"
    | "nativeHarnessRoutingRoutes"
    | "nativeHarnessSessionRoutes"
    | "sideTaskRoutes"
  > &
  Pick<
    ChatWiring,
    | "chatRoutes"
    | "linkedThreadRoutes"
    | "scaffoldRoutes"
    | "threadCheckpointRoutes"
    | "threadMentionRoutes"
    | "workspacePresetRoutes"
  > &
  Pick<
    WorkWiring,
    "fileMentionRoutes" | "goalLoopRoutes" | "threadExportRoutes" | "threadMessageQueueRoutes"
  > &
  Pick<
    ZenWiring,
    "navigatorAssistantRoutes" | "workTurnRoutes" | "zenBackgroundRoutes" | "zenRoutes"
  > &
  Pick<ContextWiring, "agentMessageRoutes" | "browserAutomationRoutes" | "contextRoutes"> &
  Pick<
    WorkFilesWiring,
    | "imageRoutes"
    | "previewHandoffBridgeRoutes"
    | "previewRoutes"
    | "speechRoutes"
    | "workFileListingRoutes"
    | "workMutationRoutes"
    | "workResearchRoutes"
  > &
  Pick<
    CanvasWiring,
    "artifactLibraryRoutes" | "artifactMirrorRoutes" | "canvasRoutes" | "threadHandOffRoutes"
  > &
  Pick<AutomationWiring, "automationNotificationRoutes" | "automationRoutes"> &
  Pick<
    WorkRequestsWiring,
    | "fleetActivityRoutes"
    | "pendingRequestRoutes"
    | "sidebarBackgroundRoutes"
    | "workOverviewRoutes"
    | "workPromotionRoutes"
    | "workRequestRoutes"
    | "workThreadRoutes"
  > & {
    /** Wired by wireRemote; read only after startup. */
    readonly hostResourceRoutes: () => ReturnType<typeof createHostResourceRouteHandler>;
    /** Wired by wireRemote; read only after startup. */
    readonly replicaSyncStatusRoutes: () => ReturnType<typeof createReplicaSyncStatusRouteHandler>;
    /** Wired by wireRemote; read only after startup. */
    readonly syncedArtifactRoutes: () => ReturnType<typeof createSyncedArtifactRouteHandler>;
  };

export function wireRoutes(deps: RoutesDependencies) {
  const {
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
    replicaSyncStatusRoutes,
    scaffoldRoutes,
    shellRoutes,
    shipRoutes,
    sidebarBackgroundRoutes,
    sideTaskRoutes,
    speechRoutes,
    spendCeilingRoutes,
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
  } = deps;

  // One route chain is shared by the loopback listener and the authenticated
  // remote gateway. The remote dispatcher binds the verified principal and
  // gives this chain a loopback-shaped internal request; individual handlers
  // resolve the bound context through principalRouteContext before effects.
  const dispatchProductRoutes = async (request: Request): Promise<Response | undefined> =>
    (await hostResourceRoutes()(request)) ??
    (await replicaSyncStatusRoutes()(request)) ??
    (await projectBindingRoutes(request)) ??
    (await launchSessionRoutes(request)) ??
    (await machineChangeRoutes(request)) ??
    (await contextRoutes(request)) ??
    (await projectRoutes(request)) ??
    (await agentRunRoutes(request)) ??
    (await agentRunSettingsRoutes(request)) ??
    (await nativeHarnessRoutingRoutes(request)) ??
    (await nativeHarnessSessionRoutes(request)) ??
    (await nativeHarnessEgressRoutes(request)) ??
    (await followUpSuggestionRoutes(request)) ??
    (await sideTaskRoutes(request)) ??
    (await githubRoutes(request)) ??
    (await integrationRoutes(request)) ??
    (await githubCloneRoutes(request)) ??
    (await agentProfileRoutes(request)) ??
    (await folderBrowseRoutes(request)) ??
    (await linkedThreadRoutes(request)) ??
    (await codeOperationApprovalRoutes(request)) ??
    (await codeCheckoutOpenRoutes(request)) ??
    (await codeExternalEditorRoutes(request)) ??
    (await previewHandoffBridgeRoutes(request)) ??
    (await codeRoutes(request)) ??
    (await appleToolchainRoutes(request)) ??
    (await androidToolchainRoutes(request)) ??
    (await providerRoutes(request)) ??
    (await providerOAuthRoutes(request)) ??
    (await providerUsageLimitsRoutes(request)) ??
    (await discoveryRoutes(request)) ??
    (await chatRoutes(request)) ??
    (await threadMessageQueueRoutes(request)) ??
    (await threadCheckpointRoutes(request)) ??
    (await scaffoldRoutes(request)) ??
    (await workspacePresetRoutes(request)) ??
    (await productFeedbackRoutes(request)) ??
    (await workThreadRoutes(request)) ??
    (await workTurnRoutes(request)) ??
    (await workOverviewRoutes(request)) ??
    (await workMutationRoutes(request)) ??
    (await workFileListingRoutes(request)) ??
    (await previewRoutes(request)) ??
    (await canvasRoutes(request)) ??
    (await imageRoutes(request)) ??
    (await speechRoutes(request)) ??
    (await artifactLibraryRoutes(request)) ??
    (await artifactMirrorRoutes(request)) ??
    (await syncedArtifactRoutes()(request)) ??
    (await automationRoutes(request)) ??
    (await automationNotificationRoutes(request)) ??
    (await workPromotionRoutes(request)) ??
    (await workRequestRoutes(request)) ??
    (await pendingRequestRoutes(request)) ??
    (await fleetActivityRoutes(request)) ??
    (await sidebarBackgroundRoutes(request)) ??
    (await zenBackgroundRoutes(request)) ??
    (await zenRoutes(request)) ??
    (await navigatorAssistantRoutes(request)) ??
    (await localServerRoutes(request)) ??
    (await remoteServerGrantLocalRoutes(request)) ??
    (await threadMentionRoutes(request)) ??
    (await fileMentionRoutes(request)) ??
    (await spendCeilingRoutes(request)) ??
    (await usageDashboardRoutes(request)) ??
    (await localUsageHistoryRoutes(request)) ??
    (await usageRoutes(request)) ??
    (await diagnosticsExportRoutes(request)) ??
    (await threadExportRoutes(request)) ??
    (await threadHandOffRoutes(request)) ??
    (await computerUseRoutes(request)) ??
    (await validationEvidenceRoutes(request)) ??
    (await extensionRoutes(request)) ??
    (await browserAutomationRoutes(request)) ??
    (await shellRoutes(request)) ??
    (await shipRoutes(request)) ??
    (await goalRoutes(request)) ??
    (await goalLoopRoutes(request)) ??
    (await planRoutes(request)) ??
    (await workResearchRoutes(request)) ??
    (await agentMessageRoutes(request)) ??
    (await themeRoutes(request));

  const dispatchMeasuredProductRoutes = async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const measurement = observedRpcLatency(url.pathname);
    if (measurement === undefined) return dispatchProductRoutes(request);
    const startedAt = performance.now();
    const response = await dispatchProductRoutes(request);
    if (response === undefined) return undefined;
    // This measures time to produce the response; a streaming route that
    // promptly returns its stream is not considered slow. Round once so the
    // dashboard slowCount and this warning agree on the same millisecond.
    const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
    latencyStats.record(measurement, durationMs);
    const thresholdMs = latencyStats.slowThresholdMs(measurement);
    if (thresholdMs !== undefined && durationMs >= thresholdMs) {
      console.warn(
        `Octant request handling took ${(durationMs / 1_000).toFixed(1)}s for ${request.method} ${slowRequestRoute(url.pathname)}, past ${(thresholdMs / 1_000).toFixed(0)}s slow request threshold.`,
      );
    }
    return withServerTiming(response, measurement, durationMs);
  };

  const forwardListDrift = compareRemoteForwardListToClassifier();
  if (forwardListDrift.length > 0) {
    throw new Error(
      "Remote forward list does not match the product classifier; a paired device would be admitted to a local-only action or denied a classified remote one.",
    );
  }
  const authenticatedProductDispatch = createAuthenticatedProductDispatch({
    dispatch: (request, context) =>
      codeProjectAccess.run(context, () => dispatchMeasuredProductRoutes(request)),
  });
  return { authenticatedProductDispatch, dispatchMeasuredProductRoutes };
}

export type RoutesWiring = ReturnType<typeof wireRoutes>;
