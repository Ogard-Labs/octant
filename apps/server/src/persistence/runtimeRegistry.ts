import {
  ContextCapacityReservationUpdated,
  ContextManifestCreated,
  ContextOverridesUpdated,
  ContextPlanCreated,
  ContextSummaryCreated,
  ContextUsageReconciled,
  ChatAttachmentUpdated,
  ChatAttemptUpdated,
  ChatCitationRecorded,
  ChatDeleted,
  ChatDeletionRequested,
  ChatSettingsUpdated,
  ChatThreadCreated,
  ChatThreadUpdated,
  ChatTurnCreated,
  ChatTurnRouteDecided,
  CodeProjectAccessChanged,
  CodeProjectNewThreadWorkspaceChanged,
  CodeCheckoutObserved,
  CodeCheckoutRemoved,
  CodeFileReferenceUpdated,
  CodeRuntimeWorkUpdated,
  CodeReviewFindingUpdated,
  CodeThreadFollowUpUpdated,
  CodeOperationEventFrame,
  CodeSettingsUpdated,
  CodeThreadCreated,
  CodeThreadUpdated,
  PersistedCodeThreadCreated,
  PersistedCodeThreadUpdated,
  WorkArtifactMutationFrame,
  WorkThreadCreated,
  WorkThreadUpdated,
  WorkThreadCompletionConfirmed,
  WorkTurnAccepted,
  WorkTurnUpdated,
  WorkPromotionFrame,
  WorkResearchFrame,
  WorkRequestFrame,
  WorkflowFrame,
  EnvironmentPresentationReplaced,
  MemoryEntryCreated,
  MemoryEntryRetracted,
  MemoryEntrySuperseded,
  MemoryEntryTransferred,
  NAVIGATOR_ASSISTANT_EVENT_NAMES,
  NavigatorAssistantThreadBound,
  OllamaHistoryRecorded,
  ProjectBindingRelinked,
  ProjectCreated,
  ProjectLifecycleChanged,
  ProjectOrderChanged,
  ProjectRenamed,
  ProviderDefaultsUpdated,
  ProviderCatalogUpdated,
  ProviderInstanceBinaryChanged,
  ProviderInstanceConfigurationChanged,
  ProviderInstanceCreated,
  ProviderInstanceEnabledChanged,
  ProviderInstanceRemoved,
  ProviderInstanceRenamed,
  RootlessFolderAttached,
  RootlessFolderAttachmentDenied,
  RootlessThreadCreated,
  RootlessTurnAccepted,
  RootlessTurnUpdated,
  ShellSettingsReplaced,
  THREAD_GOAL_EVENT_NAMES,
  THREAD_PLAN_EVENT_NAMES,
  ZEN_FOCUS_ZONE_EVENT_NAMES,
  ThreadFollowUpUpdated,
  ThemeSettingsUpdated,
  ThreadGoalUpdated,
  ThreadPlanUpdated,
  ZenFocusZoneRecorded,
  ThreadWorkUpdated,
  ValidationEvidenceRecorded,
  ValidationPlanCreated,
  ValidationReportCompleted,
  ZenSpaceSnapshotRecorded,
  ZenWidgetMutationRecorded,
  AgentProfileCreated,
  AgentProfileUpdated,
  AgentProfileRemoved,
  AgentRunPolicySettings,
  AgentRunRequested,
  AgentRunResultAcknowledged,
  AgentRunStatusChanged,
  AutomationNotificationDeliveryRecorded,
  AutomationNotificationPreferences,
  CanvasActionReceiptRecorded,
  CanvasCreated,
  CanvasRefreshReceiptRecorded,
  CanvasVersionAppended,
  DiagnosticsExportReceiptRecorded,
  DiagnosticsFailureIncidentRecorded,
  DiagnosticsFailureIncidentRecordedV1,
  ExtensionLifecycleEvent,
  ProductFeedbackCaptured,
  ProductFeedbackDelivered,
  ProductFeedbackDiscarded,
  ThreadCheckpointForgotten,
  ThreadCheckpointMarked,
  ThreadCheckpointRestored,
  GithubCloneRequested,
  GithubCloneTransitioned,
  THREAD_RETENTION_EVENT_NAMES,
  ThreadRetentionThreadPurged,
  ThreadRetentionWindowSet,
} from "@octant/contracts";
import {
  REMOTE_ACCESS_EVENT_NAMES,
  DeviceKeyRotatedV1,
  DeviceRegisteredV1,
  DeviceRevokedV1,
  DeviceCredentialExpiredV1,
  HostKeyRotatedV1,
  RemoteCommandReceiptRecordedV1,
  RemoteSessionInvalidatedV1,
  HostIdentityInitializedV1,
  SecurityAuditRecordedV1,
} from "@octant/contracts/remote-access";
import { Schema } from "effect";
import { AggregateHeadsProjection } from "./aggregateHeadsProjection";
import { AgentProfileProjection } from "./agentProfileProjection";
import { ChatProjection } from "./chatProjection";
import { CodeProjection } from "./codeProjection";
import { ContextProjection } from "./contextProjection";
import { EventRegistry } from "./eventRegistry";
import { ProjectionRegistry } from "./projection";
import { ProjectProjection } from "./projectProjection";
import { ProviderProjection } from "../providers/providerProjection";
import {
  PersistedEnvironmentPresentationReplaced,
  PersistedShellSettingsReplaced,
  PersistedWorkspaceLayoutReplaced,
} from "./shellPersistenceSchema";
import { ShellProjection } from "./shellProjection";
import { RootlessProjection } from "./rootlessProjection";
import { ZenProjection } from "./zenProjection";
import { UsageProjection } from "./usageProjection";
import { ValidationEvidenceProjection } from "../validation/validationEvidenceProjection";
import { ThemeProjection } from "./themeProjection";
import { ExtensionProjection, EXTENSION_LIFECYCLE_EVENT } from "./extensionProjection";
import { RemoteAccessProjection } from "./remoteAccessProjection";
import {
  PRODUCT_FEEDBACK_CAPTURED,
  PRODUCT_FEEDBACK_DELIVERED,
  PRODUCT_FEEDBACK_DISCARDED,
  ProductFeedbackProjection,
} from "./productFeedbackProjection";
import { ThreadRetentionProjection } from "./threadRetentionProjection";
import {
  THREAD_CHECKPOINT_FORGOTTEN,
  THREAD_CHECKPOINT_MARKED,
  THREAD_CHECKPOINT_RESTORED,
  ThreadCheckpointProjection,
} from "./threadCheckpointProjection";
import {
  DiagnosticsExportProjection,
  DIAGNOSTICS_EXPORT_RECEIPT_RECORDED,
  DIAGNOSTICS_FAILURE_INCIDENT_RECORDED,
  DIAGNOSTICS_FAILURE_INCIDENT_RECORDED_V1,
} from "./diagnosticsExportProjection";
import { AgentRunProjection } from "../agentRun/agentRunProjection";
import {
  AGENT_RUN_REQUESTED,
  AGENT_RUN_RESULT_ACKNOWLEDGED,
  AGENT_RUN_STATUS_CHANGED,
} from "../agentRun/agentRunEventStore";
import { registerAutomationEvents } from "../automation/automationEventStore";
import { AutomationProjection } from "../automation/automationProjection";
import { AGENT_RUN_SETTINGS_UPDATED } from "../agentRun/agentRunSettingsStore";
import { CanvasProjection } from "../canvas/canvasProjection";
import {
  CANVAS_ACTION_RECEIPT_RECORDED,
  CANVAS_CREATED,
  CANVAS_REFRESH_RECEIPT_RECORDED,
  CANVAS_VERSION_APPENDED,
} from "../canvas/canvasEventStore";
import { registerArtifactMirrorEvents } from "../canvas/artifactMirrorEventStore";
import { registerCanvasShareEvents } from "../canvas/canvasShareEventStore";
import type { HostIdentityMigrationRegistry } from "./hostIdentityMigration";
import { createRuntimeHostIdentityMigrationRegistry } from "./hostIdentityTransforms";
import {
  GITHUB_CLONE_REQUESTED,
  GITHUB_CLONE_TRANSITIONED,
  GithubCloneProjection,
} from "./githubCloneProjection";

