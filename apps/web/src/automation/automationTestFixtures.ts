import {
  decodeAutomationDefinition,
  decodeAutomationRun,
  deriveAutomationOccurrenceKey,
  type AutomationDefinition,
  type AutomationDefinitionDraft,
  type AutomationRun,
  type AutomationSummary,
} from "@octant/contracts";

/**
 * Deterministic Automation fixtures for renderer tests. Every fixture decodes
 * through the strict A1 contracts so the UI tests exercise exactly the shapes
 * the sanitized A2 projections can serve.
 */
export const AUTOMATION_UI_TEST_IDS = {
  automation: "aa000000-0000-4000-8000-000000000001",
  otherAutomation: "aa000000-0000-4000-8000-000000000002",
  run: "aa000000-0000-4000-8000-000000000010",
  otherRun: "aa000000-0000-4000-8000-000000000011",
  project: "aa000000-0000-4000-8000-000000000020",
  otherProject: "aa000000-0000-4000-8000-000000000021",
  bindingRevision: "aa000000-0000-4000-8000-000000000030",
  executionProfile: "aa000000-0000-4000-8000-000000000040",
  authorityProfile: "aa000000-0000-4000-8000-000000000050",
  deliveryTargetRevision: "aa000000-0000-4000-8000-000000000060",
  providerInstance: "aa000000-0000-4000-8000-000000000070",
  runNowRequest: "aa000000-0000-4000-8000-000000000080",
  firstTurnRequest: "aa000000-0000-4000-8000-0000000000a0",
  thread: "aa000000-0000-4000-8000-0000000000d0",
  actor: "aa000000-0000-4000-8000-0000000000b0",
  repository: `repo_${"a".repeat(64)}`,
  checkout: "aa000000-0000-4000-8000-0000000000e1",
  worktreeReceipt: "aa000000-0000-4000-8000-0000000000e2",
  codeExecutionProfile: "aa000000-0000-4000-8000-0000000000f0",
  codeAuthorityProfile: "aa000000-0000-4000-8000-0000000000f1",
} as const;

export const AUTOMATION_UI_TEST_NOW = "2026-08-10T12:00:00.000Z";
export const AUTOMATION_UI_TEST_DUE = "2026-09-01T09:00:00.000Z";

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

const approvalGatedCodeAuthority = {
  ...approvalGatedWorkAuthority,
  shell: true,
  git: true,
} as const;

export function automationWorkDraftFixture(
  overrides: Partial<AutomationDefinitionDraft> = {},
): AutomationDefinitionDraft {
  return {
    displayName: "Weekly summary",
    taskPrompt: "Summarize the Project's open work.",
    hostId: "local",
    mode: "work",
    projectId: AUTOMATION_UI_TEST_IDS.project,
    projectVersion: 1,
    binding: {
      kind: "work",
      hostId: "local",
      projectId: AUTOMATION_UI_TEST_IDS.project,
      projectVersion: 1,
      bindingRevisionId: AUTOMATION_UI_TEST_IDS.bindingRevision,
      bindingReceiptId: `${"A".repeat(42)}A`,
    },
    executionProfile: {
      profileId: AUTOMATION_UI_TEST_IDS.executionProfile,
      profileVersion: 1,
      hostId: "local",
      mode: "work",
      projectId: AUTOMATION_UI_TEST_IDS.project,
      providerInstanceId: AUTOMATION_UI_TEST_IDS.providerInstance,
      modelId: "approved-model",
      executionPolicy: "approval-gated",
      permissionPersistence: "current-session",
    },
    authorityProfile: {
      profileId: AUTOMATION_UI_TEST_IDS.authorityProfile,
      profileVersion: 1,
      requested: approvalGatedWorkAuthority,
      effective: approvalGatedWorkAuthority,
      effectiveAuthorityDigest: "automation-authority-digest",
    },
    deliveryTarget: {
      revisionId: AUTOMATION_UI_TEST_IDS.deliveryTargetRevision,
      revision: 1,
      mode: "work",
      summary: "A confirmed weekly summary document exists in the Project.",
      confirmed: true,
      confirmedBy: AUTOMATION_UI_TEST_IDS.actor,
      confirmedAt: AUTOMATION_UI_TEST_NOW,
    },
    trigger: { kind: "once", scheduledAt: AUTOMATION_UI_TEST_DUE },
    missedRunPolicy: "skip",
    targetPolicy: "new-thread",
    ...overrides,
  } as unknown as AutomationDefinitionDraft;
}

