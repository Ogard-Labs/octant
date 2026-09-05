import { IMAGE_LIBRARY_SCOPE_ID } from "@octant/contracts";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type DiscoveryCandidate,
  LOCAL_TOOL_HOST_ID,
  type AppleRpcEnvelope,
  decodeAgentRunParentThreadId,
  decodeChatThreadId,
  decodeCodeCheckoutId,
  decodeCodeCheckoutIdentity,
  decodeCodeEvidenceContentId,
  decodeCodeFileId,
  decodeCodeRelativePath,
  decodeCodeRepositoryId,
  decodeCodeThreadId,
  decodeWorkThreadId,
  ThreadCreationRootId,
  decodeThreadWorkingDirectory,
  decodeCodeWorktreeRef,
  decodeCodeWorktreeSourcePreview,
  decodeWindowId,
  ReplayCursor,
  type AgentRun,
  type AgentRunParentThreadId,
  type CodeCheckoutIdentity,
  type PermissionPersistence,
  type ProviderDriverKind,
  type ProviderInstance,
  type ProviderRuntimeEvent,
  type WindowId,
  type CanvasRefreshRequest,
  type CanvasRefreshSkill,
  type CapacityReservationId,
  type CodeOperationId,
  type CodeThreadForkOrigin,
  type CodeThreadId,
  type OctantMode,
  type WorkThreadId,
} from "@octant/contracts";
import type { ExtensionProviderFamily, StandaloneSkillScope } from "@octant/contracts/extensions";
import type { ExtensionSnapshot } from "@octant/contracts/extension-rpc";
import type { ProviderDriver } from "@octant/provider-sdk/driver";
import {
  authorizeAgentRunCreation,
  layoutContainsAgentRunThread,
} from "./agentRun/authorizeAgentRunCreation";
import { Data, Effect, Schema, Scope } from "effect";
import { DurableBindingReceiptStore } from "./bindingReceiptStore";
import { assistantTranscript } from "./chat/assistantTranscript";
import { ChatService } from "./chat/chatService";
import { ResearchRouter } from "./chat/research/researchRouter";
import { SearxngClient } from "./chat/research/searxngClient";
import { ThreadWorkService } from "./chat/threadWorkService";
import { createChatRouteHandler } from "./chatRoutes";
import { MachineChangeFeed } from "./machineChangeFeed";
import { createMachineChangeRouteHandler } from "./machineChangeRoutes";
import { createScaffoldRouteHandler } from "./scaffoldRoutes";
import {
  admittedBundledProviderDriverKinds,
  filterSkillCatalogForScope,
} from "@octant/plugin-host";
import {
  decodeLayoutNodeId,
  decodeMentionableThreadId,
  decodePaneId,
  decodeWorkspaceTabId,
} from "@octant/contracts";
import { createWorkspacePresetRouteHandler } from "./workspacePresetRoutes";
import { CURATED_WORKSPACE_PRESETS } from "./workspacePresets/curatedWorkspacePresets";
import { createThreadCheckpointRouteHandler } from "./threadCheckpointRoutes";
import { createProductFeedbackRouteHandler } from "./productFeedbackRoutes";
import {
  decodeBrowserContextId,
  decodeBrowserThreadId,
} from "@octant/contracts/browser-automation";
import { decodeCodeEvidenceReference } from "@octant/contracts/code-operations";
import { ProductFeedbackService } from "./browser/productFeedbackService";
import { createProductFeedbackTurnPort } from "./browser/productFeedbackTurnPort";
import {
  createCheckpointChatPort,
  createCheckpointCodePort,
} from "./checkpoint/threadCheckpointPorts";
import { ThreadCheckpointService } from "./checkpoint/threadCheckpointService";
import { createWorkMutationRouteHandler } from "./workMutationRoutes";
import { createWorkFileListingRouteHandler } from "./workFileListingRoutes";
import { WorkFileListingService } from "./work/workFileListingService";
import { WorkTurnFileObserver } from "./work/workTurnFileObserver";
import { WorkFilePreviewRefs } from "./work/workFilePreviewRefs";
import { createWorkOverviewRouteHandler } from "./workOverviewRoutes";
import { WorkArtifactProjection } from "./work/workArtifactProjection";
import { liveWorkFilesystem } from "./work/workFilesystemPort";
import { WorkMutationEventStore } from "./work/workMutationEventStore";
import { WorkMutationService } from "./work/workMutationService";
import { WorkResolutionService } from "./work/workResolutionService";
import {
  WorkThreadProjection,
  hydrateWorkThreadProjectionFromJournal,
} from "./work/workThreadProjection";
import { WorkThreadService } from "./work/workThreadService";
import {
  boardRuntimeActivityFromTurnsAndSignals,
  composeWorkBoardEvidence,
  WorkThreadBoardService,
  type WorkBoardRuntimeActivity,
  type WorkBoardThread,
} from "./work/workThreadBoardService";
import {
  WorkTurnProjection,
  hydrateWorkTurnProjectionFromJournal,
} from "./work/workTurnProjection";
import { WorkAttachmentStore } from "./work/workAttachmentStore";
import { WorkTurnService } from "./work/workTurnService";
import { withWorkflowLifecycle } from "./work/workThreadWorkflowHook";
import { WorkflowEventStore } from "./work/workflowEventStore";
import { WorkflowProjection } from "./work/workflowProjection";
import { WorkflowService } from "./work/workflowService";
import { resolveThreadWorkingDirectory } from "./threadWorkingDirectoryAuthority";
import { WorkPromotionApplicationService } from "./work/workPromotionApplicationService";
import { createWorkPromotionCodeThreadPort } from "./work/workPromotionCodeThreadPort";
import { WorkPromotionEventStore } from "./work/workPromotionEventStore";
import {
  createWorkPromotionProjectPort,
  hydrateWorkArtifactProjectionFromJournal,
} from "./work/workPromotionProjectPort";
import { WorkPromotionProjection } from "./work/workPromotionProjection";
import { WorkPromotionService } from "./work/workPromotionService";
import { createWorkPromotionRouteHandler } from "./workPromotionRoutes";
import { WorkRequestApplicationService } from "./work/workRequestApplicationService";
import { WorkRequestEventStore } from "./work/workRequestEventStore";
import { WorkRequestProjection } from "./work/workRequestProjection";
import { attachWorkRequestRuntime, WorkRequestRuntime } from "./work/workRequestRuntime";
import { WorkRequestService } from "./work/workRequestService";
import { createWorkRequestRouteHandler } from "./workRequestRoutes";
import { createWorkThreadRouteHandler } from "./workThreadRoutes";
import { createWorkTurnRouteHandler } from "./workTurnRoutes";
import { createSidebarBackgroundRouteHandler } from "./theme/sidebarBackgroundRoutes";
import { SidebarBackgroundStore } from "./theme/backgroundStore";
import { createThemeRouteHandler } from "./theme/themeRoutes";
import { createGoalRouteHandler } from "./goal/goalRoutes";
import { createGoalLoopRouteHandler } from "./goal/goalLoopRoutes";
import { GoalLoopEventStore } from "./goal/goalLoopEventStore";
import { GoalLoopService } from "./goal/goalLoopService";
import { createShipRouteHandler } from "./ship/shipRoutes";
import { ShipEventStore } from "./ship/shipEventStore";
import { ShipService } from "./ship/shipService";
import { createPlanRouteHandler } from "./plan/planRoutes";
import { PlanService } from "./plan/planService";
import { JournalPlanStore } from "./plan/journalPlanStore";
import { JournalNavigatorAssistantBindingStore } from "./navigatorAssistant/navigatorAssistantBindingStore";
import { createNavigatorAssistantRouteHandler } from "./navigatorAssistant/navigatorAssistantRoutes";
import { NavigatorAssistantService } from "./navigatorAssistant/navigatorAssistantService";
import { GoalService } from "./goal/goalService";
import { JournalGoalStore } from "./goal/journalGoalStore";
import { createWorkResearchRouteHandler } from "./workResearchRoutes";
import { WorkResearchService } from "./work/workResearchService";
import { WorkResearchEventStore } from "./work/workResearchEventStore";
import { WorkResearchProjection } from "./work/workResearchProjection";
import { createWorkResearchSourcePort } from "./work/workResearchSourcePort";
import { ThemeService } from "./theme/themeService";
import { MAX_CHAT_ATTACHMENT_BYTES } from "./chat/chatAttachmentStore";
import { GeneratedImageStore } from "./image/generatedImageStore";
import { ImageJobService } from "./image/imageJobService";
import { createImageAgentTools } from "./image/imageAgentTools";
import { createImageRouteHandler } from "./image/imageRoutes";
import { createSpeechRouteHandler } from "./speech/speechRoutes";
import { chatImageScopeAllowedForWindow } from "./image/imageScopeAuthority";
import { writeConfinedWorkFile } from "./work/workConfinedWrite";
import { CodeContentStore } from "./code/codeContentStore";
import { CodeEvidenceStore } from "./code/codeEvidenceStore";
import { CodeAttachmentStore } from "./code/codeAttachmentStore";
import { CodeFileService } from "./code/codeFileService";
import { CodeFileListingService } from "./code/codeFileListingService";
import { CodeFileWatchService } from "./code/codeFileWatchService";
import { CodeSearchService } from "./code/codeSearchService";
import { RepositoryTestDiscoveryService } from "./code/repositoryTestDiscoveryService";
import {
  CodeService,
  type CodeCheckoutObservationPort,
  type CodeFileRootAuthorityPort,
  type CodeWorktreeRefsPort,
  type CodeWorktreeSourcePreviewPort,
  type ManagedCodeThreadCreationPort,
} from "./code/codeService";
import { createCodeOperationRuntime, type CodeOperationRuntime } from "./code/codeOperationRuntime";
import { CodePlannerService } from "./code/codePlannerService";
import {
  createCodeProfileSkillResolver,
  createStoredCodeProfileSkillTextLoader,
} from "./code/codeProfileSkillResolver";
import { CodeOperationEventStore } from "./code/codeOperationEventStore";
import {
  CodeThreadMetadataService,
  pullRequestIdentitiesFromHistory,
} from "./code/codeThreadMetadataService";
import {
  boardRuntimeActivityFromWorks,
  CodeThreadBoardService,
  type CodeBoardThread,
} from "./code/codeThreadBoardService";
import { createCodeBoardPlanProgressSource } from "./code/codeBoardPlanProgress";
import { CodeFollowUpService } from "./code/codeFollowUpService";
import { FailingChecksFollowUps } from "./code/failingChecksFollowUps";
import {
  CodeProjectPullRequestService,
  type CodeProjectPullRequestDetailPort,
  type CodeProjectPullRequestListPort,
} from "./code/codeProjectPullRequestService";
import { CodeProjectPullRequestCadence } from "./code/codeProjectPullRequestCadence";
import { CodeProjectPullRequestSnapshotStore } from "./code/codeProjectPullRequestSnapshotStore";
import { createGhCommandPort, GhPullRequestPort } from "./code/ghPullRequestPort";
import { RepositoryTestProcessPort } from "./code/repositoryTestProcessPort";
import { TerminalProcessPort } from "./code/terminalProcessPort";
import { CodeOperationApprovalStore } from "./code/codeOperationApprovalStore";
import { CodeSessionAuthorityStore } from "./code/codeSessionAuthorityStore";
import { ProcessAuthorityClock } from "./processAuthorityClock";
import {
  createFileHelperProcessTransport,
  type FileHelperProcessTransport,
} from "./code/fileHelperProcessTransport";
import { FileOperationPort } from "./code/fileOperationPort";
import { createManagedWorktreeNodePorts, listWorktreeRefs } from "./code/managedWorktreeNodePorts";
import {
  ManagedWorktreeService,
  type ManagedWorktreeRepositoryPort,
} from "./code/managedWorktreeService";
import { ManagedRootGrantStore } from "./code/managedRootGrantStore";
import { ManagedWorktreeReceiptStore } from "./code/managedWorktreeReceiptStore";
import { createManagedCodeThreadCreationPort } from "./code/managedCodeThreadCreation";
import {
  MAX_CODE_FILE_BODY_SIZE,
  createCodeRouteHandler,
  type CodeRouteService,
} from "./codeRoutes";
import {
  createCodeCheckoutOpenRouteHandler,
  createCodeExternalEditorRouteHandler,
  isCodeCheckoutOpenTargetCurrent,
  isCodeExternalEditorTargetCurrent,
} from "./codeExternalEditorRoutes";
import { createCodeOperationApprovalRouteHandler } from "./codeOperationApprovalRoutes";
import {
  createComputerUseRuntime,
  reportComputerUseDestination,
  type ComputerUseNativeAdapter,
  type ComputerUseRuntime,
} from "./computerUse/computerUseRuntime";
import { detectMacOsScreen } from "./computerUse/computerUseDestination";
import { createMacOsComputerUseAdapter } from "./computerUse/macOsComputerUseAdapter";
import { createNodeComputerUseProcessPort } from "./computerUse/nodeComputerUseProcessPort";
import { createComputerUseValidationEvidenceRecorder } from "./computerUse/computerUseValidationEvidence";
import { createComputerUseRouteHandler } from "./computerUseRoutes";
import { CodeEnvironmentService } from "./codeEnvironmentService";
import { ContextHarnessService } from "./context/contextHarnessService";
import {
  makeProviderCapacityScheduler,
  makeUnobservedProviderCapacityFacts,
} from "./context/contextRuntime";
import { createContextRouteHandler } from "./contextRoutes";
import { GitEnvironmentPort } from "./gitEnvironmentPort";
import { GitObservationPort } from "./code/gitObservationPort";
import { GitMutationPort } from "./code/gitMutationPort";
import { GitService } from "./code/gitService";
import { GhAuthenticationPort } from "./github/ghAuthenticationPort";
import { GhRepositoryCataloguePort } from "./github/ghRepositoryCataloguePort";
import { GhRepositoryObservationPort } from "./github/ghRepositoryObservationPort";
import { GithubCapabilityService } from "./github/githubCapabilityService";
import { GithubCatalogueService } from "./github/githubCatalogueService";
import { GithubIssueContextService } from "./github/githubIssueContextService";
import { LinearIssueContextService } from "./plugins/linear/linearIssueContextService";
import { LINEAR_ISSUE_GET_OPERATION } from "@octant/contracts/linear-issues";
import { GithubReadToolService } from "./github/githubReadToolService";
import {
  githubReadToolSetIfEffective,
  isGithubIntegrationEffective,
  isLinearIntegrationEffective,
} from "./github/githubIntegrationEffective";
import { ManagedCloneProcessPort, createOwnedGitContext } from "./github/managedCloneProcessPort";
import { ManagedCloneService } from "./github/managedCloneService";
import { ManagedRepositoryInventory } from "./github/managedRepositoryInventory";
import { createGithubCloneRouteHandler } from "./githubCloneRoutes";
import { createGithubRouteHandler } from "./githubRoutes";
import {
  createBrokerSecretVault,
  createUnavailableSecretVault,
  type IntegrationSecretVault,
} from "./integration/integrationCredentialVault";
import { createFileConnectionStore } from "./integration/integrationConnectionStore";
import { createLinearIntegrationService } from "./integration/integrationService";
import { createIntegrationRouteHandler } from "./integrationRoutes";
import { healthResponse } from "./health";
import { LaunchSessionStore } from "./launchSessionStore";
import { createLaunchSessionRouteHandler } from "./launchSessionRoutes";
import {
  Persistence,
  PersistenceStartupFailed,
  type PersistenceService,
  type VerifiedStoreBackupReceipt,
} from "./persistence/persistenceService";
import { readAgentRunAdmittedContext } from "./persistence/agentRunContentStore";
import { readHostIdentity } from "./persistence/remoteAccessProjection";
import { createProjectBindingRouteHandler } from "./projectBindingRoutes";
import { createProjectRouteHandler } from "./projectRoutes";
import { createAgentProfileRouteHandler } from "./agentProfileRoutes";
import { AgentProfileService } from "./agentProfileService";
import { AgentRunEventStore } from "./agentRun/agentRunEventStore";
import {
  AgentRunOrchestrationService,
  type AgentRunProcessSupervisorPort,
  createInMemoryCapacityPort,
} from "./agentRun/agentRunOrchestrationService";
import { AgentRunPersistenceService } from "./agentRun/agentRunPersistenceService";
import { createAgentRunRouteHandler } from "./agentRun/agentRunRoutes";
import {
  createAgentRunChildWorktreePort,
  deriveAgentRunChildWorktreeThreadId,
  resolveAgentRunCodeWorkspaceContext,
} from "./agentRun/agentRunChildWorktreePort";
import { AgentRunWorkspaceReceiptStore } from "./agentRun/agentRunWorkspaceReceiptStore";
import { AgentRunWorkspaceService } from "./agentRun/agentRunWorkspaceService";
import type { AgentRunChildWorktreePort } from "./agentRun/agentRunWorkspaceService";
import { AgentRunSettingsStore } from "./agentRun/agentRunSettingsStore";
import { createAgentRunSettingsRouteHandler } from "./agentRun/agentRunSettingsRoutes";
import type { AgentRunRouteDependencies } from "./agentRun/agentRunRoutes";
import {
  createAgentRunSessionRuntime,
  createRecordedAgentRunContextSnapshotPort,
} from "./agentRun/agentRunSessionRuntime";
import { AgentRunSessionSupervisor } from "./agentRun/agentRunSessionSupervisor";
import { AgentRunLiveConversationStore } from "./agentRun/agentRunLiveConversationStore";
import { createFolderBrowseRouteHandler } from "./folderBrowseRoutes";
import { createLinkedThreadRouteHandler } from "./linkedThread/linkedThreadRoutes";
import { createLinkedThreadRuntime } from "./linkedThread/linkedThreadRuntime";
import { FolderBrowseService } from "./folderBrowseService";
import { ProjectService } from "./projectService";
import { windowCanAccessCodeProject } from "./windowCodeProjectAccess";
import { ProjectRootPort } from "./projectRootPort";
import { createArtifactLibraryRouteHandler } from "./artifactLibraryRoutes";
import { createArtifactMirrorRouteHandler } from "./artifactMirrorRoutes";
import { ArtifactLibraryService } from "./canvas/artifactLibraryService";
import {
  createCanvasRouteHandler,
  readCanvasForWindow,
  resolveCanvasActiveContext,
} from "./canvasRoutes";
import { AutomationCommandService } from "./automation/automationCommandService";
import {
  createAutomationCodeDispatchPort,
  automationCodeEvidenceFromText,
} from "./automation/automationCodeDispatchPort";
import { createAutomationWorkDispatchPort } from "./automation/automationWorkDispatchPort";
import { AutomationDispatchService } from "./automation/automationDispatchService";
import { AutomationEventStore } from "./automation/automationEventStore";
import { hydrateAutomationProjection } from "./automation/automationProjection";
import { createAutomationRouteHandler } from "./automation/automationRoutes";
import { AutomationSchedulerService } from "./automation/automationSchedulerService";
import { resolveAutomationAuthorityLiveFacts } from "./automation/resolveAutomationAuthorityLiveFacts";
import { AutomationNotificationPreferencesStore } from "./automation/automationNotificationPreferencesStore";
import { AutomationNotificationDeliveryStore } from "./automation/automationNotificationDeliveryStore";
import { AutomationNotificationDeliveryService } from "./automation/automationNotificationDeliveryService";
import { createAutomationNotificationRouteHandler } from "./automation/automationNotificationRoutes";
import { createUnavailablePushDeliveryTransport } from "./automation/pushDeliveryTransport";
import { createPushNotificationTokenStore } from "./remote/pushNotificationTokenStore";
import { CanvasEventStore } from "./canvas/canvasEventStore";
import { CanvasService, type CanvasServiceDependencies } from "./canvas/canvasService";
import { CanvasShareEventStore } from "./canvas/canvasShareEventStore";
import { CanvasShareService } from "./canvas/canvasShareService";
import { createCanvasRefreshSourceResolver } from "./canvas/canvasRefreshSourceResolver";
import { readCanvasRefreshFile, resolveCanvasRefreshFile } from "./canvas/canvasRefreshFileRead";
import { createCanvasSkillContributionResolver } from "./canvas/canvasSkillContributionResolver";
import { createCanvasSkillContributionLookup } from "./canvas/canvasSkillContributionLoader";
import { resolveConfinedPath } from "./preview/previewTargetRegistry";
import {
  createPreviewRouteHandler,
  resolvePreviewActiveContext,
  resolvePreviewAuthority,
} from "./previewRoutes";
import { createPreviewHandoffBridgeRouteHandler } from "./previewHandoffRoutes";
import { PreviewService } from "./preview/previewService";
import { derivePreviewHostId } from "./preview/previewHostIdentity";
import { makeOpenAiCompatibleDriver } from "./providers/openAiCompatibleDriver";
import { makeAnthropicCompatibleDriver } from "./providers/anthropicCompatibleDriver";
import { makeAzureFoundryDriver } from "./providers/azureFoundryDriver";
import {
  makeCredentialBrokerClient,
  type ProviderCredentialResolver,
} from "./providers/credentialBrokerClient";
import type { CompatibleFetch } from "./providers/openAiCompatibleEndpoint";
import { makeClaudeAgentSdkPort, type ClaudeAgentSdkPort } from "./providers/claudeAgentSdkPort";
import type { ClaudeResumeIdentityPort } from "./providers/claudeDriver";
import { makeClaudeProcessLive, type ClaudeProcessPort } from "./providers/claudeProcess";
import { ClaudeResumeIdentityStore } from "./providers/claudeResumeIdentityStore";
import { makeCodexProcessLive } from "./providers/codexProcess";
import type { CodexProcessPort } from "./providers/codexProcess";
import { makeAcpProcessLive, type AcpProcessPort } from "./providers/acpProcess";
import type { AcpProviderKind } from "./providers/acpProfiles";
import {
  makeProviderDriver,
  ProviderDriverConfigurationError,
} from "./providers/providerDriverFactory";
import { JournalOllamaHistoryStore, type OllamaHistoryStore } from "./providers/ollamaHistoryStore";
import { makeOpenCodeProcessLive } from "./providers/openCodeProcess";
import type { OpenCodeProcessPort } from "./providers/openCodeProcess";
import { makeOhMyPiProcessLive, type OhMyPiProcessPort } from "./providers/ohMyPiProcess";
import { makePiProcessLive, type PiProcessPort } from "./providers/piProcess";
import { createProviderRouteHandler } from "./providers/providerRoutes";
import { createDiscoveryRouteHandler } from "./providers/discoveryRoutes";
import { createProviderFromDiscoveryCandidate } from "./providers/discoveryProviderCreate";
import { makeDiscoveryService } from "./providers/discoveryService";
import { ProviderRuntimeRegistry } from "./providers/providerRuntimeRegistry";
import {
  LatencyStatsProjection,
  observedRpcLatency,
  slowRequestRoute,
  withServerTiming,
} from "./latencyStatsProjection";
import { ProviderService } from "./providers/providerService";
import {
  CANONICAL_REVIEWED_MODEL_MANIFEST,
  refreshReviewedModelManifest,
  ReviewedModelManifest,
} from "./providers/reviewedModelManifest";
import { ProviderUsageLimitsService } from "./providers/providerUsageLimitsService";
import { unavailableLimitsReason } from "./providers/providerLimitsReporting";
import { createProviderUsageLimitsRouteHandler } from "./providers/providerUsageLimitsRoutes";
import { ProviderRuntimeUsageLimitsStore } from "./providers/providerRuntimeUsageLimitsStore";
import { attachProviderRuntimeUsageLimits } from "./providers/providerRuntimeUsageLimitsDriver";
import {
  createShellRouteHandler,
  isAllowedRendererOrigin,
  isLoopbackHostname,
} from "./shellRoutes";
import { OCTANT_LOCAL_ACTOR_ID, ShellService } from "./shellService";
import { WindowAuthorityStore } from "./windowAuthorityStore";
import { createWebAssetsHandler } from "./webAssets";
import { createZenRouteHandler } from "./zenRoutes";
import { createZenBackgroundRouteHandler } from "./zenBackgroundRoutes";
import { createUsageRouteHandler } from "./usageRoutes";
import { CacheStatsProjection } from "./cacheStatsProjection";
import { createUsageDashboardRouteHandler } from "./usageDashboardRoutes";
import { resolveWindowProjectScope, type UsageProjectScope } from "./usageProjectScope";
import { SideChatSidecarStore } from "./chat/sideChatSidecarStore";
import {
  ThreadMentionService,
  createChatThreadMentionDirectory,
  createCodeThreadMentionDirectory,
  createWorkThreadMentionDirectory,
  createChatSideChatThreadFactory,
} from "./chat/threadMentionService";
import { ThreadDialogueService } from "./chat/threadDialogueService";
import { codeForkHandoffResolver } from "./code/codeForkHandoff";
import { createThreadMentionRouteHandler } from "./threadMentionRoutes";
import { createFileMentionRouteHandler } from "./fileMentionRoutes";
import { pinFileMentionRoot } from "./fileMentionIo";
import { FileMentionService, fileMentionContextBlocks } from "./fileMentionService";
import { createLocalServerRouteHandler } from "./localServerRoutes";
import { createLiveLocalListenerPort } from "./localServers/localListenerPort";
import {
  createLiveLocalServerHealthProbe,
  createLiveLocalServerStopPort,
} from "./localServers/localServerHostPorts";
import { createCodeThreadLocalServerScopeResolver } from "./localServers/localServerScopeResolver";
import { LocalServerService } from "./localServers/localServerService";
import { createDiagnosticsExportRouteHandler } from "./diagnosticsExportRoutes";
import {
  createThreadExportRouteHandler,
  createThreadHandOffRouteHandler,
} from "./threadExportRoutes";
import { ThreadExportService } from "./threadExportService";
import { makeThreadHandOffCompletion } from "./threadHandOffCompletion";
import { ThreadHandOffService } from "./threadHandOffService";
import { createValidationEvidenceRouteHandler } from "./validationEvidenceRoutes";
import { createValidationEvidenceLoader } from "./validation/validationEvidenceLoader";
import { createExtensionRouteHandler } from "./extensionRoutes";
import {
  ExtensionApiService,
  type ExtensionPackageResolverPort,
} from "./extensions/extensionApiService";
import {
  ExtensionActivationService,
  createLocalExtensionActivationPolicy,
  type ExtensionActivationPolicyPort,
} from "./extensions/extensionActivationService";
import {
  ExtensionLifecycleService,
  type ExtensionSupervisorPort,
} from "./extensions/extensionLifecycleService";
import {
  ExtensionSupervisor,
  type ExtensionRuntimeEvidence,
} from "./extensions/extensionSupervisor";
import { createNodeExtensionProcessPort } from "./extensions/nodeExtensionProcessPort";
import { ExtensionPackageStore } from "./extensions/extensionPackageStore";
import {
  createExtensionChatResolver,
  createStoredExtensionMaterialLoader,
  type ExtensionToolExecutionPort,
} from "./extensions/extensionChatResolver";
import {
  isExtensionCompatibilityCompatible,
  isExtensionPackageCompatible,
} from "./extensions/packageInspector";
import {
  SkillDiscoveryService,
  type SkillDiscoveryRootProvider,
} from "./extensions/skillDiscoveryService";
import { createThreadSkillDiscoveryRootProvider } from "./extensions/threadSkillDiscoveryRootProvider";
import {
  StandaloneSkillService,
  type SkillMarketplacePort,
} from "./extensions/standaloneSkillService";
import { createCompositeSkillMarketplace } from "./extensions/compositeSkillMarketplace";
import {
  CodexPluginPackageResolver,
  type CodexPluginPackageResolverOptions,
} from "./extensions/codexPluginResolver";
import { ArtifactMirrorEventStore } from "./canvas/artifactMirrorEventStore";
import {
  createArtifactMirrorFilePort,
  isInsideHomeDirectory,
} from "./canvas/artifactMirrorFilePort";
import { createArtifactMirrorCommitPort } from "./canvas/artifactMirrorCommitPort";
import { ArtifactMirrorService } from "./canvas/artifactMirrorService";
import { createDefaultCodexPluginPackageSources } from "./extensions/curatedBuildIosAppsCatalog";
import { CURATED_SCAFFOLDS, curatedScaffoldTools } from "./scaffold/curatedScaffoldCatalog";
import { resolveAvailableTools } from "./scaffold/scaffoldFilesystem";
import { AgentPluginMcpSessionManager } from "./extensions/agentPluginMcpSessionManager";
import { LocalPluginFolderRegistry } from "./extensions/localPluginFolderRegistry";
import { LocalPluginImportReceiptStore } from "./extensions/localPluginImportReceiptStore";
import { ExtensionToolApprovalService } from "./extensions/extensionToolApprovalService";
import {
  BrowserAutomationService,
  createBrowserToolCallAuthorityService,
} from "./browser/browserAutomationService";
import { ExternalContentIngestionStore } from "./context/externalContentIngestionStore";
import { readThreadExternalContentTaint } from "./context/externalContentTaintProjection";
import { createNativeHarnessAuthority } from "./harness/nativeHarnessAuthority";
import {
  createNativeHarnessComposition,
  type NativeHarnessComposition,
} from "./harness/nativeHarnessComposition";
import { createNativeHarnessShell } from "./harness/nativeHarnessShell";
import { createNativeHarnessDelegatePort } from "./harness/nativeHarnessDelegatePort";
import { NativeHarnessRouter } from "./harness/nativeHarnessRouter";
import { NativeHarnessRoutingStore } from "./harness/nativeHarnessRoutingStore";
import { createNativeHarnessRoutingRouteHandler } from "./harness/nativeHarnessRoutingRoutes";
import { NativeHarnessSessionStore } from "./harness/nativeHarnessSessionStore";
import {
  createNativeHarnessFollowUp,
  type NativeHarnessFollowUpCreationDependencies,
} from "./harness/nativeHarnessFollowUpCreation";
import { NativeHarnessApprovalStore } from "./harness/nativeHarnessApprovals";
import { NativeHarnessQuestionStore } from "./harness/nativeHarnessQuestions";
import { createNativeHarnessSessionRouteHandler } from "./harness/nativeHarnessSessionRoutes";
import { NativeHarnessTurnObserver } from "./harness/nativeHarnessTurnObserver";
import { fetchPublicUrl, PublicFetchRefused } from "./harness/nativeHarnessWebFetch";
import {
  ServerBrowserAuthorityResolver,
  deriveToolHostId,
} from "./browser/browserAuthorityResolver";
import { createPlaywrightBrowserRuntime } from "./browser/playwrightBrowserRuntime";
import { createDesktopBrowserRuntimeFromEnvironment } from "./browser/desktopBrowserRuntime";
import { RoutingBrowserRuntime } from "./browser/routingBrowserRuntime";
import type { BrowserRuntimePort } from "./browser/browserRuntimePort";
import { createBrowserAutomationRouteHandler } from "./browserAutomationRoutes";
import { ValidationEventStore } from "./validation/validationEventStore";
import { AppleRuntimeStore } from "./apple/appleRuntimeStore";
import {
  AppleToolchainService,
  type AppleExecutionContext,
  type AppleRuntimeReceipt,
} from "./apple/appleToolchainService";
import { createAppleToolchainRouteHandler } from "./appleToolchainRoutes";
import { composeAppleValidationEvents } from "./apple/appleValidationEvidence";
import { ZenEventStore } from "./zen/zenEventStore";
import { ZenFocusZoneStore } from "./zen/zenFocusZoneStore";
import { ZenService } from "./zen/zenService";
import { ZenBackgroundStore } from "./zen/zenBackgroundStore";
import { readFile as readFileFromDisk, stat as statFromDisk } from "node:fs/promises";
import {
  CANVAS_REFRESH_MAX_SKILL_OPTIONS,
  LOCAL_HOST_ID,
  MAX_AGENT_RUN_ADMITTED_CONTEXT_BLOCKS,
  MAX_AGENT_RUN_ADMITTED_CONTEXT_CHARACTERS,
  decodeImageGenerationScopeId,
  decodeMultiModelRoutingVendorId,
  type ChatThreadView,
  type CodeProjectPullRequestRow,
  type CodeWorktreeRemoteFacts,
  type ImageGenerationSaveResult,
  type MentionableThreadId,
  type MultiModelPoolCandidate,
  type ProviderContextBlock,
  type ProviderProbeResult,
  type ThreadMentionCommandResult,
} from "@octant/contracts";
import type { MultiModelCandidateRuntimeFacts } from "@octant/domain/multi-model-pool-policy";
import {
  decodeCanvasDefinition,
  decodeProjectId,
  type ProjectId,
  type UtcTimestamp,
} from "@octant/contracts";
import {
  activeChatTurns,
  assertHostRoutable,
  authorizeCanvasInventoryAccess,
  canonicalizeWorkRelativePath,
  chatAttemptAnswered,
  decidesCodeEffectsByApproval,
  defaultShellSettings,
  formatThreadMentionContext,
  isAgentRunActiveStatus,
  isImageProfileDriverKind,
  isNativeHarnessDriverKind,
  nativeHarnessJobForRole,
  THREAD_MENTION_UNREADABLE_CONTEXT,
  listHosts,
  type PreviewPosture,
  findWorkspacePresetTarget,
} from "@octant/domain";
import { ZenThreadCatalog } from "./zen/zenThreadCatalog";
import { localHostDisplayName } from "./localHostDisplayName";
import { ZenAssistantTools } from "./zen/zenAssistantTools";
import { createCanvasAgentTools, type CanvasAgentToolPort } from "./canvas/canvasAgentTools";
import { combineAppManagedToolSets } from "./providers/appManagedToolSet";
import { taintAppManagedToolResults } from "./providers/appManagedToolTaint";
import {
  isPrivateListenerFailureCode,
  type PrivateListener,
  type PrivateListenerConfig,
  type PrivateListenerFailureCode,
  type PrivateListenerTls,
} from "./privateListener";
import { createAuthenticatedProductDispatch } from "./authenticatedProductRoutes";
import { compareRemoteForwardListToClassifier } from "./remoteForwardListClassifierGate";
import { requireJournalHydration } from "./persistence/journalHydration";
import {
  createRemoteGateway,
  type RemoteGateway,
  type RemoteGatewayServices,
} from "./remote/remoteGateway";
import { createLocalDeviceAdministrationRouteHandler } from "./remote/localDeviceAdministrationRoutes";
import {
  createHostControlRouteHandler,
  type HostControlServicePolicyPort,
} from "./hostControlRoutes";
import { desktopCredentialStore } from "./hostDataMap";
import { ThreadRetentionService } from "./threadRetentionService";
import { ChatAttachmentStore } from "./chat/chatAttachmentStore";
import { createPrivateListenerLifecycleController } from "./remote/privateListenerLifecycleController";
import { resolvePrivateListenerHostIdentity } from "./remote/privateListenerHostIdentity";
import { createPrivateListenerAdministrationRouteHandler } from "./remote/privateListenerAdministrationRoutes";
import {
  boundHostRuntimeDiagnostics,
  type HostRuntimeDiagnostics,
  type HostRuntimeServiceMode,
} from "@octant/host-runtime";