const fixtureRecordedPayload = Schema.Struct({ value: Schema.String });

export interface Phase1RuntimeRegistries {
  readonly events: EventRegistry;
  readonly projections: ProjectionRegistry;
  readonly agentRunProjection: AgentRunProjection;
  readonly canvasProjection: CanvasProjection;
  readonly automationProjection: AutomationProjection;
  readonly githubCloneProjection: GithubCloneProjection;
  readonly hostIdentityMigrations: HostIdentityMigrationRegistry;
}

export function createPhase1RuntimeRegistries(): Phase1RuntimeRegistries {
  const events = new EventRegistry()
    .register("fixture.recorded", 1, fixtureRecordedPayload)
    .register("shell.settings-replaced", 1, ShellSettingsReplaced, {
      persistedSchema: PersistedShellSettingsReplaced,
    })
    .register("workspace.layout-replaced", 1, PersistedWorkspaceLayoutReplaced)
    .register("shell.environment-presentation-replaced", 1, EnvironmentPresentationReplaced, {
      persistedSchema: PersistedEnvironmentPresentationReplaced,
    })
    .register("project.created@1", 1, ProjectCreated)
    .register("project.renamed@1", 1, ProjectRenamed)
    .register("project.order-changed@1", 1, ProjectOrderChanged)
    .register("project.lifecycle-changed@1", 1, ProjectLifecycleChanged)
    .register("project.binding-relinked@1", 1, ProjectBindingRelinked)
    .register("project.code-access-changed@1", 1, CodeProjectAccessChanged)
    .register(
      "project.code-new-thread-workspace-changed@1",
      1,
      CodeProjectNewThreadWorkspaceChanged,
    )
    .register("memory.entry-created@1", 1, MemoryEntryCreated)
    .register("memory.entry-superseded@1", 1, MemoryEntrySuperseded)
    .register("memory.entry-retracted@1", 1, MemoryEntryRetracted)
    .register("memory.entry-transferred@1", 1, MemoryEntryTransferred)
    .register("provider.instance-created@1", 1, ProviderInstanceCreated)
    .register("provider.instance-renamed@1", 1, ProviderInstanceRenamed)
    .register("provider.instance-binary-changed@1", 1, ProviderInstanceBinaryChanged)
    .register("provider.instance-configuration-changed@1", 1, ProviderInstanceConfigurationChanged)
    .register("provider.instance-enabled-changed@1", 1, ProviderInstanceEnabledChanged)
    .register("provider.instance-removed@1", 1, ProviderInstanceRemoved)
    .register("provider.defaults-updated@1", 1, ProviderDefaultsUpdated)
    .register("provider.catalog-updated@1", 1, ProviderCatalogUpdated)
    .register("ollama.history-recorded@1", 1, OllamaHistoryRecorded)
    .register("context.manifest-created@1", 1, ContextManifestCreated)
    .register("context.overrides-updated@1", 1, ContextOverridesUpdated)
    .register("context.plan-created@1", 1, ContextPlanCreated)
    .register("context.summary-created@1", 1, ContextSummaryCreated)
    .register("context.usage-reconciled@1", 1, ContextUsageReconciled)
    .register("context.capacity-reservation-updated@1", 1, ContextCapacityReservationUpdated)
    .register("chat.settings-updated@1", 1, ChatSettingsUpdated)
    .register("chat.thread-created@1", 1, ChatThreadCreated)
    .register("chat.thread-updated@1", 1, ChatThreadUpdated)
    .register("chat.turn-created@1", 1, ChatTurnCreated)
    .register("chat.attempt-updated@1", 1, ChatAttemptUpdated)
    .register("chat.turn-route-decided@1", 1, ChatTurnRouteDecided)
    .register("chat.attachment-updated@1", 1, ChatAttachmentUpdated)
    .register("chat.citation-recorded@1", 1, ChatCitationRecorded)
    .register("thread.work-updated@1", 1, ThreadWorkUpdated)
    .register("thread.follow-up-updated@1", 1, ThreadFollowUpUpdated)
    .register(THREAD_GOAL_EVENT_NAMES.updated, 1, ThreadGoalUpdated)
    .register(ZEN_FOCUS_ZONE_EVENT_NAMES.updated, 1, ZenFocusZoneRecorded)
    .register(THREAD_PLAN_EVENT_NAMES.updated, 1, ThreadPlanUpdated)
    .register(NAVIGATOR_ASSISTANT_EVENT_NAMES.threadBound, 1, NavigatorAssistantThreadBound)
    .register("chat.deletion-requested@1", 1, ChatDeletionRequested)
    .register("chat.deleted@1", 1, ChatDeleted)
    .register("code.settings-updated@1", 1, CodeSettingsUpdated)
    .register("code.thread-created@1", 1, CodeThreadCreated, {
      persistedSchema: PersistedCodeThreadCreated,
    })
    .register("code.thread-updated@1", 1, CodeThreadUpdated, {
      persistedSchema: PersistedCodeThreadUpdated,
    })
    .register("code.checkout-observed@1", 1, CodeCheckoutObserved)
    .register("code.checkout-removed@1", 1, CodeCheckoutRemoved)
    .register("code.file-reference-updated@1", 1, CodeFileReferenceUpdated)
    .register("code.runtime-work-updated@1", 1, CodeRuntimeWorkUpdated)
    .register("code.review-finding-updated@1", 1, CodeReviewFindingUpdated)
    .register("code.follow-up-updated@1", 1, CodeThreadFollowUpUpdated)
    .register("code.operation-event-recorded@1", 1, CodeOperationEventFrame)
    .register(AGENT_RUN_REQUESTED, 1, AgentRunRequested)
    .register(AGENT_RUN_STATUS_CHANGED, 1, AgentRunStatusChanged)
    .register(AGENT_RUN_RESULT_ACKNOWLEDGED, 1, AgentRunResultAcknowledged)
    .register(AGENT_RUN_SETTINGS_UPDATED, 1, AgentRunPolicySettings)
    .register("automation-notification-preferences-updated@1", 1, AutomationNotificationPreferences)
    .register(
      "automation-notification-delivery-recorded@1",
      1,
      AutomationNotificationDeliveryRecorded,
    )
    .register(CANVAS_CREATED, 1, CanvasCreated)
    .register(CANVAS_VERSION_APPENDED, 1, CanvasVersionAppended)
    .register(CANVAS_REFRESH_RECEIPT_RECORDED, 1, CanvasRefreshReceiptRecorded)
    .register(CANVAS_ACTION_RECEIPT_RECORDED, 1, CanvasActionReceiptRecorded)
    .register(DIAGNOSTICS_FAILURE_INCIDENT_RECORDED_V1, 1, DiagnosticsFailureIncidentRecordedV1)
    .register(DIAGNOSTICS_FAILURE_INCIDENT_RECORDED, 1, DiagnosticsFailureIncidentRecorded)
    .register(DIAGNOSTICS_EXPORT_RECEIPT_RECORDED, 1, DiagnosticsExportReceiptRecorded)
    .register("work.thread-created@1", 1, WorkThreadCreated)
    .register("work.thread-updated@1", 1, WorkThreadUpdated)
    .register("work.thread-completion-confirmed@1", 1, WorkThreadCompletionConfirmed)
    .register("work.turn-accepted@1", 1, WorkTurnAccepted)
    .register("work.turn-updated@1", 1, WorkTurnUpdated)
    .register("work.artifact-mutation-recorded@1", 1, WorkArtifactMutationFrame)
    .register("work.promotion-recorded@1", 1, WorkPromotionFrame)
    .register("work.research-recorded@1", 1, WorkResearchFrame)
    .register("work.workflow-recorded@1", 1, WorkflowFrame)
    .register("work.request-recorded@1", 1, WorkRequestFrame)
    .register("rootless.thread-created@1", 1, RootlessThreadCreated)
    .register("rootless.turn-accepted@1", 1, RootlessTurnAccepted)
    .register("rootless.turn-updated@1", 1, RootlessTurnUpdated)
    .register("rootless.folder-attached@1", 1, RootlessFolderAttached)
    .register("rootless.folder-attachment-denied@1", 1, RootlessFolderAttachmentDenied)
    .register("zen.space-snapshot-recorded@1", 1, Schema.Unknown)
    .register("zen.space-snapshot-recorded@2", 1, ZenSpaceSnapshotRecorded)
    .register("zen.widget-mutation-recorded@1", 1, ZenWidgetMutationRecorded)
    .register("agent.profile-created@1", 1, AgentProfileCreated)
    .register("agent.profile-updated@1", 1, AgentProfileUpdated)
    .register("agent.profile-removed@1", 1, AgentProfileRemoved)
    .register("validation.plan-created@1", 1, ValidationPlanCreated)
    .register("validation.evidence-recorded@1", 1, ValidationEvidenceRecorded)
    .register("validation.report-completed@1", 1, ValidationReportCompleted)
    .register("theme.settings-updated@1", 1, ThemeSettingsUpdated)
    .register(EXTENSION_LIFECYCLE_EVENT, 1, ExtensionLifecycleEvent)
    .register(REMOTE_ACCESS_EVENT_NAMES.hostIdentityInitialized, 1, HostIdentityInitializedV1)
    .register(REMOTE_ACCESS_EVENT_NAMES.deviceRegistered, 1, DeviceRegisteredV1)
    .register(REMOTE_ACCESS_EVENT_NAMES.deviceKeyRotated, 1, DeviceKeyRotatedV1)
    .register(REMOTE_ACCESS_EVENT_NAMES.deviceRevoked, 1, DeviceRevokedV1)
    .register(REMOTE_ACCESS_EVENT_NAMES.deviceCredentialExpired, 1, DeviceCredentialExpiredV1)
    .register(REMOTE_ACCESS_EVENT_NAMES.hostKeyRotated, 1, HostKeyRotatedV1)
    .register(REMOTE_ACCESS_EVENT_NAMES.sessionInvalidated, 1, RemoteSessionInvalidatedV1)
    .register(REMOTE_ACCESS_EVENT_NAMES.commandReceiptRecorded, 1, RemoteCommandReceiptRecordedV1)
    .register(REMOTE_ACCESS_EVENT_NAMES.securityAuditRecorded, 1, SecurityAuditRecordedV1)
    .register(PRODUCT_FEEDBACK_CAPTURED, 1, ProductFeedbackCaptured)
    .register(PRODUCT_FEEDBACK_DISCARDED, 1, ProductFeedbackDiscarded)
    .register(PRODUCT_FEEDBACK_DELIVERED, 1, ProductFeedbackDelivered)
    .register(THREAD_CHECKPOINT_MARKED, 1, ThreadCheckpointMarked)
    .register(THREAD_CHECKPOINT_FORGOTTEN, 1, ThreadCheckpointForgotten)
    .register(THREAD_CHECKPOINT_RESTORED, 1, ThreadCheckpointRestored)
    .register(GITHUB_CLONE_REQUESTED, 1, GithubCloneRequested)
    .register(GITHUB_CLONE_TRANSITIONED, 1, GithubCloneTransitioned)
    .register(THREAD_RETENTION_EVENT_NAMES.windowSet, 1, ThreadRetentionWindowSet)
    .register(THREAD_RETENTION_EVENT_NAMES.threadPurged, 1, ThreadRetentionThreadPurged);
  registerAutomationEvents(events);
  registerCanvasShareEvents(events);
  registerArtifactMirrorEvents(events);

  const hostIdentityMigrations = createRuntimeHostIdentityMigrationRegistry(events);
  const agentRunProjection = new AgentRunProjection();
  const canvasProjection = new CanvasProjection();
  const automationProjection = new AutomationProjection();
  const githubCloneProjection = new GithubCloneProjection();

  return {
    events,
    hostIdentityMigrations,
    agentRunProjection,
    canvasProjection,
    automationProjection,
    githubCloneProjection,
    projections: new ProjectionRegistry()
      .register(new AggregateHeadsProjection())
      .register(new ProjectProjection())
      .register(new ProviderProjection())
      .register(new ContextProjection())
      .register(new UsageProjection())
      .register(new DiagnosticsExportProjection())
      .register(new ShellProjection())
      .register(new ChatProjection())
      .register(new CodeProjection())
      .register(agentRunProjection)
      .register(canvasProjection)
      .register(automationProjection)
      .register(githubCloneProjection)
      .register(new RootlessProjection())
      .register(new ZenProjection())
      .register(new AgentProfileProjection())
      .register(new ValidationEvidenceProjection())
      .register(new ThemeProjection())
      .register(new ExtensionProjection())
      .register(new RemoteAccessProjection())
      .register(new ThreadCheckpointProjection())
      .register(new ProductFeedbackProjection())
      .register(new ThreadRetentionProjection()),
  };
}