export function automationCodeDraftFixture(
  overrides: Partial<AutomationDefinitionDraft> = {},
): AutomationDefinitionDraft {
  const work = automationWorkDraftFixture();
  return automationWorkDraftFixture({
    displayName: "Nightly build check",
    mode: "code",
    projectId: AUTOMATION_UI_TEST_IDS.otherProject,
    binding: {
      kind: "code",
      hostId: "local",
      projectId: AUTOMATION_UI_TEST_IDS.otherProject,
      projectVersion: 1,
      bindingRevisionId: AUTOMATION_UI_TEST_IDS.bindingRevision,
      repositoryId: AUTOMATION_UI_TEST_IDS.repository,
      checkoutId: AUTOMATION_UI_TEST_IDS.checkout,
      worktreeReceiptId: AUTOMATION_UI_TEST_IDS.worktreeReceipt,
    },
    executionProfile: {
      ...work.executionProfile,
      profileId: AUTOMATION_UI_TEST_IDS.codeExecutionProfile,
      mode: "code",
      projectId: AUTOMATION_UI_TEST_IDS.otherProject,
    },
    authorityProfile: {
      ...work.authorityProfile,
      profileId: AUTOMATION_UI_TEST_IDS.codeAuthorityProfile,
      requested: approvalGatedCodeAuthority,
      effective: approvalGatedCodeAuthority,
    },
    deliveryTarget: {
      ...work.deliveryTarget,
      mode: "code",
      summary: "A green build report exists on the checkout.",
    },
    ...overrides,
  } as Partial<AutomationDefinitionDraft>);
}

export function automationDefinitionFixture(
  overrides: Partial<AutomationDefinition> = {},
): AutomationDefinition {
  return decodeAutomationDefinition({
    id: AUTOMATION_UI_TEST_IDS.automation,
    ...automationWorkDraftFixture(),
    lifecycle: "enabled",
    definitionRevision: 1,
    nextDueAt: AUTOMATION_UI_TEST_DUE,
    createdBy: { kind: "local-window", windowId: "window-1", capabilityGeneration: 0 },
    updatedBy: { kind: "local-window", windowId: "window-1", capabilityGeneration: 0 },
    version: 1,
    createdAt: AUTOMATION_UI_TEST_NOW,
    updatedAt: AUTOMATION_UI_TEST_NOW,
    ...overrides,
  });
}

export function automationSummaryFixture(
  overrides: Partial<AutomationSummary> = {},
): AutomationSummary {
  return {
    id: AUTOMATION_UI_TEST_IDS.automation,
    displayName: "Weekly summary",
    hostId: "local",
    mode: "work",
    projectId: AUTOMATION_UI_TEST_IDS.project,
    lifecycle: "enabled",
    definitionRevision: 1,
    trigger: { kind: "weekly-local", weekdays: [1], localTime: "09:00", timeZone: "UTC" },
    nextDueAt: AUTOMATION_UI_TEST_DUE,
    latestRunLifecycle: "completed",
    version: 1,
    updatedAt: AUTOMATION_UI_TEST_NOW,
    ...overrides,
  } as AutomationSummary;
}

export interface AutomationRunFixtureOverrides {
  readonly id?: string;
  readonly lifecycle?: AutomationRun["lifecycle"];
  readonly withThread?: boolean;
  readonly threadId?: string;
  readonly failureMessage?: string;
  readonly at?: string;
}

/** Build a manual run that is contract-consistent with the definition. */
export function automationRunFixture(
  definition: AutomationDefinition,
  overrides: AutomationRunFixtureOverrides = {},
): AutomationRun {
  const at = overrides.at ?? AUTOMATION_UI_TEST_NOW;
  const lifecycle = overrides.lifecycle ?? "queued";
  const threadId = overrides.threadId ?? AUTOMATION_UI_TEST_IDS.thread;
  const withThread =
    overrides.withThread ?? ["running", "waiting", "completed", "interrupted"].includes(lifecycle);
  const occurrence = {
    kind: "manual",
    automationId: definition.id,
    definitionRevision: definition.definitionRevision,
    runNowRequestId: AUTOMATION_UI_TEST_IDS.runNowRequest,
  } as const;
  const authoritySnapshot = {
    profileId: definition.authorityProfile.profileId,
    profileVersion: definition.authorityProfile.profileVersion,
    requested: definition.authorityProfile.requested,
    effective: definition.authorityProfile.effective,
    effectiveAuthorityDigest: definition.authorityProfile.effectiveAuthorityDigest,
    capturedAt: at,
  };
  return decodeAutomationRun({
    id: overrides.id ?? AUTOMATION_UI_TEST_IDS.run,
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
    authoritySnapshot,
    ...(withThread
      ? {
          threadId,
          dispatchIntent: {
            firstTurnRequestId: AUTOMATION_UI_TEST_IDS.firstTurnRequest,
            threadId,
            authoritySnapshot,
            promptDigest: "prompt-digest",
            recordedAt: at,
          },
          ...(["running", "waiting", "completed", "interrupted"].includes(lifecycle)
            ? {
                firstTurnAcceptance: {
                  firstTurnRequestId: AUTOMATION_UI_TEST_IDS.firstTurnRequest,
                  runtimeReceipt: "runtime-receipt",
                  acceptedAt: at,
                },
              }
            : {}),
        }
      : {}),
    firstTurnRequestId: AUTOMATION_UI_TEST_IDS.firstTurnRequest,
    lifecycle,
    ...(lifecycle === "failed"
      ? {
          failure: {
            reason: "delivery-target-invalid",
            message: overrides.failureMessage ?? "The delivery target no longer matches.",
          },
        }
      : {}),
    notificationRefs: [],
    ...(["completed", "failed", "cancelled"].includes(lifecycle) ? { completedAt: at } : {}),
    version: 1,
    createdAt: at,
    updatedAt: at,
  });
}
