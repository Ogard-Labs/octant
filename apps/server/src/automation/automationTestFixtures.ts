import {
  decodeAutomationDefinition,
  decodeAutomationRun,
  deriveAutomationOccurrenceKey,
  type AutomationClientPrincipal,
  type AutomationDefinition,
  type AutomationDefinitionDraft,
  type AutomationRun,
} from "@octant/contracts";
import type { AutomationWorkDispatchPort } from "./automationModeDispatchPorts";

/**
 * Deterministic Automation fixtures shared by the event store, projection,
 * command service, and route tests. Every fixture decodes through the strict
 * A1 contracts so tests exercise the same validation as production appends.
 */
export const AUTOMATION_TEST_IDS = {
  automation: "aa000000-0000-4000-8000-000000000001",
  otherAutomation: "aa000000-0000-4000-8000-000000000002",
  run: "aa000000-0000-4000-8000-000000000010",
  project: "aa000000-0000-4000-8000-000000000020",
  otherProject: "aa000000-0000-4000-8000-000000000021",
  bindingRevision: "aa000000-0000-4000-8000-000000000030",
  executionProfile: "aa000000-0000-4000-8000-000000000040",
  authorityProfile: "aa000000-0000-4000-8000-000000000050",
  deliveryTargetRevision: "aa000000-0000-4000-8000-000000000060",
  providerInstance: "aa000000-0000-4000-8000-000000000070",
  runNowRequest: "aa000000-0000-4000-8000-000000000080",
  cancelRequest: "aa000000-0000-4000-8000-000000000090",
  firstTurnRequest: "aa000000-0000-4000-8000-0000000000a0",
  actor: "aa000000-0000-4000-8000-0000000000b0",
  correlation: "aa000000-0000-4000-8000-0000000000c0",
} as const;

export const AUTOMATION_TEST_NOW = "2026-08-10T12:00:00.000Z";
export const AUTOMATION_TEST_DUE = "2026-09-01T09:00:00.000Z";

const approvalGatedWorkAuthority = {
  filesystem: true,
  shell: false,
  git: false,
  network: false,
  tools: true,
  subagents: false,
  executionPolicy: "approval-gated",
  permissionPersistence: "current-session",
} as const;

export function automationLocalWindowPrincipal(
  windowId = "automation-window-1",
): AutomationClientPrincipal {
  return { kind: "local-window", windowId, capabilityGeneration: 0 } as AutomationClientPrincipal;
}

export function automationRemoteDevicePrincipal(): AutomationClientPrincipal {
  return {
    kind: "remote-device",
    hostId: "local",
    deviceId: "device-1",
    credentialGeneration: 1,
    origin: "https://remote.example",
    protocolVersion: 1,
    capabilityDigest: "d".repeat(64),
    sessionId: "session-1",
  } as AutomationClientPrincipal;
}

export function automationDefinitionDraftFixture(
  overrides: Partial<AutomationDefinitionDraft> = {},
): AutomationDefinitionDraft {
  return {
    displayName: "Weekly summary",
    taskPrompt: "Summarize the Project's open work.",
    hostId: "local",
    mode: "work",
    projectId: AUTOMATION_TEST_IDS.project,
    projectVersion: 1,
    binding: {
      kind: "work",
      hostId: "local",
      projectId: AUTOMATION_TEST_IDS.project,
      projectVersion: 1,
      bindingRevisionId: AUTOMATION_TEST_IDS.bindingRevision,
      bindingReceiptId: `${"A".repeat(42)}A`,
    },
    executionProfile: {
      profileId: AUTOMATION_TEST_IDS.executionProfile,
      profileVersion: 1,
      hostId: "local",
      mode: "work",
      projectId: AUTOMATION_TEST_IDS.project,
      providerInstanceId: AUTOMATION_TEST_IDS.providerInstance,
      modelId: "approved-model",
      executionPolicy: "approval-gated",
      permissionPersistence: "current-session",
    },
    authorityProfile: {
      profileId: AUTOMATION_TEST_IDS.authorityProfile,
      profileVersion: 1,
      requested: approvalGatedWorkAuthority,
      effective: approvalGatedWorkAuthority,
      effectiveAuthorityDigest: "automation-authority-digest",
    },
    deliveryTarget: {
      revisionId: AUTOMATION_TEST_IDS.deliveryTargetRevision,
      revision: 1,
      mode: "work",
      summary: "A confirmed weekly summary document exists in the Project.",
      confirmed: true,
      confirmedBy: AUTOMATION_TEST_IDS.actor,
      confirmedAt: AUTOMATION_TEST_NOW,
    },
    trigger: { kind: "once", scheduledAt: AUTOMATION_TEST_DUE },
    missedRunPolicy: "skip",
    targetPolicy: "new-thread",
    ...overrides,
  } as unknown as AutomationDefinitionDraft;
}