export interface OctantServer {
  readonly url: URL;
  readonly remoteListener?: PrivateListener;
  readonly remoteListenerError?: PrivateListenerFailureCode;
  readonly diagnostics?: () => HostRuntimeDiagnostics;
  /**
   * Owner-mediated online backup: a verified snapshot created through the
   * live owner connection, confined to the data directory. Second processes
   * never open the live store; they route here over the control socket.
   */
  readonly backup?: (label?: string) => VerifiedStoreBackupReceipt;
  stop(closeActiveConnections?: boolean): void | Promise<void>;
}

/**
 * Listener trust class carried into the request boundary. The loopback
 * listener preserves all existing local behavior; the remote (private)
 * listener is separately classified and subject to remote admission.
 */
export type RemoteListenerTrust = "loopback" | "remote";

/**
 * Coarse source class derived from the accepted socket peer address. It is
 * never read from request headers. `unknown` covers missing, public, or
 * otherwise unclassifiable peer identity and rejects remote API traffic.
 */
export type RemoteSourceClass = "loopback" | "lan-private" | "tailscale" | "unknown";

/**
 * Immutable, non-header request facts derived from the accepted socket. The
 * `sourceKey` is an HMAC of the normalized peer address over a process-scoped
 * salt; the raw address and salt are never exposed or persisted. The type name
 * `RequestTransportFacts` avoids collision with the contracts
 * `RemoteRequestFactsV1` wire type.
 */
export interface RequestTransportFacts {
  readonly listenerTrust: RemoteListenerTrust;
  readonly sourceClass: RemoteSourceClass;
  readonly sourceKey: string;
}

export interface ServeOptions {
  readonly hostname: string;
  readonly port: number;
  readonly maxRequestBodySize: number;
  /** Defaults to `loopback`; the private listener passes `remote`. */
  readonly listenerTrust?: RemoteListenerTrust;
  readonly fetch: (request: Request, facts?: RequestTransportFacts) => Response | Promise<Response>;
  readonly tls?: PrivateListenerTls;
}

export const MAX_REQUEST_BODY_SIZE = 1_048_576;
export const MAX_JSON_REQUEST_BODY_SIZE = MAX_REQUEST_BODY_SIZE;
export { MAX_CHAT_ATTACHMENT_BYTES };
export { MAX_CODE_FILE_BODY_SIZE };

export type Serve = (options: ServeOptions) => OctantServer | Promise<OctantServer>;

export {
  createRemoteRequestFacts,
  deriveRemoteSourceKey,
  classifyRemoteSourceClass,
  normalizePeerAddress,
  resetProcessRequestFactsSaltForTests,
} from "./remoteRequestFacts";

export class ServerStartupFailed extends Data.TaggedError("ServerStartupFailed")<{
  readonly category: "server-unavailable";
  readonly message: string;
}> {}

interface ConfiguredProviderDriverOptions {
  readonly openCodeProcess: OpenCodeProcessPort;
  readonly codexProcess: CodexProcessPort;
  readonly acpProcess?: AcpProcessPort;
  readonly acpHome?: (kind: AcpProviderKind, instanceId: ProviderInstance["id"]) => string;
  readonly piProcess?: PiProcessPort;
  readonly piHome?: (instanceId: ProviderInstance["id"]) => string;
  readonly ohMyPiProcess?: OhMyPiProcessPort;
  readonly ohMyPiHome?: (instanceId: ProviderInstance["id"]) => string;
  readonly claudeProcess?: ClaudeProcessPort;
  readonly claudeSdk?: ClaudeAgentSdkPort;
  readonly claudeResumeIdentityPort?: ClaudeResumeIdentityPort;
  readonly isProjectConfinedPath?: (projectRoot: string, absolutePath: string) => boolean;
  readonly runtimeRegistry: ProviderRuntimeRegistry;
  readonly permissionPersistence: () => PermissionPersistence;
  readonly credentialResolver?: ProviderCredentialResolver;
  readonly fetch?: CompatibleFetch;
  readonly ollamaHistoryStore?: OllamaHistoryStore;
  readonly onRuntimeEvent?: (event: ProviderRuntimeEvent) => void;
  readonly admittedDriverKinds?: ReadonlySet<ProviderDriverKind>;
}