export function automationDefinitionFixture(
  overrides: Partial<AutomationDefinition> = {},
): AutomationDefinition {
  return decodeAutomationDefinition({
    id: AUTOMATION_TEST_IDS.automation,
    ...automationDefinitionDraftFixture(),
    lifecycle: "enabled",
    definitionRevision: 1,
    nextDueAt: AUTOMATION_TEST_DUE,
    createdBy: automationLocalWindowPrincipal(),
    updatedBy: automationLocalWindowPrincipal(),
    version: 1,
    createdAt: AUTOMATION_TEST_NOW,
    updatedAt: AUTOMATION_TEST_NOW,
    ...overrides,
  });
}

export interface AutomationRunForDefinitionOverrides {
  readonly id?: string;
  readonly runNowRequestId?: string;
  readonly firstTurnRequestId?: string;
  readonly at?: string;
}

/** Build a queued manual run that is contract-consistent with a definition. */
export function automationRunForDefinition(
  definition: AutomationDefinition,
  overrides: AutomationRunForDefinitionOverrides = {},
): AutomationRun {
  const at = overrides.at ?? AUTOMATION_TEST_NOW;
  const occurrence = {
    kind: "manual",
    automationId: definition.id,
    definitionRevision: definition.definitionRevision,
    runNowRequestId: overrides.runNowRequestId ?? AUTOMATION_TEST_IDS.runNowRequest,
  } as const;
  return decodeAutomationRun({
    id: overrides.id ?? AUTOMATION_TEST_IDS.run,
    automationId: definition.id,
    occurrence,
    occurrenceKey: deriveAutomationOccurrenceKey(occurrence as never),
    scheduledAt: null,
    claimedAt: at,
    definitionSnapshot: {
      automationId: definition.id,
      definitionRevision: definition.definitionRevision,
      displayName: definition.displayName,
      taskPrompt: definition.taskPrompt,
      hostId: definition.hostId,
      mode: definition.mode,
      projectId: definition.projectId,
      projectVersion: definition.projectVersion,
      binding: definition.binding,
      executionProfile: definition.executionProfile,
      authorityProfile: definition.authorityProfile,
      deliveryTarget: definition.deliveryTarget,
      trigger: definition.trigger,
      missedRunPolicy: definition.missedRunPolicy,
      targetPolicy: definition.targetPolicy,
    },
    authoritySnapshot: {
      profileId: definition.authorityProfile.profileId,
      profileVersion: definition.authorityProfile.profileVersion,
      requested: definition.authorityProfile.requested,
      effective: definition.authorityProfile.effective,
      effectiveAuthorityDigest: definition.authorityProfile.effectiveAuthorityDigest,
      capturedAt: at,
    },
    firstTurnRequestId: overrides.firstTurnRequestId ?? AUTOMATION_TEST_IDS.firstTurnRequest,
    lifecycle: "queued",
    notificationRefs: [],
    version: 1,
    createdAt: at,
    updatedAt: at,
  });
}

export function automationRunFixture(overrides: Partial<AutomationRun> = {}): AutomationRun {
  const definition = automationDefinitionFixture();
  const occurrence = {
    kind: "manual",
    automationId: definition.id,
    definitionRevision: definition.definitionRevision,
    runNowRequestId: AUTOMATION_TEST_IDS.runNowRequest,
  } as const;
  return decodeAutomationRun({
    id: AUTOMATION_TEST_IDS.run,
    automationId: definition.id,
    occurrence,
    occurrenceKey: deriveAutomationOccurrenceKey(occurrence as never),
    scheduledAt: null,
    claimedAt: AUTOMATION_TEST_NOW,
    definitionSnapshot: {
      automationId: definition.id,
      definitionRevision: definition.definitionRevision,
      ...automationDefinitionDraftFixture(),
    },
    authoritySnapshot: {
      profileId: definition.authorityProfile.profileId,
      profileVersion: definition.authorityProfile.profileVersion,
      requested: definition.authorityProfile.requested,
      effective: definition.authorityProfile.effective,
      effectiveAuthorityDigest: definition.authorityProfile.effectiveAuthorityDigest,
      capturedAt: AUTOMATION_TEST_NOW,
    },
    firstTurnRequestId: AUTOMATION_TEST_IDS.firstTurnRequest,
    lifecycle: "queued",
    notificationRefs: [],
    version: 1,
    createdAt: AUTOMATION_TEST_NOW,
    updatedAt: AUTOMATION_TEST_NOW,
    ...overrides,
  });
}

/**
 * Closed Work gate for tests that exercise Code dispatch or an unavailable
 * first-turn runtime. Production hosts wire createAutomationWorkDispatchPort
 * instead.
 */
export function unavailableAutomationWorkDispatchPort(
  reason = "Work first-turn runtime is unavailable for Automation dispatch.",
): AutomationWorkDispatchPort {
  return {
    available: false,
    unavailableReason: reason,
    createThread: async () => ({
      kind: "failed",
      reason: "unavailable",
      message: reason,
    }),
    startOrRecoverFirstTurn: async () => ({
      kind: "failed",
      reason: "provider-launch-failed",
      message: reason,
    }),
  };
}