export function makeConfiguredProviderDriver(
  instance: ProviderInstance,
  options: ConfiguredProviderDriverOptions,
): ProviderDriver {
  if (!instance.enabled) {
    throw new Error("Provider instance is disabled.");
  }
  if (isImageProfileDriverKind(instance.driverKind)) {
    throw new ProviderDriverConfigurationError();
  }
  const admitted = options.admittedDriverKinds ?? admittedBundledProviderDriverKinds();
  if (!admitted.has(instance.driverKind)) {
    throw new Error("Provider driver plugin is not effective.");
  }
  let driver: ProviderDriver;
  if (instance.driverKind === "openai-compatible") {
    driver = makeOpenAiCompatibleDriver({
      instanceId: instance.id,
      configuration: instance.configuration,
      runtimeRegistry: options.runtimeRegistry,
      ...(options.credentialResolver === undefined
        ? {}
        : { credentialResolver: options.credentialResolver }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  } else if (instance.driverKind === "anthropic-compatible") {
    driver = makeAnthropicCompatibleDriver({
      instanceId: instance.id,
      configuration: instance.configuration,
      runtimeRegistry: options.runtimeRegistry,
      ...(options.credentialResolver === undefined
        ? {}
        : { credentialResolver: options.credentialResolver }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  } else if (instance.driverKind === "azure-foundry") {
    driver = makeAzureFoundryDriver({
      instanceId: instance.id,
      configuration: instance.configuration,
      runtimeRegistry: options.runtimeRegistry,
      ...(options.credentialResolver === undefined
        ? {}
        : { credentialResolver: options.credentialResolver }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  } else {
    driver = makeProviderDriver(instance, {
      openCodeProcess: options.openCodeProcess,
      codexProcess: options.codexProcess,
      runtimeRegistry: options.runtimeRegistry,
      permissionPersistence: options.permissionPersistence,
      ...(options.acpProcess === undefined ? {} : { acpProcess: options.acpProcess }),
      ...(options.acpHome === undefined ? {} : { acpHome: options.acpHome }),
      ...(options.piProcess === undefined ? {} : { piProcess: options.piProcess }),
      ...(options.piHome === undefined ? {} : { piHome: options.piHome }),
      ...(options.ohMyPiProcess === undefined ? {} : { ohMyPiProcess: options.ohMyPiProcess }),
      ...(options.ohMyPiHome === undefined ? {} : { ohMyPiHome: options.ohMyPiHome }),
      ...(options.claudeProcess === undefined ? {} : { claudeProcess: options.claudeProcess }),
      ...(options.claudeSdk === undefined ? {} : { claudeSdk: options.claudeSdk }),
      ...(options.claudeResumeIdentityPort === undefined
        ? {}
        : { claudeResumeIdentityPort: options.claudeResumeIdentityPort }),
      ...(options.isProjectConfinedPath === undefined
        ? {}
        : { isProjectConfinedPath: options.isProjectConfinedPath }),
      ...(options.credentialResolver === undefined
        ? {}
        : { credentialResolver: options.credentialResolver }),
      ...(options.ollamaHistoryStore === undefined
        ? {}
        : { ollamaHistoryStore: options.ollamaHistoryStore }),
    });
  }
  return options.onRuntimeEvent === undefined
    ? driver
    : attachProviderRuntimeUsageLimits(driver, { record: options.onRuntimeEvent });
}

export interface StartOctantServerOptions {
  readonly hostname: string;
  readonly port: number;
  readonly instanceId?: string;
  readonly hostId?: string;
  readonly controlEndpoint?: string;
  readonly serviceMode?: Exclude<HostRuntimeServiceMode, "maintenance">;
  readonly version?: string;
  /**
   * Honest platform capability names observed at startup (for example
   * `platform:service-manager`). Unavailable native tools are never listed,
   * so the diagnostics report fails closed by construction.
   */
  readonly platformCapabilities?: ReadonlyArray<string>;
  readonly desktopBridgeSecret?: string;
  /**
   * HTTP origin the local renderer may present. `null` is packaged
   * (`file://` only). Omitted keeps loopback-any-port for tests.
   */
  readonly allowedRendererHttpOrigin?: string | null;
  /**
   * Host control wiring for the shared web Settings host card. The
   * service policy port persists the automatic-startup policy and
   * `requestOwnerStop` requests the same graceful owner drain the control
   * socket uses. Production owners always inject both. Omitting them is a
   * test seam: the web surface then reports the exact unavailable state
   * instead of pretending a store is wired.
   */
  readonly hostControl?: {
    readonly servicePolicy?: HostControlServicePolicyPort;
    readonly requestOwnerStop?: () => void;
  };
  readonly credentialBrokerToken?: string;
  readonly credentialBrokerUrl?: string;
  readonly integrationSecretVault?: IntegrationSecretVault;
  readonly linearOAuthClientId?: string;
  readonly linearOAuthRedirectUri?: string;
  readonly packagedProviderSmokeControl?: true;
  readonly acquirePersistence?: Effect.Effect<PersistenceService, PersistenceStartupFailed>;
  readonly serve?: Serve;
  readonly providerRuntimeRegistry?: ProviderRuntimeRegistry;
  /** Optional until a host has a real provider-managed child execution port. */
  readonly agentRunProcessSupervisor?: AgentRunProcessSupervisorPort;
  readonly openCodeProcess?: OpenCodeProcessPort;
  readonly codexProcess?: CodexProcessPort;
  readonly acpProcess?: AcpProcessPort;
  readonly acpHome?: (kind: AcpProviderKind, instanceId: ProviderInstance["id"]) => string;
  readonly piProcess?: PiProcessPort;
  readonly piHome?: (instanceId: ProviderInstance["id"]) => string;
  readonly ohMyPiProcess?: OhMyPiProcessPort;
  readonly ohMyPiHome?: (instanceId: ProviderInstance["id"]) => string;
  readonly claudeProcess?: ClaudeProcessPort;
  readonly claudeSdk?: ClaudeAgentSdkPort;
  readonly claudeResumeIdentityStore?: ClaudeResumeIdentityStore;
  readonly ollamaHistoryStore?: OllamaHistoryStore;
  readonly isProjectConfinedPath?: (projectRoot: string, absolutePath: string) => boolean;
  readonly gitEnvironmentPort?: Pick<GitEnvironmentPort, "observe" | "close">;
  readonly codeService?: CodeRouteService;
  readonly codeOperationRuntime?: CodeOperationRuntime;
  readonly computerUseRuntime?: ComputerUseRuntime;
  readonly computerUseAdapter?: ComputerUseNativeAdapter;
  readonly githubAuthenticationPort?: GhAuthenticationPort;
  readonly ghExecutable?: string;
  readonly codeFileHelperPath?: string;
  readonly createCodeFileHelperTransport?: (path: string) => FileHelperProcessTransport;
  readonly codeRepositoryPort?: ManagedWorktreeRepositoryPort;
  readonly webAssetsPath?: string;
  readonly browserRuntime?: BrowserRuntimePort;
  readonly extensionPackageResolver?: ExtensionPackageResolverPort;
  readonly extensionActivationPolicy?: ExtensionActivationPolicyPort;
  readonly extensionCatalogStatus?: () => "available" | "offline";
  readonly codexPluginPackageSources?: CodexPluginPackageResolverOptions;
  readonly extensionSupervisor?: ExtensionSupervisorPort;
  readonly extensionToolExecution?: ExtensionToolExecutionPort;
  readonly extensionSkillRoots?: SkillDiscoveryRootProvider;
  readonly localPluginFolderRegistry?: LocalPluginFolderRegistry;
  readonly agentPluginMcpSessionManager?: AgentPluginMcpSessionManager;
  readonly skillMarketplace?: SkillMarketplacePort;
  readonly remoteListener?: {
    readonly config: PrivateListenerConfig;
    /**
     * Typed gateway services that compose the remote fetch handler. The
     * server constructs the gateway internally — callers cannot inject an
     * arbitrary remote fetch that bypasses route/auth policy. This is the
     * test/smoke injection seam; the packaged server composes an equivalent
     * production service graph from its own persistence graph and host
     * identity when this is absent, so the packaged host controls always drive
     * a real lifecycle controller.
     */
    readonly services: Omit<RemoteGatewayServices, "config" | "serve">;
  };
  readonly remoteServe?: Serve;
}

type InjectedStartOptions = StartOctantServerOptions & {
  readonly acquirePersistence: Effect.Effect<PersistenceService, PersistenceStartupFailed>;
};

export function createExistingWorktreeCodeFileRootAuthority(options: {
  readonly projects: Pick<ProjectService, "bootstrap">;
  readonly readProject: PersistenceService["readProject"];
  readonly repository: ManagedWorktreeRepositoryPort;
  readonly managedReceipts?: Pick<ManagedWorktreeReceiptStore, "load">;
  readonly statIdentity: (
    path: string,
  ) => Promise<{ readonly device: string; readonly inode: string }>;
}): CodeFileRootAuthorityPort {
  return {
    resolve: async (windowId, thread, checkout, relativePath) => {
      const bootstrap = await options.projects.bootstrap(windowId);
      const summary = bootstrap.active.find(
        (project) => project.id === thread.projectId && project.type === "code",
      );
      const project = options.readProject(thread.projectId);
      const revision = project?.type === "code" ? project.bindingHistory.at(-1) : undefined;
      if (
        summary?.type !== "code" ||
        project?.type !== "code" ||
        project.lifecycle !== "active" ||
        revision?.revisionId !== thread.bindingRevisionId ||
        summary.binding.canonicalRoot !== project.binding.canonicalRoot ||
        revision.currentBinding.canonicalRoot !== project.binding.canonicalRoot
      ) {
        return undefined;
      }
      const repositoryRoot = project.binding.canonicalRoot;
      let rootPath: string;
      if (checkout.kind === "existing-worktree") {
        const expectedCheckoutId = deriveExistingWorktreeCheckoutId({
          projectId: thread.projectId,
          bindingRevisionId: thread.bindingRevisionId,
          repositoryId: thread.repositoryId,
          canonicalRoot: repositoryRoot,
        });
        if (checkout.id !== expectedCheckoutId) return undefined;
        rootPath = repositoryRoot;
      } else {
        if (options.managedReceipts === undefined) return undefined;
        const receipt = await options.managedReceipts.load(checkout.ownershipReceiptId);
        if (
          receipt === undefined ||
          receipt.state !== "ready" ||
          receipt.receiptId !== checkout.ownershipReceiptId ||
          receipt.threadId !== thread.id ||
          receipt.checkoutId !== checkout.id ||
          receipt.repositoryId !== thread.repositoryId ||
          receipt.repositoryId !== checkout.repositoryId ||
          receipt.canonicalRepositoryPath !== repositoryRoot
        ) {
          return undefined;
        }
        rootPath = receipt.canonicalWorktreePath;
      }
      const observation = await options.repository.observe(
        repositoryRoot,
        new AbortController().signal,
      );
      const observedCheckout =
        checkout.kind === "existing-worktree"
          ? observation.status === "available"
            ? observation.checkout
            : undefined
          : observation.status === "available"
            ? observation.worktrees.find(
                (candidate) =>
                  candidate.status === "present" && candidate.canonicalPath === rootPath,
              )
            : undefined;
      if (
        observation.status !== "available" ||
        observation.repositoryId !== thread.repositoryId ||
        observation.repositoryId !== checkout.repositoryId ||
        observation.repositoryRoot !== repositoryRoot ||
        observedCheckout === undefined ||
        observedCheckout.locked !== undefined ||
        observedCheckout.prunable !== undefined ||
        !observedCheckoutHeadMatches(observedCheckout, checkout.head)
      ) {
        return undefined;
      }
      const rootIdentity = await options.statIdentity(rootPath);
      return {
        fileId: stableCodeFileId(thread.id, checkout.id, relativePath),
        rootPath,
        rootIdentity,
      };
    },
  };
}

export function createExistingWorktreeCodeCheckoutObservation(options: {
  readonly projects: Pick<ProjectService, "bootstrap">;
  readonly readProject: PersistenceService["readProject"];
  readonly repository: ManagedWorktreeRepositoryPort;
  readonly clock: () => string;
  readonly gitObservationPort?: GitObservationPort;
}): CodeCheckoutObservationPort {
  return {
    observe: async (windowId, projectId) => {
      const bootstrap = await options.projects.bootstrap(windowId);
      const summary = bootstrap.active.find(
        (project) => project.id === projectId && project.type === "code",
      );
      const project = options.readProject(projectId);
      const revision = project?.type === "code" ? project.bindingHistory.at(-1) : undefined;
      if (
        summary?.type !== "code" ||
        project?.type !== "code" ||
        project.lifecycle !== "active" ||
        revision === undefined ||
        summary.binding.canonicalRoot !== project.binding.canonicalRoot ||
        revision.currentBinding.canonicalRoot !== project.binding.canonicalRoot
      ) {
        throw new Error("Code Project binding is unavailable.");
      }

      const root = project.binding.canonicalRoot;
      const observation = await options.repository.observe(root, new AbortController().signal);
      if (
        observation.status !== "available" ||
        observation.repositoryRoot !== root ||
        observation.checkout.canonicalPath !== root ||
        observation.checkout.locked !== undefined ||
        observation.checkout.prunable !== undefined
      ) {
        throw new Error("Code Project checkout is unavailable.");
      }
      const head = observation.checkout.detached
        ? { kind: "detached" as const, oid: observation.checkout.head }
        : observation.checkout.branch?.startsWith("refs/heads/")
          ? {
              kind: "branch" as const,
              name: observation.checkout.branch.slice("refs/heads/".length),
              oid: observation.checkout.head,
            }
          : undefined;
      if (head === undefined) throw new Error("Code Project branch is unavailable.");

      const checkout = decodeCodeCheckoutIdentity({
        id: deriveExistingWorktreeCheckoutId({
          projectId,
          bindingRevisionId: revision.revisionId,
          repositoryId: observation.repositoryId,
          canonicalRoot: root,
        }),
        repositoryId: observation.repositoryId,
        kind: "existing-worktree",
        availability: "available",
        head,
        observedAt: options.clock(),
      });
      // D3: observe authoritative remote facts from the Git repository so the
      // composer can decide whether "Start from origin" is available. Fail
      // closed with no remotes when the observation is unavailable.
      let worktreeRemoteFacts: CodeWorktreeRemoteFacts | undefined;
      if (options.gitObservationPort !== undefined) {
        try {
          const gitObservation = await options.gitObservationPort.observe(root);
          if (gitObservation.status === "ready") {
            const remotes = gitObservation.remotes.map((remote) => remote.name);
            worktreeRemoteFacts = {
              remotes,
              ...(gitObservation.upstream === null
                ? {}
                : { upstreamRemote: gitObservation.upstream.remote }),
              ...(remotes.includes("origin")
                ? { defaultRemote: "origin" }
                : remotes.length === 1
                  ? { defaultRemote: remotes[0] }
                  : {}),
            };
          }
        } catch {
          // Fail closed; remote facts remain undefined so Start from origin is disabled.
        }
      }
      return {
        bindingRevisionId: revision.revisionId,
        checkout,
        ...(worktreeRemoteFacts === undefined ? {} : { worktreeRemoteFacts }),
      };
    },
  };
}

export function deriveExistingWorktreeCheckoutId(input: {
  readonly projectId: string;
  readonly bindingRevisionId: string;
  readonly repositoryId: string;
  readonly canonicalRoot: string;
}) {
  const digest = createHash("sha256")
    .update("octant.existing-worktree-checkout.v1\0")
    .update(input.projectId)
    .update("\0")
    .update(input.bindingRevisionId)
    .update("\0")
    .update(input.repositoryId)
    .update("\0")
    .update(input.canonicalRoot)
    .digest("hex")
    .slice(0, 32);
  return decodeCodeCheckoutId(
    `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20)}`,
  );
}

/**
 * A branch checkout is identified by its branch; HEAD advancing through
 * ordinary commits keeps it the same checkout. A detached checkout has no
 * name, so its OID is its identity and must match exactly.
 */
function observedCheckoutHeadMatches(
  observed: { readonly detached: boolean; readonly head: string; readonly branch?: string },
  expected: CodeCheckoutIdentity["head"],
): boolean {
  return expected.kind === "detached"
    ? observed.detached && observed.head === expected.oid
    : !observed.detached && observed.branch === `refs/heads/${expected.name}`;
}

/**
 * Read the `#thread` mentions a turn names, on the window the turn was sent
 * from.
 *
 * A chip names a thread; it never carries one. The renderer sends ids, and
 * this resolves them through the same mention resolution an Open would take —
 * so the sender's Open authority over every named thread is re-derived at send
 * time, and the transcript window stays the host's decision. The framing is
 * applied here, on the authoritative side, for the same reason. Chat and Code
 * share one resolver because a chip means the same thing in both, and neither
 * mode may read a thread on authority the other proved.
 *
 * The service is reached lazily so a mode wired before it exists can still
 * hold this: nothing is read until a turn actually runs.
 */
/**
 * Reach the Code service's conversation and evidence readers for the fork
 * handoff. Lazy because the runtime that holds the resolver is composed before
 * the service exists; the decision about when a handoff is owed lives with the
 * handoff itself.
 */
function forkHandoffResolver(codeService: () => CodeRouteService) {
  return codeForkHandoffResolver(() => {
    const service = codeService();
    const conversation = service.conversation;
    const readEvidence = service.readOperationContent;
    if (conversation === undefined || readEvidence === undefined) return undefined;
    return {
      conversation: async (...args) => await conversation(...args),
      readEvidence: async (...args) => await readEvidence(...args),
      projectOf: async (windowId, threadId) => {
        try {
          // `read` authorizes the window against the thread, so a thread this
          // window may not observe is indistinguishable from one that is absent.
          const view = await service.read(windowId, threadId);
          return String(view.thread.projectId);
        } catch {
          return undefined;
        }
      },
    };
  });
}

function threadMentionContextResolver(threadMentions: () => ThreadMentionService) {
  return async ({
    threadMentionIds,
    windowId,
    dialogueEnabled,
  }: {
    readonly threadMentionIds: ReadonlyArray<MentionableThreadId>;
    readonly windowId?: WindowId;
    readonly dialogueEnabled?: boolean;
  }): Promise<
    ReadonlyArray<
      | { readonly kind: "resolved"; readonly threadId: MentionableThreadId; readonly text: string }
      | { readonly kind: "unreadable"; readonly threadId: MentionableThreadId }
    >
  > => {
    const unreadable = () =>
      threadMentionIds.map((threadId) => ({ kind: "unreadable" as const, threadId }));
    // Without an authenticated window there is no principal to re-derive Open
    // authority from, so nothing resolves rather than resolving on authority
    // nobody proved.
    if (windowId === undefined) return unreadable();
    let resolved: ThreadMentionCommandResult;
    try {
      resolved = await threadMentions().execute(
        { kind: "resolve-mentions", requestId: randomUUID(), threadIds: threadMentionIds },
        { windowId },
      );
    } catch {
      return unreadable();
    }
    if (resolved.kind !== "mentions-resolved") return unreadable();
    const byThreadId = new Map(
      resolved.mentions.map((mention) => [String(mention.threadId), mention]),
    );
    return threadMentionIds.map((threadId) => {
      const mention = byThreadId.get(String(threadId));
      return mention === undefined
        ? { kind: "unreadable" as const, threadId }
        : {
            kind: "resolved" as const,
            threadId,
            text: formatThreadMentionContext([mention], {
              dialogueEnabled: dialogueEnabled === true,
            }),
          };
    });
  };
}

function stableCodeFileId(threadId: string, checkoutId: string, relativePath: string) {
  const digest = createHash("sha256")
    .update("octant.code-file.v1\0")
    .update(threadId)
    .update("\0")
    .update(checkoutId)
    .update("\0")
    .update(relativePath)
    .digest("hex")
    .slice(0, 32);
  const uuid = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20)}`;
  return decodeCodeFileId(uuid);
}

function withCodeOperationRuntime(
  service: CodeRouteService,
  runtime: CodeOperationRuntime,
): CodeRouteService {
  const readEvidenceBatch = runtime.readEvidenceBatch?.bind(runtime);
  return {
    bootstrap: (windowId) => service.bootstrap(windowId),
    navigation: (windowId) => service.navigation(windowId),
    read: (windowId, threadId) => service.read(windowId, threadId),
    execute: (windowId, command) => service.execute(windowId, command),
    executeOperation: (windowId, command, options) => runtime.execute(windowId, command, options),
    inspectTerminal: (windowId, input) => runtime.inspectTerminal(windowId, input),
    subscribe: (windowId, threadId, afterSequence, signal) =>
      service.subscribe(windowId, threadId, afterSequence, signal),
    subscribeOperation: async function* (windowId, threadId, operationId, afterCursor) {
      const frames = await runtime.subscribe(windowId, threadId, operationId, afterCursor, 100);
      yield* frames;
    },
    conversation: (windowId, threadId, afterCursor, limit) =>
      runtime.conversation(windowId, threadId, afterCursor, limit),
    readContent: (windowId, contentId) => service.readContent(windowId, contentId),
    readOperationContent: (windowId, threadId, operationId, contentId) =>
      runtime.readEvidence(windowId, threadId, operationId, decodeCodeEvidenceContentId(contentId)),
    ...(readEvidenceBatch === undefined
      ? {}
      : { readOperationContents: (windowId, input) => readEvidenceBatch(windowId, input) }),
    saveFile: (windowId, input) => service.saveFile(windowId, input),
    openFile: (windowId, input) => service.openFile(windowId, input),
    ...(service.listFiles === undefined ? {} : { listFiles: service.listFiles.bind(service) }),
    ...(service.listTests === undefined ? {} : { listTests: service.listTests.bind(service) }),
    ...(service.watchFiles === undefined ? {} : { watchFiles: service.watchFiles.bind(service) }),
    ...(service.searchFiles === undefined
      ? {}
      : { searchFiles: service.searchFiles.bind(service) }),
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
  };
}

function createProjectPullRequestPorts(ghExecutable: string | undefined): {
  readonly list: CodeProjectPullRequestListPort;
  readonly detail: CodeProjectPullRequestDetailPort;
  /**
   * False when `gh` is missing or refused validation. The background refresh
   * cadence fails closed on this instead of polling ports that can only
   * answer `disconnected`.
   */
  readonly ghAvailable: boolean;
} {
  if (ghExecutable === undefined) {
    return {
      list: { listActive: async () => ({ status: "disconnected" }) },
      detail: { observeReviewByIdentity: async () => ({ status: "unavailable" }) },
      ghAvailable: false,
    };
  }
  try {
    const port = new GhPullRequestPort({
      command: createGhCommandPort({ ghPath: ghExecutable }),
      resolveTarget: async () => undefined,
    });
    return {
      list: {
        listActive: (request, signal) => port.listActive(request, signal),
      },
      detail: {
        observeReviewByIdentity: (request, signal) => port.observeReviewByIdentity(request, signal),
      },
      ghAvailable: true,
    };
  } catch {
    return {
      list: { listActive: async () => ({ status: "disconnected" }) },
      detail: { observeReviewByIdentity: async () => ({ status: "unavailable" }) },
      ghAvailable: false,
    };
  }
}

function withCodeBoard(
  service: CodeRouteService,
  queryBoard: NonNullable<CodeRouteService["queryBoard"]>,
): CodeRouteService {
  return {
    bootstrap: (windowId) => service.bootstrap(windowId),
    navigation: (windowId) => service.navigation(windowId),
    read: (windowId, threadId) => service.read(windowId, threadId),
    execute: (windowId, command, signal) => service.execute(windowId, command, signal),
    subscribe: (windowId, threadId, afterSequence, signal) =>
      service.subscribe(windowId, threadId, afterSequence, signal),
    readContent: (windowId, contentId) => service.readContent(windowId, contentId),
    saveFile: (windowId, input) => service.saveFile(windowId, input),
    openFile: (windowId, input) => service.openFile(windowId, input),
    ...(service.listFiles === undefined ? {} : { listFiles: service.listFiles.bind(service) }),
    ...(service.listTests === undefined ? {} : { listTests: service.listTests.bind(service) }),
    ...(service.watchFiles === undefined ? {} : { watchFiles: service.watchFiles.bind(service) }),
    ...(service.searchFiles === undefined
      ? {}
      : { searchFiles: service.searchFiles.bind(service) }),
    queryBoard,
    ...(service.executeOperation === undefined
      ? {}
      : { executeOperation: service.executeOperation.bind(service) }),
    ...(service.inspectTerminal === undefined
      ? {}
      : { inspectTerminal: service.inspectTerminal.bind(service) }),
    ...(service.subscribeOperation === undefined
      ? {}
      : { subscribeOperation: service.subscribeOperation.bind(service) }),
    ...(service.conversation === undefined
      ? {}
      : { conversation: service.conversation.bind(service) }),
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
  };
}

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
    const bindingReceiptStore = new DurableBindingReceiptStore(persistence.connection);
    const processAuthorityClock = new ProcessAuthorityClock();
    const machineChangeFeed = new MachineChangeFeed();
    const unsubscribeMachineChanges = persistence.journal.subscribeCommitted((append) =>
      machineChangeFeed.publishCommitted(append),
    );
    const processAuthorityNow = (wallClockMs: number) => processAuthorityClock.clamp(wallClockMs);
    const codeApprovalStore = new CodeOperationApprovalStore({
      uuid: randomUUID,
      now: Date.now,
      clampNow: processAuthorityNow,
    });
    const extensionToolApprovalService = new ExtensionToolApprovalService({
      uuid: randomUUID,
      now: Date.now,
    });
    const codeSessionAuthority = new CodeSessionAuthorityStore();
    let activeCodeService: CodeRouteService | undefined;
    let browserAutomationService: BrowserAutomationService | undefined;
    const requireBrowserAutomationService = (): BrowserAutomationService => {
      const service = browserAutomationService;
      if (service === undefined) {
        throw new Error("Browser automation service is unavailable during server composition.");
      }
      return service;
    };
    let productFeedbackService: ProductFeedbackService;
    let activeComputerUseRuntime: ComputerUseRuntime | undefined;
    let workRequestRuntime: WorkRequestRuntime | undefined;
    let revokeShellWindow: ((windowId: WindowId) => void) | undefined;
    const windowAuthorityStore = new WindowAuthorityStore(
      (windowId) => {
        revokeShellWindow?.(windowId);
        codeApprovalStore.revokeWindow(windowId);
        extensionToolApprovalService.revokeWindow(windowId);
        codeSessionAuthority.revokeWindow(windowId);
        activeCodeService?.revokeWindow?.(windowId);
        void browserAutomationService?.revokeWindow(windowId);
        void activeComputerUseRuntime?.revokeWindow(windowId);
      },
      {
        clampNow: processAuthorityNow,
      },
    );
    const agentRunEventStore = new AgentRunEventStore({
      journal: persistence.journal,
      uuid: randomUUID,
      actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
    });
    const agentRunPersistence = new AgentRunPersistenceService({
      store: agentRunEventStore,
      projection: persistence.agentRunProjection,
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
      connection: persistence.connection,
    });
    agentRunPersistence.reconcileAfterRestart();
    // The native harness is composed once the research router and plan
    // service exist; every consumer here reads these per turn or per request,
    // long after boot, never at construction.
    let nativeHarnessComposition: NativeHarnessComposition | undefined;
    let nativeHarnessRouter: NativeHarnessRouter | undefined;
    let nativeHarnessSessions: NativeHarnessSessionStore | undefined;
    let nativeHarnessObserver: NativeHarnessTurnObserver | undefined;
    let nativeHarnessQuestions: NativeHarnessQuestionStore | undefined;
    const nativeHarnessHooks = {
      answerQuestion: (threadId: string, questionId: string, answer: string) => {
        nativeHarnessQuestions?.answer(threadId, questionId, answer);
      },
      contextFor: (scope: Parameters<NativeHarnessTurnObserver["contextFor"]>[0]) =>
        nativeHarnessObserver?.contextFor(scope) ?? [],
      admitTurn: (scope: Parameters<NativeHarnessTurnObserver["admitTurn"]>[0]) =>
        nativeHarnessObserver?.admitTurn(scope) ?? { kind: "admitted" as const },
      turnStarted: (scope: Parameters<NativeHarnessTurnObserver["turnStarted"]>[0]) =>
        nativeHarnessObserver?.turnStarted(scope),
      turnCompleted: (input: Parameters<NativeHarnessTurnObserver["turnCompleted"]>[0]) =>
        nativeHarnessObserver?.turnCompleted(input) ?? Promise.resolve(),
    };
    const agentRunSettingsStore = new AgentRunSettingsStore({
      journal: persistence.journal,
      uuid: randomUUID,
      actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
      clock: () => new Date().toISOString(),
    });
    // Managed worktree receipts are required to admit Code children with a
    // verified isolated sandbox. Constructed early so AgentRun routes
    // can resolve receipt ids before the broader Code service graph starts.
    const managedWorktreeReceipts = new ManagedWorktreeReceiptStore({
      dataDirectory: persistence.dataDirectory,
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
    });
    const agentRunWorkspaceReceipts = new AgentRunWorkspaceReceiptStore({
      dataDirectory: persistence.dataDirectory,
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
    });
    const agentRunChildWorktree: { current: AgentRunChildWorktreePort | undefined } = {
      current: undefined,
    };
    const agentRunWorkspace = new AgentRunWorkspaceService({
      receipts: agentRunWorkspaceReceipts,
      childWorktree: {
        prepare: (input) =>
          agentRunChildWorktree.current?.prepare(input) ??
          Promise.resolve({ status: "refused", reason: "unavailable" }),
        confirm: (input) =>
          agentRunChildWorktree.current?.confirm(input) ??
          Promise.resolve({ status: "refused", reason: "unavailable" }),
      },
    });
    const capacityScheduler = makeProviderCapacityScheduler({
      now: () => Date.now(),
      random: Math.random,
      maxRetryJitterMs: 250,
      ambiguousReservationTtlMs: 60_000,
    });
    const agentRunLiveConversations = new AgentRunLiveConversationStore();
    // Managed subagent execution. A managed child runs as an in-process
    // provider session, not a spawned process, so authority is re-derived from
    // the run rather than inherited from the parent thread at execution time.
    const agentRunSessionSupervisor = new AgentRunSessionSupervisor({
      port: createAgentRunSessionRuntime({
        capacityScheduler,
        appManagedTools: (input) => nativeHarnessComposition?.forAgentRun(input),
        // `configuredDriverOptions` is declared later in this scope; the closure
        // only runs when a child starts, long after boot, so the reference is safe.
        resolveDriver: (providerInstanceId) => {
          const instance = persistence.readProviderInstance(providerInstanceId);
          if (instance === undefined || !instance.enabled) return undefined;
          try {
            return makeConfiguredProviderDriver(instance, configuredDriverOptions);
          } catch {
            return undefined;
          }
        },
        // The admitted selection is resolved from the run's own journaled
        // admission and the store that holds the blocks it named. An unknown
        // run, a mismatched snapshot id, or blocks purged with a deleted parent
        // thread fails the start closed instead of executing under a selection
        // nobody admitted.
        context: createRecordedAgentRunContextSnapshotPort({
          getById: (childRunId) => agentRunPersistence.getById(childRunId),
          readAdmittedContext: (input) =>
            readAgentRunAdmittedContext(persistence.connection, input),
        }),
        uuid: randomUUID,
        scratchRoot: (run) => {
          const root = join(persistence.dataDirectory, "agent-run-scratch", String(run.id));
          mkdirSync(root, { recursive: true, mode: 0o700 });
          return root;
        },
        // Starting a child observes no provider limits of its own, so it never
        // replaces limits an ordinary turn observed on the shared scheduler. A
        // known wait therefore applies to the child as it does to any other
        // work, and unrelated turns keep the real limits.
        serviceLimits: makeUnobservedProviderCapacityFacts({
          scheduler: capacityScheduler,
          now: () => new Date().toISOString() as UtcTimestamp,
        }),
        onSessionStarted: ({ runId }) => agentRunLiveConversations.begin(runId),
        onTextDelta: ({ runId, text, occurredAt }) =>
          agentRunLiveConversations.appendText(runId, text, occurredAt),
        onSessionSettled: ({ runId, outcome }) => {
          if (outcome.kind === "completed") {
            agentRunLiveConversations.complete(runId);
          } else {
            agentRunLiveConversations.markStale(
              runId,
              outcome.kind === "failed"
                ? outcome.failure.message
                : "The child session ended before a complete transcript was retained.",
            );
          }
        },
      }),
      // A settled managed session is the only signal that a child finished, so
      // orchestration records its terminal state durably. `agentRunOrchestration`
      // is declared below; this closure runs only when a child settles.
      onSessionSettled: (settled) => agentRunOrchestration.onSessionSettled(settled),
      persistedActiveRunIds: () =>
        [...agentRunPersistence.snapshot().values()]
          .filter((run) => run.lifecycleStatus === "starting" || run.lifecycleStatus === "running")
          .map((run) => run.id),
    });
    const agentRunProcessSupervisor =
      options.agentRunProcessSupervisor ?? agentRunSessionSupervisor;
    const agentRunOrchestration = new AgentRunOrchestrationService({
      persistence: agentRunPersistence,
      capacity: createInMemoryCapacityPort(),
      worktree: {
        isVerifiedIsolation: (workspace) =>
          workspace.verified && workspace.worktreeRoot !== workspace.checkoutRoot,
        isParentCheckout: (workspace) => workspace.worktreeRoot === workspace.checkoutRoot,
      },
      workBinding: {
        isCurrent: (workspace) => {
          const project = persistence.readProject(workspace.projectId);
          if (project?.type !== "work" || project.lifecycle !== "active") return false;
          const revision = project.bindingHistory.at(-1);
          return (
            revision !== undefined &&
            String(revision.revisionId) === String(workspace.bindingRevisionId) &&
            project.binding.canonicalRoot === workspace.canonicalRoot
          );
        },
      },
      approvals: { isCurrent: () => true },
      processes: agentRunProcessSupervisor,
    });
    const agentRunRouteDependencies: AgentRunRouteDependencies = {
      windowAuthorityStore,
      // A child's model comes from its role's slot when one is configured;
      // the decision is journaled on the parent's harness session so a
      // switch is visible, and an unroutable slot falls back to inheriting.
      routeOverride: ({ parent, role }) => {
        if (nativeHarnessRouter === undefined) return undefined;
        const decision = nativeHarnessRouter.resolve({
          job: nativeHarnessJobForRole(role),
          ...(parent.parentRoute.projectId === undefined
            ? {}
            : { projectId: decodeProjectId(parent.parentRoute.projectId) }),
        });
        nativeHarnessSessions?.recordRouteDecision(
          String(parent.workspaceParent.threadId),
          decision,
        );
        if (decision.kind === "unroutable") return undefined;
        return {
          providerInstanceId: decision.candidate.providerInstanceId,
          modelId: decision.candidate.modelId,
          ...(decision.candidate.reasoning === undefined
            ? {}
            : { reasoning: decision.candidate.reasoning }),
          ...(parent.parentRoute.projectId === undefined
            ? {}
            : { projectId: parent.parentRoute.projectId }),
        };
      },
      persistence: agentRunPersistence,
      liveConversations: agentRunLiveConversations,
      orchestration: agentRunOrchestration,
      settings: agentRunSettingsStore,
      providerReadiness: {
        isReady: ({ providerInstanceId, modelId }) => {
          const instance = persistence.readProviderInstance(providerInstanceId as never);
          if (instance === undefined || !instance.enabled) return false;
          const observed = providerRuntimeRegistry.observedState(providerInstanceId as never);
          return (
            observed?.readiness === "ready" &&
            observed.models.some((model) => String(model.id) === modelId)
          );
        },
      },
      nativeEvidence: ({ parent }) => {
        const observed = providerRuntimeRegistry.observedState(
          parent.parentRoute.providerInstanceId as never,
        );
        const capabilities = observed?.capabilities;
        return {
          claimedNativeSupport: capabilities?.nativeChildAgents ?? "unavailable",
          // Native execution is an optimization this host only honors when a
          // native child adapter is wired. Workspace and authority still clamp
          // on the managed path; they are not evidenced for provider-native
          // children until that adapter exists.
          workspace: false,
          authority: false,
          observability:
            capabilities?.streaming === "supported" && capabilities?.toolActivity === "supported",
          cancellation: capabilities?.interruption === "supported",
          steering: capabilities?.userQuestions === "supported",
          recovery: capabilities?.resume === "supported",
        };
      },
      authorizeCreation: ({ parentThreadId, windowId }) =>
        authorizeAgentRunCreation({
          persistence,
          workThreadProjection,
          parentThreadId,
          windowId,
          codeSessionAuthority,
        }),
      authorizeCancellation: ({ run, windowId }) =>
        authorizeAgentRunCancellation({ persistence, workThreadProjection, run, windowId }),
      // Parent-summary reads and result acknowledgements are gated the same
      // way as cancellation: the parent thread is resolved from this host's
      // own thread stores and the window's own workspace, never from a scope
      // the caller supplied. `workThreadProjection` is declared later in
      // this scope; the closure runs per request, long after boot.
      authorizeParentThread: ({ parentThreadId, windowId }) =>
        authorizeAgentRunParentThread({
          persistence,
          workThreadProjection,
          parentThreadId,
          windowId,
        }),
      resolveCenterContext: ({ parentThreadId, mode }) =>
        resolveAgentRunCenterContext({
          persistence,
          workThreadProjection,
          parentThreadId,
          mode,
        }),
      poolRouting: ({ request }) => {
        if (request.pool === undefined) return undefined;
        // Prefer the parent mode's persisted route as the mixed-vendor binding.
        let parentThread:
          | ReturnType<PersistenceService["readChatThread"]>
          | ReturnType<PersistenceService["readCodeThread"]>;
        try {
          parentThread = persistence.readChatThread(
            decodeChatThreadId(String(request.parentThreadId)),
          );
        } catch {
          parentThread = undefined;
        }
        if (parentThread === undefined) {
          try {
            parentThread = persistence.readCodeThread(
              decodeCodeThreadId(String(request.parentThreadId)),
            );
          } catch {
            parentThread = undefined;
          }
        }
        if (parentThread === undefined) return undefined;
        const parentCandidate: MultiModelPoolCandidate = {
          hostId: LOCAL_HOST_ID,
          providerInstanceId: parentThread.providerInstanceId,
          modelId: parentThread.modelId,
        } as unknown as MultiModelPoolCandidate;
        const factsByKey = new Map<string, MultiModelCandidateRuntimeFacts>();
        for (const candidate of [...request.pool.candidates, parentCandidate]) {
          const key = `${candidate.hostId}:${candidate.providerInstanceId}:${candidate.modelId}`;
          if (!factsByKey.has(key)) {
            factsByKey.set(key, agentRunPoolCandidateFacts(candidate));
          }
        }
        return { parentCandidate, runtimeFacts: [...factsByKey.values()] };
      },
      workspace: {
        prepare: async ({ windowId, parent, code }) =>
          agentRunWorkspace.prepare({
            windowId,
            parent:
              parent.mode === "code"
                ? {
                    ...parent,
                    ...(await resolveAgentRunParentCheckout(
                      persistence,
                      managedWorktreeReceipts,
                      parent.threadId,
                    )),
                  }
                : parent,
            ...(code === undefined
              ? await resolveAgentRunPrepareCode(persistence, managedWorktreeReceipts, parent)
              : { code: code }),
          }),
        confirm: ({ windowId, parent, worktreeReceiptId }) =>
          agentRunWorkspace.confirm({ windowId, parent, worktreeReceiptId }),
        admit: async ({ windowId, requested, role, parent }) =>
          agentRunWorkspace.admit({
            windowId,
            requested,
            role,
            parent:
              parent.mode === "code"
                ? {
                    ...parent,
                    ...(await resolveAgentRunParentCheckout(
                      persistence,
                      managedWorktreeReceipts,
                      parent.threadId,
                    )),
                  }
                : parent,
          }),
      },
      // A child that asked to be admitted with its parent's context is given
      // the parent thread's own recent conversation, read through the very
      // Chat view that thread already shows. `authorizeCreation` above has
      // already proved this window may create children from that thread, so
      // this widens nothing. Code parent conversations have no transcript read
      // port on this host yet, so such a request fails the creation closed
      // rather than admitting a child with an empty selection.
      // `chatService` is declared below; this closure only runs per request.
      parentContext: {
        resolve: ({ parentThreadId, mode }) => {
          if (mode !== "chat") return undefined;
          try {
            return admittedParentChatContext(
              chatService.read(decodeChatThreadId(String(parentThreadId))),
            );
          } catch {
            return undefined;
          }
        },
      },
      uuid: randomUUID,
    };
    const agentRunRoutes = createAgentRunRouteHandler(agentRunRouteDependencies);
    /**
     * Synchronous per-candidate runtime facts for child pool routing,
     * mirroring ChatService's probe semantics but reading only the already
     * observed provider state (the same source as the readiness gate above):
     * an unconfigured, disabled, foreign-host, or not-yet-observed candidate
     * is honestly ineligible rather than probed at request time.
     */
    function agentRunPoolCandidateFacts(
      candidate: MultiModelPoolCandidate,
    ): MultiModelCandidateRuntimeFacts {
      const ineligible = (
        routingVendorId: string,
        configured: boolean,
      ): MultiModelCandidateRuntimeFacts => ({
        candidate,
        routingVendorId: decodeMultiModelRoutingVendorId(routingVendorId),
        configured,
        readiness: "unavailable",
        modelAvailable: false,
        compatibleModes: [],
        projectAllowed: true,
        profileAllowed: true,
        supportedCapabilities: [],
        authorityAllowed: false,
      });
      if (String(candidate.hostId) !== String(LOCAL_HOST_ID)) {
        return ineligible("foreign-host", false);
      }
      const instance = persistence.readProviderInstance(candidate.providerInstanceId as never);
      if (instance === undefined) return ineligible("unconfigured", false);
      if (!instance.enabled) return ineligible(instance.driverKind, true);
      const observed = providerRuntimeRegistry.observedState(candidate.providerInstanceId as never);
      return {
        candidate,
        routingVendorId: decodeMultiModelRoutingVendorId(instance.driverKind),
        configured: true,
        readiness: observed?.readiness ?? "unavailable",
        modelAvailable:
          observed?.models.some((model) => String(model.id) === String(candidate.modelId)) ?? false,
        compatibleModes: ["chat"],
        projectAllowed: true,
        profileAllowed: true,
        supportedCapabilities: [],
        authorityAllowed: true,
      };
    }
    const agentRunSettingsRoutes = createAgentRunSettingsRouteHandler({
      windowAuthorityStore,
      store: agentRunSettingsStore,
    });
    const githubAuthenticationPort =
      options.githubAuthenticationPort ??
      new GhAuthenticationPort(
        options.ghExecutable === undefined ? {} : { ghExecutable: options.ghExecutable },
      );
    const githubCataloguePort = new GhRepositoryCataloguePort(
      options.ghExecutable === undefined ? {} : { ghExecutable: options.ghExecutable },
    );
    let revokeProjectPullRequests: (() => void) | undefined;
    const githubCapabilityService = new GithubCapabilityService(githubAuthenticationPort, {
      probes: githubCataloguePort,
      onAuthenticationChanged: (snapshot) => {
        const readable = snapshot.capabilities.some(
          (capability) => capability.kind === "pull-requests-read" && capability.available,
        );
        if (!readable) revokeProjectPullRequests?.();
      },
    });
    // One reading for every cache this host keeps, so the usage dashboard can
    // report them together and a failing external cache paces itself.
    const cacheStats = new CacheStatsProjection();
    const githubCatalogueService = new GithubCatalogueService({
      port: githubCataloguePort,
      snapshot: (signal) => githubCapabilityService.snapshot(signal),
      cacheStats,
    });
    const externalContentIngestionStore = new ExternalContentIngestionStore({
      journal: persistence.journal,
      connection: persistence.connection,
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
      actor: { kind: "system", actorId: OCTANT_LOCAL_ACTOR_ID },
    });
    const githubReadToolService = new GithubReadToolService({
      catalogue: githubCatalogueService,
      snapshot: (signal) => githubCapabilityService.snapshot(signal),
      ingestion: externalContentIngestionStore,
    });
    const githubExtensionSnapshot = {
      read: (): Pick<ExtensionSnapshot, "packages"> => ({ packages: [] }),
    };
    const githubIntegrationIsEffective = () =>
      isGithubIntegrationEffective(githubExtensionSnapshot.read());
    const linearIntegrationIsEffective = () =>
      isLinearIntegrationEffective(githubExtensionSnapshot.read());
    const githubIssueContextService = new GithubIssueContextService({
      catalogue: githubCatalogueService,
      snapshot: (signal) => githubCapabilityService.snapshot(signal),
      ingestion: externalContentIngestionStore,
      uuid: randomUUID,
      isEffective: githubIntegrationIsEffective,
    });
    const githubRoutes = createGithubRouteHandler({
      windowAuthorityStore,
      service: githubCapabilityService,
      catalogue: githubCatalogueService,
      isEffective: githubIntegrationIsEffective,
    });
    const integrationVault =
      options.integrationSecretVault ??
      (options.credentialBrokerUrl === undefined || options.credentialBrokerToken === undefined
        ? createUnavailableSecretVault()
        : createBrokerSecretVault(
            makeCredentialBrokerClient({
              url: options.credentialBrokerUrl,
              token: options.credentialBrokerToken,
            }),
          ));
    const linearRedirectUri =
      options.linearOAuthRedirectUri ?? "http://127.0.0.1:52693/oauth/linear/callback";
    const integrationService = createLinearIntegrationService({
      vault: integrationVault,
      connectionStore: createFileConnectionStore(
        join(persistence.dataDirectory, "integrations", "linear-connection.json"),
      ),
      config: {
        redirectUri: linearRedirectUri,
        ...(options.linearOAuthClientId === undefined
          ? {}
          : { clientId: options.linearOAuthClientId }),
      },
      isEffective: linearIntegrationIsEffective,
    });
    const linearIssueContextService = new LinearIssueContextService({
      reader: {
        snapshot: (signal) => integrationService.snapshot("linear", signal),
        executeGetIssue: async (id, signal) =>
          integrationService.executeOperation(
            "linear",
            { kind: "operation", operationId: LINEAR_ISSUE_GET_OPERATION, input: { id } },
            signal,
          ),
      },
      ingestion: externalContentIngestionStore,
      uuid: randomUUID,
      isEffective: linearIntegrationIsEffective,
    });
    const peekCreateFromIssueFramed = (threadId: string) =>
      githubIssueContextService.peekFramedForFirstTurn(threadId) ??
      linearIssueContextService.peekFramedForFirstTurn(threadId);
    const consumeCreateFromIssueFramed = (threadId: string) => {
      githubIssueContextService.consumeFramedForFirstTurn(threadId);
      linearIssueContextService.consumeFramedForFirstTurn(threadId);
    };
    const integrationRoutes = createIntegrationRouteHandler({
      windowAuthorityStore,
      service: integrationService,
      isEffective: (slug) => slug !== "linear" || linearIntegrationIsEffective(),
    });
    const zenEventStore = new ZenEventStore({
      journal: persistence.journal,
      uuid: randomUUID,
      actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
      clock: () => new Date().toISOString(),
    });
    // Same shape as the Goal and AgentRun checks: read the window's own
    // workspace, never a scope the caller supplied. Every usage surface —
    // dashboard, query, and export — shares this one resolver so they cannot
    // disagree about what a window may see.
    const readWindowUsageProjectScope = (windowId: WindowId): UsageProjectScope =>
      resolveWindowProjectScope(persistence.readWindowWorkspace(windowId)?.workspace);
    const usageDashboardRoutes = createUsageDashboardRouteHandler({
      connection: persistence.connection,
      windowAuthorityStore,
      readWindowProjectScope: readWindowUsageProjectScope,
      cacheStats,
      latencyStats: () => latencyStats.read(),
    });
    const usageRoutes = createUsageRouteHandler({
      connection: persistence.connection,
      windowAuthorityStore,
      readWindowProjectScope: readWindowUsageProjectScope,
      maxRequestBodySize: MAX_JSON_REQUEST_BODY_SIZE,
      latencyStats: () => latencyStats.read(),
    });
    const diagnosticsExportRoutes = createDiagnosticsExportRouteHandler({
      connection: persistence.connection,
      journal: persistence.journal,
      windowAuthorityStore,
      octantVersion: version,
    });
    const validationEvidenceRoutes = createValidationEvidenceRouteHandler({
      windowAuthorityStore,
      authorize: (windowId, authority) => {
        const workspace = persistence.readWindowWorkspace(windowId)?.workspace;
        const context = workspace?.contextByMode[authority.mode];
        return (
          context !== undefined &&
          context.projectId === authority.projectId &&
          String(context.host) === String(authority.hostId)
        );
      },
      maxRequestBodySize: MAX_JSON_REQUEST_BODY_SIZE,
      loadSnapshot: createValidationEvidenceLoader({
        connection: persistence.connection,
        clock: () => new Date().toISOString(),
      }),
    });
    const validationEventStore = new ValidationEventStore({
      journal: persistence.journal,
      uuid: randomUUID,
      actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
    });
    const computerUseProcess = createNodeComputerUseProcessPort({
      receiptDirectory: join(persistence.dataDirectory, "computer-use", "runtime-receipts"),
    });
    const computerUseDestination =
      options.computerUseAdapter === undefined
        ? reportComputerUseDestination({
            platform: process.platform,
            ...(process.platform === "darwin" ? { hasScreen: detectMacOsScreen() } : {}),
          })
        : { status: "available" as const, kind: "macos-host" as const };
    const computerUseAdapter =
      options.computerUseAdapter ??
      (computerUseDestination.status === "available"
        ? createMacOsComputerUseAdapter({ process: computerUseProcess })
        : undefined);
    const computerUseRuntime =
      options.computerUseRuntime ??
      createComputerUseRuntime({
        ...(computerUseAdapter === undefined ? {} : { adapter: computerUseAdapter }),
        destination: computerUseDestination,
        evidence: createComputerUseValidationEvidenceRecorder({
          eventStore: validationEventStore,
          uuid: randomUUID,
          clock: () => new Date().toISOString(),
        }),
        uuid: randomUUID,
        clock: () => new Date().toISOString(),
      });
    activeComputerUseRuntime = computerUseRuntime;
    const computerUseRoutes = createComputerUseRouteHandler({
      runtime: computerUseRuntime,
      windowAuthorityStore,
      maxRequestBodySize: MAX_JSON_REQUEST_BODY_SIZE,
    });
    const launchSessionStore = new LaunchSessionStore({
      clampNow: processAuthorityNow,
    });
    const launchSessionRoutes = createLaunchSessionRouteHandler({
      desktopBridgeSecret: options.desktopBridgeSecret,
      ...(options.allowedRendererHttpOrigin === undefined
        ? {}
        : { allowedRendererHttpOrigin: options.allowedRendererHttpOrigin }),
      launchSessionStore,
      windowAuthorityStore,
    });
    const machineChangeRoutes = createMachineChangeRouteHandler({
      feed: machineChangeFeed,
      windowAuthorityStore,
    });
    const webAssetsPath = options.webAssetsPath ?? resolveWebAssetsPath();
    const webAssets = createWebAssetsHandler({
      distPath: webAssetsPath,
      readFile: async (path) => readFileFromDisk(path),
      stat: async (path) => statFromDisk(path),
    });
    const projectRootPort = new ProjectRootPort();
    const managedRepositoryInventory = new ManagedRepositoryInventory({
      inventoryPath: join(homedir(), "Octant", "Repositories"),
    });
    const managedCloneProcessPort = new ManagedCloneProcessPort({
      ghExecutable: options.ghExecutable ?? "gh",
      gitExecutable: "git",
      context: createOwnedGitContext(),
    });
    const githubRepositoryObservationPort = new GhRepositoryObservationPort(
      options.ghExecutable === undefined ? {} : { ghExecutable: options.ghExecutable },
    );
    const managedCloneService = new ManagedCloneService({
      journal: persistence.journal,
      projection: persistence.githubCloneProjection,
      inventory: managedRepositoryInventory,
      process: managedCloneProcessPort,
      observation: githubRepositoryObservationPort,
      snapshot: (signal) => githubCapabilityService.snapshot(signal),
      projectRootPort,
      bindingReceiptStore,
      actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
    });
    yield* Effect.promise(() => managedCloneService.recover());
    const githubCloneRoutes = createGithubCloneRouteHandler({
      windowAuthorityStore,
      service: managedCloneService,
      isEffective: githubIntegrationIsEffective,
    });
    const contextHarness = new ContextHarnessService({
      persistence,
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
    });
    const contextRoutes = createContextRouteHandler({
      service: contextHarness,
      windowAuthorityStore,
      maxRequestBodySize: MAX_JSON_REQUEST_BODY_SIZE,
    });
    const workThreadProjection = new WorkThreadProjection();
    requireJournalHydration(
      hydrateWorkThreadProjectionFromJournal({
        replay: (cursor) =>
          persistence.journal.replayAggregateType({
            ...Schema.decodeUnknownSync(ReplayCursor)({
              afterSequence: cursor.afterSequence,
              limit: cursor.limit,
            }),
            aggregateType: cursor.aggregateType ?? "work-thread",
          }),
        projection: workThreadProjection,
      }),
      "Work thread",
    );
    const shellService = new ShellService({
      persistence,
      readWorkThread: (threadId) => workThreadProjection.read(threadId),
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
    });
    revokeShellWindow = (windowId) => shellService.revokeWindow(windowId);
    const allowedRendererHttpOrigin = options.allowedRendererHttpOrigin;
    const shellRoutes = createShellRouteHandler(shellService, {
      windowAuthorityStore,
      now: Date.now,
      ...(allowedRendererHttpOrigin === undefined ? {} : { allowedRendererHttpOrigin }),
    });
    const themeService = new ThemeService({
      persistence,
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
    });
    // Publishing to a target the person owns. Octant runs no deployment
    // infrastructure and holds no service account: a target names a remote the
    // checkout already has, and the only thing this host can do is push the
    // reviewed revision to it. Targets arrive from extensions rather than being
    // built in; with none installed the list is empty and nothing publishes.
    const shipEvents = new ShipEventStore({
      journal: persistence.journal,
      uuid: randomUUID,
      clock: () => new Date().toISOString() as never,
      actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
    });
    const shipTargets = new Map<string, import("@octant/contracts").ShipTarget>();
    const shipService = new ShipService({
      listTargets: () => [...shipTargets.values()],
      writeTarget: (target) => {
        shipTargets.set(String(target.id), target);
      },
      checkout: (threadId) => {
        let thread;
        try {
          thread = persistence.readCodeThread(threadId as never);
        } catch {
          return undefined;
        }
        if (thread === undefined || thread.lifecycle !== "active") return undefined;
        const checkout = persistence.readCodeCheckout(thread.checkoutId);
        if (checkout === undefined || checkout.availability !== "available") return undefined;
        const head = checkout.head;
        return {
          checkoutRoot: String(thread.checkoutId),
          // A publication is refused on unproven work, so the host states what
          // it can observe rather than assuming: without a live observation the
          // checkout is treated as dirty and the revision as unreviewed, which
          // fails in the safe direction.
          clean: false,
          headRevision: head.kind === "branch" ? head.oid : "",
          reviewedRevision: undefined,
          executionPolicy: thread.executionPolicy,
        };
      },
      // The host has no build it watched being produced yet, so it vouches for
      // nothing. Refusing here is the record's evidence rule doing its job, not
      // a placeholder: a ship claims a build happened only when this host saw
      // it happen.
      observedArtifact: async () => undefined,
      credentialHandle: async () => undefined,
      publish: async () => ({
        outcome: "failed",
        detail: "This host has no publication path bound for that target.",
      }),
      // Publishing is approved one act at a time, against the exact target,
      // revision, and build. Nothing on this host issues such an approval yet,
      // and a standing grant must never stand in for one.
      approval: () => undefined,
      journal: shipEvents,
      uuid: randomUUID,
      clock: () => new Date().toISOString() as never,
    });
    const shipRoutes = createShipRouteHandler({
      service: shipService,
      windowAuthorityStore,
      authorizeThread: ({ threadId, windowId }) => {
        const workspace = persistence.readWindowWorkspace(windowId)?.workspace;
        if (workspace === undefined) return false;
        const context = workspace.contextByMode.code;
        if (context.mode !== "code") return false;
        let thread;
        try {
          thread = persistence.readCodeThread(threadId as never);
        } catch {
          return false;
        }
        if (thread === undefined || thread.lifecycle !== "active") return false;
        return String(context.projectId) === String(thread.projectId);
      },
    });
    const themeRoutes = createThemeRouteHandler({ service: themeService, windowAuthorityStore });
    // Goals persist through the journal, so they survive a restart and
    // rebuild by replay. The in-memory view advances only after the append
    // commits, so a failed write leaves both the journal and the served
    // aggregate on the last durable state.
    // A Goal and its loop both belong to a Work thread, so the window must
    // currently be in Work on the Project that owns the thread. Read the
    // window's own workspace, never a scope the caller supplied.
    const authorizeWorkThreadForWindow = ({
      threadId,
      windowId,
    }: {
      readonly threadId: string;
      readonly windowId: WindowId;
    }): boolean => {
      const workspace = persistence.readWindowWorkspace(windowId)?.workspace;
      if (workspace === undefined) return false;
      const context = workspace.contextByMode.work;
      if (context.mode !== "work") return false;
      let thread;
      try {
        thread = workThreadProjection.read(threadId as never);
      } catch {
        return false;
      }
      if (thread === undefined || thread.lifecycle !== "active") return false;
      return String(context.projectId) === String(thread.projectId);
    };
    const goalService = new GoalService({
      store: new JournalGoalStore({ journal: persistence.journal, uuid: randomUUID }),
    });
    const goalRoutes = createGoalRouteHandler({
      service: goalService,
      windowAuthorityStore,
      // A Goal belongs to a Work thread, so the window must currently be in
      // Work on the Project that owns the thread. Same shape as the AgentRun
      // cancellation check below: read the window's own workspace, never a
      // scope the caller supplied.
      authorizeThread: authorizeWorkThreadForWindow,
    });
    // A plan belongs to a Code thread, so the window must currently be in Code
    // on the Project that owns it. Same shape as the Goal check above: read the
    // window's own workspace, never a scope the caller supplied.
    // Hoisted so the Code board can read the same durable state (0051) instead
    // of standing up a second plan store.
    const planService = new PlanService({
      store: new JournalPlanStore({ journal: persistence.journal, uuid: randomUUID }),
    });
    const codeBoardPlanProgressSource = createCodeBoardPlanProgressSource(planService);
    const planRoutes = createPlanRouteHandler({
      service: planService,
      windowAuthorityStore,
      authorizeThread: ({ threadId, windowId }) => {
        const workspace = persistence.readWindowWorkspace(windowId)?.workspace;
        if (workspace === undefined) return false;
        const context = workspace.contextByMode.code;
        if (context.mode !== "code") return false;
        let thread;
        try {
          thread = persistence.readCodeThread(threadId as never);
        } catch {
          return false;
        }
        if (thread === undefined || thread.lifecycle !== "active") return false;
        return String(context.projectId) === String(thread.projectId);
      },
    });
    const projectBindingRoutes = createProjectBindingRouteHandler({
      desktopBridgeSecret: options.desktopBridgeSecret,
      windowAuthorityStore,
      bindingReceiptStore,
      projectRootPort,
      maxRequestBodySize: MAX_JSON_REQUEST_BODY_SIZE,
    });
    const projectService = new ProjectService({
      persistence,
      bindingReceiptStore,
      projectRootPort,
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
    });
    const gitEnvironmentPort = options.gitEnvironmentPort ?? new GitEnvironmentPort();
    const gitObservationPort = new GitObservationPort();
    const codeContent = new CodeContentStore();
    const codeEvidence = new CodeEvidenceStore({ connection: persistence.connection });
    const codeAttachments = new CodeAttachmentStore(persistence.dataDirectory);
    const workAttachments = new WorkAttachmentStore(persistence.dataDirectory);
    // Listing reads directory entries under the bound checkout and needs no
    // file helper, so it is available even when the helper transport is not.
    const codeFileListing = new CodeFileListingService();
    // Watching needs no file helper either: it reports which paths changed and
    // never reads one, so the explorer stays live even when mutations cannot.
    const codeFileWatch = new CodeFileWatchService();
    // Search reads directory entries and file bytes under the bound checkout
    // through the confined ports, so it needs no file helper either.
    const codeFileSearch = new CodeSearchService();
    // Discovery reads only the checkout's package.json and .octant/tests.json,
    // so it needs no file helper either. The same instance authorizes a run.
    const codeTestDiscovery = new RepositoryTestDiscoveryService();
    let codeFiles: Pick<CodeFileService, "open" | "save"> & Partial<Pick<CodeFileService, "list">> =
      {
        open: async () => ({
          status: "failed" as const,
          failure: { category: "unavailable" as const, code: "helper-unavailable" },
        }),
        save: async () => ({
          status: "failed" as const,
          failure: { category: "unavailable" as const, code: "helper-unavailable" },
        }),
        list: (request) => codeFileListing.list(request),
      };
    if (options.codeService === undefined && options.codeFileHelperPath !== undefined) {
      try {
        const transport = (
          options.createCodeFileHelperTransport ??
          ((path: string) => createFileHelperProcessTransport({ helperPath: path }))
        )(options.codeFileHelperPath);
        yield* Effect.addFinalizer(() => Effect.promise(() => transport.close()));
        codeFiles = new CodeFileService({
          port: new FileOperationPort(transport),
          content: codeContent,
          listing: codeFileListing,
        });
      } catch {
        // The server remains available while Code file mutations fail closed as unavailable.
      }
    }
    const repository = options.codeRepositoryPort ?? createManagedWorktreeNodePorts().repository;
    const checkouts = createExistingWorktreeCodeCheckoutObservation({
      projects: projectService,
      readProject: persistence.readProject,
      repository,
      clock: () => new Date().toISOString(),
      gitObservationPort,
    });
    const roots = createExistingWorktreeCodeFileRootAuthority({
      projects: projectService,
      readProject: persistence.readProject,
      repository,
      managedReceipts: managedWorktreeReceipts,
      statIdentity: async (path) => {
        const metadata = await lstat(path, { bigint: true });
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
          throw new Error("Code Project root is unavailable.");
        }
        return { device: metadata.dev.toString(10), inode: metadata.ino.toString(10) };
      },
    });
    const codeWorkingDirectoryProbePath = decodeCodeRelativePath("package.json");
    let refreshStandaloneSkills = async (): Promise<void> => undefined;
    const environmentService = new CodeEnvironmentService({
      projects: projectService,
      git: gitEnvironmentPort,
      clock: () => new Date().toISOString(),
      code: {
        readThread: persistence.readCodeThread,
        readCheckout: persistence.readCodeCheckout,
        resolveCheckoutRoot: async (windowId, thread, checkout) => {
          const root = await roots.resolve(
            windowId,
            thread,
            checkout,
            codeWorkingDirectoryProbePath,
          );
          return root?.rootPath;
        },
      },
    });
    const projectRoutes = createProjectRouteHandler({
      service: projectService,
      environmentService,
      windowAuthorityStore,
      maxRequestBodySize: MAX_JSON_REQUEST_BODY_SIZE,
    });
    const agentProfileService = new AgentProfileService({
      persistence,
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
    });
    const agentProfileRoutes = createAgentProfileRouteHandler({
      service: agentProfileService,
      windowAuthorityStore,
      maxRequestBodySize: MAX_JSON_REQUEST_BODY_SIZE,
    });
    const folderBrowseService = new FolderBrowseService({
      bindingReceiptStore,
      projectRootPort,
      homeDir: homedir(),
      clock: () => new Date().toISOString(),
    });
    const folderBrowseRoutes = createFolderBrowseRouteHandler({
      service: folderBrowseService,
      windowAuthorityStore,
      maxRequestBodySize: MAX_JSON_REQUEST_BODY_SIZE,
    });
    let managedWorktreeSourcePreview: CodeWorktreeSourcePreviewPort["preview"] = async () => ({
      kind: "failed",
      reason: "unavailable",
    });
    let managedWorktreeRefsList: CodeWorktreeRefsPort["list"] = async () => [];
    let managedCodeThreadCreation: ManagedCodeThreadCreationPort = {
      prepare: async () => ({ status: "waiting" }),
      commit: async () => ({ status: "waiting" }),
      cleanup: async () => ({ status: "waiting" }),
    };
    let probeProviderForThreads: (
      providerInstanceId: ProviderInstance["id"],
    ) => Promise<ProviderProbeResult> = async () => {
      throw new Error("Provider probing is unavailable during server startup.");
    };
    const canAccessCodeProject = (windowId: WindowId, projectId: ProjectId) =>
      windowCanAccessCodeProject({
        workspace: persistence.readWindowWorkspace(windowId)?.workspace,
        projectId,
        hasActiveCodeProject: (id) => projectService.hasActiveProject(id, "code"),
      });
    const codeService =
      options.codeService ??
      new CodeService({
        persistence,
        access: {
          canBrowseProject: (projectId) => projectService.hasActiveProject(projectId, "code"),
          canAccessProject: canAccessCodeProject,
        },
        checkouts,
        roots,
        files: codeFiles,
        tests: codeTestDiscovery,
        watcher: codeFileWatch,
        searcher: codeFileSearch,
        content: codeContent,
        evidence: codeEvidence,
        attachments: codeAttachments,
        uuid: randomUUID,
        clock: () => new Date().toISOString(),
        approvals: codeApprovalStore,
        sessionAuthority: codeSessionAuthority,
        worktreeSourcePreview: {
          preview: (input, signal) => managedWorktreeSourcePreview(input, signal),
        },
        worktreeRefs: {
          list: (input, signal) => managedWorktreeRefsList(input, signal),
        },
        managedThreadCreation: {
          prepare: (input, signal) => managedCodeThreadCreation.prepare(input, signal),
          commit: (input, preparation, signal) =>
            managedCodeThreadCreation.commit(input, preparation, signal),
          cleanup: (input, signal) => managedCodeThreadCreation.cleanup(input, signal),
        },
        workingDirectories: {
          resolve: async (windowId, thread, checkout, workingDirectory) => {
            const root = await roots.resolve(
              windowId,
              thread,
              checkout,
              codeWorkingDirectoryProbePath,
            );
            return root === undefined
              ? undefined
              : resolveThreadWorkingDirectory(root.rootPath, workingDirectory);
          },
        },
        onWorkingDirectoryChanged: async () => refreshStandaloneSkills(),
        waitForThreadChange: (signal) => machineChangeFeed.waitFor("code-navigation", signal),
        probeProvider: (providerInstanceId) => probeProviderForThreads(providerInstanceId),
        issueContext: githubIssueContextService,
        linearIssueContext: linearIssueContextService,
        // Resolved lazily: the pull-request service is constructed after this
        // one, and a navigation read is the first thing that needs it.
        pullRequests: {
          snapshot: (windowId) => projectPullRequestService.navigationSnapshot(windowId),
        },
      });
    // Revocation is wired at construction, before any window can hold a watch.
    activeCodeService = codeService;
    const codeBoardEventStore = new CodeOperationEventStore({
      journal: persistence.journal,
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
      actor: { kind: "system", actorId: OCTANT_LOCAL_ACTOR_ID },
    });
    const projectPullRequestPorts = createProjectPullRequestPorts(options.ghExecutable);
    // Late-bound because the follow-up service that consumes refreshed
    // snapshots is constructed further down, alongside the other Code thread
    // services (same pattern as recordExtensionRuntimeEvidence).
    let observeRefreshedPullRequestRows:
      | ((rows: ReadonlyArray<CodeProjectPullRequestRow>) => void)
      | undefined;
    // Host-wide on purpose: the snapshot cache is shared across windows, so
    // linked-thread facts must come from every persisted Code thread, not from
    // any window's visible subset. Session-authority overlays only change
    // executionPolicy, which no fact here reads.
    const listProjectPullRequestThreadFacts = async () => {
      const facts: Array<{
        readonly threadId: string;
        readonly projectId: string;
        readonly title: string;
        readonly repository: { readonly owner: string; readonly name: string };
        readonly deliveryBranch: string;
        readonly pullRequestNumbers: ReadonlyArray<{
          readonly number: number;
          readonly observedAt: string;
        }>;
      }> = [];
      for (const thread of persistence.readCodeThreads()) {
        const repository = thread.deliveryTarget.proposedBaseRepository;
        const slash = repository.indexOf("/");
        if (slash <= 0 || repository.includes("/", slash + 1)) continue;
        const owner = repository.slice(0, slash);
        const name = repository.slice(slash + 1);
        if (owner === undefined || name === undefined) continue;
        facts.push({
          threadId: String(thread.id),
          projectId: String(thread.projectId),
          title: thread.title,
          repository: { owner, name },
          deliveryBranch: thread.deliveryTarget.branchIntent,
          pullRequestNumbers: pullRequestIdentitiesFromHistory(
            codeBoardEventStore.historyForThread(thread.id),
          ),
        });
      }
      return facts;
    };
    const projectPullRequestService = new CodeProjectPullRequestService({
      projects: projectService,
      remotes: {
        remotes: async (root) => {
          const observed = await gitObservationPort.observe(root);
          return observed.status === "ready" ? observed.remotes : undefined;
        },
      },
      list: projectPullRequestPorts.list,
      detail: projectPullRequestPorts.detail,
      cacheStats,
      snapshotStore: new CodeProjectPullRequestSnapshotStore(
        join(persistence.dataDirectory, "code", "pull-request-snapshot.json"),
      ),
      onSnapshotRefreshed: (rows) => observeRefreshedPullRequestRows?.(rows),
      threads: {
        list: () => listProjectPullRequestThreadFacts(),
      },
    });
    revokeProjectPullRequests = () => projectPullRequestService.revokeGithub();
    // The cadence acts as the host, not as any renderer window. The window
    // identity below exists only to satisfy window-shaped observe signatures;
    // on this host `projectService.bootstrap` and Code Project access checks
    // do not branch on it, so no renderer authority is borrowed or widened.
    // Thread facts for hasBoardRelevantIdentities are host-wide (above).
    const pullRequestCadenceWindowId = decodeWindowId(randomUUID());
    // Refreshed once per cadence pass by the projects callback below, so the
    // per-Project identity check is a set lookup instead of a journal replay
    // repeated for every Project on every wake.
    let pullRequestCadenceProjectsWithIdentities: ReadonlySet<string> = new Set();
    const projectPullRequestCadence = new CodeProjectPullRequestCadence({
      projects: async () => {
        const projects = persistence
          .readProjects({ lifecycle: "active" })
          .filter((project) => project.type === "code")
          .map((project) => ({
            projectId: project.id,
            enabled: project.pullRequestBackgroundRefresh === "enabled",
          }));
        // A fleet with nothing enabled must cost nothing per wake: skip the
        // thread-fact read entirely rather than replaying journals for a
        // feature that is off.
        pullRequestCadenceProjectsWithIdentities = projects.some((project) => project.enabled)
          ? new Set((await listProjectPullRequestThreadFacts()).map((fact) => fact.projectId))
          : new Set();
        return projects;
      },
      hasBoardRelevantIdentities: (projectId) =>
        pullRequestCadenceProjectsWithIdentities.has(String(projectId)),
      observe: (projectId, signal) =>
        projectPullRequestService.observeForCadence(pullRequestCadenceWindowId, projectId, signal),
      onState: (state) => projectPullRequestService.recordBackgroundRefreshState(state),
      ghAvailable: projectPullRequestPorts.ghAvailable,
    });
    projectPullRequestCadence.start();
    let codeOperationRuntime = options.codeOperationRuntime;
    const providerDataDirectory = persistence.dataDirectory;
    const providerRuntimeRegistry =
      options.providerRuntimeRegistry ??
      new ProviderRuntimeRegistry({
        receiptDirectory: join(providerDataDirectory, "providers", "runtime-receipts"),
        observeAcquireMs: (durationMs) =>
          latencyStats.record("provider-runtime-acquire", durationMs),
      });
    const providerRuntimeUsageLimitsStore = new ProviderRuntimeUsageLimitsStore();
    const openCodeProcess = options.openCodeProcess ?? makeOpenCodeProcessLive();
    const codexProcess = options.codexProcess ?? makeCodexProcessLive({ octantVersion: version });
    const acpProcess = options.acpProcess ?? makeAcpProcessLive();
    const piProcess = options.piProcess ?? makePiProcessLive();
    const ohMyPiProcess = options.ohMyPiProcess ?? makeOhMyPiProcessLive();
    const extensionPackageStore = new ExtensionPackageStore({
      dataDirectory: providerDataDirectory,
      uuid: randomUUID,
    });
    let recordExtensionRuntimeEvidence: ((event: ExtensionRuntimeEvidence) => void) | undefined;
    const extensionSupervisor =
      options.extensionSupervisor ??
      new ExtensionSupervisor({
        process: createNodeExtensionProcessPort({
          receiptDirectory: join(providerDataDirectory, "extensions", "runtime-receipts"),
        }),
        clock: () => new Date().toISOString(),
        authorizeLaunch: (input) => extensionPackageStore.authorizeRuntimeLaunch(input),
        evidence: (event) => recordExtensionRuntimeEvidence?.(event),
      });
    const extensionLifecycleService = new ExtensionLifecycleService({
      connection: persistence.connection,
      journal: persistence.journal,
      store: extensionPackageStore,
      supervisor: extensionSupervisor,
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
      isCompatible: (manifest) => isExtensionPackageCompatible(manifest, version, process.platform),
    });
    recordExtensionRuntimeEvidence = (event) =>
      extensionLifecycleService.recordRuntimeEvidence(event);
    const userGlobalSkillsRoot = join(homedir(), ".agents", "skills");
    const threadSkillRoots = createThreadSkillDiscoveryRootProvider({
      readProjects: () =>
        persistence.readProjects({ lifecycle: "active" }).flatMap((project) => {
          if (project.type === "chat") return [];
          const revision = project.bindingHistory.at(-1);
          return revision === undefined
            ? []
            : [
                {
                  id: project.id,
                  mode: project.type,
                  root: project.binding.canonicalRoot,
                  bindingRevisionId: revision.revisionId,
                },
              ];
        }),
      readThreads: () => [
        ...persistence.readCodeThreads().map((thread) => ({ ...thread, mode: "code" as const })),
        ...workThreadProjection.list().map((thread) => ({ ...thread, mode: "work" as const })),
      ],
      resolveWorkingDirectory: resolveThreadWorkingDirectory,
      userGlobalSkillsRoot,
    });
    const extensionSkillRoots: SkillDiscoveryRootProvider = options.extensionSkillRoots ?? {
      resolve: async () => {
        const roots = await threadSkillRoots.resolve();
        return roots.length > 0
          ? roots
          : [
              {
                workingDirectory: process.cwd(),
                projectRoot: process.cwd(),
                projectRef: "server-working-directory",
                userGlobalSkillsRoot,
              },
            ];
      },
    };
    const skillDiscoveryService = new SkillDiscoveryService({ roots: extensionSkillRoots });
    const isMarketplaceFetchAllowed = () =>
      (persistence.readShellSettings()?.settings ?? defaultShellSettings())
        .marketplaceFetchesEnabled;
    const skillMarketplace =
      options.skillMarketplace ??
      createCompositeSkillMarketplace({
        appVersion: version,
        platform: process.platform,
        isMarketplaceFetchAllowed,
      });
    const standaloneSkillService = new StandaloneSkillService({
      discovery: skillDiscoveryService,
      lifecycle: extensionLifecycleService,
      marketplace: skillMarketplace,
    });
    refreshStandaloneSkills = async () => {
      await standaloneSkillService.reconcile();
    };
    yield* Effect.tryPromise({
      try: async () => {
        await extensionPackageStore.initialize();
        await providerRuntimeRegistry.reconcile();
        await codeOperationRuntime?.reconcile?.();
        await computerUseProcess.reconcile?.();
        await agentRunProcessSupervisor.reconcile?.();
        await extensionSupervisor.reconcile?.();
        await extensionLifecycleService.reconcileStartup();
        await standaloneSkillService.reconcile();
      },
      catch: () =>
        new ServerStartupFailed({
          category: "server-unavailable",
          message: "Octant extension storage requires recovery.",
        }),
    });
    const localPluginFolderRegistry =
      options.localPluginFolderRegistry ??
      new LocalPluginFolderRegistry({
        appVersion: version,
        platform: process.platform,
        statePath: join(providerDataDirectory, "extensions", "local-plugin-folders.json"),
      });
    yield* Effect.promise(() => localPluginFolderRegistry.initialize());
    const extensionPackageResolver =
      options.extensionPackageResolver ??
      new CodexPluginPackageResolver({
        ...(options.codexPluginPackageSources ?? createDefaultCodexPluginPackageSources()),
        localFolderRegistry: localPluginFolderRegistry,
        isMarketplaceFetchAllowed,
      });
    const agentPluginMcpSessionManager =
      options.agentPluginMcpSessionManager ??
      new AgentPluginMcpSessionManager({
        store: extensionPackageStore,
        authorizeToolCall: async ({ windowId, thread, signal, ...tool }) =>
          windowId === undefined
            ? false
            : extensionToolApprovalService.request({
                windowId,
                threadId: String(thread.id),
                ...(thread.projectId === undefined ? {} : { projectId: String(thread.projectId) }),
                ...tool,
                ...(signal === undefined ? {} : { signal }),
              }),
        recordExternalContentIngestion: (input) => externalContentIngestionStore.record(input),
        ...(extensionSupervisor instanceof ExtensionSupervisor
          ? { stdioSupervisor: extensionSupervisor }
          : {}),
      });
    const persistedExtensionActivationPolicy = createLocalExtensionActivationPolicy({
      project: (scope) => {
        if (scope.projectId === null) return { allowed: true, revision: 0 };
        const project = persistence.readProject(scope.projectId);
        return {
          allowed:
            project !== undefined && project.lifecycle === "active" && project.type === scope.mode,
          revision: Number(project?.version ?? 0),
        };
      },
      thread: (scope) => {
        if (scope.threadId === null) return { allowed: true, revision: 0 };
        if (scope.mode === "chat") {
          const thread = persistence.readChatThread(decodeChatThreadId(scope.threadId));
          return {
            allowed:
              thread?.lifecycle === "active" && (thread.projectId ?? null) === scope.projectId,
            revision: Number(thread?.version ?? 0),
          };
        }
        const thread = persistence.readCodeThread(decodeCodeThreadId(scope.threadId));
        return {
          allowed: thread?.lifecycle === "active" && thread.projectId === scope.projectId,
          revision: Number(thread?.version ?? 0),
        };
      },
    });
    const extensionActivationService = new ExtensionActivationService({
      policy: options.extensionActivationPolicy ?? persistedExtensionActivationPolicy,
      compatibility: (packageState) =>
        isExtensionCompatibilityCompatible(packageState.compatibility, version, process.platform),
      catalogStatus:
        options.extensionCatalogStatus ??
        (() => (extensionPackageResolver.searchCatalog === undefined ? "offline" : "available")),
    });
    const extensionApiService = new ExtensionApiService({
      lifecycle: extensionLifecycleService,
      resolver: extensionPackageResolver,
      skills: standaloneSkillService,
      activation: {
        resolve: (snapshot, query) =>
          agentPluginMcpSessionManager.projectEffectiveState(
            extensionActivationService.resolve(snapshot, query),
          ),
      },
      onStateChanged: async (snapshot) => {
        // Settings has no thread authority. Drain only package/components whose
        // lifecycle state changed; unrelated in-flight MCP calls remain intact.
        await agentPluginMcpSessionManager.reconcileLifecycleSnapshot(snapshot);
      },
    });
    githubExtensionSnapshot.read = () => extensionApiService.snapshot();
    const extensionRoutes = createExtensionRouteHandler({
      service: extensionApiService,
      windowAuthorityStore,
      maxRequestBodySize: MAX_JSON_REQUEST_BODY_SIZE,
      ...(options.desktopBridgeSecret === undefined
        ? {}
        : { desktopBridgeSecret: options.desktopBridgeSecret }),
      localPluginFolderRegistry,
      localPluginImportReceipts: new LocalPluginImportReceiptStore(),
      toolApprovals: extensionToolApprovalService,
    });
    const managedWorktreePorts = createManagedWorktreeNodePorts();
    const managedWorktreeService = new ManagedWorktreeService({
      grants: new ManagedRootGrantStore(randomUUID, processAuthorityNow),
      receipts: managedWorktreeReceipts,
      ...managedWorktreePorts,
      authority: {
        observeCleanupEligibility: async ({ repositoryId, threadId, checkoutId }) => {
          const thread = persistence.readCodeThread(decodeCodeThreadId(threadId));
          const checkout = persistence.readCodeCheckout(decodeCodeCheckoutId(checkoutId));
          if (
            thread === undefined ||
            checkout === undefined ||
            thread.repositoryId !== repositoryId ||
            thread.checkoutId !== checkoutId
          ) {
            return { status: "unavailable" as const };
          }
          return {
            status: "eligible" as const,
            active: thread.lifecycle === "active",
            delivered: true,
            checkoutId: decodeCodeCheckoutId(checkoutId),
            repositoryId: decodeCodeRepositoryId(repositoryId),
          };
        },
      },
      now: Date.now,
    });
    agentRunChildWorktree.current = createAgentRunChildWorktreePort({
      service: managedWorktreeService,
      loadReceipt: (receiptId) => managedWorktreeReceipts.load(receiptId),
      findActive: (lookup) => managedWorktreeReceipts.findActive(lookup),
    });
    managedWorktreeRefsList = async (input, signal) => {
      const project = persistence.readProject(input.projectId);
      if (project?.type !== "code") return [];
      const entries = await listWorktreeRefs(project.binding.canonicalRoot, signal);
      return entries.map((entry) => decodeCodeWorktreeRef(entry));
    };
    managedWorktreeSourcePreview = async (input, signal) => {
      const project = persistence.readProject(input.projectId);
      if (project?.type !== "code") return { kind: "failed", reason: "unavailable" };
      const revision = project.bindingHistory.at(-1);
      if (revision === undefined || revision.revisionId !== input.bindingRevisionId) {
        return { kind: "failed", reason: "unavailable" };
      }
      const result = await managedWorktreeService.previewSource(
        {
          repositoryId: input.repositoryId,
          repositoryRoot: project.binding.canonicalRoot,
          refIntent: input.refIntent,
          startFromOrigin: input.startFromOrigin,
          ...(input.remoteName === undefined ? {} : { remoteName: input.remoteName }),
        },
        signal,
      );
      if (result.status === "origin") {
        return decodeCodeWorktreeSourcePreview({
          kind: "origin",
          remoteName: result.remoteName,
          branch: result.branch,
          resolvedHead: result.resolvedHead,
          fetchedAt: result.fetchedAt,
        });
      }
      if (result.status === "local") {
        return decodeCodeWorktreeSourcePreview(
          result.remoteName === undefined
            ? { kind: "local", branch: result.branch, resolvedHead: result.resolvedHead }
            : {
                kind: "local",
                branch: result.branch,
                resolvedHead: result.resolvedHead,
                remoteName: result.remoteName,
              },
        );
      }
      return { kind: "failed", reason: result.reason };
    };
    managedCodeThreadCreation = createManagedCodeThreadCreationPort({
      readProject: (projectId) => persistence.readProject(projectId),
      service: managedWorktreeService,
      repository: managedWorktreePorts.repository,
      clock: () => new Date().toISOString(),
    });
    const acpHome =
      options.acpHome ??
      ((kind: AcpProviderKind, instanceId: ProviderInstance["id"]) =>
        join(providerDataDirectory, "providers", kind, instanceId));
    const piHome =
      options.piHome ??
      ((instanceId: ProviderInstance["id"]) =>
        join(providerDataDirectory, "providers", "pi", instanceId));
    const ohMyPiHome =
      options.ohMyPiHome ??
      ((instanceId: ProviderInstance["id"]) =>
        join(providerDataDirectory, "providers", "oh-my-pi", instanceId));
    const claudeProcess =
      options.claudeProcess ??
      makeClaudeProcessLive({
        onProcessStarted: (process) => {
          return providerRuntimeRegistry.trackProcess(`claude:${process.pid}`, process);
        },
      });
    const claudeSdk =
      options.claudeSdk ?? makeClaudeAgentSdkPort({ spawnClaudeCodeProcess: claudeProcess.spawn });
    const claudeResumeIdentityStore =
      options.claudeResumeIdentityStore ?? new ClaudeResumeIdentityStore();
    const ollamaHistoryStore =
      options.ollamaHistoryStore ??
      new JournalOllamaHistoryStore({
        persistence,
        uuid: randomUUID,
        clock: () => new Date().toISOString(),
      });
    const isProjectConfinedPath = options.isProjectConfinedPath ?? pathIsProjectConfined;
    const credentialResolver =
      options.credentialBrokerUrl === undefined || options.credentialBrokerToken === undefined
        ? undefined
        : makeCredentialBrokerClient({
            url: options.credentialBrokerUrl,
            token: options.credentialBrokerToken,
          });
    const providerService = new ProviderService({
      persistence,
      runtimeRegistry: providerRuntimeRegistry,
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
      clearResumeIdentities: (instanceId) =>
        claudeResumeIdentityStore.removeProvider(instanceId, new AbortController().signal),
      clearRuntimeUsageLimits: (instanceId) => providerRuntimeUsageLimitsStore.clear(instanceId),
      driver: (instance) =>
        attachWorkRequestRuntime(
          makeConfiguredProviderDriver(instance, {
            openCodeProcess,
            codexProcess,
            acpProcess,
            acpHome,
            piProcess,
            piHome,
            ohMyPiProcess,
            ohMyPiHome,
            ollamaHistoryStore,
            claudeProcess,
            claudeSdk,
            claudeResumeIdentityPort: claudeResumeIdentityStore,
            isProjectConfinedPath,
            runtimeRegistry: providerRuntimeRegistry,
            permissionPersistence: () => persistence.readProviderDefaults().permissionPersistence,
            onRuntimeEvent: (event) => providerRuntimeUsageLimitsStore.record(event),
            ...(credentialResolver === undefined ? {} : { credentialResolver }),
          }),
          () => workRequestRuntime,
        ),
    });
    probeProviderForThreads = (providerInstanceId) =>
      providerService.probe(LOCAL_HOST_ID as never, providerInstanceId);
    const reviewedModelManifest = new ReviewedModelManifest();
    // Model classification tracks the canonical manifest branch by commit
    // rather than by app release. It is opt-in so the local-first default
    // reaches no remote, and background so a refused refresh only leaves the
    // built-in conservative limits in place.
    if (process.env.OCTANT_REVIEWED_MODEL_MANIFEST === "1") {
      void refreshReviewedModelManifest({ reference: CANONICAL_REVIEWED_MODEL_MANIFEST })
        .then((refresh) => reviewedModelManifest.accept(refresh))
        .catch(() => undefined);
    }
    const providerRoutes = createProviderRouteHandler({
      service: providerService,
      windowAuthorityStore,
      maxRequestBodySize: MAX_JSON_REQUEST_BODY_SIZE,
      packagedProviderSmokeControl: options.packagedProviderSmokeControl === true,
    });
    const discoveryService = makeDiscoveryService({ hostId: LOCAL_HOST_ID });
    const createDisabledProviderFromDiscovery = async (
      candidate: DiscoveryCandidate,
      windowId: string,
    ) => {
      const { command } = createProviderFromDiscoveryCandidate(candidate, { enabled: false });
      const result = await providerService.execute(windowId as never, command);
      if (result.kind !== "provider-created") {
        throw new Error("Provider discovery auto-register did not create a provider instance.");
      }
      return { instanceId: result.instance.id };
    };
    const discoveryRoutes = createDiscoveryRouteHandler({
      discoveryService,
      windowAuthorityStore,
      maxRequestBodySize: MAX_JSON_REQUEST_BODY_SIZE,
      listInstances: async () => persistence.readProviderInstances(),
      createDisabled: createDisabledProviderFromDiscovery,
      onConnect: async (command, windowId) => {
        const { command: providerCommand } = createProviderFromDiscoveryCandidate(command, {
          enabled: true,
        });
        const result = await providerService.execute(windowId as never, providerCommand);
        if (result.kind !== "provider-created") {
          throw new Error("Provider discovery connect did not create a provider instance.");
        }
        return { instanceId: result.instance.id };
      },
    });
    const chatDataDirectory = join(providerDataDirectory, "chat");
    const configuredDriverOptions: ConfiguredProviderDriverOptions = {
      openCodeProcess,
      codexProcess,
      acpProcess,
      acpHome,
      piProcess,
      piHome,
      ohMyPiProcess,
      ohMyPiHome,
      ollamaHistoryStore,
      claudeProcess,
      claudeSdk,
      claudeResumeIdentityPort: claudeResumeIdentityStore,
      isProjectConfinedPath,
      runtimeRegistry: providerRuntimeRegistry,
      permissionPersistence: () => persistence.readProviderDefaults().permissionPersistence,
      onRuntimeEvent: (event) => providerRuntimeUsageLimitsStore.record(event),
      ...(credentialResolver === undefined ? {} : { credentialResolver }),
    };
    const providerUsageLimitsService = new ProviderUsageLimitsService({
      // Image profiles are jobs against a generation endpoint, not runtimes
      // with an account to meter; listing them would promise a report that
      // has no channel to arrive on.
      listInstances: () =>
        persistence
          .readProviderInstances()
          .filter((instance) => !isImageProfileDriverKind(instance.driverKind)),
      now: () => new Date().toISOString() as UtcTimestamp,
      unavailableReason: (instance) =>
        unavailableLimitsReason(
          instance.driverKind,
          providerRuntimeUsageLimitsStore.lastCompletedTurn(instance.id),
        ),
      observe: async (instance, signal) => {
        let driver: ProviderDriver;
        try {
          driver = makeConfiguredProviderDriver(instance, {
            ...configuredDriverOptions,
          });
        } catch {
          return undefined;
        }
        const facts = driver.contextFacts;
        if (facts === undefined) return undefined;
        const limits = await Effect.runPromise(
          Effect.scoped(facts.observeServiceLimits({ instanceId: instance.id })),
          { signal },
        );
        return { source: "provider-runtime", limits };
      },
      runtimeLimits: (instanceId, observedAt) =>
        providerRuntimeUsageLimitsStore.serviceLimits(instanceId, observedAt),
    });
    providerUsageLimitsService.start();
    void providerUsageLimitsService.refresh().catch(() => undefined);
    const providerUsageLimitsRoutes = createProviderUsageLimitsRouteHandler({
      service: providerUsageLimitsService,
      windowAuthorityStore,
    });
    const browserAuthority = new ServerBrowserAuthorityResolver({
      hostId: deriveToolHostId(providerDataDirectory),
      persistence,
      workThreads: workThreadProjection,
    });
    const headlessBrowserRuntime = createPlaywrightBrowserRuntime({
      receiptDirectory: join(providerDataDirectory, "browser", "runtime-receipts"),
    });
    const desktopBrowserRuntime = createDesktopBrowserRuntimeFromEnvironment(process.env);
    const browserRuntime =
      options.browserRuntime ??
      (desktopBrowserRuntime === undefined
        ? headlessBrowserRuntime
        : new RoutingBrowserRuntime({
            native: desktopBrowserRuntime,
            headless: headlessBrowserRuntime,
          }));
    yield* Effect.promise(() => browserRuntime.reconcile?.() ?? Promise.resolve());
    browserAutomationService = new BrowserAutomationService({
      runtime: browserRuntime,
      authority: browserAuthority,
      toolCallAuthority: createBrowserToolCallAuthorityService(
        browserAuthority,
        () => new Date().toISOString(),
        (threadId) => readThreadExternalContentTaint(persistence.connection, threadId),
        (threadId) => {
          const thread = persistence.readCodeThread(threadId as never);
          if (thread === undefined) return undefined;
          return {
            ...(thread.toolConstraints === undefined
              ? {}
              : { toolConstraints: thread.toolConstraints }),
            ...(thread.profileDisplayName === undefined
              ? {}
              : { profileDisplayName: thread.profileDisplayName }),
          };
        },
      ),
      recordExternalContentIngestion: (input) => externalContentIngestionStore.record(input),
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
      now: Date.now,
    });
    // Notes the user points at the running product. The service owns the
    // authority check and resolves the element itself; the crop lives in the
    // same purgeable evidence store the rest of Code's bulk content uses, and
    // the journal keeps only the reference.
    productFeedbackService = new ProductFeedbackService({
      journal: persistence.journal,
      browser: {
        describePoint: async (input) =>
          (await browserAutomationService?.describePoint({
            windowId: input.windowId,
            threadId: decodeBrowserThreadId(input.threadId),
            contextId: decodeBrowserContextId(input.contextId),
            point: input.point,
          })) ?? { status: "unavailable" },
      },
      crops: {
        put: (dataUrl) => {
          const reference = codeEvidence.put(dataUrl);
          return {
            contentId: String(reference.contentId),
            digest: reference.digest,
            byteLength: reference.byteLength,
          };
        },
        read: (crop) => {
          try {
            return codeEvidence.read(
              decodeCodeEvidenceReference({
                contentId: crop.contentId,
                digest: crop.digest,
                byteLength: crop.byteLength,
              }),
            );
          } catch {
            return undefined;
          }
        },
      },
      readNote: (noteId) => persistence.readProductFeedbackNote(noteId),
      readNotes: (threadId) => persistence.readProductFeedbackNotes(threadId),
      canAccessThread: async (windowId, threadId) => {
        const thread = persistence.readCodeThread(decodeCodeThreadId(threadId));
        if (thread === undefined) return false;
        return projectService.hasActiveProject(thread.projectId, "code");
      },
      recordExternalContentIngestion: (input) => externalContentIngestionStore.record(input),
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
      actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
    });
    const productFeedbackRoutes = createProductFeedbackRouteHandler({
      feedback: productFeedbackService,
      windowAuthorityStore,
    });
    if (codeOperationRuntime === undefined && options.codeService === undefined) {
      const terminalProcessPort = new TerminalProcessPort({
        receiptDirectory: join(providerDataDirectory, "code", "terminal-receipts"),
        shellStateDirectory: join(providerDataDirectory, "code", "terminal-shell"),
      });
      const repositoryTestProcessPort = new RepositoryTestProcessPort({
        receiptDirectory: join(providerDataDirectory, "code", "test-receipts"),
      });
      // A scaffold generator downloads what it writes, so it gets its own
      // private work directory and is pointed at it for every package cache.
      // Nothing it fetches lands in the user's own caches, and the confinement
      // still writes only the checkout and this directory.
      const scaffoldWorkDirectory = join(providerDataDirectory, "code", "scaffold-work");
      const scaffoldProcessPort = new RepositoryTestProcessPort({
        receiptDirectory: join(providerDataDirectory, "code", "scaffold-receipts"),
        temporaryDirectory: scaffoldWorkDirectory,
      });
      const rootProbePath = decodeCodeRelativePath("package.json");
      codeOperationRuntime = createCodeOperationRuntime({
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
          readReviewFinding: persistence.readCodeReviewFinding,
          readReviewFindings: persistence.readCodeReviewFindings,
        },
        windowAccess: {
          canAccessProject: canAccessCodeProject,
        },
        resolveCheckoutRoot: async (windowId, thread, checkout) => {
          const root = await roots.resolve(windowId, thread, checkout, rootProbePath);
          if (root === undefined) return undefined;
          const workingDirectory = await resolveThreadWorkingDirectory(
            root.rootPath,
            thread.workingDirectory ?? decodeThreadWorkingDirectory("."),
          );
          return {
            checkoutRoot: root.rootPath,
            workingDirectory,
            shell: "/bin/zsh",
            credentialReferences: [],
            environment: {},
          };
        },
        resolveProviderDriver: (thread) => {
          const instance = persistence.readProviderInstance(thread.providerInstanceId);
          if (instance === undefined || !instance.enabled) return undefined;
          try {
            return attachWorkRequestRuntime(
              makeConfiguredProviderDriver(instance, configuredDriverOptions),
              () => workRequestRuntime,
            );
          } catch {
            return undefined;
          }
        },
        nativeHarnessTools: (input) => nativeHarnessComposition?.forCode(input),
        nativeHarness: nativeHarnessHooks,
        supportsAppManagedTools: (thread) => {
          const observed = providerRuntimeRegistry.observedState(thread.providerInstanceId);
          return (
            observed?.capabilities.appManagedTools === "supported" ||
            observed?.verifiedToolModelIds?.some(
              (candidate) => String(candidate) === String(thread.modelId),
            ) === true
          );
        },
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
        browserAutomation: {
          resolveAuthority: (threadId, mode) => browserAuthority.resolve(threadId, mode),
          inspectThread: (windowId, threadId) =>
            requireBrowserAutomationService().inspectThread(windowId, threadId),
          create: (input) => requireBrowserAutomationService().create(input),
          act: (input) => requireBrowserAutomationService().act(input),
          releaseThread: (windowId, threadId) =>
            requireBrowserAutomationService().releaseThread(windowId, threadId),
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
            await recordAppleEvidence(evidence, startedAt);
            return evidence;
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
        },
        credentialResolver: { resolve: async () => undefined },
        resolveThreadMentionContext: threadMentionContextResolver(() => threadMentionService),
        resolveFileMentionContext: async ({ fileMentionPaths, windowId, threadId, checkoutId }) =>
          fileMentionContextBlocks(fileMentionService, {
            windowId,
            scope: { mode: "code", threadId, checkoutId },
            paths: fileMentionPaths,
          }),
        takeProductFeedbackForTurn: createProductFeedbackTurnPort({
          service: productFeedbackService,
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
        resolveForkHandoff: forkHandoffResolver(() => routeCodeService),
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
        recordExternalContentIngestion: (input) => externalContentIngestionStore.record(input),
        // Planner tools resolve their designation on every call through the
        // services declared after this runtime; the closures run only once a
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
          const owner = thread.deliveryTarget.proposedBaseRepository.split("/")[0];
          if (owner === undefined || owner.length === 0) return undefined;
          return {
            authorization: "confirmed-delivery-target",
            baseRepository: thread.deliveryTarget.proposedBaseRepository,
            baseBranch: thread.deliveryTarget.proposedBaseBranch,
            head: `${owner}:${thread.deliveryTarget.branchIntent}`,
          };
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
    yield* Effect.promise(() => codeOperationRuntime?.reconcile?.() ?? Promise.resolve());
    const baseRouteCodeService: CodeRouteService =
      codeOperationRuntime === undefined
        ? codeService
        : withCodeOperationRuntime(codeService, codeOperationRuntime);
    // The Code Thread Board composes the journal-rebuildable operational
    // metadata projection with live runtime works. Local Git worktree
    // observation still degrades to unavailable here when the checkout cannot
    // be observed; GitHub is never called. Cached PR evidence comes from the
    // operation journal, labeled with freshness, and cannot independently
    // satisfy a delivery target when stale.
    const codeThreadMetadataService = new CodeThreadMetadataService({
      git: { observe: () => ({ status: "unavailable" }) },
      history: {
        read: (threadId) => codeBoardEventStore.historyForThread(threadId),
      },
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
    // the planner has no creation authority of its own.
    const codePlannerService = new CodePlannerService({
      persistence,
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
      canAccessProject: canAccessCodeProject,
      createThread: async (windowId, creation, signal) =>
        baseRouteCodeService.execute(windowId, creation, signal),
    });
    // A linked pull request's checks turning red is a user obligation, not an
    // agent event: every snapshot refresh feeds the durable follow-up marker on
    // the owning thread. Read-only toward GitHub; only an explicit completion
    // clears the marker.
    const failingChecksFollowUps = new FailingChecksFollowUps({
      followUps: codeFollowUpService,
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
    });
    observeRefreshedPullRequestRows = (rows) => {
      void failingChecksFollowUps.observe(rows);
    };
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
        const boardThreads: CodeBoardThread[] = bootstrap.threads
          .filter((thread) => thread.lifecycle !== "archived")
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
            observe: (threadId) =>
              boardRuntimeActivityFromWorks(persistence.readCodeRuntimeWorks(threadId)),
          },
          pullRequests: {
            snapshot: () => projectPullRequestService.boardSnapshot(windowId),
          },
          planProgress: codeBoardPlanProgressSource,
          clock: () => new Date().toISOString(),
        });
        return board.query(query);
      },
    );
    const routeCodeService: CodeRouteService = {
      ...boardRouteCodeService,
      readFollowUp: (_windowId, threadId) => codeFollowUpService.read(threadId),
      executeFollowUp: (_windowId, command) => codeFollowUpService.execute(command),
      readPlanner: (windowId, projectId) => codePlannerService.readView(windowId, projectId),
      executePlanner: (windowId, command) => codePlannerService.execute(windowId, command),
      executePlannerProposal: (windowId, command, signal) =>
        codePlannerService.resolveProposal(windowId, command, signal),
      queryProjectPullRequests: (windowId, query) =>
        projectPullRequestService.query(windowId, query),
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
        return view;
      },
      queryProjectPullRequestDetail: (windowId, query) =>
        projectPullRequestService.queryDetail(windowId, query),
      refreshProjectPullRequestDetail: (windowId, command, signal) =>
        projectPullRequestService.refreshDetail(
          windowId,
          command,
          signal ?? new AbortController().signal,
        ),
    };
    const appleRuntimeStore = new AppleRuntimeStore(join(providerDataDirectory, "apple-runtime"));
    const appleProcess = new RepositoryTestProcessPort({
      receiptDirectory: join(providerDataDirectory, "apple-runtime", "test-receipts"),
    });
    yield* Effect.promise(() => appleProcess.reconcile());
    const appleToolchainService = new AppleToolchainService({
      execute: (input, signal) => appleProcess.execute(input, signal),
      realpath,
      writeArtifact: (reference, bytes) => appleRuntimeStore.writeArtifact(reference, bytes),
      readArtifact: (reference) => appleRuntimeStore.readArtifact(reference),
      persistReceipts: (receipts) => appleRuntimeStore.persistReceipts(receipts),
      now: () => new Date().toISOString(),
      newId: randomUUID,
    });
    const appleValidationEvents = new ValidationEventStore({
      journal: persistence.journal,
      uuid: randomUUID,
      actor: { kind: "system", actorId: OCTANT_LOCAL_ACTOR_ID },
    });
    const recordAppleEvidence = (
      evidence: import("@octant/contracts").AppleBuildEvidence,
      startedAt: string,
    ) => {
      const composed = composeAppleValidationEvents({ evidence, startedAt, newId: randomUUID });
      appleValidationEvents.appendPlan({ plan: composed.plan, expectedVersion: 0 });
      appleValidationEvents.appendEvidence({ evidence: composed.record, expectedVersion: 1 });
      appleValidationEvents.appendReport({ report: composed.report, expectedVersion: 2 });
    };
    const appleRootProbe = decodeCodeRelativePath("package.json");
    const resolveAppleContext = async (
      windowId: WindowId,
      scope: {
        readonly authority: import("@octant/contracts").ToolActionAuthority;
        readonly threadId: import("@octant/contracts").CodeThreadId;
        readonly checkoutId: import("@octant/contracts").CodeCheckoutId;
      },
      envelope: AppleRpcEnvelope,
    ): Promise<AppleExecutionContext | undefined> => {
      const thread = persistence.readCodeThread(scope.threadId);
      const checkout = persistence.readCodeCheckout(scope.checkoutId);
      if (
        thread === undefined ||
        checkout === undefined ||
        thread.checkoutId !== checkout.id ||
        thread.repositoryId !== checkout.repositoryId ||
        thread.lifecycle !== "active" ||
        checkout.availability !== "available" ||
        scope.authority.hostId !== LOCAL_TOOL_HOST_ID ||
        scope.authority.mode !== "code" ||
        scope.authority.projectId !== thread.projectId ||
        scope.authority.providerInstanceId !== thread.providerInstanceId ||
        scope.authority.extension.kind !== "core"
      ) {
        return undefined;
      }
      const projects = await projectService.bootstrap(windowId);
      if (
        !projects.active.some(
          (project) => project.id === thread.projectId && project.type === "code",
        )
      ) {
        return undefined;
      }
      const resolvedRoot = await roots.resolve(windowId, thread, checkout, appleRootProbe);
      if (resolvedRoot === undefined) return undefined;
      if (
        scope.authority.worktreeId !== undefined &&
        String(scope.authority.worktreeId) !== String(checkout.id)
      ) {
        return undefined;
      }
      if (
        scope.authority.rootId !== undefined &&
        String(scope.authority.rootId) !== stableAppleRootId(resolvedRoot.rootPath)
      ) {
        return undefined;
      }
      const effectiveThread = codeSessionAuthority.effectiveThread(windowId, thread);
      const approvalValid =
        envelope.kind !== "apple-action-request"
          ? true
          : effectiveThread.executionPolicy === "full-access"
            ? true
            : decidesCodeEffectsByApproval(effectiveThread.executionPolicy)
              ? ((await codeOperationRuntime?.validateAppleApproval(windowId, envelope.request)) ??
                false)
              : false;
      return {
        authority: scope.authority,
        threadId: thread.id,
        checkoutId: checkout.id,
        checkoutRoot: resolvedRoot.rootPath,
        artifactRoot: appleRuntimeStore.artifactRoot,
        sourceRevision: checkout.head.oid,
        executionPolicy: effectiveThread.executionPolicy,
        approvalValid,
      };
    };
    const appleToolchainRoutes = createAppleToolchainRouteHandler({
      windowAuthorityStore,
      service: appleToolchainService,
      resolveContext: resolveAppleContext,
      recordEvidence: recordAppleEvidence,
      maxRequestBodySize: MAX_JSON_REQUEST_BODY_SIZE,
    });
    yield* Effect.promise(async () => {
      const receipts = await appleRuntimeStore.loadReceipts();
      for (const receipt of receipts) {
        const context = appleRestartContext(receipt, persistence, appleRuntimeStore.artifactRoot);
        if (context !== undefined) {
          const reconciled = await appleToolchainService.reconcileAfterRestart([receipt], context);
          for (const evidence of reconciled) recordAppleEvidence(evidence, receipt.startedAt);
        }
      }
      await appleRuntimeStore.persistReceipts([]);
    });
    const codeRoutes = createCodeRouteHandler({
      service: routeCodeService,
      windowAuthorityStore,
      maxJsonBodySize: MAX_JSON_REQUEST_BODY_SIZE,
      maxFileBodySize: MAX_CODE_FILE_BODY_SIZE,
    });
    // Local servers. The scope resolver is what decides who may stop a
    // process, so it is bound to the same authoritative thread, checkout, and
    // root resolution the Code workspace already uses. `ownedPids` is empty
    // until an owned-process inventory is threaded through: that classifies
    // every listener as a leftover, which is the conservative direction because
    // a leftover stop always requires an explicit confirmation.
    const localServerRoutes = createLocalServerRouteHandler({
      service: new LocalServerService({
        listeners: createLiveLocalListenerPort(),
        health: createLiveLocalServerHealthProbe(),
        stopPort: createLiveLocalServerStopPort(),
        scopes: createCodeThreadLocalServerScopeResolver({
          projects: projectService,
          source: {
            readThread: (threadId) => persistence.readCodeThread(threadId),
            readCheckout: (checkoutId) => persistence.readCodeCheckout(checkoutId),
            resolveCheckoutRoot: async (windowId, thread, checkout) =>
              (await roots.resolve(windowId, thread, checkout, codeWorkingDirectoryProbePath))
                ?.rootPath,
            ownedPids: () => new Set<number>(),
          },
        }),
      }),
      persistence,
      projects: projectService,
      windowAuthorityStore,
    });
    const codeOperationApprovalRoutes = createCodeOperationApprovalRouteHandler({
      desktopBridgeSecret: options.desktopBridgeSecret,
      windowAuthorityStore,
      prepare: async (windowId, request) =>
        await codeOperationRuntime?.prepareApproval(windowId, request),
      confirm: async (windowId, confirmation) =>
        await codeOperationRuntime?.confirmApproval(windowId, confirmation),
    });
    const codeExternalEditorRoutes = createCodeExternalEditorRouteHandler({
      desktopBridgeSecret: options.desktopBridgeSecret,
      resolve: async (input) => {
        const editor = persistence.readCodeSettings()?.settings.externalEditor;
        if (editor === undefined) return undefined;
        const windowId = decodeWindowId(input.windowId);
        const thread = persistence.readCodeThread(decodeCodeThreadId(input.threadId));
        const checkout = persistence.readCodeCheckout(decodeCodeCheckoutId(input.checkoutId));
        const reference = persistence.readCodeFileReference(decodeCodeFileId(input.fileId));
        if (
          thread === undefined ||
          checkout === undefined ||
          reference === undefined ||
          !isCodeExternalEditorTargetCurrent({ thread, checkout, reference })
        ) {
          return undefined;
        }
        try {
          const relativePath = reference.relativePath;
          if (relativePath === undefined) return undefined;
          const root = await roots.resolve(windowId, thread, checkout, relativePath);
          if (root === undefined || root.fileId !== reference.id) return undefined;
          const file = await realpath(resolve(root.rootPath, relativePath));
          if (!pathIsProjectConfined(root.rootPath, file)) return undefined;
          return { file, editor };
        } catch {
          return undefined;
        }
      },
    });
    const codeCheckoutOpenRoutes = createCodeCheckoutOpenRouteHandler({
      desktopBridgeSecret: options.desktopBridgeSecret,
      resolve: async (input) => {
        const windowId = decodeWindowId(input.windowId);
        const thread = persistence.readCodeThread(decodeCodeThreadId(input.threadId));
        if (thread === undefined) return undefined;
        const checkout = persistence.readCodeCheckout(thread.checkoutId);
        if (checkout === undefined || !isCodeCheckoutOpenTargetCurrent({ thread, checkout })) {
          return undefined;
        }
        try {
          const rooted = await roots.resolve(
            windowId,
            thread,
            checkout,
            codeWorkingDirectoryProbePath,
          );
          if (rooted === undefined) return undefined;
          return { checkoutRoot: await realpath(rooted.rootPath) };
        } catch {
          return undefined;
        }
      },
    });
    const researchRouter = new ResearchRouter({
      searxngClient: {
        search: async (input) => {
          const settings = persistence.readChatSettings()?.settings;
          if (settings?.searxngBaseUrl === undefined) {
            throw new Error("SearXNG is not configured.");
          }
          return new SearxngClient({ baseUrl: settings.searxngBaseUrl }).search(input);
        },
      },
    });
    const threadWork = new ThreadWorkService({
      persistence,
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
    });
    // The harness `bash` tool runs through the same owned-process-group,
    // Seatbelt-confined port repository tests use, with its own receipt and
    // script directories so a command's leftovers never mix with a test's.
    const harnessWorkDirectory = join(providerDataDirectory, "harness", "work");
    mkdirSync(harnessWorkDirectory, { recursive: true, mode: 0o700 });
    const harnessProcessPort = new RepositoryTestProcessPort({
      receiptDirectory: join(providerDataDirectory, "harness", "receipts"),
      temporaryDirectory: harnessWorkDirectory,
    });
    const nativeHarnessRoutingStore = new NativeHarnessRoutingStore({
      journal: persistence.journal,
      uuid: randomUUID,
      actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
      clock: () => new Date().toISOString(),
    });
    nativeHarnessRouter = new NativeHarnessRouter({
      store: nativeHarnessRoutingStore,
      isReady: (candidate) =>
        agentRunRouteDependencies.providerReadiness.isReady({
          providerInstanceId: String(candidate.providerInstanceId),
          modelId: String(candidate.modelId),
        }),
    });
    const nativeHarnessRouterLive = nativeHarnessRouter;
    nativeHarnessSessions = new NativeHarnessSessionStore({
      journal: persistence.journal,
      uuid: randomUUID,
      actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
      clock: () => new Date().toISOString(),
    });
    const nativeHarnessSessionsLive = nativeHarnessSessions;
    nativeHarnessQuestions = new NativeHarnessQuestionStore({
      sessions: nativeHarnessSessionsLive,
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
      // Code threads already have an inline question surface; the same
      // question shows there so the answer can come from the thread itself.
      onAsked: ({ threadId, mode, question }) => {
        if (mode !== "code") return;
        codeOperationRuntime?.raiseHarnessQuestion?.({
          threadId,
          questionId: String(question.id),
          prompt: question.prompt,
          options: question.options,
        });
      },
    });
    const nativeHarnessQuestionsLive = nativeHarnessQuestions;
    const nativeHarnessApprovals = new NativeHarnessApprovalStore({
      sessions: nativeHarnessSessionsLive,
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
    });
    const nativeHarnessRoutingRoutes = createNativeHarnessRoutingRouteHandler({
      windowAuthorityStore,
      store: nativeHarnessRoutingStore,
    });
    // The Chat, Work, and Code services a follow-up creates through are
    // composed after these routes; the creator is bound once they exist.
    const nativeHarnessFollowUpCreation: {
      current: NativeHarnessFollowUpCreationDependencies | undefined;
    } = { current: undefined };
    const nativeHarnessSessionRoutes = createNativeHarnessSessionRouteHandler({
      windowAuthorityStore,
      store: nativeHarnessSessionsLive,
      createFollowUp: (input) =>
        nativeHarnessFollowUpCreation.current === undefined
          ? Promise.resolve({
              kind: "refused" as const,
              message: "Follow-up creation is unavailable on this host.",
            })
          : createNativeHarnessFollowUp(nativeHarnessFollowUpCreation.current, input),
      answerQuestion: ({ threadId, questionId, answer }) =>
        nativeHarnessQuestionsLive.answer(threadId, questionId, answer),
      decideApproval: ({ threadId, approvalId, decision }) =>
        nativeHarnessApprovals.decide(threadId, approvalId, decision),
      steer: ({ threadId, command }) => {
        if (command.kind === "clear") {
          nativeHarnessSessionsLive.clearSteering(threadId, "all");
          return true;
        }
        return nativeHarnessSessionsLive.queueSteering(threadId, {
          id: randomUUID(),
          text: command.text,
          status: "queued",
          at: new Date().toISOString() as never,
        });
      },
      authorizeThread: ({ threadId, windowId }) =>
        authorizeAgentRunParentThread({
          persistence,
          workThreadProjection,
          parentThreadId: threadId as never,
          windowId,
        }),
      previewFollowUp: ({ view, suggestion }) => {
        if (suggestion.target === "same-thread") {
          return { kind: "same-thread", threadId: view.session.threadId };
        }
        if (suggestion.target === "new-thread") {
          return {
            kind: "new-thread",
            mode: view.session.mode,
            ...(view.session.projectId === undefined ? {} : { projectId: view.session.projectId }),
            title: suggestion.title,
          };
        }
        if (view.session.mode !== "code" || view.session.projectId === undefined) return undefined;
        return {
          kind: "new-worktree",
          mode: "code",
          projectId: view.session.projectId,
          title: suggestion.title,
        };
      },
    });
    nativeHarnessObserver = new NativeHarnessTurnObserver({
      sessions: nativeHarnessSessionsLive,
      router: nativeHarnessRouterLive,
      isHarnessProvider: (providerInstanceId) => {
        const instance = persistence.readProviderInstance(providerInstanceId);
        return instance !== undefined && isNativeHarnessDriverKind(instance.driverKind);
      },
      resolveDriver: (providerInstanceId) => {
        const instance = persistence.readProviderInstance(providerInstanceId);
        if (instance === undefined || !instance.enabled) return undefined;
        try {
          return makeConfiguredProviderDriver(instance, configuredDriverOptions);
        } catch {
          return undefined;
        }
      },
      hostId: String(LOCAL_HOST_ID),
      scratchRoot: harnessWorkDirectory,
      contextHarness,
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
    });
    nativeHarnessComposition = createNativeHarnessComposition({
      questions: nativeHarnessQuestionsLive,
      approvals: nativeHarnessApprovals,
      activity: nativeHarnessSessionsLive,
      delegate: (scope) =>
        createNativeHarnessDelegatePort(
          {
            admission: {
              persistence: agentRunPersistence,
              orchestration: agentRunOrchestration,
              settings: agentRunSettingsStore,
              providerReadiness: agentRunRouteDependencies.providerReadiness,
              uuid: randomUUID,
              authorizeCreation: agentRunRouteDependencies.authorizeCreation,
              nativeEvidence: ({ parent }) =>
                agentRunRouteDependencies.nativeEvidence?.({ parent }) ?? {
                  claimedNativeSupport: "unsupported",
                  workspace: false,
                  authority: false,
                  observability: false,
                  cancellation: false,
                  steering: false,
                  recovery: false,
                },
              ...(agentRunRouteDependencies.workspace === undefined
                ? {}
                : { workspace: agentRunRouteDependencies.workspace }),
              ...(agentRunRouteDependencies.poolRouting === undefined
                ? {}
                : { poolRouting: agentRunRouteDependencies.poolRouting }),
              ...(agentRunRouteDependencies.parentContext === undefined
                ? {}
                : { parentContext: agentRunRouteDependencies.parentContext }),
            },
            orchestration: agentRunOrchestration,
            persistence: agentRunPersistence,
            router: nativeHarnessRouterLive,
            sessions: nativeHarnessSessionsLive,
            uuid: randomUUID,
          },
          scope,
        ),
      authority: createNativeHarnessAuthority({
        hostId: deriveToolHostId(providerDataDirectory),
        persistence,
        workThreads: workThreadProjection,
        readThreadTaint: (threadId) =>
          readThreadExternalContentTaint(persistence.connection, threadId),
      }),
      isHarnessProvider: (providerInstanceId) => {
        const instance = persistence.readProviderInstance(providerInstanceId);
        return instance !== undefined && isNativeHarnessDriverKind(instance.driverKind);
      },
      plans: planService,
      shell: createNativeHarnessShell({
        process: harnessProcessPort,
        scriptDirectory: harnessWorkDirectory,
      }),
      webSearch:
        persistence.readChatSettings()?.settings.searxngBaseUrl === undefined
          ? undefined
          : async (input) => {
              const settings = persistence.readChatSettings()?.settings;
              if (settings?.searxngBaseUrl === undefined) return [];
              const found = await new SearxngClient({ baseUrl: settings.searxngBaseUrl }).search(
                input,
              );
              return found.results.map((result) => ({
                title: result.title,
                url: result.url,
                snippet: result.snippet,
              }));
            },
      webFetch: async (input) => {
        try {
          return await fetchPublicUrl(input);
        } catch (error) {
          if (error instanceof PublicFetchRefused) return { refused: error.reason };
          throw error;
        }
      },
      contextHarness,
      hostId: deriveToolHostId(providerDataDirectory),
      readThreadTaint: (threadId) =>
        readThreadExternalContentTaint(persistence.connection, threadId).externalContentIngested,
      recordExternalContentIngestion: (input) => externalContentIngestionStore.record(input),
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
    });
    let zenAssistantTools: ZenAssistantTools | undefined;
    let threadDialogueService: ThreadDialogueService | undefined;
    // Composed after the Canvas service exists, the same way Zen's tools are.
    let canvasAgentToolPort: CanvasAgentToolPort | undefined;
    // Side Chat sidecars are ordinary Chat threads that must not appear in
    // Recents/Unfiled/Project listings; the store is the single source of which
    // ids stay hidden, while read() still opens them for the Side Chat tab.
    const sideChatSidecars = new SideChatSidecarStore(chatDataDirectory);
    yield* Effect.promise(() => sideChatSidecars.hydrate());
    // The host-owned Navigator conversation is an ordinary Chat thread that
    // must stay out of every listing, so it rides the same hidden-thread seam
    // as a Side Chat sidecar rather than a second hiding mechanism. Its
    // binding is journaled, so the conversation survives a restart.
    const navigatorAssistantBindings = new JournalNavigatorAssistantBindingStore({
      journal: persistence.journal,
      uuid: randomUUID,
    });
    let imageJobService!: ImageJobService;
    const chatService = new ChatService({
      persistence,
      issueContext: githubIssueContextService,
      linearIssueContext: linearIssueContextService,
      reviewedModelManifest,
      hiddenThreadIds: () => {
        const hidden = new Set(sideChatSidecars.hiddenThreadIds());
        for (const threadId of navigatorAssistantBindings.hiddenThreadIds()) hidden.add(threadId);
        return hidden;
      },
      // A Side Chat sidecar is a lane *about* one source thread, so that
      // thread rides every one of its turns without the user having to add a
      // `#thread` chip. The host resolves it: the link comes from the sidecar
      // registry, and the transcript comes back through the same mention
      // resolution an Open would take, re-derived on this send's own window.
      // The renderer therefore cannot name a different source or widen what
      // the sidecar reads. `threadMentionService` is declared below; this
      // closure only runs at send time.
      resolveSideChatSourceContext: async ({ sidecarThreadId, windowId }) => {
        const sidecar = sideChatSidecars.findBySidecarThread(sidecarThreadId);
        if (sidecar === undefined) return undefined;
        // Without an authenticated window there is no principal to re-derive
        // the source thread's Open authority from, so the sidecar refuses
        // rather than answering about a thread nobody proved it may read.
        if (windowId === undefined) return { kind: "unreadable" };
        let resolved: ThreadMentionCommandResult;
        try {
          resolved = await threadMentionService.execute(
            {
              kind: "resolve-mentions",
              requestId: randomUUID(),
              threadIds: [sidecar.sourceThreadId],
            },
            { windowId },
          );
        } catch {
          return { kind: "unreadable" };
        }
        const mention = resolved.kind === "mentions-resolved" ? resolved.mentions[0] : undefined;
        if (mention === undefined) return { kind: "unreadable" };
        return { kind: "resolved", text: formatThreadMentionContext([mention]) };
      },
      resolveThreadMentionContext: threadMentionContextResolver(() => threadMentionService),
      dataDirectory: chatDataDirectory,
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
      driver: (providerInstanceId) => {
        const instance = persistence.readProviderInstance(providerInstanceId);
        if (instance === undefined) {
          throw new Error("Provider instance is unavailable.");
        }
        return attachWorkRequestRuntime(
          makeConfiguredProviderDriver(instance, configuredDriverOptions),
          () => workRequestRuntime,
        );
      },
      contextHarness,
      capacityScheduler,
      researchRouter,
      threadWork,
      providerRuntimeRegistry: providerRuntimeRegistry,
      nativeHarness: nativeHarnessHooks,
      resolveAppManagedTools: ({ windowId, thread, threadMentionIds, coordinationDepth }) =>
        taintAppManagedToolResults({
          tools: combineAppManagedToolSets(
            nativeHarnessComposition?.forChat({ thread, windowId }),
            zenAssistantTools?.forThread(windowId, thread),
            threadDialogueService?.forThread({
              windowId,
              sourceThreadId: thread.id,
              sourceTitle: thread.title,
              targetThreadIds: threadMentionIds ?? [],
              ...(coordinationDepth === undefined ? {} : { coordinationDepth }),
            }),
            canvasAgentToolPort === undefined
              ? undefined
              : createCanvasAgentTools({
                  windowId,
                  thread,
                  port: canvasAgentToolPort,
                }),
            createImageAgentTools({
              threadKind: "chat-thread",
              scopeId: decodeImageGenerationScopeId(String(thread.id)),
              port: {
                listInstances: () => persistence.readProviderInstances(),
                enqueue: (input) => imageJobService.enqueue(input),
                listJobs: (scopeId) => imageJobService.listByScope(scopeId),
              },
            }),
          ),
          threadId: thread.id,
          recordExternalContentIngestion: (input) => externalContentIngestionStore.record(input),
          uuid: randomUUID,
        }),
      resolveExtensionSelectionContext: createExtensionChatResolver({
        snapshot: () => extensionApiService.snapshot(),
        resolveEffectiveState: (snapshot, query) =>
          extensionActivationService.resolve(snapshot, query),
        reconcileEffectiveState: async (effective) => {
          await agentPluginMcpSessionManager.reconcile(effective);
          return agentPluginMcpSessionManager.projectEffectiveState(effective);
        },
        providerFamily: (thread) => {
          const instance = persistence.readProviderInstance(thread.providerInstanceId);
          if (instance === undefined) throw new Error("Provider instance is unavailable.");
          return instance.driverKind as ExtensionProviderFamily;
        },
        materialLoader: createStoredExtensionMaterialLoader(extensionPackageStore, {
          mcpToolsForComponent: ({ packageId, componentId, scope }) =>
            agentPluginMcpSessionManager.toolDefinitionsFor(packageId, componentId, scope),
        }),
        toolExecution:
          options.extensionToolExecution ?? agentPluginMcpSessionManager.createToolExecutionPort(),
      }),
    });
    const projectMentionLabel = (projectId: string) =>
      persistence.readProject(projectId as ProjectId)?.name;
    const threadMentionService = new ThreadMentionService({
      // Every mode contributes its own already-authorized listing, because a
      // mention resolves exactly what the principal can Open —
      // Chat alone would make a Work or Code thread unmentionable from any
      // composer, including its own.
      directories: [
        createChatThreadMentionDirectory({
          bootstrap: () => chatService.bootstrap(),
          read: (threadId) => chatService.read(threadId),
          projectLabel: projectMentionLabel,
        }),
        createWorkThreadMentionDirectory({
          // `workThreadService` and `workTurnService` are composed further
          // down; the directory only calls them per request, never at
          // construction.
          bootstrap: (windowId) => workThreadService.bootstrap(windowId),
          transcript: (windowId, threadId) => workTurnService.transcript(windowId, threadId),
          projectLabel: projectMentionLabel,
        }),
        createCodeThreadMentionDirectory({
          bootstrap: async (windowId) => await routeCodeService.bootstrap(windowId),
          conversation: async (windowId, threadId, afterCursor, limit) => {
            const read = routeCodeService.conversation;
            if (read === undefined) throw new Error("Code conversation is unavailable.");
            return await read(windowId, threadId, afterCursor, limit);
          },
          readEvidence: async (windowId, threadId, operationId, contentId) => {
            const read = routeCodeService.readOperationContent;
            if (read === undefined) throw new Error("Code operation evidence is unavailable.");
            return await read(windowId, threadId, operationId, contentId);
          },
          projectLabel: projectMentionLabel,
        }),
      ],
      sidecars: sideChatSidecars,
      sideChatThreads: createChatSideChatThreadFactory({
        execute: (command) => chatService.execute(command),
        // A thread Chat refuses to open — missing, deleting, or deleted — is
        // absent for this purpose, so the claimed id is (re)created rather
        // than adopted as an existing sidecar.
        read: (threadId) => {
          try {
            return chatService.read(threadId);
          } catch {
            return undefined;
          }
        },
      }),
      clock: () => new Date().toISOString(),
      uuid: randomUUID,
    });
    threadDialogueService = new ThreadDialogueService({
      resolveChatTargets: (windowId, threadIds) =>
        threadMentionService.chatDialogueTargets(windowId, threadIds),
      readChatThread: (threadId) => chatService.read(threadId),
      executeChat: (command, context) => chatService.execute(command, context),
    });
    const threadMentionRoutes = createThreadMentionRouteHandler({
      service: threadMentionService,
      windowAuthorityStore,
      maxJsonBodySize: MAX_JSON_REQUEST_BODY_SIZE,
    });
    yield* Effect.promise(() => chatService.reapStaleProviderSessions({ staleAfterMs: 0 }));
    yield* Effect.promise(() => chatService.recoverManagedAttachments());
    yield* Effect.promise(() => codeAttachments.recover());
    yield* Effect.promise(() => workAttachments.recover());
    const generatedImageStore = new GeneratedImageStore(persistence.dataDirectory);
    yield* Effect.promise(() =>
      generatedImageStore.recover({
        isFinalizedAttachmentReferenced: (scopeId, attachmentId) =>
          persistence.imageJobProjection.isFinalizedAttachmentReferenced(scopeId, attachmentId),
      }),
    );
    imageJobService = new ImageJobService({
      journal: persistence.journal,
      projection: persistence.imageJobProjection,
      attachments: generatedImageStore,
      readProviderInstance: (id) => persistence.readProviderInstance(id),
      credentialResolver:
        credentialResolver ??
        ({
          has: async () => false,
          resolve: async () => "",
        } as const),
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
      actor: { kind: "system", actorId: OCTANT_LOCAL_ACTOR_ID },
    });
    yield* Effect.promise(() => imageJobService.reconcileInterruptedRunningJobs());
    yield* Effect.promise(() => chatService.recoverPendingDeletions());
    const linkedThreadService = createLinkedThreadRuntime({
      actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
      chat: chatService,
      readChatThreadView: (threadId) => {
        try {
          return chatService.read(threadId);
        } catch {
          return undefined;
        }
      },
    });
    const linkedThreadRoutes = createLinkedThreadRouteHandler({
      service: linkedThreadService,
      windowAuthorityStore,
      maxJsonBodySize: MAX_JSON_REQUEST_BODY_SIZE,
    });
    const chatRoutes = createChatRouteHandler({
      service: chatService,
      windowAuthorityStore,
      maxJsonBodySize: MAX_JSON_REQUEST_BODY_SIZE,
      maxAttachmentBodySize: MAX_CHAT_ATTACHMENT_BYTES,
      waitForThreadChange: (signal) => machineChangeFeed.waitFor("chat-navigation", signal),
    });
    // Checkpoints span Chat and Code, so the service owns only the marker and
    // delegates every thread it produces to the mode that owns the authority
    // for it: Chat branches, Code creates a managed-worktree thread.
    const threadCheckpointService = new ThreadCheckpointService({
      journal: persistence.journal,
      readCheckpoint: (checkpointId) => persistence.readThreadCheckpoint(checkpointId),
      readCheckpoints: (threadId) => persistence.readThreadCheckpoints(threadId),
      canAccess: async (_windowId, projectId) => {
        if (projectId === undefined) return true;
        try {
          return persistence.readProject(decodeProjectId(projectId))?.lifecycle === "active";
        } catch {
          return false;
        }
      },
      chat: createCheckpointChatPort({
        readChatThread: (threadId) => persistence.readChatThread(threadId),
        readChatThreadView: (threadId) => persistence.readChatThreadView(threadId),
        readProject: (projectId) => persistence.readProject(projectId),
        execute: (command) => chatService.execute(command),
      }),
      code: createCheckpointCodePort({
        readCodeThread: (threadId) => persistence.readCodeThread(threadId),
        readProject: (projectId) => persistence.readProject(projectId),
        readOperationStart: (operationId) =>
          persistence.journal.replayAggregate({
            aggregateType: "code-operation",
            aggregateId: String(operationId),
            afterVersion: 0,
            limit: 1,
          })[0],
        execute: (windowId, command) => codeService.execute(windowId, command),
        uuid: randomUUID,
        clock: () => new Date().toISOString(),
      }),
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
      actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
    });
    const threadCheckpointRoutes = createThreadCheckpointRouteHandler({
      checkpoints: threadCheckpointService,
      windowAuthorityStore,
    });
    const scaffoldRoutes = createScaffoldRouteHandler({
      entries: CURATED_SCAFFOLDS,
      availableTools: () => resolveAvailableTools(curatedScaffoldTools()),
      windowAuthorityStore,
    });
    const workspacePresetRoutes = createWorkspacePresetRouteHandler(
      {
        presets: CURATED_WORKSPACE_PRESETS,
        windowAuthorityStore,
        // The thread and the pane both come from the window's own workspace,
        // never from the request, so a preset lands on a thread this window
        // already has open rather than one the caller merely named.
        resolveTarget: async (windowId, threadId) => {
          const found = findWorkspacePresetTarget(
            shellService.bootstrap(windowId).workspace.layouts.code,
            threadId,
          );
          return found === undefined
            ? undefined
            : {
                paneId: found.paneId,
                mentionableThreadId: decodeMentionableThreadId(String(threadId)),
                title: found.title,
              };
        },
        applyOperations: async (windowId, operations) => {
          let version = shellService.bootstrap(windowId).workspaceVersion;
          for (const operation of operations) {
            const result = shellService.execute({
              kind: "apply-workspace-operation",
              windowId,
              expectedVersion: version,
              operation,
            });
            if (result.kind !== "workspace-replaced") break;
            version = result.version;
          }
          return version;
        },
        // What the thread's own catalog leaves it able to use. A preset reads
        // this and reports; it never writes activation.
        resolveSkills: async (windowId, threadId) => {
          const thread = persistence.readCodeThread(threadId);
          const scoped = filterSkillCatalogForScope(skillDiscoveryService.snapshot(), {
            mode: "code",
            projectId: thread === undefined ? null : String(thread.projectId),
            threadRef: String(threadId),
          });
          return scoped.skills.map((record) => ({
            name: String(record.skill.name),
            enabled: record.effectiveState.kind === "effective",
          }));
        },
      },
      {
        mintTabId: () => decodeWorkspaceTabId(randomUUID()),
        mintPaneId: () => decodePaneId(randomUUID()),
        mintNodeId: () => decodeLayoutNodeId(randomUUID()),
      },
    );
    const workArtifactProjection = new WorkArtifactProjection();
    requireJournalHydration(
      hydrateWorkArtifactProjectionFromJournal({
        replay: (cursor) =>
          persistence.journal.replayAggregateType({
            ...Schema.decodeUnknownSync(ReplayCursor)({
              afterSequence: cursor.afterSequence,
              limit: cursor.limit,
            }),
            aggregateType: cursor.aggregateType ?? "work-artifact",
          }),
        projection: workArtifactProjection,
      }),
      "Work artifact",
    );
    const workTurnProjection = new WorkTurnProjection();
    requireJournalHydration(
      hydrateWorkTurnProjectionFromJournal({
        replay: (cursor) =>
          persistence.journal.replayAggregateType({
            ...Schema.decodeUnknownSync(ReplayCursor)({
              afterSequence: cursor.afterSequence,
              limit: cursor.limit,
            }),
            aggregateType: cursor.aggregateType ?? "work-turn",
          }),
        projection: workTurnProjection,
      }),
      "Work turn",
    );
    workTurnProjection.markInterruptedOnRestart(new Date().toISOString());
    // Bound after Work request and agent-run ports exist; until then bootstrap
    // reports no executing threads rather than inventing a second run source.
    let observeWorkThreadRuntime:
      | ((threadId: WorkThreadId) => WorkBoardRuntimeActivity)
      | undefined;
    const workThreadService = new WorkThreadService({
      persistence,
      projects: projectService,
      projection: workThreadProjection,
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
      workingDirectories: { resolve: resolveThreadWorkingDirectory },
      onWorkingDirectoryChanged: async () => refreshStandaloneSkills(),
      probeProvider: (providerInstanceId) => probeProviderForThreads(providerInstanceId),
      observeRuntime: (threadId) => observeWorkThreadRuntime?.(threadId) ?? { executing: false },
      issueContext: githubIssueContextService,
      linearIssueContext: linearIssueContextService,
    });
    const workTurnService = new WorkTurnService({
      persistence,
      resolveAppManagedTools: (input) => nativeHarnessComposition?.forWork(input),
      nativeHarness: nativeHarnessHooks,
      turnFileObserver: new WorkTurnFileObserver(),
      threads: workThreadService,
      peekIssueContextFramed: peekCreateFromIssueFramed,
      consumeIssueContextFramed: consumeCreateFromIssueFramed,
      projects: projectService,
      projection: workTurnProjection,
      workingDirectories: { resolve: resolveThreadWorkingDirectory },
      resolveDriver: (providerInstanceId) => {
        const instance = persistence.readProviderInstance(providerInstanceId);
        if (instance === undefined) return undefined;
        return attachWorkRequestRuntime(
          makeConfiguredProviderDriver(instance, configuredDriverOptions),
          () => workRequestRuntime,
        );
      },
      attachments: workAttachments,
      supportsAttachments: (thread) => {
        const observed = providerRuntimeRegistry.observedState(thread.providerInstanceId);
        if (observed?.capabilities.nativeAttachments !== "supported") return false;
        return observed.models.some(
          (model) =>
            String(model.id) === String(thread.modelId) && model.inputModalities.includes("image"),
        );
      },
      resolveThreadMentionContext: async ({ threadMentionIds, windowId }) => {
        const resolved = await threadMentionContextResolver(() => threadMentionService)({
          threadMentionIds,
          windowId,
        });
        return resolved.map((mention) => ({
          kind: "user-message" as const,
          text: mention.kind === "resolved" ? mention.text : THREAD_MENTION_UNREADABLE_CONTEXT,
        }));
      },
      resolveFileMentionContext: async ({ fileMentionPaths, windowId, threadId }) =>
        fileMentionContextBlocks(fileMentionService, {
          windowId,
          scope: { mode: "work", threadId },
          paths: fileMentionPaths,
        }),
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
    });
    const fileMentionService = new FileMentionService({
      authority: {
        resolveCodeRoot: async (windowId, threadId, checkoutId) => {
          try {
            const view = await codeService.read(windowId, decodeCodeThreadId(threadId));
            if (String(view.checkout.id) !== checkoutId) return { kind: "unauthorized" };
            const rooted = await roots.resolve(
              windowId,
              view.thread,
              view.checkout,
              codeWorkingDirectoryProbePath,
            );
            if (rooted !== undefined) {
              return {
                kind: "ok",
                rootPath: rooted.rootPath,
                rootIdentity: rooted.rootIdentity,
              };
            }
            // ADR 0017: a Code Project may bind a non-Git folder. Mention
            // confinement follows the authorized checkout directory rather
            // than requiring a Git observation.
            const project = persistence.readProject(view.thread.projectId);
            const revision = project?.type === "code" ? project.bindingHistory.at(-1) : undefined;
            if (
              project?.type !== "code" ||
              project.lifecycle !== "active" ||
              revision?.revisionId !== view.thread.bindingRevisionId
            ) {
              return { kind: "unauthorized" };
            }
            let rootPath: string;
            if (view.checkout.kind === "existing-worktree") {
              rootPath = project.binding.canonicalRoot;
            } else {
              const receipt = await managedWorktreeReceipts.load(view.checkout.ownershipReceiptId);
              if (
                receipt === undefined ||
                receipt.state !== "ready" ||
                receipt.canonicalWorktreePath === undefined
              ) {
                return { kind: "unavailable" };
              }
              rootPath = receipt.canonicalWorktreePath;
            }
            const metadata = await lstat(rootPath, { bigint: true });
            if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
              return { kind: "unavailable" };
            }
            return {
              kind: "ok",
              rootPath,
              rootIdentity: {
                device: metadata.dev.toString(10),
                inode: metadata.ino.toString(10),
              },
            };
          } catch {
            return { kind: "unauthorized" };
          }
        },
        resolveWorkRoot: async (windowId, threadId) => {
          try {
            const bootstrap = await workThreadService.bootstrap(windowId);
            const thread = bootstrap.threads.find((candidate) => String(candidate.id) === threadId);
            if (thread === undefined) return { kind: "not-found" };
            const project = persistence.readProject(thread.projectId);
            if (
              project === undefined ||
              project.type !== "work" ||
              project.lifecycle !== "active"
            ) {
              return { kind: "unauthorized" };
            }
            const latest = project.bindingHistory.at(-1);
            if (
              thread.bindingRevisionId === undefined ||
              latest === undefined ||
              String(thread.bindingRevisionId) !== String(latest.revisionId)
            ) {
              return { kind: "unauthorized" };
            }
            return pinFileMentionRoot(project.binding.canonicalRoot);
          } catch {
            return { kind: "unavailable" };
          }
        },
      },
    });
    const fileMentionRoutes = createFileMentionRouteHandler({
      service: fileMentionService,
      windowAuthorityStore,
      maxJsonBodySize: MAX_JSON_REQUEST_BODY_SIZE,
    });
    const threadExportService = new ThreadExportService({
      hostId: LOCAL_HOST_ID,
      clock: () => new Date().toISOString(),
      chat: {
        read: (threadId) => {
          try {
            return chatService.read(decodeChatThreadId(threadId));
          } catch {
            return undefined;
          }
        },
      },
      work: {
        read: async (windowId, threadId) => {
          try {
            const id = decodeWorkThreadId(threadId);
            const transcript = await workTurnService.transcript(windowId, id);
            const bootstrap = await workThreadService.bootstrap(windowId);
            const thread = bootstrap.threads.find((candidate) => String(candidate.id) === threadId);
            if (thread === undefined) return undefined;
            return { thread, turns: transcript.turns };
          } catch {
            return undefined;
          }
        },
      },
      code: {
        readThread: async (windowId, threadId) => {
          try {
            const view = await routeCodeService.read(windowId, decodeCodeThreadId(threadId));
            return {
              threadId: String(view.thread.id),
              title: view.thread.title,
              projectId: view.thread.projectId,
              version: view.thread.version,
              lastSequence: view.lastSequence,
              providerInstanceId: view.thread.providerInstanceId,
              modelId: view.thread.modelId,
              createdAt: view.thread.createdAt,
              updatedAt: view.thread.updatedAt,
              ...(view.thread.forkedFrom === undefined
                ? {}
                : { forkedFrom: { threadId: String(view.thread.forkedFrom.threadId) } }),
            };
          } catch {
            return undefined;
          }
        },
        conversation: async (windowId, threadId, afterCursor, limit) => {
          const read = routeCodeService.conversation;
          if (read === undefined) throw new Error("Code conversation is unavailable.");
          return await read(windowId, threadId, afterCursor, limit);
        },
        readEvidence: async (windowId, threadId, operationId, contentId) => {
          const read = routeCodeService.readOperationContent;
          if (read === undefined) throw new Error("Code operation evidence is unavailable.");
          return await read(windowId, threadId, operationId, contentId);
        },
      },
      canvases: persistence.canvasProjection,
      generatedImages: {
        listByScope: (scopeId) => imageJobService.listByScope(scopeId),
      },
    });
    const threadExportRoutes = createThreadExportRouteHandler({
      service: threadExportService,
      windowAuthorityStore,
    });
    // Work workflow projection: a downstream side channel driven by
    // already-authorized Work thread lifecycle facts, never an independent
    // authority source. `withWorkflowLifecycle` wraps the thread route
    // service so every successful create/lifecycle-change also feeds the
    // rebuildable workflow projection Overview reads from.
    // A goal loop keeps working on a Work thread's goal without a person
    // watching. It runs ordinary Work turns through the same service a person's
    // turn goes through, so it adds no place work happens and no authority the
    // thread did not already have; everything it may or may not do is decided
    // by the domain and journaled here.
    // What a Work turn is fixed at, stated once. Work denies shell, Git, and
    // reach outside the Project by construction rather than by asking, so this
    // is a fact about the mode and not a grant anyone can change.
    const WORK_TURN_POSTURE = {
      filesystem: true,
      shell: false,
      git: false,
      network: false,
      tools: true,
      subagents: false,
      executionPolicy: "approval-gated",
      permissionPersistence: "current-session",
    } as const;
    /** Any registered local window; the ordinary turn path rechecks Project access. */
    const firstRegisteredWindowId = (): WindowId | undefined => {
      for (const windowId of windowAuthorityStore.listWindowIds()) return windowId;
      return undefined;
    };
    const goalLoopEvents = new GoalLoopEventStore({
      journal: persistence.journal,
      uuid: randomUUID,
      clock: () => new Date().toISOString() as never,
      actor: { kind: "system", actorId: OCTANT_LOCAL_ACTOR_ID },
    });
    const goalLoopService = new GoalLoopService({
      readGoal: (threadId) => goalService.read(threadId).goal,
      recordUsage: async ({ threadId, goal, tokensSpent, elapsedMs, evidence, complete }) => {
        const recorded = await goalService.execute({
          kind: "record-thread-goal-usage",
          threadId,
          expectedVersion: goal.version,
          goalId: goal.id,
          deltaTokens: tokensSpent,
          deltaElapsedMs: elapsedMs,
          deltaTurns: 1,
        });
        if (!complete) return;
        await goalService.execute({
          kind: "complete-thread-goal",
          threadId,
          expectedVersion: recorded.goal.version,
          goalId: goal.id,
          evidence: evidence.slice(0, 16),
        });
      },
      threadAuthority: (threadId) => {
        let thread;
        try {
          thread = workThreadProjection.read(threadId as never);
        } catch {
          return undefined;
        }
        if (thread === undefined || thread.lifecycle !== "active") return undefined;
        return WORK_TURN_POSTURE;
      },
      // What a Work turn is fixed at. There is no per-turn grant to narrow, so
      // a ceiling asking for less than this is refused when the loop starts
      // rather than quietly ignored on every round.
      modePosture: () => WORK_TURN_POSTURE,
      // Work has no approval queue of its own: its posture denies shell, Git,
      // and reach outside the Project outright rather than asking. Saying so
      // here is honest; inventing a source would make the pause untestable.
      pendingApproval: () => undefined,
      markCheckpoint: async (threadId) => {
        const windowId = firstRegisteredWindowId();
        if (windowId === undefined) return undefined;
        const marked = await threadCheckpointService
          .execute(windowId, {
            kind: "mark-thread-checkpoint",
            threadKind: "work",
            threadId,
            checkpointId: randomUUID(),
            label: "Goal loop round",
          })
          .catch(() => undefined);
        return marked === undefined || marked.kind !== "checkpoint-marked"
          ? undefined
          : String(marked.checkpoint.id);
      },
      runRound: async ({ threadId, objective }) => {
        const windowId = firstRegisteredWindowId();
        const thread = workThreadProjection.read(threadId as never);
        if (windowId === undefined || thread === undefined) {
          return {
            outcome: "failed",
            tokensSpent: 0,
            elapsedMs: 0,
            detail: "No local window is available to run the round.",
          };
        }
        const startedAt = Date.now();
        try {
          await workTurnService.startFirstTurn(windowId, {
            kind: "start-work-thread-turn",
            requestId: randomUUID(),
            threadId,
            turnId: randomUUID(),
            prompt: objective,
            authority: {
              hostId: LOCAL_HOST_ID,
              projectId: thread.projectId,
              bindingRevisionId: thread.bindingRevisionId,
              workingDirectory: ".",
              confinementPosture: "project-root-confined",
              providerInstanceId: thread.providerInstanceId,
              modelId: thread.modelId,
            },
          });
          return { outcome: "ran", tokensSpent: 0, elapsedMs: Date.now() - startedAt };
        } catch (error) {
          return {
            outcome: "failed",
            tokensSpent: 0,
            elapsedMs: Date.now() - startedAt,
            detail: error instanceof Error ? error.message : "The round could not be run.",
          };
        }
      },
      journal: goalLoopEvents,
      uuid: randomUUID,
      clock: () => new Date().toISOString() as never,
    });
    const goalLoopRoutes = createGoalLoopRouteHandler({
      service: goalLoopService,
      windowAuthorityStore,
      authorizeThread: authorizeWorkThreadForWindow,
    });

    const workflowProjection = new WorkflowProjection();
    const workflowEventStore = new WorkflowEventStore({
      journal: persistence.journal,
      uuid: randomUUID,
      actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
    });
    const workflowService = new WorkflowService({
      projection: workflowProjection,
      eventStore: workflowEventStore,
      threads: {
        listFacts: () => workThreadProjection.listLifecycleFacts(),
      },
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
    });
    workflowService.hydrate();
    const workThreadServiceWithWorkflows = withWorkflowLifecycle({
      threads: workThreadService,
      workflows: workflowService,
    });
    nativeHarnessFollowUpCreation.current = {
      chat: chatService,
      work: workThreadServiceWithWorkflows,
      code: codeService,
      readCodeThread: (threadId) => persistence.readCodeThread(threadId),
      readProject: (projectId) => persistence.readProject(projectId),
      hostId: LOCAL_HOST_ID,
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
    };
    const zenThreadCatalog = new ZenThreadCatalog({
      localHostId: LOCAL_HOST_ID,
      localHostDisplayName: localHostDisplayName(),
      readSettings: () => persistence.readShellSettings()?.settings ?? defaultShellSettings(),
      readProjects: (windowId) => projectService.bootstrap(windowId),
      readChatThreads: () => persistence.readChatThreads(),
      readWorkThreads: () => workThreadProjection.list(),
      readCodeThreads: () => persistence.readCodeThreads(),
      readCodeCheckout: (checkoutId) => persistence.readCodeCheckout(checkoutId),
    });
    const zenFocusZones = new ZenFocusZoneStore({
      journal: persistence.journal,
      uuid: randomUUID,
    });
    const zenService = new ZenService({
      loadSpace: (spaceId) => persistence.readZenSpace(spaceId),
      loadSpaceByWindow: (windowId) => persistence.readZenSpaceByWindowId(windowId),
      focusZone: {
        read: (windowId) => zenFocusZones.read(windowId),
        write: (zone) => zenFocusZones.write(zone),
      },
      // Pinning a terminal asks Code whether this window owns it. Without the
      // Code runtime there is nothing to own a shell, so there is nothing to
      // pin and Zen refuses rather than inventing an answer.
      ...(codeOperationRuntime === undefined
        ? {}
        : {
            codeTerminals: {
              read: (windowId, request) => codeOperationRuntime.inspectTerminal(windowId, request),
            },
          }),
      // Pinning a canvas asks Canvas whether this window may read it, the same
      // question the read route asks, so a card and a tab agree about what is
      // reachable instead of each keeping an answer of its own.
      canvases: {
        read: (windowId, canvasId) =>
          readCanvasForWindow(
            {
              canvasProjection: persistence.canvasProjection,
              projects: projectService,
              activeContextResolver: (id) => resolveCanvasActiveContext(shellService.bootstrap(id)),
            },
            windowId,
            canvasId,
          ),
      },
      eventStore: zenEventStore,
      localHostId: LOCAL_HOST_ID,
      threadCatalog: zenThreadCatalog,
      uuid: randomUUID,
      assistantChat: {
        // Zen's assistant is a front on the host's one Navigator conversation,
        // not a conversation of its own. Binding the id the host already owns
        // is what keeps the thread the user converses with and the thread Zen's
        // tools are authorized against the same thread. Resolved lazily because
        // Navigator is composed below.
        create: async () => {
          const threadId = await navigatorAssistantService.ensureConversation();
          try {
            return chatService.read(threadId).thread;
          } catch {
            throw new Error("Navigator conversation is unavailable.");
          }
        },
        read: (threadId) => {
          try {
            return chatService.read(threadId);
          } catch {
            return undefined;
          }
        },
      },
      assistantProviderState: (thread) => {
        const instance = persistence.readProviderInstance(thread.providerInstanceId);
        const observed = providerRuntimeRegistry.observedState(thread.providerInstanceId);
        const model = observed?.models.find(
          (candidate) => String(candidate.id) === String(thread.modelId),
        );
        const verifiedForModel =
          observed?.verifiedToolModelIds?.some(
            (candidate) => String(candidate) === String(thread.modelId),
          ) ?? false;
        const toolCapability =
          observed?.capabilities.appManagedTools === "supported" || verifiedForModel
            ? "supported"
            : (observed?.capabilities.appManagedTools ?? "unavailable");
        return {
          providerInstanceId: thread.providerInstanceId,
          providerLabel: instance?.displayName ?? String(thread.providerInstanceId),
          modelId: thread.modelId,
          modelLabel: model?.displayName ?? String(thread.modelId),
          readiness: observed?.readiness ?? "unavailable",
          toolCapability,
          ...(toolCapability === "supported"
            ? {}
            : {
                toolCapabilityReason:
                  toolCapability === "unsupported"
                    ? "This provider/model does not support app-managed tools. Use the manual Zen controls."
                    : "Tool capability has not been verified. Use the manual Zen controls.",
              }),
        };
      },
    });
    zenAssistantTools = new ZenAssistantTools({ zenService });
    const zenRoutes = createZenRouteHandler({ zenService, windowAuthorityStore });
    // Navigator is the production consumer of the `navigatorAssistant`
    // settings section: the conversation runs on the configured default model
    // through the ordinary Chat commands below, and reports itself
    // unconfigured — never silently re-routed — when no default model is set.
    const navigatorAssistantService = new NavigatorAssistantService({
      localHostId: LOCAL_HOST_ID,
      readSettings: () =>
        (persistence.readShellSettings()?.settings ?? defaultShellSettings()).navigatorAssistant,
      bindings: navigatorAssistantBindings,
      chat: {
        create: async ({ threadId, title }) => {
          const result = await chatService.execute({
            kind: "create-chat-thread",
            hostId: LOCAL_HOST_ID,
            threadId,
            title,
          });
          if (result.kind !== "thread-created") {
            throw new Error("Navigator conversation creation failed.");
          }
        },
        read: (threadId) => {
          try {
            const view = chatService.read(threadId);
            return {
              threadId: view.thread.id,
              version: view.thread.version,
              lifecycle: view.thread.lifecycle,
              providerInstanceId: view.thread.providerInstanceId,
              modelId: view.thread.modelId,
              // The same fold Zen's assistant reads, so the Navigator dock
              // panel and Zen's assistant show one conversation, not two
              // readings of it.
              transcript: assistantTranscript(view),
            };
          } catch {
            return undefined;
          }
        },
        selectModel: async ({ threadId, expectedVersion, providerInstanceId, modelId }) => {
          await chatService.execute({
            kind: "change-chat-provider",
            threadId,
            expectedVersion,
            providerInstanceId,
            modelId,
          });
        },
        send: async ({ threadId, expectedVersion, prompt, windowId }) => {
          await chatService.execute(
            { kind: "send-chat-turn", threadId, expectedVersion, prompt },
            { windowId },
          );
        },
      },
      // Image capability comes from the host's observed provider catalog, the
      // same facts Settings renders; an unobserved model stays `unknown`.
      modelFacts: ({ providerInstanceId, modelId }) =>
        providerRuntimeRegistry
          .observedState(providerInstanceId)
          ?.models.find((candidate) => String(candidate.id) === String(modelId)),
      clock: () => new Date().toISOString(),
    });
    const navigatorAssistantRoutes = createNavigatorAssistantRouteHandler({
      service: navigatorAssistantService,
      windowAuthorityStore,
      // Navigator is host-owned, so there is no thread or Project target to
      // authorize; what must be proven is that the authenticated window is a
      // live workspace of this host. A capability whose window the host no
      // longer tracks cannot open the conversation or spend a provider turn.
      authorizeWindow: ({ windowId }) =>
        persistence.readWindowWorkspace(windowId)?.workspace !== undefined,
    });
    const zenBackgroundRoutes = createZenBackgroundRouteHandler({
      store: new ZenBackgroundStore({ dataDirectory: providerDataDirectory }),
      zenService,
      windowAuthorityStore,
      liveAssets: () =>
        new Map(
          persistence.readZenSpaces().flatMap((space) => {
            if (space.appearance.background.kind !== "image") return [];
            const owner = { ownerWindowId: space.windowId, spaceId: space.spaceId };
            return [
              [String(space.appearance.background.assetId), owner] as const,
              ...(space.appearance.background.stillAssetId === undefined
                ? []
                : [[String(space.appearance.background.stillAssetId), owner] as const]),
            ];
          }),
        ),
    });
    const workTurnRoutes = createWorkTurnRouteHandler({
      service: workTurnService,
      windowAuthorityStore,
      maxJsonBodySize: MAX_JSON_REQUEST_BODY_SIZE,
    });
    const browserAutomationRoutes = createBrowserAutomationRouteHandler({
      service: browserAutomationService,
      authority: browserAuthority,
      windowAuthorityStore,
      maxRequestBodySize: MAX_JSON_REQUEST_BODY_SIZE,
    });
    const previewHostId = derivePreviewHostId(providerDataDirectory);
    const workResolutionService = new WorkResolutionService(liveWorkFilesystem);
    const workMutationEventStore = new WorkMutationEventStore({
      journal: persistence.journal,
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
      actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
    });
    const workMutationService = new WorkMutationService({
      filesystem: liveWorkFilesystem,
      resolution: workResolutionService,
      projection: workArtifactProjection,
      eventStore: workMutationEventStore,
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
      actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
      hostId: previewHostId,
    });
    const workMutationRoutes = createWorkMutationRouteHandler({
      service: workMutationService,
      persistence,
      projects: projectService,
      windowAuthorityStore,
      maxJsonBodySize: MAX_JSON_REQUEST_BODY_SIZE,
    });
    // Minted by the folder listing, read by the preview target resolver. It
    // holds no authority of its own: a resolved path is still confined to the
    // Project root, and the preview route still requires that Project to be the
    // window's active one.
    const workFilePreviewRefs = new WorkFilePreviewRefs({
      hostId: previewHostId,
      uuid: randomUUID,
    });
    const workFileListingRoutes = createWorkFileListingRouteHandler({
      service: new WorkFileListingService({
        filesystem: liveWorkFilesystem,
        previewRefs: workFilePreviewRefs,
        // The same projection the mutation service writes to, so a file the
        // panel calls Work's own is one this host recorded writing.
        artifactsForProject: (projectId) =>
          [...workArtifactProjection.snapshot().values()].filter(
            (entry) => String(entry.projectId) === String(projectId),
          ),
        // A provider writes with its own tools and never calls the mutation
        // service, so the artifact projection alone would show most of a
        // Project's real output as files the folder merely happened to hold.
        // The turns' own observations are the other half of that answer.
        pathsWrittenByTurns: (projectId) =>
          workTurnProjection
            .listForProject(projectId)
            .flatMap((turn) => turn.wroteFiles?.paths ?? []),
      }),
      persistence,
      projects: projectService,
      windowAuthorityStore,
    });
    const speechRoutes = createSpeechRouteHandler({
      readVoiceSettings: () =>
        (persistence.readShellSettings()?.settings ?? defaultShellSettings()).voice,
      listInstances: () => persistence.readProviderInstances(),
      windowAuthorityStore,
      ...(credentialResolver === undefined ? {} : { credentialResolver }),
    });
    const imageRoutes = createImageRouteHandler({
      jobs: imageJobService,
      listInstances: () => persistence.readProviderInstances(),
      authorizeScope: async (windowId, threadKind, scopeId) => {
        const threadId = String(scopeId);
        // The library is host-wide: window capability already proved the
        // caller is a registered window, and the scope id is fixed.
        if (threadKind === "image-library") return threadId === String(IMAGE_LIBRARY_SCOPE_ID);
        try {
          if (threadKind === "chat-thread") {
            const view = chatService.read(decodeChatThreadId(threadId));
            const workspace = persistence.readWindowWorkspace(windowId)?.workspace;
            return chatImageScopeAllowedForWindow({
              chatContext: workspace?.contextByMode.chat,
              thread: view?.thread,
            });
          }
          if (threadKind === "work-thread") {
            const bootstrap = await workThreadService.bootstrap(windowId);
            return bootstrap.threads.some((thread) => String(thread.id) === threadId);
          }
          const view = await routeCodeService.read(windowId, decodeCodeThreadId(threadId));
          return view !== undefined;
        } catch {
          return false;
        }
      },
      saveToProject: async (input) => {
        if (input.threadKind === "chat-thread") {
          return {
            status: "refused",
            reason: "Chat artifacts grant no filesystem authority.",
          } satisfies ImageGenerationSaveResult;
        }
        try {
          let canonicalRoot: string | undefined;
          if (input.threadKind === "work-thread") {
            const bootstrap = await workThreadService.bootstrap(input.windowId);
            const thread = bootstrap.threads.find(
              (candidate) => String(candidate.id) === String(input.scopeId),
            );
            const project =
              thread === undefined ? undefined : persistence.readProject(thread.projectId);
            if (
              project === undefined ||
              project.type !== "work" ||
              project.lifecycle !== "active"
            ) {
              return {
                status: "refused",
                reason: "The Work Project is unavailable.",
              } satisfies ImageGenerationSaveResult;
            }
            canonicalRoot = project.binding.canonicalRoot;
            const relativePath = canonicalizeWorkRelativePath(input.relativePath);
            const resolution = await workResolutionService.resolveForCreate({
              binding: {
                canonicalRoot,
                knownCanonicalRoot: canonicalRoot,
                availability: "available",
                bindingSuperseded: false,
              },
              relativePath,
            });
            if (resolution.status !== "resolved-for-create") {
              return {
                status: "refused",
                reason: "The save path is outside the Project.",
              } satisfies ImageGenerationSaveResult;
            }
            const written = await writeConfinedWorkFile({
              filesystem: liveWorkFilesystem,
              canonicalPath: resolution.absolutePath,
              allowCreate: true,
              parent: {
                absolutePath: resolution.parentAbsolute,
                identity: resolution.parentIdentity,
                remaining: resolution.remaining,
              },
              bytes: input.bytes,
            });
            if (!written) {
              return {
                status: "failed",
                reason: "The image could not be saved.",
              } satisfies ImageGenerationSaveResult;
            }
            return { status: "saved", relativePath: resolution.relativePath };
          }
          const view = await routeCodeService.read(
            input.windowId,
            decodeCodeThreadId(String(input.scopeId)),
          );
          const project = persistence.readProject(view.thread.projectId);
          if (project === undefined || project.type !== "code" || project.lifecycle !== "active") {
            return {
              status: "refused",
              reason: "The Code Project is unavailable.",
            } satisfies ImageGenerationSaveResult;
          }
          canonicalRoot = project.binding.canonicalRoot;
          const relativePath = canonicalizeWorkRelativePath(input.relativePath);
          const resolution = await workResolutionService.resolveForCreate({
            binding: {
              canonicalRoot,
              knownCanonicalRoot: canonicalRoot,
              availability: "available",
              bindingSuperseded: false,
            },
            relativePath,
          });
          if (resolution.status !== "resolved-for-create") {
            return {
              status: "refused",
              reason: "The save path is outside the Project.",
            } satisfies ImageGenerationSaveResult;
          }
          const written = await writeConfinedWorkFile({
            filesystem: liveWorkFilesystem,
            canonicalPath: resolution.absolutePath,
            allowCreate: true,
            parent: {
              absolutePath: resolution.parentAbsolute,
              identity: resolution.parentIdentity,
              remaining: resolution.remaining,
            },
            bytes: input.bytes,
          });
          if (!written) {
            return {
              status: "failed",
              reason: "The image could not be saved.",
            } satisfies ImageGenerationSaveResult;
          }
          return { status: "saved", relativePath: resolution.relativePath };
        } catch {
          return {
            status: "failed",
            reason: "The image could not be saved.",
          } satisfies ImageGenerationSaveResult;
        }
      },
      windowAuthorityStore,
    });
    // Work research. Sources are observed read-only through the
    // confined filesystem port, so a brief can only cite files inside the
    // approved Project root; kinds this host cannot re-read without egress
    // are reported unsupported rather than recorded as fresh.
    const workResearchProjection = new WorkResearchProjection();
    const workResearchService = new WorkResearchService({
      projection: workResearchProjection,
      eventStore: new WorkResearchEventStore({
        journal: persistence.journal,
        uuid: randomUUID,
        actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
      }),
      sources: createWorkResearchSourcePort({
        filesystem: liveWorkFilesystem,
        resolveProjectRoot: (projectId) => {
          const project = persistence.readProject(projectId);
          if (project === undefined || project.type !== "work") return undefined;
          if (project.lifecycle !== "active") return undefined;
          return project.binding.canonicalRoot;
        },
      }),
      actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
      clock: () => new Date().toISOString(),
    });
    // Hydration replays only `work-research` history, so unrelated journal
    // growth cannot abort it. If the research history itself outgrows the scan
    // bound the projection is not a faithful rebuild, so the routes report
    // research unavailable instead of serving a projection that would read as
    // "you have no briefs" and answer mutations on durable briefs as missing.
    const workResearchProjectionRebuilt =
      workResearchService.hydrate().status !== "snapshot-required";
    if (!workResearchProjectionRebuilt) {
      console.warn(
        "Work research projection requires a snapshot; research reports unavailable on this host.",
      );
    }
    const workResearchRoutes = createWorkResearchRouteHandler({
      service: workResearchService,
      projection: workResearchProjection,
      projectionRebuilt: () => workResearchProjectionRebuilt,
      persistence,
      projects: projectService,
      windowAuthorityStore,
      maxJsonBodySize: MAX_JSON_REQUEST_BODY_SIZE,
    });
    const previewService = new PreviewService({
      hostId: previewHostId,
      budget: {
        maxSniffBytes: 4096,
        maxByteSize: 8 * 1024 * 1024,
        maxRenderBytes: 4 * 1024 * 1024,
      },
      textBudget: { maxLinesPerChunk: 200, maxBytesPerChunk: 64 * 1024 },
      targetResolver: {
        async resolve({ projectId, opaqueRef, kind }) {
          // An ordinary file in a Work Project's bound folder, opened from the
          // Files tool. The token was minted by the listing that showed it, so
          // the renderer never names a path; a token this host does not know
          // resolves to nothing rather than to a guess.
          if (kind === "file") {
            const relativePath = workFilePreviewRefs.resolve(projectId, opaqueRef);
            if (relativePath === undefined) return { ok: false, code: "not-found" };
            return { ok: true, relativePath, displayName: relativePath };
          }
          if (kind !== "artifact-version") return { ok: false, code: "not-found" };
          for (const entry of workArtifactProjection.snapshot().values()) {
            if (
              entry.projectId === projectId &&
              entry.artifactRef === opaqueRef &&
              !entry.deleted
            ) {
              return {
                ok: true,
                relativePath: entry.relativePath,
                displayName: entry.displayName,
              };
            }
          }
          return { ok: false, code: "not-found" };
        },
      },
      projectRootResolver: {
        async resolve(id) {
          const project = persistence.readProject(id);
          if (project === undefined || project.type === "chat" || project.lifecycle !== "active") {
            return { ok: false, code: "unavailable" };
          }
          return { ok: true, canonicalRoot: project.binding.canonicalRoot };
        },
      },
    });
    const previewRouteDependencies = {
      service: previewService,
      windowAuthorityStore,
      projects: projectService,
      activeContextResolver: (windowId: WindowId) =>
        resolvePreviewActiveContext(shellService.bootstrap(windowId)),
      // Plan mode is a Code-thread execution policy: hide and server-enforce
      // every host handoff flag for plan-mode threads so Finder reveal,
      // Quick Look, and open-external can never be commanded from a read-only
      // thread even when a renderer capability flag slipped through.
      postureResolver: (windowId: WindowId, _projectId: ProjectId): PreviewPosture => {
        const activeContext = resolvePreviewActiveContext(shellService.bootstrap(windowId));
        if (activeContext.mode !== "code" || activeContext.activeThreadId === undefined) {
          return "approval-gated";
        }
        const thread = persistence.readCodeThread(activeContext.activeThreadId);
        if (thread === undefined) return "approval-gated";
        if (thread.executionPolicy === "plan") return "plan";
        if (thread.executionPolicy === "full-access") return "full";
        return "approval-gated";
      },
      hostId: previewHostId,
      maxJsonBodySize: MAX_JSON_REQUEST_BODY_SIZE,
    };
    const previewRoutes = createPreviewRouteHandler(previewRouteDependencies);
    const previewHandoffBridgeRoutes = createPreviewHandoffBridgeRouteHandler({
      desktopBridgeSecret: options.desktopBridgeSecret,
      resolve: async ({ windowId, target, kind, signal }) => {
        const authority = await resolvePreviewAuthority(previewRouteDependencies, windowId, target);
        if (authority.kind !== "ok") {
          return { kind: "unauthorized", targetId: target.targetId };
        }
        // The desktop bridge is always the local host, but the handoff still
        // re-runs the full preview authority (mode/Project/thread/posture) and
        // resolves the opaque ref to the confined path before the native
        // executor touches the filesystem.
        return previewService.handoff({
          authority: authority.context,
          principalKind: "local-window",
          target,
          kind,
          ...(signal === undefined ? {} : { signal }),
        });
      },
    });
    const canvasEventStore = new CanvasEventStore({
      journal: persistence.journal,
      uuid: randomUUID,
      actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
    });
    // One server-owned Canvas authority, shared by every Canvas mutation
    // including sharing, so a share can never be admitted under weaker checks
    // than a revise or a refresh.
    const authorizeCanvas: CanvasServiceDependencies["authorize"] = (entry, context, project) => {
      if (context.projectId === null || project === undefined || project.lifecycle !== "active") {
        return false;
      }
      const provenance = entry.currentVersion.definition.provenance;
      let activeProjectId: ProjectId;
      try {
        activeProjectId = decodeProjectId(context.projectId);
      } catch {
        return false;
      }
      return (
        authorizeCanvasInventoryAccess({
          requestedProjectId: provenance.projectId,
          activeProjectId,
          activeMode: context.mode,
          projectMode: project.type,
        }) && provenance.mode === project.type
      );
    };
    // Resolved from the Canvas's own provenance and durable host state, so
    // the scope a client echoes is never the scope that authorizes it.
    // Takes only what it reads, so a caller that has a thread but no full
    // provenance — a hand-off, for one — derives its scope the same way
    // rather than building a parallel one.
    const resolveCanvasWorkspace = (provenance: {
      readonly mode: OctantMode;
      readonly threadId: string;
    }): import("@octant/contracts/canvas-cards").CanvasWorkspaceScope | undefined => {
      if (provenance.mode === "chat") {
        const thread = persistence.readChatThread(provenance.threadId as never);
        if (thread === undefined || thread.lifecycle !== "active") return undefined;
        return { kind: "chat-virtual", projectId: null };
      }
      if (provenance.mode === "work") {
        const thread = workThreadProjection.read(provenance.threadId as never);
        const project =
          thread === undefined ? undefined : persistence.readProject(thread.projectId);
        const revision = project?.type === "work" ? project.bindingHistory.at(-1) : undefined;
        if (
          thread === undefined ||
          thread.lifecycle !== "active" ||
          revision === undefined ||
          String(thread.bindingRevisionId) !== String(revision.revisionId)
        ) {
          return undefined;
        }
        return {
          kind: "work-root",
          projectId: thread.projectId,
          rootId: Schema.decodeUnknownSync(ThreadCreationRootId)(revision.revisionId),
        };
      }
      const thread = persistence.readCodeThread(provenance.threadId as never);
      if (thread === undefined || thread.lifecycle !== "active") return undefined;
      const project = persistence.readProject(thread.projectId);
      const revision = project?.type === "code" ? project.bindingHistory.at(-1) : undefined;
      const checkout = persistence.readCodeCheckout(thread.checkoutId);
      if (
        project?.type !== "code" ||
        project.lifecycle !== "active" ||
        revision === undefined ||
        String(revision.revisionId) !== String(thread.bindingRevisionId) ||
        checkout === undefined ||
        checkout.availability !== "available"
      ) {
        return undefined;
      }
      return {
        kind: "code-worktree",
        projectId: thread.projectId,
        repositoryId: thread.repositoryId,
        bindingRevisionId: thread.bindingRevisionId,
        checkoutId: thread.checkoutId,
        verified: true,
      };
    };

    const artifactMirrorEvents = new ArtifactMirrorEventStore({
      journal: persistence.journal,
      uuid: randomUUID,
      clock: () => new Date().toISOString() as never,
      actor: { kind: "system", actorId: OCTANT_LOCAL_ACTOR_ID },
    });
    // The mirror listens for committed versions rather than being called by
    // each surface that can revise, so every revision materializes the same way
    // wherever it came from. It is constructed before the service it listens to
    // so the hook below can name it.
    const artifactMirrorService = new ArtifactMirrorService({
      files: createArtifactMirrorFilePort(),
      currentVersion: (canvasId) => persistence.canvasProjection.getById(canvasId)?.currentVersion,
      projects: {
        read: (projectId: string) => {
          const project = persistence
            .readProjects()
            .find((candidate) => String(candidate.id) === projectId);
          if (project === undefined) return undefined;
          return {
            name: project.name,
            ...(project.type === "chat" ? {} : { checkoutRoot: project.binding.canonicalRoot }),
          };
        },
      },
      // A folder the person picked is theirs to pick, but only inside their own
      // home: anywhere else needs the access-outside-project grant, which has no
      // surface yet, so it fails closed rather than being assumed.
      outsideRootApproved: (destination) =>
        destination.kind !== "global-folder" ||
        isInsideHomeDirectory(destination.canonicalRoot, homedir()),
      // Read-only is a promise about the disk as well as the journal, so a
      // Code thread under Plan mode writes no files. Only Code carries an
      // execution policy; Chat and Work threads have no read-only posture to
      // read here.
      planMode: (version) => {
        const provenance = version.definition.provenance;
        if (provenance.mode !== "code") return false;
        return persistence.readCodeThread(provenance.threadId)?.executionPolicy === "plan";
      },
      // Taking an edited file back in goes through `revise` — the same path a
      // person or an agent takes — so it is authorized, journaled, and counted
      // as a version like any other. Nothing here can replace a version.
      appendVersionFromBundle: ({ canvasId, definition }) => {
        const entry = persistence.canvasProjection.getById(canvasId);
        if (entry === undefined) {
          return { kind: "denied", message: "That artifact is no longer available." };
        }
        let blocks;
        try {
          blocks = decodeCanvasDefinition(definition).blocks;
        } catch {
          return { kind: "denied", message: "The file is not a readable artifact bundle." };
        }
        const current = entry.currentVersion;
        const provenance = current.definition.provenance;
        const workspace = resolveCanvasWorkspace(provenance);
        if (workspace === undefined) {
          return {
            kind: "denied",
            message: "The Project or thread this artifact belongs to is no longer available.",
          };
        }
        const project = persistence.readProject(provenance.projectId);
        const result = canvasService.revise(
          {
            schemaVersion: 1,
            kind: "canvas-revise",
            requestId: randomUUID(),
            canvasId,
            expectedSequence: current.sequence,
            hostId: LOCAL_HOST_ID,
            mode: provenance.mode,
            workspace,
            originThreadId: provenance.threadId,
            prompt: "Re-imported from the mirrored file.",
            actor: { kind: "system", actorId: OCTANT_LOCAL_ACTOR_ID },
            providerInstanceId: provenance.providerInstanceId,
            modelId: provenance.modelId,
            requestedAuthority: {
              filesystem: false,
              shell: false,
              git: false,
              network: false,
              tools: false,
              subagents: false,
              executionPolicy: "plan",
              permissionPersistence: "current-session",
            },
          },
          {
            mode: provenance.mode,
            projectId: String(provenance.projectId),
            hostId: String(LOCAL_HOST_ID),
            workspace,
            originThreadId: String(provenance.threadId),
          },
          project === undefined
            ? undefined
            : { id: String(project.id), type: project.type, lifecycle: project.lifecycle },
          blocks,
        );
        return result.kind === "accepted"
          ? { kind: "accepted", versionId: String(result.receipt.versionId) }
          : { kind: "denied", message: result.message };
      },
      // Auto-commit is off unless the person turned it on, and even then it
      // commits only what the mirror wrote. Its Git service is this host's own
      // rather than the Code runtime's: the commit is authorized against the
      // index as it stands at that moment, so anything staged underneath
      // refuses the commit rather than joining it.
      commitMirroredFiles: createArtifactMirrorCommitPort(
        new GitService(new GitObservationPort(), new GitMutationPort()),
      ),
      journal: artifactMirrorEvents,
      clock: () => new Date().toISOString() as never,
    });

    const canvasService = new CanvasService(
      {
        projection: persistence.canvasProjection,
        eventStore: canvasEventStore,
        uuid: randomUUID,
        clock: () => new Date().toISOString() as never,
        onVersionCommitted: (version) => {
          void artifactMirrorService.materialize(version);
        },
      },
      {
        // Reauthorize every source against authoritative server state; the
        // resolver fails closed (missing/revoked/offline/unauthorized/failed)
        // when a source is gone, deleted, offline, or not refreshable.
        refreshSource: createCanvasRefreshSourceResolver({
          clock: () => new Date().toISOString() as never,
          artifactState: (projectId, opaqueRef) => {
            for (const entry of workArtifactProjection.snapshot().values()) {
              if (String(entry.projectId) === projectId && entry.artifactRef === opaqueRef) {
                return {
                  displayName: entry.displayName,
                  relativePath: entry.relativePath,
                  contentSha256: entry.currentSourceVersion.contentSha256,
                  deleted: entry.deleted,
                };
              }
            }
            return undefined;
          },
          threadState: (projectId, threadId, mode) => {
            if (mode === "chat") {
              const thread = persistence.readChatThread(threadId as never);
              if (thread === undefined || String(thread.projectId) !== projectId) return undefined;
              return {
                title: thread.title,
                updatedAt: thread.updatedAt,
                lifecycle: thread.lifecycle,
              };
            }
            if (mode === "code") {
              const thread = persistence.readCodeThread(threadId as never);
              if (thread === undefined || String(thread.projectId) !== projectId) return undefined;
              return {
                title: thread.title,
                updatedAt: thread.updatedAt,
                lifecycle: thread.lifecycle,
              };
            }
            const thread = workThreadProjection.read(threadId as never);
            if (thread === undefined || String(thread.projectId) !== projectId) return undefined;
            return {
              title: thread.title,
              updatedAt: thread.updatedAt,
              lifecycle: thread.lifecycle,
            };
          },
          fileState: {
            resolve: async (projectId, opaqueRef, request) => {
              const project = persistence.readProject(projectId as never);
              if (project === undefined || project.lifecycle !== "active") {
                return undefined;
              }
              if (project.type === "chat") {
                const thread = persistence.readChatThread(request.originThreadId as never);
                if (
                  thread === undefined ||
                  thread.lifecycle !== "active" ||
                  thread.projectId === undefined ||
                  String(thread.projectId) !== projectId
                ) {
                  return undefined;
                }
                const view = persistence.readChatThreadView(thread.id);
                const source = request.recipe.sourceManifest.find(
                  (entry) => String(entry.opaqueRef) === opaqueRef,
                );
                if (
                  request.mode !== "chat" ||
                  (source?.kind !== "attachment" && source?.kind !== "image")
                ) {
                  return undefined;
                }
                const attachment = view?.attachments.find(
                  (candidate) =>
                    String(candidate.id) === opaqueRef &&
                    String(candidate.threadId) === String(thread.id) &&
                    candidate.status === "finalized",
                );
                if (attachment === undefined) return undefined;
                const attachmentPath = join(
                  chatDataDirectory,
                  "threads",
                  String(request.originThreadId),
                  String(attachment.id),
                  "finalized.bin",
                );
                return await resolveCanvasRefreshFile(liveWorkFilesystem, {
                  absolutePath: attachmentPath,
                  displayName: attachment.displayName,
                  relativePath: String(attachment.id),
                  expectedDigest: attachment.digest,
                  expectedByteLength: attachment.byteLength,
                });
              }
              if (project.type === "code") {
                const thread = persistence.readCodeThread(request.originThreadId as never);
                if (
                  thread === undefined ||
                  String(thread.projectId) !== projectId ||
                  thread.lifecycle !== "active"
                ) {
                  return undefined;
                }
                const reference = persistence
                  .readCodeFileReferences(thread.id)
                  .find((candidate) => String(candidate.id) === opaqueRef);
                if (
                  reference === undefined ||
                  reference.relativePath === undefined ||
                  (reference.state !== "available" &&
                    reference.state !== "read-only" &&
                    reference.state !== "completed")
                )
                  return undefined;
                let checkoutRoot = project.binding.canonicalRoot;
                const checkout = persistence.readCodeCheckout(thread.checkoutId);
                if (checkout === undefined) return undefined;
                if (checkout?.kind === "managed-worktree") {
                  const receipt = await managedWorktreeReceipts.load(
                    String(checkout.ownershipReceiptId),
                  );
                  if (
                    receipt === undefined ||
                    receipt.state !== "ready" ||
                    receipt.receiptId !== checkout.ownershipReceiptId ||
                    receipt.threadId !== thread.id ||
                    receipt.checkoutId !== checkout.id ||
                    receipt.repositoryId !== thread.repositoryId ||
                    receipt.repositoryId !== checkout.repositoryId ||
                    receipt.canonicalRepositoryPath !== project.binding.canonicalRoot
                  ) {
                    return undefined;
                  }
                  checkoutRoot = receipt.canonicalWorktreePath;
                } else if (checkout.kind !== "existing-worktree") {
                  return undefined;
                }
                const resolved = resolveConfinedPath(checkoutRoot, reference.relativePath);
                if (!resolved.ok) return undefined;
                return await resolveCanvasRefreshFile(liveWorkFilesystem, {
                  absolutePath: resolved.absolutePath,
                  displayName: reference.relativePath,
                  relativePath: reference.relativePath,
                });
              }
              for (const entry of workArtifactProjection.snapshot().values()) {
                if (
                  String(entry.projectId) === projectId &&
                  entry.artifactRef === opaqueRef &&
                  !entry.deleted
                ) {
                  const resolved = resolveConfinedPath(
                    project.binding.canonicalRoot,
                    entry.relativePath,
                  );
                  if (!resolved.ok) return undefined;
                  return await resolveCanvasRefreshFile(liveWorkFilesystem, {
                    absolutePath: resolved.absolutePath,
                    displayName: entry.displayName,
                    relativePath: entry.relativePath,
                  });
                }
              }
              return undefined;
            },
            read: async (file) =>
              await readCanvasRefreshFile({
                filesystem: liveWorkFilesystem,
                file,
                maxBytes: Math.max(MAX_CHAT_ATTACHMENT_BYTES, MAX_CODE_FILE_BODY_SIZE),
              }),
          },
          providerObserved: (providerInstanceId, modelId) => {
            const observed = providerRuntimeRegistry.observedState(providerInstanceId as never);
            return (
              observed?.readiness === "ready" &&
              observed.models.some((model) => String(model.id) === modelId)
            );
          },
        }),
        // The Canvas's only source of authorized skill identity. A renderer
        // cannot mint a digest-pinned qualifiedId, so the host publishes the
        // skills already trusted, enabled, effective, and in scope for this
        // Canvas. Every option here is one `skillAuthorized` below would
        // admit — it is offered, not granted, and the refresh re-checks it.
        listRefreshSkills: (provenance, workspace) => {
          const scopeContext = {
            mode: provenance.mode,
            workspace,
            originThreadId: provenance.threadId,
          };
          return (extensionApiService.snapshot().skills ?? [])
            .filter(
              (record) =>
                record.desiredEnabled &&
                record.effectiveState.kind === "effective" &&
                // The record's own scope is what a client would echo back, so
                // the eligibility test is the admission test run against it.
                sameCanvasSkillScope(record.scope, record.scope, scopeContext),
            )
            .map((record) => ({
              skill: {
                qualifiedId: record.skill.qualifiedId,
                ...(record.version === undefined ? {} : { version: record.version }),
                ...(record.scope === undefined ? {} : { scope: record.scope }),
              },
              displayName: record.displayName,
            }))
            .slice(0, CANVAS_REFRESH_MAX_SKILL_OPTIONS);
        },
        skillAuthorized: (skill, request) => {
          const record = extensionApiService
            .snapshot()
            .skills?.find(
              (candidate) => String(candidate.skill.qualifiedId) === String(skill.qualifiedId),
            );
          return (
            record !== undefined &&
            record.desiredEnabled &&
            record.effectiveState.kind === "effective" &&
            (record.version === undefined ||
              skill.version === undefined ||
              String(record.version) === String(skill.version)) &&
            sameCanvasSkillScope(record.scope, skill.scope, request)
          );
        },
        // Resolve trusted skill layout/presentation contributions during
        // refresh on the real production path. The authoritative skill record
        // supplies the trust/enablement facts, and the published contribution
        // document (carried on the reconciled record) is re-validated at this
        // trust boundary before the pure admission policy admits or denies it.
        // A denied contribution fails the refresh closed and a contribution
        // never grants authority beyond the reauthorized sources. Skills that
        // do not yet publish parsed Canvas contribution content simply carry no
        // document, so the trusted skill contributes no layouts and the C2
        // skill gate above still applies.
        resolveSkillContribution: createCanvasSkillContributionResolver({
          lookup: createCanvasSkillContributionLookup({
            findSkillRecord: (skill, request) => {
              const record = extensionApiService
                .snapshot()
                .skills?.find(
                  (candidate) => String(candidate.skill.qualifiedId) === String(skill.qualifiedId),
                );
              if (
                record === undefined ||
                !sameCanvasSkillScope(record.scope, skill.scope, request)
              ) {
                return undefined;
              }
              return record;
            },
            readContributionDocument: (record) => record.canvasContribution,
          }),
        }),
        parameterAuthorized: (parameter, request, currentDefinition) => {
          if (!parameter.value.startsWith("ref:")) return false;
          const reference = parameter.value.slice("ref:".length);
          const allowed = new Set([
            String(request.canvasId),
            String(request.originThreadId),
            ...currentDefinition.sourceManifest.map((source) => String(source.sourceId)),
          ]);
          return allowed.has(reference);
        },
        resolveWorkspace: resolveCanvasWorkspace,
        authorize: authorizeCanvas,
      },
    );
    // What a Chat thread's agent may do with a Canvas: write blocks into one,
    // through the same service and the same Project the person clicking New
    // Canvas reaches. The Project and workspace are resolved from the window
    // here, never taken from the agent.
    canvasAgentToolPort = {
      activeContext: (windowId) => resolveCanvasActiveContext(shellService.bootstrap(windowId)),
      project: async (windowId, projectId) => {
        const bootstrap = await projectService.bootstrap(windowId);
        const project = bootstrap.active.find((candidate) => String(candidate.id) === projectId);
        return project === undefined
          ? undefined
          : { id: String(project.id), type: project.type, lifecycle: project.lifecycle };
      },
      canvas: canvasService,
      uuid: randomUUID,
      hostId: LOCAL_HOST_ID,
    };
    // Canvas sharing is local-only: a snapshot is served over the loopback
    // Canvas API to a principal this host authenticates, never uploaded or
    // linked. Lifecycle is journaled, so revocation survives restart and the
    // access log is rebuilt by replay.
    const canvasShareService = new CanvasShareService(
      {
        projection: persistence.canvasProjection,
        eventStore: new CanvasShareEventStore({
          journal: persistence.journal,
          uuid: randomUUID,
          actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
        }),
        uuid: randomUUID,
        clock: () => new Date().toISOString() as never,
        hostId: String(LOCAL_HOST_ID),
        owner: { kind: "local-user", actorId: String(OCTANT_LOCAL_ACTOR_ID) },
      },
      { authorize: authorizeCanvas },
    );
    // The library is a host-wide read of the same journal-derived projection
    // the per-Project inventory reads. It is deliberately wider than a window's
    // Project scope (0026); the service, not the route, decides what a given
    // principal may see.
    const artifactLibraryService = new ArtifactLibraryService({
      projection: persistence.canvasProjection,
      projects: () =>
        persistence.readProjects().map((project) => ({
          id: project.id,
          name: project.name,
          type: project.type,
          lifecycle: project.lifecycle,
        })),
      liveShares: () => canvasShareService.liveShareCanvasIds(),
      clock: () => new Date().toISOString() as never,
    });
    const artifactLibraryRoutes = createArtifactLibraryRouteHandler({
      library: artifactLibraryService,
      windowAuthorityStore,
    });
    const artifactMirrorRoutes = createArtifactMirrorRouteHandler({
      mirror: artifactMirrorService,
      windowAuthorityStore,
    });
    // Hand-off starts from the export cut and keeps its document as a Canvas
    // of the thread, resolved from the thread the way an authoring agent's
    // Canvas is — never from whichever Project the window happens to show.
    const threadHandOffService = new ThreadHandOffService({
      exports: threadExportService,
      provider: {
        readiness: (providerInstanceId) => {
          const instance = persistence.readProviderInstance(providerInstanceId);
          if (instance === undefined || !instance.enabled) return undefined;
          return providerRuntimeRegistry.observedState(providerInstanceId)?.readiness;
        },
        complete: makeThreadHandOffCompletion({
          resolveDriver: (providerInstanceId) => {
            const instance = persistence.readProviderInstance(providerInstanceId);
            if (instance === undefined || !instance.enabled) return undefined;
            try {
              return makeConfiguredProviderDriver(instance, configuredDriverOptions);
            } catch {
              return undefined;
            }
          },
          scratchRoot: (threadId) => {
            const root = join(persistence.dataDirectory, "hand-off-scratch", threadId);
            mkdirSync(root, { recursive: true, mode: 0o700 });
            return root;
          },
          uuid: randomUUID,
        }),
      },
      documents: {
        save: async ({ windowId, mode, threadId, projectId, title, blocks }) => {
          const bootstrap = await projectService.bootstrap(windowId);
          const project = bootstrap.active.find(
            (candidate) => String(candidate.id) === String(projectId),
          );
          if (project === undefined || project.lifecycle !== "active" || project.type !== mode) {
            return { kind: "refused", message: "The thread's Project is unavailable." };
          }
          // The scope is derived by the resolver the Canvas surfaces already
          // use, not built alongside it. A hand-built scope disagreed with the
          // resolver on all three modes, and `validateCanvasRefreshRequest`
          // compares the two, so a handed-off Canvas could refuse its own
          // refresh as a scope mismatch.
          //
          // It also answers with `undefined` rather than throwing: the provider
          // call before this is bounded at 180 seconds, and the thread can be
          // archived or its checkout can go away while that runs.
          const workspace = resolveCanvasWorkspace({ mode, threadId });
          if (workspace === undefined) {
            return { kind: "refused", message: "The thread's workspace is unavailable." };
          }
          const created = canvasService.create(
            {
              schemaVersion: 1,
              kind: "canvas-create",
              requestId: randomUUID(),
              intent: "blank",
              hostId: LOCAL_HOST_ID,
              mode,
              workspace,
              originThreadId: threadId,
              title,
              sourceManifest: [],
              // A hand-off is a document: it reads nothing and runs nothing.
              requestedAuthority: {
                filesystem: false,
                shell: false,
                git: false,
                network: false,
                tools: false,
                subagents: false,
                executionPolicy: "plan",
                permissionPersistence: "current-session",
              },
            },
            { mode, projectId: String(projectId) },
            { id: String(project.id), type: mode, lifecycle: "active" },
            blocks,
          );
          if (created.kind !== "accepted") {
            return { kind: "refused", message: created.message };
          }
          return {
            kind: "saved",
            canvasId: String(created.card.canvasId),
            versionId: String(created.card.versionId),
          };
        },
      },
    });
    const threadHandOffRoutes = createThreadHandOffRouteHandler({
      service: threadHandOffService,
      windowAuthorityStore,
    });
    const canvasRoutes = createCanvasRouteHandler({
      canvasProjection: persistence.canvasProjection,
      canvasService,
      canvasShareService,
      windowAuthorityStore,
      projects: projectService,
      activeContextResolver: (windowId) =>
        resolveCanvasActiveContext(shellService.bootstrap(windowId)),
    });
    const automationEventStore = new AutomationEventStore({
      journal: persistence.journal,
      uuid: randomUUID,
      actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
    });
    // The Automation projection is in-memory; rebuild it from the
    // authoritative journal on every startup. Hydration fails closed: a
    // hostile or undecodable frame leaves the projection empty instead of
    // trusting a partially valid stream.
    hydrateAutomationProjection({
      store: automationEventStore,
      projection: persistence.automationProjection,
    });
    // A6: shared device destinations, opt-in preferences, durable delivery
    // receipts. Credentialed APNs/FCM remains a named validation residual —
    // the default transport reports unavailable honestly.
    const pushNotificationTokenStore = createPushNotificationTokenStore();
    const automationNotificationPreferencesStore = new AutomationNotificationPreferencesStore({
      journal: persistence.journal,
      uuid: randomUUID,
      actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
      clock: () => new Date().toISOString(),
    });
    const automationNotificationDeliveryStore = new AutomationNotificationDeliveryStore({
      journal: persistence.journal,
      uuid: randomUUID,
      actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
      clock: () => new Date().toISOString(),
    });
    const automationNotificationDelivery = new AutomationNotificationDeliveryService({
      hostId: String(LOCAL_HOST_ID),
      preferences: automationNotificationPreferencesStore,
      deliveries: automationNotificationDeliveryStore,
      tokens: pushNotificationTokenStore,
      transport: createUnavailablePushDeliveryTransport(),
      clock: () => new Date().toISOString() as UtcTimestamp,
      resolveAutomationProjectId: (automationId) => {
        const definition = persistence.automationProjection.getDefinition(automationId);
        return definition === undefined ? undefined : String(definition.projectId);
      },
      recordRunNotificationRef: ({ run, notificationRef, recordedAt }) => {
        const current = persistence.automationProjection.getRun(run.id);
        if (current === undefined) return;
        if (current.notificationRefs.includes(notificationRef as never)) return;
        try {
          automationEventStore.appendNotificationRefRecorded({
            automationId: current.automationId,
            runId: current.id,
            notificationRef,
            expectedVersion: current.version,
            recordedAt,
          });
        } catch {
          // Notification ref append failure never changes run lifecycle.
        }
      },
    });
    const automationNotificationRoutes = createAutomationNotificationRouteHandler({
      windowAuthorityStore,
      preferences: automationNotificationPreferencesStore,
      delivery: automationNotificationDelivery,
    });
    const automationCommandService = new AutomationCommandService({
      store: automationEventStore,
      projection: persistence.automationProjection,
      hostId: String(LOCAL_HOST_ID),
      clock: () => new Date().toISOString(),
    });
    // The one host-local durable scheduler (A3) plus the ordinary-thread
    // dispatcher (A4). Claims stay journaled; the dispatcher revalidates
    // authority, creates at most one Code/Work thread per occurrence, and
    // launches the first turn behind a durable intent/claim. Work uses the
    // provider-backed first-turn runtime through the ordinary thread
    // and turn services.
    const automationCodeDispatch = createAutomationCodeDispatchPort({
      codeService: {
        execute: async (windowId, command) =>
          routeCodeService.execute(windowId, command as never) as Promise<{
            readonly kind: string;
            readonly thread?: { readonly id: CodeThreadId; readonly checkoutId?: string };
          }>,
        bootstrap: async (windowId) => {
          const bootstrap = await routeCodeService.bootstrap(windowId);
          return {
            threads: bootstrap.threads.map((thread) => ({
              id: thread.id,
              checkoutId: String(thread.checkoutId),
            })),
          };
        },
      },
      operations: {
        execute: async (windowId, command) => {
          if (routeCodeService.executeOperation === undefined) {
            throw new Error("Code operation runtime is unavailable.");
          }
          return routeCodeService.executeOperation(windowId, command as never);
        },
      },
      evidence: automationCodeEvidenceFromText(),
      clock: () => new Date().toISOString() as UtcTimestamp,
      uuid: randomUUID,
    });
    const automationWorkDispatch = createAutomationWorkDispatchPort({
      threads: {
        execute: async (windowId, command) =>
          workThreadServiceWithWorkflows.execute(windowId, command as never) as Promise<{
            readonly kind: string;
            readonly thread?: { readonly id: WorkThreadId };
          }>,
        bootstrap: async (windowId) => {
          const bootstrap = await workThreadServiceWithWorkflows.bootstrap(windowId);
          return {
            threads: bootstrap.threads.map((thread) => ({ id: thread.id })),
          };
        },
      },
      turns: {
        startFirstTurn: async (windowId, command) =>
          workTurnService.startFirstTurn(windowId, command),
      },
      clock: () => new Date().toISOString() as UtcTimestamp,
      uuid: randomUUID,
    });
    const automationDispatch = new AutomationDispatchService({
      store: automationEventStore,
      projection: persistence.automationProjection,
      code: automationCodeDispatch,
      work: automationWorkDispatch,
      windows: {
        resolveWindowForProject: (projectId) => {
          for (const windowId of windowAuthorityStore.listWindowIds()) {
            // Prefer any registered local window; Project access is rechecked
            // by the ordinary Code/Work creation path.
            void projectId;
            return windowId;
          }
          return undefined;
        },
      },
      capacity: {
        admit: (input) => {
          try {
            const submission = capacityScheduler.submit({
              reservationId: input.reservationId as CapacityReservationId,
              subject: {
                aggregateType: "code-thread" as never,
                aggregateId: input.subjectThreadId as never,
              },
              providerInstanceId: input.providerInstanceId as never,
              modelId: input.modelId as never,
              estimatedTokens: 0,
              requests: 1,
              origin: "thread",
            });
            if (submission.status === "queued") {
              return {
                kind: "waiting",
                message: "Provider capacity is unavailable for Automation dispatch.",
              };
            }
            capacityScheduler.markRunning(input.reservationId as CapacityReservationId);
            return {
              kind: "admitted",
              release: () => {
                try {
                  capacityScheduler.recordTerminal({
                    reservationId: input.reservationId as CapacityReservationId,
                    outcome: "completed",
                  });
                } catch {
                  // Capacity release is best-effort; the claim lease bounds retry.
                }
              },
            };
          } catch (error) {
            // No provider capacity facts yet: do not invent a limit, but do not
            // block Automation behind an unconfigured scheduler.
            if (
              error instanceof Error &&
              error.name === "ProviderCapacitySchedulerRejected" &&
              "code" in error &&
              (error as { readonly code?: string }).code === "invalid-configuration"
            ) {
              return { kind: "admitted", release: () => undefined };
            }
            return {
              kind: "waiting",
              message: "Provider capacity admission failed for Automation dispatch.",
            };
          }
        },
      },
      resolveFacts: ({ definition, run }) =>
        resolveAutomationAuthorityLiveFacts(
          {
            hostId: String(LOCAL_HOST_ID),
            readProject: (projectId) => persistence.readProject(projectId as never),
            readProviderInstance: (providerInstanceId) =>
              persistence.readProviderInstance(providerInstanceId as never),
            providerSupportsModel: (providerInstanceId, modelId) => {
              const instance = persistence.readProviderInstance(providerInstanceId as never);
              if (instance === undefined || !instance.enabled) return false;
              const catalog = persistence.readProviderCatalog?.(providerInstanceId as never);
              if (catalog === undefined) return true;
              const models = (
                catalog as { readonly models?: ReadonlyArray<{ readonly id: string }> }
              ).models;
              return models?.some((model) => model.id === modelId) ?? true;
            },
            readExecutionProfileVersion: (profileId) => {
              const profile = persistence.readAgentProfile(profileId as never);
              if (profile === undefined) return undefined;
              return {
                version: profile.version,
                executionPolicy: profile.defaultExecutionPolicy,
              };
            },
            readCodeCheckoutAvailable: (input) => {
              const project = persistence.readProject(input.projectId as never);
              if (project === undefined || project.type !== "code") return false;
              const latest =
                "bindingHistory" in project ? project.bindingHistory.at(-1)?.revisionId : undefined;
              if (String(latest) !== input.bindingRevisionId) {
                return false;
              }
              const checkout = persistence.readCodeCheckout(input.checkoutId as never);
              return (
                checkout !== undefined &&
                checkout.availability === "available" &&
                String(checkout.repositoryId) === input.repositoryId
              );
            },
          },
          { definition, run },
        ),
      now: () => new Date().toISOString() as UtcTimestamp,
      onRunStatusChanged: (input) => {
        try {
          automationNotificationDelivery.observeRunStatusChanged(input);
        } catch {
          // Notification failure never changes run lifecycle truth.
        }
      },
    });
    const automationScheduler = new AutomationSchedulerService({
      store: automationEventStore,
      projection: persistence.automationProjection,
      dispatch: automationDispatch,
      now: () => new Date().toISOString() as UtcTimestamp,
    });
    automationScheduler.start();
    const automationRoutes = createAutomationRouteHandler({
      projection: persistence.automationProjection,
      commands: {
        // Every authenticated command wakes the scheduler so pause/resume/
        // run-now/cancel re-arm timers immediately instead of at the next poll.
        execute: (command) => {
          const result = automationCommandService.execute(command);
          automationScheduler.poke();
          return result;
        },
      },
      windowAuthorityStore,
      projects: projectService,
      hostId: String(LOCAL_HOST_ID),
    });
    const workPromotionProjection = new WorkPromotionProjection();
    const workPromotionEventStore = new WorkPromotionEventStore({
      journal: persistence.journal,
      uuid: randomUUID,
      actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
    });
    const workPromotionWindowScope: { current: WindowId | undefined } = { current: undefined };
    const workPromotionService = new WorkPromotionService({
      projects: createWorkPromotionProjectPort({
        persistence,
        projects: projectService,
        artifacts: workArtifactProjection,
        gitObservation: gitObservationPort,
        clock: () => new Date().toISOString(),
      }),
      codeThreads: createWorkPromotionCodeThreadPort({
        codeService: routeCodeService,
        clock: () => new Date().toISOString(),
      }),
      projection: workPromotionProjection,
      eventStore: workPromotionEventStore,
      actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
      clock: () => new Date().toISOString(),
      authenticatedWindowId: () => workPromotionWindowScope.current,
    });
    workPromotionService.hydrate();
    const workPromotionApplication = new WorkPromotionApplicationService({
      promotion: workPromotionService,
      projection: workPromotionProjection,
      projects: projectService,
      windowScope: workPromotionWindowScope,
    });
    const workPromotionRoutes = createWorkPromotionRouteHandler({
      service: workPromotionApplication,
      windowAuthorityStore,
      maxJsonBodySize: MAX_JSON_REQUEST_BODY_SIZE,
    });
    const workRequestProjection = new WorkRequestProjection();
    const workRequestEventStore = new WorkRequestEventStore({
      journal: persistence.journal,
      uuid: randomUUID,
    });
    const workRequestService = new WorkRequestService({
      projects: {
        projectType: (projectId) => persistence.readProject(projectId)?.type ?? "unknown",
        isActiveWorkProject: (projectId) => {
          const project = persistence.readProject(projectId);
          return project?.type === "work" && project.lifecycle === "active";
        },
        workCanonicalRoot: (projectId) => {
          const project = persistence.readProject(projectId);
          if (project === undefined || project.type !== "work") return undefined;
          const root = project.binding.canonicalRoot;
          return root.length > 0 ? root : undefined;
        },
        threadProjectId: (threadId) => workThreadProjection.read(threadId)?.projectId,
        threadProviderInstanceId: (threadId) =>
          workThreadProjection.read(threadId)?.providerInstanceId,
      },
      projection: workRequestProjection,
      eventStore: workRequestEventStore,
      providerSessions: {
        answerApproval: (input) => {
          if (workRequestRuntime === undefined) {
            return Promise.reject(new Error("Work provider session runtime is unavailable."));
          }
          return workRequestRuntime.answerApproval(input);
        },
        answerUserInput: (input) => {
          if (workRequestRuntime === undefined) {
            return Promise.reject(new Error("Work provider session runtime is unavailable."));
          }
          return workRequestRuntime.answerUserInput(input);
        },
        cancel: (input) => {
          if (workRequestRuntime === undefined) {
            return Promise.reject(new Error("Work provider session runtime is unavailable."));
          }
          return workRequestRuntime.cancel(input);
        },
      },
      actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
      clock: () => new Date().toISOString(),
    });
    workRequestRuntime = new WorkRequestRuntime({
      requests: workRequestService,
      uuid: randomUUID,
    });
    workRequestService.hydrate();
    workRequestService.reconcileUnavailableRequests();
    observeWorkThreadRuntime = (threadId) => {
      const thread = workThreadProjection.read(threadId);
      const pending = thread
        ? workRequestService
            .listForThread(thread.projectId, threadId)
            .some((request) => request.status === "pending")
        : false;
      const childRuns = persistence.agentRunProjection.parentSummary(
        decodeAgentRunParentThreadId(String(threadId)),
      );
      return boardRuntimeActivityFromTurnsAndSignals({
        turns: workTurnProjection.listForThread(threadId),
        pendingRequest: pending,
        childActive: childRuns.filter(
          (run) => isAgentRunActiveStatus(run.lifecycleStatus) && run.lifecycleStatus !== "waiting",
        ).length,
        childWaiting: childRuns.filter((run) => run.lifecycleStatus === "waiting").length,
      });
    };
    projectService.onWorkProjectArchived((project) => {
      workRequestService.interruptProject(project.id);
    });
    const workRequestApplication = new WorkRequestApplicationService({
      requests: workRequestService,
      projects: projectService,
      threads: workThreadService,
    });
    const workRequestRoutes = createWorkRequestRouteHandler({
      service: workRequestApplication,
      windowAuthorityStore,
      maxJsonBodySize: MAX_JSON_REQUEST_BODY_SIZE,
    });
    const workThreadRoutes = createWorkThreadRouteHandler({
      service: {
        bootstrap: (windowId) => workThreadServiceWithWorkflows.bootstrap(windowId),
        navigation: (windowId) => workThreadServiceWithWorkflows.navigation(windowId),
        execute: (windowId, command) => workThreadServiceWithWorkflows.execute(windowId, command),
        queryBoard: async (windowId, query) => {
          const bootstrap = await workThreadServiceWithWorkflows.bootstrap(windowId);
          const projects = await projectService.bootstrap(windowId);
          const projectById = new Map(
            projects.active.map((project) => [String(project.id), project] as const),
          );
          const boardThreads: WorkBoardThread[] = bootstrap.threads
            .filter((thread) => thread.lifecycle !== "archived")
            .map((thread) => {
              const project = projectById.get(String(thread.projectId));
              const currentRevisionId =
                project !== undefined && project.type === "work"
                  ? project.bindingRevisionId
                  : undefined;
              return {
                thread,
                project: { id: thread.projectId, name: project?.name ?? thread.title },
                projectProjectionPresent: project !== undefined,
                bindingRevisionCurrent:
                  thread.bindingRevisionId === undefined ||
                  (currentRevisionId !== undefined &&
                    String(currentRevisionId) === String(thread.bindingRevisionId)),
                followUp: false,
              };
            });
          const board = new WorkThreadBoardService({
            threads: { list: () => boardThreads },
            evidence: {
              forThread: (entry) =>
                composeWorkBoardEvidence({
                  turns: workTurnProjection.listForThread(entry.thread.id),
                  pendingRequests: workRequestService.listForThread(
                    entry.thread.projectId,
                    entry.thread.id,
                  ),
                  artifacts: [...workArtifactProjection.snapshot().values()].filter(
                    (artifact) =>
                      String(artifact.projectId) === String(entry.thread.projectId) &&
                      !artifact.deleted,
                  ),
                  citations: [...workResearchProjection.snapshot().values()]
                    .filter(
                      (brief) => String(brief.brief.projectId) === String(entry.thread.projectId),
                    )
                    .flatMap((brief) => [...brief.sources.values()]),
                  goal: goalService.read(String(entry.thread.id)).goal,
                  childRuns: persistence.agentRunProjection.parentSummary(
                    decodeAgentRunParentThreadId(String(entry.thread.id)),
                  ),
                }),
            },
            runtime: {
              observe: (threadId) =>
                observeWorkThreadRuntime?.(threadId) ?? {
                  executing: false,
                  awaitingInput: false,
                  interrupted: false,
                },
            },
            clock: () => new Date().toISOString(),
          });
          return board.query(query);
        },
      },
      windowAuthorityStore,
      maxJsonBodySize: MAX_JSON_REQUEST_BODY_SIZE,
    });
    const workOverviewRoutes = createWorkOverviewRouteHandler({
      artifacts: workArtifactProjection,
      threads: workThreadService,
      workflows: workflowService,
      projects: projectService,
      requests: workRequestService,
      windowAuthorityStore,
    });
    const sidebarBackgroundStore = new SidebarBackgroundStore({
      dataDirectory: providerDataDirectory,
    });
    const sidebarBackgroundRoutes = createSidebarBackgroundRouteHandler({
      store: sidebarBackgroundStore,
      windowAuthorityStore,
      currentSidebarBackground: () =>
        persistence.readShellSettings()?.settings.sidebarBackground ?? null,
    });

    // One route chain is shared by the loopback listener and the authenticated
    // remote gateway. The remote dispatcher binds the verified principal and
    // gives this chain a loopback-shaped internal request; individual handlers
    // resolve the bound context through principalRouteContext before effects.
    const dispatchProductRoutes = async (request: Request): Promise<Response | undefined> =>
      (await projectBindingRoutes(request)) ??
      (await launchSessionRoutes(request)) ??
      (await machineChangeRoutes(request)) ??
      (await contextRoutes(request)) ??
      (await projectRoutes(request)) ??
      (await agentRunRoutes(request)) ??
      (await agentRunSettingsRoutes(request)) ??
      (await nativeHarnessRoutingRoutes(request)) ??
      (await nativeHarnessSessionRoutes(request)) ??
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
      (await providerRoutes(request)) ??
      (await providerUsageLimitsRoutes(request)) ??
      (await discoveryRoutes(request)) ??
      (await chatRoutes(request)) ??
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
      (await automationRoutes(request)) ??
      (await automationNotificationRoutes(request)) ??
      (await workPromotionRoutes(request)) ??
      (await workRequestRoutes(request)) ??
      (await sidebarBackgroundRoutes(request)) ??
      (await zenBackgroundRoutes(request)) ??
      (await zenRoutes(request)) ??
      (await navigatorAssistantRoutes(request)) ??
      (await localServerRoutes(request)) ??
      (await threadMentionRoutes(request)) ??
      (await fileMentionRoutes(request)) ??
      (await usageDashboardRoutes(request)) ??
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
      (await themeRoutes(request));

    const dispatchMeasuredProductRoutes = async (
      request: Request,
    ): Promise<Response | undefined> => {
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
      dispatch: dispatchMeasuredProductRoutes,
    });
    let remoteListener: PrivateListener | undefined;
    let remoteListenerError: PrivateListenerFailureCode | undefined;
    // Retained so shutdown can settle warming before the runtime registry
    // closes: an acquisition that lands after `closeAll()` would leave a warm
    // runtime alive on its idle lease with nothing left to close it.
    let warmingProviders: Promise<void> = Promise.resolve();
    // The private listener lifecycle is owned by a server-side controller so
    // the packaged host controls (over the loopback bridge) drive the real
    // dual-listener gateway, not a stub. `currentRemoteGateway` tracks the most
    // recent gateway generation the controller constructed so the local device
    // administration routes and the returned server shape can observe it. The
    // controller only ever binds the private gateway; the loopback listener is
    // never touched by an enable/disable/restart failure.
    let currentRemoteGateway: RemoteGateway | undefined;
    // The gateway service graph is either injected (test/smoke seam) or composed
    // from the server's own persistence graph and host identity for the packaged
    // desktop. Composition is lazy — it runs on the first enable, not at startup —
    // so a disabled-by-default server never touches host-identity key material.
    // The controller is always constructed so the packaged host controls reach a
    // real lifecycle authority instead of a 503 from an undefined controller.
    const injectedRemoteListenerServices = options.remoteListener?.services;
    const resolveRemoteGatewayServices = (): Omit<RemoteGatewayServices, "config" | "serve"> => {
      if (injectedRemoteListenerServices !== undefined) return injectedRemoteListenerServices;
      const identity = resolvePrivateListenerHostIdentity({
        connection: persistence.connection,
        dataDirectory: providerDataDirectory,
      });
      return {
        connection: persistence.connection,
        journal: persistence.journal,
        hostId: identity.hostId,
        displayName: identity.displayName,
        serverBuildVersion: version,
        signing: identity.signing,
        webAssets,
        productDispatch: authenticatedProductDispatch,
        pushTokenStore: pushNotificationTokenStore,
      };
    };
    const privateListenerController = createPrivateListenerLifecycleController({
      createGateway: (config) => {
        const services = resolveRemoteGatewayServices();
        const gateway = createRemoteGateway({
          ...services,
          productDispatch: services.productDispatch ?? authenticatedProductDispatch,
          serve: options.remoteServe ?? serve,
          config,
        });
        currentRemoteGateway = gateway;
        return gateway;
      },
    });
    const localDeviceAdministrationRoutes = createLocalDeviceAdministrationRouteHandler({
      desktopBridgeSecret: options.desktopBridgeSecret,
      windowAuthorityStore,
      control: () => currentRemoteGateway?.localDeviceAdministration(),
      maxRequestBodySize: MAX_JSON_REQUEST_BODY_SIZE,
    });
    const privateListenerAdministrationRoutes = createPrivateListenerAdministrationRouteHandler({
      desktopBridgeSecret: options.desktopBridgeSecret,
      windowAuthorityStore,
      hostIdentityFingerprint: () => readHostIdentity(persistence.connection)?.key_fingerprint,
      control: () => privateListenerController,
      maxRequestBodySize: MAX_JSON_REQUEST_BODY_SIZE,
    });
    // One diagnostics composer is shared by the owner control socket (through
    // the returned server shape) and the authenticated local host-control
    // routes, so the web Settings host card and `octant server status`
    // can never disagree about the same host.
    const composeHostDiagnostics = (): HostRuntimeDiagnostics => {
      const status = persistence.status();
      const capabilities = [
        "local-loopback",
        ...persistence
          .readProviderInstances()
          .filter((provider) => provider.enabled)
          .map((provider) => `provider:${provider.driverKind}`),
        ...(remoteListener === undefined ? [] : ["private-listener"]),
        ...(options.platformCapabilities ?? []),
      ];
      return boundHostRuntimeDiagnostics({
        identity: {
          hostId: options.hostId ?? "unknown",
          instanceId: options.instanceId ?? "unknown",
          endpoint: options.controlEndpoint ?? "unknown",
          serviceMode: options.serviceMode ?? "foreground",
        },
        version: { server: version, wire: "1" },
        store: { state: status.state, integrity: status.integrity },
        replay: {
          journalHead: status.journalHead,
          projections: status.projections.length,
        },
        clients: { connected: windowAuthorityStore.size() },
        capabilities,
        work: {
          active: providerRuntimeRegistry.activeSessionTotal(),
          attentionRequired: providerRuntimeRegistry.attentionRequired(),
        },
        uptimeSeconds: Math.max(0, Math.floor((Date.now() - startedAt) / 1_000)),
      });
    };
    // Registered on the loopback chain only — never inside
    // dispatchProductRoutes — so the remote gateway's product dispatch can
    // never reach host lifecycle authority even if route policy regressed.
    const chatAttachmentStore = new ChatAttachmentStore(persistence.dataDirectory);
    const threadRetention = new ThreadRetentionService({
      connection: persistence.connection,
      journal: persistence.journal,
      clock: () => new Date().toISOString(),
      uuid: randomUUID,
      listWorkThreads: () =>
        workThreadProjection.list().map((thread) => ({
          id: String(thread.id),
          projectId: thread.projectId,
          updatedAt: thread.updatedAt,
        })),
      forgetWorkThread: (threadId) => {
        workThreadProjection.forget(threadId as never);
      },
      purgeThreadArtifacts: async ({ mode, threadId }) => {
        if (mode === "chat") await chatAttachmentStore.purgeThread(threadId as never);
        try {
          await generatedImageStore.purgeScope(decodeImageGenerationScopeId(String(threadId)));
        } catch {
          // A thread id that is not a generated-image scope is not an image basin.
        }
      },
    });
    const hostRuntimePlatform =
      process.platform === "darwin" || process.platform === "linux" ? process.platform : undefined;
    const hostControlRoutes = createHostControlRouteHandler({
      windowAuthorityStore,
      diagnostics: composeHostDiagnostics,
      threadRetention,
      ...(options.hostControl?.servicePolicy === undefined
        ? {}
        : { servicePolicy: options.hostControl.servicePolicy }),
      ...(options.hostControl?.requestOwnerStop === undefined
        ? {}
        : { requestOwnerStop: options.hostControl.requestOwnerStop }),
      ...(hostRuntimePlatform === undefined
        ? {}
        : {
            dataMap: {
              dataDirectory: persistence.dataDirectory,
              platform: hostRuntimePlatform,
              ...(options.credentialBrokerUrl !== undefined && hostRuntimePlatform === "darwin"
                ? { credentialStore: desktopCredentialStore() }
                : {}),
              listProjects: () =>
                persistence.readProjects().map((project) => ({
                  id: String(project.id),
                  name: project.name,
                  type: project.type,
                  ...(project.type === "chat" ? {} : { boundRoot: project.binding.canonicalRoot }),
                })),
            },
          }),
      backup: (label) => {
        const receipt = persistence.createVerifiedBackup(label);
        return {
          label,
          migrationVersion: receipt.migrationVersion,
          journalHead: receipt.journalHead,
          byteLength: receipt.byteLength,
        };
      },
    });
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
                (await localDeviceAdministrationRoutes(request)) ??
                (await hostControlRoutes(request)) ??
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
          // Startup auto-enable: when a launch-time private listener config is
          // supplied (test/smoke seam), enable it through the controller after
          // the loopback listener binds. A failure fails closed with a typed
          // error code and never prevents the loopback listener from serving.
          if (options.remoteListener?.config !== undefined) {
            try {
              await privateListenerController.enable(options.remoteListener.config);
              remoteListener = currentRemoteGateway?.listener();
            } catch (error) {
              remoteListenerError =
                error instanceof Error &&
                "code" in error &&
                isPrivateListenerFailureCode(error.code)
                  ? error.code
                  : "bind-failed";
            }
          }
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
              if (currentRemoteGateway === undefined) {
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
            await codeOperationRuntime?.close();
          } catch (error) {
            shutdownFailure ??= error;
          }
          try {
            await browserAutomationService?.close();
          } catch (error) {
            shutdownFailure ??= error;
          }
          try {
            await computerUseRuntime.close();
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

export function stableAppleRootId(rootPath: string): string {
  const digest = createHash("sha256")
    .update("octant.apple-root.v1\0")
    .update(rootPath)
    .digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function authorizeAgentRunCancellation(input: {
  readonly persistence: PersistenceService;
  readonly workThreadProjection: WorkThreadProjection;
  readonly run: AgentRun;
  readonly windowId: string;
}): boolean {
  const workspace = input.persistence.readWindowWorkspace(input.windowId as WindowId)?.workspace;
  if (workspace === undefined) return false;
  const mode = input.run.routingReceipt.mode;
  const context = workspace.contextByMode[mode];
  if (
    context.mode !== mode ||
    String(context.host) !== String(input.run.routingReceipt.hostId) ||
    input.run.workspaceReceipt.mode !== mode
  ) {
    return false;
  }

  let threadProjectId: string | null | undefined;
  try {
    if (mode === "chat") {
      const thread = input.persistence.readChatThread(
        decodeChatThreadId(String(input.run.parentThreadId)),
      );
      if (thread === undefined) return false;
      threadProjectId = thread.projectId;
    } else if (mode === "work") {
      const thread = input.workThreadProjection.read(input.run.parentThreadId as never);
      if (thread === undefined) return false;
      threadProjectId = thread.projectId;
    } else {
      const thread = input.persistence.readCodeThread(
        decodeCodeThreadId(String(input.run.parentThreadId)),
      );
      if (thread === undefined) return false;
      threadProjectId = thread.projectId;
    }
  } catch {
    return false;
  }
  if (String(context.projectId) !== String(threadProjectId ?? null)) return false;
  if (
    input.run.routingReceipt.projectId !== undefined &&
    String(input.run.routingReceipt.projectId) !== String(threadProjectId)
  ) {
    return false;
  }
  if (
    input.run.workspaceReceipt.kind !== "chat-virtual" &&
    String(input.run.workspaceReceipt.projectId) !== String(threadProjectId)
  ) {
    return false;
  }
  return layoutContainsAgentRunThread(
    workspace.layouts[mode],
    String(input.run.parentThreadId),
    String(input.run.routingReceipt.hostId),
  );
}

/**
 * Authorizes a window to read a parent thread's AgentRuns (the parent summary,
 * which carries each completed child's reply, and result acknowledgements).
 *
 * Same shape as the cancellation check above, but resolved from a bare parent
 * thread id: the thread is looked up in this host's own stores across all
 * three modes — the parent-summary route serves Chat, Work, and Code — and
 * the window's own workspace must currently contain that thread on the
 * matching Project. Nothing the caller supplied is trusted as scope.
 */
function authorizeAgentRunParentThread(input: {
  readonly persistence: PersistenceService;
  readonly workThreadProjection: WorkThreadProjection;
  readonly parentThreadId: AgentRunParentThreadId;
  readonly windowId: string;
}): boolean {
  const workspace = input.persistence.readWindowWorkspace(input.windowId as WindowId)?.workspace;
  if (workspace === undefined) return false;
  const threadId = String(input.parentThreadId);

  const chatContext = workspace.contextByMode.chat;
  let chatThread;
  try {
    chatThread = input.persistence.readChatThread(decodeChatThreadId(threadId));
  } catch {
    chatThread = undefined;
  }
  if (
    chatThread !== undefined &&
    chatContext.mode === "chat" &&
    String(chatContext.projectId) === String(chatThread.projectId ?? null) &&
    layoutContainsAgentRunThread(workspace.layouts.chat, threadId, String(chatContext.host))
  ) {
    return true;
  }

  const workContext = workspace.contextByMode.work;
  let workThread;
  try {
    workThread = input.workThreadProjection.read(threadId as never);
  } catch {
    workThread = undefined;
  }
  if (
    workThread !== undefined &&
    workContext.mode === "work" &&
    String(workContext.projectId) === String(workThread.projectId) &&
    layoutContainsAgentRunThread(workspace.layouts.work, threadId, String(workContext.host))
  ) {
    return true;
  }

  const codeContext = workspace.contextByMode.code;
  let codeThread;
  try {
    codeThread = input.persistence.readCodeThread(decodeCodeThreadId(threadId));
  } catch {
    codeThread = undefined;
  }
  return (
    codeThread !== undefined &&
    codeContext.mode === "code" &&
    String(codeContext.projectId) === String(codeThread.projectId) &&
    layoutContainsAgentRunThread(workspace.layouts.code, threadId, String(codeContext.host))
  );
}

function resolveAgentRunCenterContext(input: {
  readonly persistence: PersistenceService;
  readonly workThreadProjection: WorkThreadProjection;
  readonly parentThreadId: AgentRunParentThreadId;
  readonly mode: OctantMode;
}): { readonly parentThreadTitle: string; readonly childThreadId?: CodeThreadId } {
  const threadId = String(input.parentThreadId);
  const title = resolveAgentRunParentThreadTitle(input);
  return {
    parentThreadTitle: title ?? "Thread",
    ...(input.mode === "code"
      ? { childThreadId: decodeCodeThreadId(deriveAgentRunChildWorktreeThreadId(threadId)) }
      : {}),
  };
}

function resolveAgentRunParentThreadTitle(input: {
  readonly persistence: PersistenceService;
  readonly workThreadProjection: WorkThreadProjection;
  readonly parentThreadId: AgentRunParentThreadId;
  readonly mode: OctantMode;
}): string | undefined {
  const threadId = String(input.parentThreadId);
  if (input.mode === "chat") {
    try {
      return input.persistence.readChatThread(decodeChatThreadId(threadId))?.title;
    } catch {
      return undefined;
    }
  }
  if (input.mode === "work") {
    try {
      return input.workThreadProjection.read(threadId as never)?.title;
    } catch {
      return undefined;
    }
  }
  try {
    return input.persistence.readCodeThread(decodeCodeThreadId(threadId))?.title;
  } catch {
    return undefined;
  }
}

/**
 * The bounded parent-thread selection a Chat child is admitted with.
 *
 * Superseded turns stay journaled but are no longer part of the conversation
 * the parent is having, so the selection is folded with `activeChatTurns`: an
 * abandoned branch must never ride along beside its replacement. For the same
 * reason only a `completed` attempt contributes an answer, because an attempt
 * that failed, was interrupted or cancelled, or has not finished arriving left
 * text the parent never accepted. The window is the most recent exchanges,
 * bounded by the contract, because a child is given the question it was created
 * from, not the parent's whole history.
 */
export function admittedParentChatContext(
  view: ChatThreadView,
): ReadonlyArray<ProviderContextBlock> {
  const bodies = new Map(view.contents.map((content) => [String(content.contentId), content.body]));
  const blocks: ProviderContextBlock[] = [];
  const admit = (kind: "user-message" | "assistant-message", body: string | undefined) => {
    const text = (body ?? "").trim().slice(0, MAX_AGENT_RUN_ADMITTED_CONTEXT_CHARACTERS).trim();
    if (text.length === 0) return;
    blocks.push({ kind, text });
  };
  for (const turn of activeChatTurns(view.turns)) {
    admit("user-message", bodies.get(String(turn.userMessageRef.contentId)));
    for (const attempt of turn.attempts) {
      // Skipped before the block budget is spent, not after: an abandoned
      // fragment that reached `blocks` would occupy a slot the cap below then
      // charged for, pushing one of the parent's real exchanges out of the
      // window. A child briefed with a partial reply answers from text the
      // parent never accepted, and after a retry it would see the abandoned
      // fragment and the answer side by side with nothing to tell them apart.
      // No block kind can mark text as partial, so an unfinished attempt
      // contributes nothing; the turn's prompt is still admitted above.
      if (!chatAttemptAnswered(attempt)) continue;
      for (const reference of attempt.responseRefs) {
        admit("assistant-message", bodies.get(String(reference.contentId)));
      }
    }
  }
  return blocks.slice(-MAX_AGENT_RUN_ADMITTED_CONTEXT_BLOCKS);
}

async function resolveAgentRunParentCheckout(
  persistence: PersistenceService,
  receipts: ManagedWorktreeReceiptStore,
  parentThreadId: string,
): Promise<{ readonly checkoutRoot: string } | Record<string, never>> {
  try {
    const thread = persistence.readCodeThread(decodeCodeThreadId(parentThreadId));
    const project = thread === undefined ? undefined : persistence.readProject(thread.projectId);
    if (thread === undefined || project?.type !== "code") return {};
    const checkout = persistence.readCodeCheckout(thread.checkoutId);
    const context = await resolveAgentRunCodeWorkspaceContext({
      thread: {
        projectId: String(thread.projectId),
        bindingRevisionId: String(thread.bindingRevisionId),
        repositoryId: String(thread.repositoryId),
        checkoutId: String(thread.checkoutId),
      },
      repositoryRoot: project.binding.canonicalRoot,
      checkout,
      loadManagedReceipt: (receiptId) => receipts.load(receiptId),
    });
    return context === undefined ? {} : { checkoutRoot: context.parentCheckoutRoot };
  } catch {
    return {};
  }
}

async function resolveAgentRunPrepareCode(
  persistence: PersistenceService,
  receipts: ManagedWorktreeReceiptStore,
  parent: { readonly mode: string; readonly threadId: string },
): Promise<
  | { readonly code: NonNullable<Awaited<ReturnType<typeof resolveAgentRunCodeWorkspaceContext>>> }
  | Record<string, never>
> {
  if (parent.mode !== "code") return {};
  try {
    const thread = persistence.readCodeThread(decodeCodeThreadId(parent.threadId));
    const project = thread === undefined ? undefined : persistence.readProject(thread.projectId);
    if (thread === undefined || project?.type !== "code") return {};
    const checkout = persistence.readCodeCheckout(thread.checkoutId);
    const resolved = await resolveAgentRunCodeWorkspaceContext({
      thread: {
        projectId: String(thread.projectId),
        bindingRevisionId: String(thread.bindingRevisionId),
        repositoryId: String(thread.repositoryId),
        checkoutId: String(thread.checkoutId),
      },
      repositoryRoot: project.binding.canonicalRoot,
      checkout,
      loadManagedReceipt: (receiptId) => receipts.load(receiptId),
    });
    return resolved === undefined ? {} : { code: resolved };
  } catch {
    return {};
  }
}

function appleRestartContext(
  receipt: AppleRuntimeReceipt,
  persistence: PersistenceService,
  artifactRoot: string,
): AppleExecutionContext | undefined {
  const thread = persistence.readCodeThread(decodeCodeThreadId(receipt.threadId));
  const checkout = persistence.readCodeCheckout(decodeCodeCheckoutId(receipt.checkoutId));
  const project = thread === undefined ? undefined : persistence.readProject(thread.projectId);
  if (
    thread === undefined ||
    checkout === undefined ||
    project === undefined ||
    project.type !== "code" ||
    project.lifecycle !== "active" ||
    thread.lifecycle !== "active" ||
    thread.checkoutId !== checkout.id ||
    thread.repositoryId !== checkout.repositoryId ||
    receipt.authority.hostId !== LOCAL_TOOL_HOST_ID ||
    receipt.authority.mode !== "code" ||
    receipt.authority.projectId !== thread.projectId ||
    receipt.authority.providerInstanceId !== thread.providerInstanceId ||
    receipt.authority.extension.kind !== "core" ||
    (receipt.authority.worktreeId !== undefined &&
      String(receipt.authority.worktreeId) !== String(checkout.id)) ||
    (receipt.authority.rootId !== undefined &&
      String(receipt.authority.rootId) !== stableAppleRootId(project.binding.canonicalRoot))
  ) {
    return undefined;
  }
  return {
    authority: receipt.authority,
    threadId: thread.id,
    checkoutId: checkout.id,
    checkoutRoot: project.binding.canonicalRoot,
    artifactRoot,
    sourceRevision: checkout.head.oid,
    executionPolicy: thread.executionPolicy,
    approvalValid: false,
  };
}

export function pathIsProjectConfined(projectRoot: string, absolutePath: string): boolean {
  if (
    !isAbsolute(projectRoot) ||
    resolve(projectRoot) !== projectRoot ||
    !isAbsolute(absolutePath) ||
    resolve(absolutePath) !== absolutePath
  ) {
    return false;
  }
  try {
    const canonicalRoot = realpathSync(projectRoot);
    if (canonicalRoot !== projectRoot) return false;
    let nearestExistingPath = absolutePath;
    while (true) {
      try {
        lstatSync(nearestExistingPath);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
        const parent = dirname(nearestExistingPath);
        if (parent === nearestExistingPath) return false;
        nearestExistingPath = parent;
      }
    }
    return isPathWithin(canonicalRoot, realpathSync(nearestExistingPath));
  } catch {
    return false;
  }
}

function isPathWithin(root: string, candidate: string): boolean {
  const confined = relative(root, candidate);
  return (
    confined === "" ||
    (confined !== ".." && !confined.startsWith(`..${sep}`) && !isAbsolute(confined))
  );
}

function sameCanvasSkillScope(
  recordScope: StandaloneSkillScope | undefined,
  recipeScope: CanvasRefreshSkill["scope"],
  request: Pick<CanvasRefreshRequest, "mode" | "workspace" | "originThreadId">,
): boolean {
  if (recordScope === undefined) return recipeScope === undefined;
  if (recipeScope === undefined || recipeScope.mode !== request.mode) return false;
  return (
    recordScope.mode === recipeScope.mode &&
    String(recordScope.projectId) === String(recipeScope.projectId) &&
    String(recordScope.threadRef) === String(recipeScope.threadRef) &&
    String(recipeScope.projectId) === String(request.workspace.projectId) &&
    String(recipeScope.threadRef) === String(request.originThreadId)
  );
}

export function resolveWebAssetsPath(): string {
  const fromEnv = process.env.OCTANT_WEB_DIST_PATH;
  if (fromEnv !== undefined && isAbsolute(fromEnv)) return fromEnv;
  const serverRoot = dirname(fileURLToPath(import.meta.url));
  return resolve(serverRoot, "..", "..", "web", "dist");
}

export function fatalStartupOutput(error: unknown): string {
  const failure =
    error instanceof PersistenceStartupFailed || error instanceof ServerStartupFailed
      ? error
      : {
          category: "startup-failed",
          message: "Octant could not start the local server.",
        };
  return JSON.stringify({
    product: "Octant",
    status: "failed",
    category: failure.category,
    message: failure.message,
  });
}
