import {
  AutomationFileActivityWindowLimit,
  AutomationFileArrivalTrigger,
  AutomationFileSourceCheckpoint,
  AutomationFileSourceSummary,
  AutomationSourceDigest,
  AutomationSourceRelativePath,
  MAX_AUTOMATION_FILE_START_LIMIT,
  MAX_AUTOMATION_SOURCE_FILES,
} from "./automationFileArrival";
import { NonNegativeInt, PositiveInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
export * from "./automationFileArrival";
import {
  AUTOMATION_WEBHOOK_INTEGRATION_ID,
  AutomationIntegrationEventTrigger,
  AutomationIntegrationEventReceipt,
  AutomationEventSourceCheckpoint,
  AutomationIntegrationEvent,
} from "./automationEvents";
export * from "./automationEvents";
import { Schema } from "effect";
import { AgentProfileId } from "./agentProfile";
import { AgentRunAuthority } from "./agentRun";
import { CodeCheckoutId, CodeRepositoryId, WorktreeReceiptId } from "./code";
import { ActorId, AggregateVersion, UtcTimestamp } from "./events";
import { HostId } from "./host";
import { BindingReceiptId, BindingRevisionId, ProjectId } from "./projects";
import {
  PermissionPersistence,
  ProviderExecutionPolicy,
  ProviderInstanceId,
  ProviderModelId,
} from "./providers";

const brandedUuid = <B extends string>(brand: Parameters<typeof Schema.brand<B>>[0]) =>
  Schema.String.pipe(Schema.check(Schema.isGUID()), Schema.brand<B>(brand));
const boundedText = (maximum: number) =>
  Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(maximum));
const positiveInteger = PositiveInt;
const nonNegativeInteger = NonNegativeInt;

export const MAX_AUTOMATION_DISPLAY_NAME_LENGTH = 255;
export const MAX_AUTOMATION_TASK_PROMPT_LENGTH = 8_192;
export const MAX_AUTOMATION_TARGET_SUMMARY_LENGTH = 2_048;
export const MAX_AUTOMATION_FAILURE_MESSAGE_LENGTH = 1_024;
export const MAX_AUTOMATION_NOTIFICATION_REFERENCES = 32;
export const MAX_AUTOMATION_HISTORY_ENTRIES = 256;
export const MAX_AUTOMATION_QUERY_LIMIT = 100;
export const MAX_AUTOMATION_QUERY_CURSOR_LENGTH = 256;
export const MAX_AUTOMATION_MISSED_RUN_CAP = 10_000;
export const AutomationMissedRunCap = Schema.Int.pipe(
  Schema.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(MAX_AUTOMATION_MISSED_RUN_CAP),
  ),
  Schema.brand("AutomationMissedRunCap"),
);
export type AutomationMissedRunCap = typeof AutomationMissedRunCap.Type;

// ── Stable identifiers and bounded scalar contracts ────────────────────────

export const AutomationId = brandedUuid("AutomationId");
export type AutomationId = typeof AutomationId.Type;
export const AutomationRunId = brandedUuid("AutomationRunId");
export type AutomationRunId = typeof AutomationRunId.Type;
export const AutomationDefinitionRevisionId = brandedUuid("AutomationDefinitionRevisionId");
export type AutomationDefinitionRevisionId = typeof AutomationDefinitionRevisionId.Type;
export const AutomationAuthorityProfileId = brandedUuid("AutomationAuthorityProfileId");
export type AutomationAuthorityProfileId = typeof AutomationAuthorityProfileId.Type;
export const AutomationDeliveryTargetRevisionId = brandedUuid("AutomationDeliveryTargetRevisionId");
export type AutomationDeliveryTargetRevisionId = typeof AutomationDeliveryTargetRevisionId.Type;
export const AutomationRunNowRequestId = brandedUuid("AutomationRunNowRequestId");
export type AutomationRunNowRequestId = typeof AutomationRunNowRequestId.Type;
export const AutomationCancelRunRequestId = brandedUuid("AutomationCancelRunRequestId");
export type AutomationCancelRunRequestId = typeof AutomationCancelRunRequestId.Type;
export const AutomationFirstTurnRequestId = brandedUuid("AutomationFirstTurnRequestId");
export type AutomationFirstTurnRequestId = typeof AutomationFirstTurnRequestId.Type;
export const AutomationThreadId = brandedUuid("AutomationThreadId");
export type AutomationThreadId = typeof AutomationThreadId.Type;

const AutomationDefinitionRevision = positiveInteger.pipe(
  Schema.check(Schema.isLessThanOrEqualTo(MAX_AUTOMATION_MISSED_RUN_CAP)),
  Schema.brand("AutomationDefinitionRevision"),
);
export { AutomationDefinitionRevision };
export type AutomationDefinitionRevision = typeof AutomationDefinitionRevision.Type;

const AutomationRunGeneration = positiveInteger.pipe(
  Schema.check(Schema.isLessThanOrEqualTo(MAX_AUTOMATION_MISSED_RUN_CAP)),
  Schema.brand("AutomationRunGeneration"),
);
export { AutomationRunGeneration };
export type AutomationRunGeneration = typeof AutomationRunGeneration.Type;

const AutomationOpaqueReference = boundedText(256).pipe(Schema.brand("AutomationOpaqueReference"));
export { AutomationOpaqueReference };
export type AutomationOpaqueReference = typeof AutomationOpaqueReference.Type;

const AutomationDigest = boundedText(128).pipe(Schema.brand("AutomationDigest"));
export { AutomationDigest };
export type AutomationDigest = typeof AutomationDigest.Type;

const AutomationFailureMessage = boundedText(MAX_AUTOMATION_FAILURE_MESSAGE_LENGTH);

// ── Trigger contracts ──────────────────────────────────────────────────────

export const AutomationTriggerKind = Schema.Literals([
  "once",
  "interval",
  "weekly-local",
  "file-arrival",
  "integration-event",
]);
export type AutomationTriggerKind = typeof AutomationTriggerKind.Type;

export const AutomationMissedRunPolicy = Schema.Literals(["skip", "run-once"]);
export type AutomationMissedRunPolicy = typeof AutomationMissedRunPolicy.Type;

/**
 * Where a run's turn goes. `new-thread` starts a fresh thread for each run.
 * `same-thread` is a one-time follow-up: its single run sends the fixed
 * prompt as a new turn in the thread the routine came from, so the agent has
 * that conversation. Only a once trigger may use it.
 */
export const AutomationTargetPolicy = Schema.Literals(["new-thread", "same-thread"]);
export type AutomationTargetPolicy = typeof AutomationTargetPolicy.Type;

/**
 * How late a missed follow-up may still run once the host is back. A
 * follow-up exists to check on something at about a chosen time; a day later
 * the check is stale, so past this it is recorded as missed instead.
 */
export const AUTOMATION_FOLLOW_UP_MISSED_WINDOW_MS = 24 * 60 * 60 * 1_000;

/**
 * The first line of the turn a follow-up sends into its thread. It tells the
 * agent the turn was scheduled, and the transcript shows such a turn as
 * scheduled rather than typed.
 */
export const AUTOMATION_FOLLOW_UP_TURN_HEADING =
  "Scheduled follow-up you set up earlier in this thread:";

/** The text a follow-up's turn sends: the heading, then the fixed prompt. */
export function automationFollowUpTurnPrompt(taskPrompt: string): string {
  return `${AUTOMATION_FOLLOW_UP_TURN_HEADING}\n\n${taskPrompt}`;
}

/** The fixed prompt of a follow-up's turn text, or undefined when the text is not one. */
export function parseAutomationFollowUpTurnPrompt(text: string): string | undefined {
  const prefix = `${AUTOMATION_FOLLOW_UP_TURN_HEADING}\n\n`;
  return text.startsWith(prefix) ? text.slice(prefix.length) : undefined;
}

export const AutomationLifecycle = Schema.Literals(["enabled", "paused", "exhausted", "archived"]);
export type AutomationLifecycle = typeof AutomationLifecycle.Type;

export const AutomationRunLifecycle = Schema.Literals([
  "queued",
  "awaiting-confirmation",
  "dispatching",
  "recovering-dispatch",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "skipped",
]);
export type AutomationRunLifecycle = typeof AutomationRunLifecycle.Type;
const AUTOMATION_POST_LAUNCH_LIFECYCLES: ReadonlySet<AutomationRunLifecycle> = new Set([
  "running",
  "waiting",
  "completed",
  "interrupted",
]);
const AUTOMATION_PRE_LAUNCH_LIFECYCLES: ReadonlySet<AutomationRunLifecycle> = new Set([
  "queued",
  "awaiting-confirmation",
  "dispatching",
  "recovering-dispatch",
]);
export const AutomationDefinitionLifecycle = AutomationLifecycle;
export type AutomationDefinitionLifecycle = AutomationLifecycle;
export const AutomationRunStatus = AutomationRunLifecycle;
export type AutomationRunStatus = AutomationRunLifecycle;

export const AutomationWeekday = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(7)),
  Schema.brand("AutomationWeekday"),
);
export type AutomationWeekday = typeof AutomationWeekday.Type;

const AutomationWeekdays = Schema.NonEmptyArray(AutomationWeekday).check(
  Schema.isMaxLength(7),
  Schema.makeFilter((weekdays) => new Set(weekdays).size === weekdays.length),
);
export { AutomationWeekdays };
export type AutomationWeekdays = typeof AutomationWeekdays.Type;

export const AutomationLocalTime = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^(?:[01]\d|2[0-3]):[0-5]\d$/)),
  Schema.brand("AutomationLocalTime"),
);
export type AutomationLocalTime = typeof AutomationLocalTime.Type;

export const AutomationLocalDate = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/),
    Schema.makeFilter((date) => {
      const parsed = new Date(`${date}T00:00:00.000Z`);
      return parsed.toISOString().slice(0, 10) === date;
    }),
  ),
  Schema.brand("AutomationLocalDate"),
);
export type AutomationLocalDate = typeof AutomationLocalDate.Type;

export const AutomationWeeklyResolution = Schema.Struct({
  resolutionVersion: positiveInteger.check(Schema.isLessThanOrEqualTo(32)),
  timeZone: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
  timeZoneDatabase: boundedText(64),
  resolvedAt: UtcTimestamp,
  resolvedLocalDate: AutomationLocalDate,
  resolvedLocalTime: AutomationLocalTime,
  utcOffsetMinutes: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(-1_440),
    Schema.isLessThanOrEqualTo(1_440),
  ),
  resolution: Schema.Literals(["exact", "gap-forward", "fold-earlier"]),
});
export type AutomationWeeklyResolution = typeof AutomationWeeklyResolution.Type;

/** An IANA identifier validated against the host runtime's timezone database. */
export const AutomationTimeZone = Schema.Trimmed.pipe(
  Schema.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(128),
    Schema.makeFilter((timeZone) => {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone }).format();
        return true;
      } catch {
        return false;
      }
    }),
  ),
  Schema.brand("AutomationTimeZone"),
);
export type AutomationTimeZone = typeof AutomationTimeZone.Type;

export const AutomationIntervalMinutes = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(15), Schema.isLessThanOrEqualTo(43_200)),
  Schema.brand("AutomationIntervalMinutes"),
);
export type AutomationIntervalMinutes = typeof AutomationIntervalMinutes.Type;

export const AutomationOnceTrigger = Schema.Struct({
  kind: Schema.Literal("once"),
  scheduledAt: UtcTimestamp,
});
export type AutomationOnceTrigger = typeof AutomationOnceTrigger.Type;

export const AutomationIntervalTrigger = Schema.Struct({
  kind: Schema.Literal("interval"),
  anchorAt: UtcTimestamp,
  intervalMinutes: AutomationIntervalMinutes,
});
export type AutomationIntervalTrigger = typeof AutomationIntervalTrigger.Type;

export const AutomationWeeklyLocalTrigger = Schema.Struct({
  kind: Schema.Literal("weekly-local"),
  weekdays: AutomationWeekdays,
  localTime: AutomationLocalTime,
  timeZone: AutomationTimeZone,
});
export type AutomationWeeklyLocalTrigger = typeof AutomationWeeklyLocalTrigger.Type;

export const AutomationScheduledTrigger = Schema.Union([
  AutomationOnceTrigger,
  AutomationIntervalTrigger,
  AutomationWeeklyLocalTrigger,
]);
export type AutomationScheduledTrigger = typeof AutomationScheduledTrigger.Type;
export const AutomationTrigger = Schema.Union([
  AutomationScheduledTrigger,
  AutomationFileArrivalTrigger,
  AutomationIntegrationEventTrigger,
]);
export type AutomationTrigger = typeof AutomationTrigger.Type;

// ── Authority, principal, and binding receipts ─────────────────────────────

export const AutomationMode = Schema.Literals(["chat", "work", "code"]);
export type AutomationMode = typeof AutomationMode.Type;

/**
 * The modes whose threads have a folder, so a routine that starts a new
 * thread per run can be proposed from one of their threads. A follow-up can
 * return to a thread of any mode, Chat included (maintainer decision,
 * 2026-11-21), so it takes {@link AutomationMode}.
 */
export const AutomationThreadMode = Schema.Literals(["work", "code"]);
export type AutomationThreadMode = typeof AutomationThreadMode.Type;

const AutomationLocalUserPrincipal = Schema.Struct({
  kind: Schema.Literal("local-user"),
  actorId: ActorId,
});

const AutomationLocalWindowPrincipal = Schema.Struct({
  kind: Schema.Literal("local-window"),
  windowId: AutomationOpaqueReference,
  // The current authenticated desktop principal uses generation zero until
  // a durable capability-generation counter exists on the wire.
  capabilityGeneration: nonNegativeInteger,
});

const AutomationRemoteDevicePrincipal = Schema.Struct({
  kind: Schema.Literal("remote-device"),
  hostId: HostId,
  deviceId: AutomationOpaqueReference,
  credentialGeneration: positiveInteger,
  origin: AutomationOpaqueReference,
  protocolVersion: positiveInteger,
  capabilityDigest: AutomationDigest,
  sessionId: AutomationOpaqueReference,
  // Who let the device onto the host, as the remote gateway marks every
  // device principal. A command carries the authenticated principal whole, so
  // a strict struct without this refused every paired device's command.
  admittedBy: Schema.optional(Schema.Literals(["host-person", "hub-roster"])),
  // A narrowed device's level, marked beside its admission for the same reason.
  accessLevel: Schema.optional(Schema.Literals(["approve-and-steer", "read-only"])),
});

/** Authenticated principals accepted on mutation commands. */
export const AutomationClientPrincipal = Schema.Union([
  AutomationLocalWindowPrincipal,
  AutomationRemoteDevicePrincipal,
]);
export type AutomationClientPrincipal = typeof AutomationClientPrincipal.Type;
export const ClientPrincipal = AutomationClientPrincipal;
export type ClientPrincipal = AutomationClientPrincipal;

const reviewCounter = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const reviewPositiveCounter = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const AutomationFileSourceReviewFields = {
  expectedDefinitionVersion: reviewPositiveCounter,
  previousObservationRevision: reviewPositiveCounter,
  previousSourceIdentity: AutomationSourceDigest,
  previousBatchDigest: AutomationSourceDigest,
  disposition: Schema.Literals(["skip", "run-once"]),
  reviewedAt: UtcTimestamp,
} as const;

/**
 * The person's review of a held file batch, naming who reviewed it: a window
 * on this host, or a device the host's own person paired, which may do what a
 * window may (maintainer decision, 2026-11-12). Recovery rebuilds the
 * routine's author from it, so it carries the whole device principal. A
 * hub-introduced or restricted device never reviews, so its form is refused.
 */
export const AutomationFileSourceReview = Schema.Union([
  Schema.Struct({
    ...AutomationFileSourceReviewFields,
    reviewedWindowId: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
    reviewedCapabilityGeneration: reviewCounter,
  }),
  Schema.Struct({
    ...AutomationFileSourceReviewFields,
    reviewedDevice: AutomationRemoteDevicePrincipal,
  }).check(Schema.makeFilter((review) => review.reviewedDevice.admittedBy === "host-person")),
]);
export type AutomationFileSourceReview = typeof AutomationFileSourceReview.Type;

/**
 * The wire invariant the lifecycle schema keeps at decode: the review the
 * event carries was made by the principal the event names as its author.
 * Callers that need the same matching use `automationFileSourceReviewedBy`
 * in `@octant/domain`; this stays private to the schema.
 */
function fileSourceReviewMatchesAuthor(
  review: AutomationFileSourceReview,
  author: AutomationAuthorPrincipal,
): boolean {
  if ("reviewedDevice" in review)
    return (
      author.kind === "remote-device" &&
      String(author.hostId) === String(review.reviewedDevice.hostId) &&
      String(author.deviceId) === String(review.reviewedDevice.deviceId) &&
      author.credentialGeneration === review.reviewedDevice.credentialGeneration &&
      String(author.sessionId) === String(review.reviewedDevice.sessionId)
    );
  return (
    author.kind === "local-window" &&
    String(author.windowId) === review.reviewedWindowId &&
    author.capabilityGeneration === review.reviewedCapabilityGeneration
  );
}

export const AutomationFileArrivalReceipt = Schema.Struct({
  checkpoint: AutomationFileSourceCheckpoint,
  files: Schema.Array(AutomationSourceRelativePath).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_AUTOMATION_SOURCE_FILES),
  ),
  automaticStartOrdinal: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: MAX_AUTOMATION_FILE_START_LIMIT }),
  ),
  rearm: Schema.optional(AutomationFileSourceReview),
}).check(
  Schema.makeFilter(
    (receipt) =>
      (receipt.rearm === undefined || receipt.rearm.disposition === "run-once") &&
      receipt.automaticStartOrdinal === receipt.checkpoint.automaticStarts &&
      receipt.checkpoint.baselineReady &&
      (receipt.checkpoint.phase === "watching" ||
        (receipt.checkpoint.phase === "needs-rearm" &&
          receipt.checkpoint.reason === "automatic-start-limit")) &&
      new Set(receipt.files).size === receipt.files.length &&
      receipt.files.every((path) => receipt.checkpoint.baseline.some((file) => file.path === path)),
  ),
);
export type AutomationFileArrivalReceipt = typeof AutomationFileArrivalReceipt.Type;

/** Separate author attribution may retain the local actor identity. */
export const AutomationAuthorPrincipal = Schema.Union([
  AutomationLocalUserPrincipal,
  AutomationLocalWindowPrincipal,
  AutomationRemoteDevicePrincipal,
]);
export type AutomationAuthorPrincipal = typeof AutomationAuthorPrincipal.Type;

// Keep the authenticated command principal separate from author attribution:
// a local-user actor UUID is not proof of an authenticated request.

export const AutomationOrigin = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("interactive") }),
  Schema.Struct({
    kind: Schema.Literal("automation-run"),
    automationId: AutomationId,
    runId: AutomationRunId,
    occurrenceKey: AutomationOpaqueReference,
  }),
]);
export type AutomationOrigin = typeof AutomationOrigin.Type;
export const AutomationRunOrigin = AutomationOrigin;
export type AutomationRunOrigin = AutomationOrigin;

/** Automation authority is the existing provider-neutral run authority shape. */
export const AutomationAuthority = AgentRunAuthority;
export type AutomationAuthority = AgentRunAuthority;

export const AutomationBindingReceipt = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("chat"),
    hostId: HostId,
    projectId: ProjectId,
    projectVersion: AggregateVersion,
  }),
  Schema.Struct({
    kind: Schema.Literal("work"),
    hostId: HostId,
    projectId: ProjectId,
    projectVersion: AggregateVersion,
    bindingRevisionId: BindingRevisionId,
    bindingReceiptId: BindingReceiptId,
  }),
  Schema.Struct({
    kind: Schema.Literal("code"),
    hostId: HostId,
    projectId: ProjectId,
    projectVersion: AggregateVersion,
    bindingRevisionId: BindingRevisionId,
    repositoryId: CodeRepositoryId,
    checkoutId: CodeCheckoutId,
    worktreeReceiptId: WorktreeReceiptId,
  }),
]);
export type AutomationBindingReceipt = typeof AutomationBindingReceipt.Type;

export const AutomationExecutionProfileReceipt = Schema.Struct({
  profileId: AgentProfileId,
  profileVersion: AggregateVersion,
  hostId: HostId,
  mode: AutomationMode,
  projectId: ProjectId,
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  executionPolicy: ProviderExecutionPolicy,
  permissionPersistence: PermissionPersistence,
});
export type AutomationExecutionProfileReceipt = typeof AutomationExecutionProfileReceipt.Type;

export const AutomationAuthorityProfileReceipt = Schema.Struct({
  profileId: AutomationAuthorityProfileId,
  profileVersion: AggregateVersion,
  requested: AgentRunAuthority,
  effective: AgentRunAuthority,
  effectiveAuthorityDigest: AutomationDigest,
});
export type AutomationAuthorityProfileReceipt = typeof AutomationAuthorityProfileReceipt.Type;

const automationAuthorityExecutionPolicyRank: Record<AgentRunAuthority["executionPolicy"], number> =
  {
    plan: 0,
    "approval-gated": 1,
    "auto-accept-edits": 2,
    "full-access": 3,
  };

const automationAuthorityCapabilityKeys = [
  "filesystem",
  "shell",
  "git",
  "network",
  "tools",
  "subagents",
] as const;

function automationAuthorityDoesNotWiden(
  requested: AgentRunAuthority,
  effective: AgentRunAuthority,
): boolean {
  if (
    automationAuthorityCapabilityKeys.some((key) => effective[key] && !requested[key]) ||
    (requested.permissionPersistence === "current-session" &&
      effective.permissionPersistence === "project-default")
  ) {
    return false;
  }
  return (
    automationAuthorityExecutionPolicyRank[effective.executionPolicy] <=
    automationAuthorityExecutionPolicyRank[requested.executionPolicy]
  );
}

function automationAuthorityProfileFitsExecutionProfile(
  authorityProfile: AutomationAuthorityProfileReceipt,
  executionProfile: AutomationExecutionProfileReceipt,
): boolean {
  const executionPolicyCeiling =
    automationAuthorityExecutionPolicyRank[executionProfile.executionPolicy];
  return (
    automationAuthorityExecutionPolicyRank[authorityProfile.requested.executionPolicy] <=
      executionPolicyCeiling &&
    automationAuthorityExecutionPolicyRank[authorityProfile.effective.executionPolicy] <=
      executionPolicyCeiling &&
    (executionProfile.permissionPersistence === "project-default" ||
      (authorityProfile.requested.permissionPersistence === "current-session" &&
        authorityProfile.effective.permissionPersistence === "current-session"))
  );
}

export const AutomationAuthoritySnapshot = Schema.Struct({
  profileId: AutomationAuthorityProfileId,
  profileVersion: AggregateVersion,
  requested: AgentRunAuthority,
  effective: AgentRunAuthority,
  effectiveAuthorityDigest: AutomationDigest,
  capturedAt: UtcTimestamp,
}).check(
  Schema.makeFilter(
    (snapshot) =>
      snapshot.requested.executionPolicy !== "full-access" &&
      snapshot.effective.executionPolicy !== "full-access" &&
      automationAuthorityDoesNotWiden(snapshot.requested, snapshot.effective),
  ),
);
export type AutomationAuthoritySnapshot = typeof AutomationAuthoritySnapshot.Type;

export const AutomationDeliveryTargetTemplate = Schema.Struct({
  revisionId: AutomationDeliveryTargetRevisionId,
  revision: positiveInteger,
  mode: AutomationMode,
  summary: boundedText(MAX_AUTOMATION_TARGET_SUMMARY_LENGTH),
  confirmed: Schema.Literal(true),
  confirmedBy: ActorId,
  confirmedAt: UtcTimestamp,
});
export type AutomationDeliveryTargetTemplate = typeof AutomationDeliveryTargetTemplate.Type;

export const AutomationDeliveryTargetReceipt = AutomationDeliveryTargetTemplate;
export type AutomationDeliveryTargetReceipt = AutomationDeliveryTargetTemplate;

// ── Definition, occurrence, and run aggregates ─────────────────────────────

export const AutomationBlockReason = Schema.Literals([
  "missed-run-cap-exceeded",
  "host-mismatch",
  "project-mismatch",
  "binding-mismatch",
  "execution-profile-mismatch",
  "provider-capability-mismatch",
  "authority-mismatch",
  "delivery-target-invalid",
  "full-access-ineligible",
  "unsupported-mode",
  "automation-recursion",
  "thread-unavailable",
  "thread-done",
  "thread-busy",
  "follow-up-missed",
]);
export type AutomationBlockReason = typeof AutomationBlockReason.Type;

export const AutomationRuntimeFailureReason = Schema.Literals([
  "dispatch-failed",
  "thread-creation-failed",
  "provider-launch-failed",
  "recovery-failed",
  "runtime-failed",
]);
export type AutomationRuntimeFailureReason = typeof AutomationRuntimeFailureReason.Type;

export const AutomationRunFailureReason = Schema.Union([
  AutomationBlockReason,
  AutomationRuntimeFailureReason,
]);
export type AutomationRunFailureReason = typeof AutomationRunFailureReason.Type;

/**
 * A person's per-routine choice to run at the level its Project's new threads
 * start at (the Code Project's mode or Settings › Code › Access, or
 * Settings › Chat & Work for a Work Project), Full access included, instead of
 * asking first. Absent asks first, as every routine did before. Only a person
 * at a window on this host sets it; a routine an agent proposed never has it.
 * It is part of the definition, so every change to it is journaled.
 */
export const AutomationProjectLevel = Schema.Literal("opted-in");
export type AutomationProjectLevel = typeof AutomationProjectLevel.Type;

/**
 * A level a person picks on the routine itself, for a Work or Code routine.
 * It is the highest level a run may use, never a grant: each run takes the
 * lower of this and the level its Project's new threads start at, so it can
 * lower a run below the Project's level and never raise it above. Only a
 * person at a window on this host sets it, and a routine an agent proposed
 * never has it. A Chat routine has no level because Chat has none to widen.
 */
export const AutomationRunLevel = Schema.Literals([
  "ask-first",
  "auto-accept-edits",
  "auto",
  "full-access",
]);
export type AutomationRunLevel = typeof AutomationRunLevel.Type;

/**
 * A person's per-routine choice, made when the routine is created or revised,
 * to let a Code run merge the pull request its own thread opened (with the
 * head and required checks still enforced by the host). Absent means a merge
 * asks for each act, as it always did. Only a person at a window on this host
 * sets it; a routine an agent proposed never has it. It is part of the
 * definition, so every change to it is journaled.
 */
export const AutomationAgentMerge = Schema.Literal("allowed");
export type AutomationAgentMerge = typeof AutomationAgentMerge.Type;

export const AutomationDefinitionDraft = Schema.Struct({
  displayName: boundedText(MAX_AUTOMATION_DISPLAY_NAME_LENGTH),
  taskPrompt: boundedText(MAX_AUTOMATION_TASK_PROMPT_LENGTH),
  hostId: HostId,
  mode: AutomationMode,
  projectId: ProjectId,
  projectVersion: AggregateVersion,
  binding: AutomationBindingReceipt,
  executionProfile: AutomationExecutionProfileReceipt,
  authorityProfile: AutomationAuthorityProfileReceipt,
  deliveryTarget: AutomationDeliveryTargetTemplate,
  trigger: AutomationTrigger,
  missedRunPolicy: AutomationMissedRunPolicy,
  targetPolicy: AutomationTargetPolicy,
  projectLevel: Schema.optional(AutomationProjectLevel),
  runLevel: Schema.optional(AutomationRunLevel),
  agentMerge: Schema.optional(AutomationAgentMerge),
});
export type AutomationDefinitionDraft = typeof AutomationDefinitionDraft.Type;

function automationAuthorityIsChat(authority: AgentRunAuthority): boolean {
  return !authority.filesystem && !authority.shell && !authority.git && !authority.subagents;
}

/**
 * A run a webhook starts never reaches Full access (decision H34): it may not
 * follow its Project's level, and may name no level above Ask first, so Code is
 * approval-gated at most and Work runs at its default. Checked when a routine is
 * saved and again before every occurrence.
 */
export function automationLevelFitsTrigger(
  definition: Pick<AutomationDefinitionDraft, "trigger" | "projectLevel" | "runLevel">,
): boolean {
  const trigger = definition.trigger;
  if (
    trigger.kind !== "integration-event" ||
    trigger.integrationId !== AUTOMATION_WEBHOOK_INTEGRATION_ID
  )
    return true;
  return (
    definition.projectLevel === undefined &&
    (definition.runLevel === undefined || definition.runLevel === "ask-first")
  );
}

function automationDefinitionDraftMatchesPolicy(definition: AutomationDefinitionDraft): boolean {
  if (
    !automationLevelFitsTrigger(definition) ||
    ((definition.trigger.kind === "file-arrival" ||
      definition.trigger.kind === "integration-event") &&
      (definition.mode === "chat" || definition.targetPolicy !== "new-thread")) ||
    definition.mode !== definition.binding.kind ||
    definition.binding.hostId !== definition.hostId ||
    definition.binding.projectId !== definition.projectId ||
    definition.binding.projectVersion !== definition.projectVersion ||
    definition.executionProfile.hostId !== definition.hostId ||
    definition.executionProfile.mode !== definition.mode ||
    definition.executionProfile.projectId !== definition.projectId ||
    definition.deliveryTarget.mode !== definition.mode ||
    definition.executionProfile.executionPolicy === "full-access" ||
    definition.authorityProfile.requested.executionPolicy === "full-access" ||
    definition.authorityProfile.effective.executionPolicy === "full-access" ||
    !automationAuthorityDoesNotWiden(
      definition.authorityProfile.requested,
      definition.authorityProfile.effective,
    ) ||
    !automationAuthorityProfileFitsExecutionProfile(
      definition.authorityProfile,
      definition.executionProfile,
    ) ||
    // A follow-up runs once, and late rather than never while inside its
    // missed window; the window, not the missed-run policy, bounds it.
    (definition.targetPolicy === "same-thread" &&
      (definition.trigger.kind !== "once" || definition.missedRunPolicy !== "run-once")) ||
    // One level choice at most: follow the Project's, or name one.
    (definition.projectLevel !== undefined && definition.runLevel !== undefined) ||
    // Chat has no level to pick, and its routine, a follow-up included,
    // keeps Chat's authority: no folder, shell, or Git, and no subagents.
    (definition.mode === "chat" &&
      (definition.projectLevel !== undefined ||
        definition.runLevel !== undefined ||
        definition.agentMerge !== undefined ||
        !automationAuthorityIsChat(definition.authorityProfile.requested) ||
        !automationAuthorityIsChat(definition.authorityProfile.effective)))
  ) {
    return false;
  }
  return true;
}

export const AutomationDefinition = Schema.Struct({
  id: AutomationId,
  ...AutomationDefinitionDraft.fields,
  lifecycle: AutomationLifecycle,
  definitionRevision: AutomationDefinitionRevision,
  nextDueAt: Schema.NullOr(UtcTimestamp),
  nextDueResolution: Schema.optional(AutomationWeeklyResolution),
  blockedReason: Schema.optional(AutomationBlockReason),
  /**
   * The run whose failure paused this routine, when the block receipt named
   * one: its recorded message is what a paused banner shows, not a newer
   * run's. Absent for a pause that came from revalidation rather than a run.
   */
  blockedRunId: Schema.optional(AutomationRunId),
  createdBy: AutomationAuthorPrincipal,
  updatedBy: AutomationAuthorPrincipal,
  /**
   * The Work or Code thread whose agent proposed this routine, when a person
   * confirmed it from that thread. Set by the host at creation, never by a
   * command body, and kept unchanged by every later revision.
   */
  originThreadId: Schema.optional(AutomationThreadId),
  version: AggregateVersion,
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
});
export type AutomationDefinition = typeof AutomationDefinition.Type;

function automationPersistedDefinitionMatchesPolicy(definition: AutomationDefinition): boolean {
  const dueEvidenceMatches =
    definition.nextDueAt === null
      ? definition.nextDueResolution === undefined
      : definition.trigger.kind === "file-arrival" ||
          definition.trigger.kind === "integration-event"
        ? false
        : definition.trigger.kind === "once"
          ? definition.nextDueAt === definition.trigger.scheduledAt &&
            definition.nextDueResolution === undefined
          : definition.trigger.kind === "interval"
            ? automationScheduledAtMatchesTrigger(definition.trigger, definition.nextDueAt) &&
              definition.nextDueResolution === undefined
            : automationWeeklyResolutionMatchesTrigger(
                definition.trigger,
                definition.nextDueAt,
                definition.nextDueResolution,
              );
  const enabledDueMatches =
    definition.lifecycle !== "enabled" ||
    (definition.trigger.kind === "file-arrival" || definition.trigger.kind === "integration-event"
      ? definition.nextDueAt === null
      : definition.trigger.kind === "once"
        ? definition.nextDueAt === definition.trigger.scheduledAt
        : definition.nextDueAt !== null);
  return (
    automationDefinitionDraftMatchesPolicy(definition) &&
    (definition.trigger.kind !== "integration-event" ||
      (definition.trigger.sourceIdentity !== undefined &&
        definition.trigger.sourceLabel !== undefined)) &&
    (definition.targetPolicy !== "same-thread" || definition.originThreadId !== undefined) &&
    dueEvidenceMatches &&
    enabledDueMatches &&
    (definition.lifecycle !== "enabled" ||
      (definition.blockedReason === undefined && definition.blockedRunId === undefined)) &&
    !(
      (definition.lifecycle === "archived" || definition.lifecycle === "exhausted") &&
      definition.nextDueAt !== null
    )
  );
}

const AutomationPersistedDefinition = AutomationDefinition.check(
  Schema.makeFilter(automationPersistedDefinitionMatchesPolicy),
);

export const AutomationDefinitionSnapshot = Schema.Struct({
  automationId: AutomationId,
  definitionRevision: AutomationDefinitionRevision,
  ...AutomationDefinitionDraft.fields,
}).check(Schema.makeFilter(automationDefinitionDraftMatchesPolicy));
export type AutomationDefinitionSnapshot = typeof AutomationDefinitionSnapshot.Type;

export const AutomationScheduledOccurrence = Schema.Struct({
  kind: Schema.Literal("scheduled"),
  automationId: AutomationId,
  definitionRevision: AutomationDefinitionRevision,
  triggerKind: Schema.Literals(["once", "interval", "weekly-local"]),
  scheduledAt: UtcTimestamp,
  resolutionEvidence: Schema.optional(AutomationWeeklyResolution),
}).check(
  Schema.makeFilter(
    (occurrence) =>
      (occurrence.triggerKind === "weekly-local") === (occurrence.resolutionEvidence !== undefined),
  ),
);
export type AutomationScheduledOccurrence = typeof AutomationScheduledOccurrence.Type;

export const AutomationManualOccurrence = Schema.Struct({
  kind: Schema.Literal("manual"),
  automationId: AutomationId,
  definitionRevision: AutomationDefinitionRevision,
  runNowRequestId: AutomationRunNowRequestId,
  retryOfRunId: Schema.optional(AutomationRunId),
  fileSource: Schema.optional(AutomationFileArrivalReceipt),
  eventSource: Schema.optional(AutomationIntegrationEventReceipt),
}).check(
  Schema.makeFilter(
    (occurrence) =>
      (occurrence.fileSource === undefined && occurrence.eventSource === undefined) ||
      occurrence.retryOfRunId !== undefined,
  ),
);
export type AutomationManualOccurrence = typeof AutomationManualOccurrence.Type;

export const AutomationFileArrivalOccurrence = Schema.Struct({
  kind: Schema.Literal("file-arrival"),
  automationId: AutomationId,
  definitionRevision: AutomationDefinitionRevision,
  source: AutomationFileArrivalReceipt,
});
export type AutomationFileArrivalOccurrence = typeof AutomationFileArrivalOccurrence.Type;

export const AutomationIntegrationEventOccurrence = Schema.Struct({
  kind: Schema.Literal("integration-event"),
  automationId: AutomationId,
  definitionRevision: AutomationDefinitionRevision,
  source: AutomationIntegrationEventReceipt,
});
export type AutomationIntegrationEventOccurrence = typeof AutomationIntegrationEventOccurrence.Type;

export const AutomationOccurrence = Schema.Union([
  AutomationScheduledOccurrence,
  AutomationManualOccurrence,
  AutomationFileArrivalOccurrence,
  AutomationIntegrationEventOccurrence,
]);
export type AutomationOccurrence = typeof AutomationOccurrence.Type;

export const AutomationOccurrenceKey = AutomationOccurrence;
export type AutomationOccurrenceKey = AutomationOccurrence;

export const AutomationOccurrenceKeyText = boundedText(512).pipe(
  Schema.brand("AutomationOccurrenceKeyText"),
);
export type AutomationOccurrenceKeyText = typeof AutomationOccurrenceKeyText.Type;
export const decodeAutomationOccurrenceKeyText = Schema.decodeUnknownSync(
  AutomationOccurrenceKeyText,
  STRICT_DECODE_OPTIONS,
);

export function deriveAutomationOccurrenceKey(
  occurrence: AutomationOccurrence,
): AutomationOccurrenceKeyText {
  if (occurrence.kind === "scheduled") {
    return decodeAutomationOccurrenceKeyText(
      `scheduled:${String(occurrence.automationId)}:${occurrence.definitionRevision}:${occurrence.triggerKind}:${String(occurrence.scheduledAt)}`,
    );
  }
  if (occurrence.kind === "file-arrival")
    return decodeAutomationOccurrenceKeyText(
      `file:${occurrence.automationId}:${occurrence.definitionRevision}:${occurrence.source.checkpoint.armGeneration}:${occurrence.source.checkpoint.observationRevision}:${occurrence.source.checkpoint.baselineDigest}`,
    );
  if (occurrence.kind === "integration-event")
    return decodeAutomationOccurrenceKeyText(
      `event:${occurrence.automationId}:${occurrence.definitionRevision}:${occurrence.source.checkpoint.sourceIdentity}:${occurrence.source.checkpoint.observationRevision}:${occurrence.source.event.id}`,
    );
  return decodeAutomationOccurrenceKeyText(
    `manual:${String(occurrence.automationId)}:${occurrence.definitionRevision}:${String(occurrence.runNowRequestId)}`,
  );
}

function occurrenceKeyMatches(input: {
  readonly occurrence: AutomationOccurrence;
  readonly occurrenceKey: AutomationOccurrenceKeyText;
}): boolean {
  return input.occurrenceKey === deriveAutomationOccurrenceKey(input.occurrence);
}

const AUTOMATION_MINUTE_MS = 60 * 1_000;

function automationScheduledAtMatchesTrigger(
  trigger: AutomationTrigger,
  scheduledAt: UtcTimestamp,
): boolean {
  switch (trigger.kind) {
    case "file-arrival":
    case "integration-event":
      return false;
    case "once":
      return scheduledAt === trigger.scheduledAt;
    case "interval": {
      const scheduledMs = new Date(scheduledAt).getTime();
      const anchorMs = new Date(trigger.anchorAt).getTime();
      const intervalMs = trigger.intervalMinutes * AUTOMATION_MINUTE_MS;
      return scheduledMs >= anchorMs && (scheduledMs - anchorMs) % intervalMs === 0;
    }
    case "weekly-local":
      return false;
  }
}

function automationLocalTimeMinutes(localTime: string): number | undefined {
  const [hourText, minuteText] = localTime.split(":");
  if (hourText === undefined || minuteText === undefined) return undefined;
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return undefined;
  return hour * 60 + minute;
}

function automationWeeklyResolutionMatchesTrigger(
  trigger: Extract<AutomationTrigger, { readonly kind: "weekly-local" }>,
  scheduledAt: UtcTimestamp,
  evidence: AutomationWeeklyResolution | undefined,
): boolean {
  if (
    evidence === undefined ||
    evidence.timeZone !== trigger.timeZone ||
    evidence.resolvedAt !== scheduledAt
  ) {
    return false;
  }
  const weekday = new Date(`${evidence.resolvedLocalDate}T00:00:00.000Z`).getUTCDay() || 7;
  if (!trigger.weekdays.some((value) => value === weekday)) return false;
  if (evidence.resolution === "gap-forward") {
    const resolvedMinutes = automationLocalTimeMinutes(evidence.resolvedLocalTime);
    const triggerMinutes = automationLocalTimeMinutes(trigger.localTime);
    return (
      resolvedMinutes !== undefined &&
      triggerMinutes !== undefined &&
      resolvedMinutes >= triggerMinutes
    );
  }
  return evidence.resolvedLocalTime === trigger.localTime;
}

function automationScheduledAtMatchesPersistedOccurrence(
  trigger: AutomationTrigger,
  scheduledAt: UtcTimestamp,
  evidence: AutomationWeeklyResolution | undefined,
): boolean {
  return trigger.kind === "weekly-local"
    ? automationWeeklyResolutionMatchesTrigger(trigger, scheduledAt, evidence)
    : automationScheduledAtMatchesTrigger(trigger, scheduledAt);
}

function automationAuthoritiesMatch(left: AgentRunAuthority, right: AgentRunAuthority): boolean {
  return (
    left.filesystem === right.filesystem &&
    left.shell === right.shell &&
    left.git === right.git &&
    left.network === right.network &&
    left.tools === right.tools &&
    left.subagents === right.subagents &&
    left.executionPolicy === right.executionPolicy &&
    left.permissionPersistence === right.permissionPersistence
  );
}

function automationAuthoritySnapshotsMatch(
  left: AutomationAuthoritySnapshot,
  right: AutomationAuthoritySnapshot,
): boolean {
  return (
    left.profileId === right.profileId &&
    left.profileVersion === right.profileVersion &&
    automationAuthoritiesMatch(left.requested, right.requested) &&
    automationAuthoritiesMatch(left.effective, right.effective) &&
    left.effectiveAuthorityDigest === right.effectiveAuthorityDigest &&
    left.capturedAt === right.capturedAt
  );
}

function automationAuthoritySnapshotMatchesDefinition(
  snapshot: AutomationAuthoritySnapshot,
  definition: AutomationDefinitionSnapshot,
): boolean {
  const authorityProfile = definition.authorityProfile;
  return (
    snapshot.profileId === authorityProfile.profileId &&
    snapshot.profileVersion === authorityProfile.profileVersion &&
    automationAuthoritiesMatch(snapshot.requested, authorityProfile.requested) &&
    automationAuthoritiesMatch(snapshot.effective, authorityProfile.effective) &&
    snapshot.effectiveAuthorityDigest === authorityProfile.effectiveAuthorityDigest
  );
}

function occurrenceEventMatches(input: {
  readonly automationId: AutomationId;
  readonly occurrence: AutomationOccurrence;
  readonly occurrenceKey: AutomationOccurrenceKeyText;
}): boolean {
  return input.automationId === input.occurrence.automationId && occurrenceKeyMatches(input);
}

export const AutomationDispatchIntent = Schema.Struct({
  firstTurnRequestId: AutomationFirstTurnRequestId,
  threadId: AutomationThreadId,
  authoritySnapshot: AutomationAuthoritySnapshot,
  promptDigest: AutomationDigest,
  recordedAt: UtcTimestamp,
});
export type AutomationDispatchIntent = typeof AutomationDispatchIntent.Type;

export const AutomationRuntimeLaunchClaim = Schema.Struct({
  firstTurnRequestId: AutomationFirstTurnRequestId,
  generation: AutomationRunGeneration,
  leaseExpiresAt: UtcTimestamp,
  claimedAt: UtcTimestamp,
}).check(Schema.makeFilter((claim) => claim.leaseExpiresAt > claim.claimedAt));
export type AutomationRuntimeLaunchClaim = typeof AutomationRuntimeLaunchClaim.Type;

export const AutomationCancellationTombstone = Schema.Struct({
  requestId: AutomationCancelRunRequestId,
  cancelledAt: UtcTimestamp,
});
export type AutomationCancellationTombstone = typeof AutomationCancellationTombstone.Type;

export const AutomationFirstTurnAcceptanceReceipt = Schema.Struct({
  firstTurnRequestId: AutomationFirstTurnRequestId,
  runtimeReceipt: AutomationOpaqueReference,
  acceptedAt: UtcTimestamp,
});
export type AutomationFirstTurnAcceptanceReceipt = typeof AutomationFirstTurnAcceptanceReceipt.Type;

export const AutomationRunFailure = Schema.Struct({
  reason: AutomationRunFailureReason,
  message: AutomationFailureMessage,
});
export type AutomationRunFailure = typeof AutomationRunFailure.Type;

/**
 * How a run's own agent said the work went, in its own words. The run's
 * lifecycle stays the host's: a reported "failed" never fails a run, and a
 * reported "succeeded" never completes one.
 */
export const AutomationRunResultOutcome = Schema.Literals([
  "succeeded",
  "nothing-to-do",
  "needs-attention",
  "failed",
]);
export type AutomationRunResultOutcome = typeof AutomationRunResultOutcome.Type;
export const MAX_AUTOMATION_RUN_RESULT_SUMMARY_BYTES = 1_024;
const automationTextEncoder = new TextEncoder();
const AutomationRunResultSummary = boundedText(MAX_AUTOMATION_RUN_RESULT_SUMMARY_BYTES).check(
  Schema.makeFilter(
    (summary) =>
      automationTextEncoder.encode(summary).byteLength <= MAX_AUTOMATION_RUN_RESULT_SUMMARY_BYTES,
  ),
);

export const AutomationRunReportedResult = Schema.Struct({
  outcome: AutomationRunResultOutcome,
  summary: AutomationRunResultSummary,
  reportedAt: UtcTimestamp,
});
export type AutomationRunReportedResult = typeof AutomationRunReportedResult.Type;

/**
 * Which run a routine-dispatched turn belongs to. The dispatcher hands it to
 * the turn it starts; no wire command or request body carries it.
 */
export const AutomationRunReference = Schema.Struct({
  automationId: AutomationId,
  runId: AutomationRunId,
});
export type AutomationRunReference = typeof AutomationRunReference.Type;

export const AutomationRun = Schema.Struct({
  id: AutomationRunId,
  automationId: AutomationId,
  occurrence: AutomationOccurrence,
  occurrenceKey: AutomationOccurrenceKeyText,
  scheduledAt: Schema.NullOr(UtcTimestamp),
  claimedAt: UtcTimestamp,
  definitionSnapshot: AutomationDefinitionSnapshot,
  authoritySnapshot: AutomationAuthoritySnapshot,
  threadId: Schema.optional(AutomationThreadId),
  firstTurnRequestId: AutomationFirstTurnRequestId,
  dispatchIntent: Schema.optional(AutomationDispatchIntent),
  runtimeLaunchClaim: Schema.optional(AutomationRuntimeLaunchClaim),
  cancellationTombstone: Schema.optional(AutomationCancellationTombstone),
  firstTurnAcceptance: Schema.optional(AutomationFirstTurnAcceptanceReceipt),
  lifecycle: AutomationRunLifecycle,
  failure: Schema.optional(AutomationRunFailure),
  notificationRefs: Schema.Array(AutomationOpaqueReference).check(
    Schema.isMaxLength(MAX_AUTOMATION_NOTIFICATION_REFERENCES),
  ),
  /** The result the run's own agent reported, if any; at most one per run. */
  reportedResult: Schema.optional(AutomationRunReportedResult),
  completedAt: Schema.optional(UtcTimestamp),
  version: AggregateVersion,
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
}).check(
  Schema.makeFilter((run) => {
    const fileSource =
      run.occurrence.kind === "file-arrival"
        ? run.occurrence.source
        : run.occurrence.kind === "manual"
          ? run.occurrence.fileSource
          : undefined;
    const eventSource =
      run.occurrence.kind === "integration-event"
        ? run.occurrence.source
        : run.occurrence.kind === "manual"
          ? run.occurrence.eventSource
          : undefined;
    const occurrenceIdentityMatches =
      !(fileSource !== undefined && eventSource !== undefined) &&
      (fileSource === undefined ||
        (run.definitionSnapshot.trigger.kind === "file-arrival" &&
          fileSource.automaticStartOrdinal <=
            run.definitionSnapshot.trigger.automaticStartLimit)) &&
      (eventSource === undefined ||
        (run.definitionSnapshot.trigger.kind === "integration-event" &&
          eventSource.checkpoint.sourceIdentity === run.definitionSnapshot.trigger.sourceIdentity &&
          eventSource.checkpoint.automaticStarts > 0 &&
          eventSource.checkpoint.automaticStarts <=
            run.definitionSnapshot.trigger.automaticStartLimit)) &&
      run.automationId === run.occurrence.automationId &&
      run.definitionSnapshot.automationId === run.occurrence.automationId &&
      run.definitionSnapshot.definitionRevision === run.occurrence.definitionRevision &&
      (run.occurrence.kind === "scheduled"
        ? run.scheduledAt === run.occurrence.scheduledAt &&
          run.occurrence.triggerKind === run.definitionSnapshot.trigger.kind &&
          automationScheduledAtMatchesPersistedOccurrence(
            run.definitionSnapshot.trigger,
            run.occurrence.scheduledAt,
            run.occurrence.resolutionEvidence,
          ) &&
          (run.definitionSnapshot.trigger.kind !== "once" ||
            run.occurrence.scheduledAt === run.definitionSnapshot.trigger.scheduledAt)
        : run.scheduledAt === null &&
          (run.occurrence.kind !== "file-arrival" ||
            (run.definitionSnapshot.trigger.kind === "file-arrival" &&
              run.occurrence.source.automaticStartOrdinal <=
                run.definitionSnapshot.trigger.automaticStartLimit)));
    const launchReceiptsMatch = [
      run.dispatchIntent,
      run.runtimeLaunchClaim,
      run.firstTurnAcceptance,
    ].every(
      (receipt) => receipt === undefined || receipt.firstTurnRequestId === run.firstTurnRequestId,
    );
    const launchReceiptsHaveDispatchIntent =
      (run.runtimeLaunchClaim === undefined && run.firstTurnAcceptance === undefined) ||
      (run.dispatchIntent !== undefined && run.threadId !== undefined);
    const dispatchIntentMatches =
      run.dispatchIntent === undefined ||
      (run.threadId !== undefined &&
        run.dispatchIntent.threadId === run.threadId &&
        automationAuthoritySnapshotsMatch(
          run.dispatchIntent.authoritySnapshot,
          run.authoritySnapshot,
        ));
    const authoritySnapshotMatchesDefinition = automationAuthoritySnapshotMatchesDefinition(
      run.authoritySnapshot,
      run.definitionSnapshot,
    );
    const cancellationTombstoneMatchesLifecycle =
      run.cancellationTombstone === undefined ||
      (run.lifecycle === "cancelled" && run.firstTurnAcceptance === undefined);
    const postLaunchEvidenceMatches =
      !AUTOMATION_POST_LAUNCH_LIFECYCLES.has(run.lifecycle) ||
      (run.threadId !== undefined &&
        run.dispatchIntent !== undefined &&
        run.firstTurnAcceptance !== undefined);
    const preLaunchAcceptanceAbsent =
      !AUTOMATION_PRE_LAUNCH_LIFECYCLES.has(run.lifecycle) || run.firstTurnAcceptance === undefined;
    const queuedLaunchEvidenceAbsent =
      (run.lifecycle !== "queued" && run.lifecycle !== "awaiting-confirmation") ||
      (run.threadId === undefined &&
        run.dispatchIntent === undefined &&
        run.runtimeLaunchClaim === undefined &&
        run.firstTurnAcceptance === undefined);
    const failedRunHasFailure = run.lifecycle !== "failed" || run.failure !== undefined;

    return (
      occurrenceKeyMatches(run) &&
      occurrenceIdentityMatches &&
      authoritySnapshotMatchesDefinition &&
      launchReceiptsMatch &&
      launchReceiptsHaveDispatchIntent &&
      dispatchIntentMatches &&
      cancellationTombstoneMatchesLifecycle &&
      postLaunchEvidenceMatches &&
      preLaunchAcceptanceAbsent &&
      queuedLaunchEvidenceAbsent &&
      failedRunHasFailure
    );
  }),
);
export type AutomationRun = typeof AutomationRun.Type;

// ── Commands and query contracts ────────────────────────────────────────────

const AutomationCommandFields = {
  automationId: AutomationId,
  expectedVersion: AggregateVersion,
  principal: AutomationClientPrincipal,
  origin: AutomationOrigin,
} as const;

export const AutomationCommand = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("rearm-file-automation"),
    ...AutomationCommandFields,
    sourceIdentity: AutomationSourceDigest,
    observationRevision: Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    ),
    batchDigest: AutomationSourceDigest,
    disposition: Schema.Literals(["skip", "run-once"]),
  }),
  Schema.Struct({
    kind: Schema.Literal("change-file-automation-activity-window"),
    ...AutomationCommandFields,
    change: Schema.Union([
      Schema.Struct({
        kind: Schema.Literal("raise"),
        activityWindowLimit: AutomationFileActivityWindowLimit,
      }),
      Schema.Struct({ kind: Schema.Literal("clear") }),
    ]),
  }),
  Schema.Struct({
    kind: Schema.Literal("create-automation"),
    ...AutomationCommandFields,
    definition: AutomationDefinitionDraft,
    // Omitted means enabled. A routine that must not run until a person resumes
    // it is journaled paused from its first event, never created then paused.
    initialLifecycle: Schema.optional(Schema.Literal("paused")),
  }),
  Schema.Struct({
    kind: Schema.Literal("update-automation"),
    ...AutomationCommandFields,
    definition: AutomationDefinitionDraft,
    rearmEvents: Schema.optional(Schema.Literal(true)),
  }),
  Schema.Struct({
    kind: Schema.Literal("pause-automation"),
    ...AutomationCommandFields,
  }),
  Schema.Struct({
    kind: Schema.Literal("resume-automation"),
    ...AutomationCommandFields,
  }),
  Schema.Struct({
    kind: Schema.Literal("archive-automation"),
    ...AutomationCommandFields,
  }),
  Schema.Struct({
    kind: Schema.Literal("run-now-automation"),
    ...AutomationCommandFields,
    runNowRequestId: AutomationRunNowRequestId,
    retryRunId: Schema.optional(AutomationRunId),
  }),
  Schema.Struct({
    kind: Schema.Literal("confirm-automation-run"),
    ...AutomationCommandFields,
    runId: AutomationRunId,
    expectedRunVersion: AggregateVersion,
  }),
  Schema.Struct({
    kind: Schema.Literal("cancel-current-automation-run"),
    ...AutomationCommandFields,
    runId: AutomationRunId,
    cancelRunRequestId: AutomationCancelRunRequestId,
    expectedRunVersion: AggregateVersion,
  }),
]);
export type AutomationCommand = typeof AutomationCommand.Type;
export const AutomationDefinitionCommand = AutomationCommand;
export type AutomationDefinitionCommand = AutomationCommand;

export const AutomationCommandFailure = Schema.Struct({
  kind: Schema.Literal("automation-command-failed"),
  reason: Schema.Literals([
    "invalid",
    "unauthorized",
    "not-found",
    "stale-version",
    "active-occurrence",
    "blocked",
    "terminal",
    "unsupported",
  ]),
  message: AutomationFailureMessage,
  automationId: Schema.optional(AutomationId),
  runId: Schema.optional(AutomationRunId),
});
export type AutomationCommandFailure = typeof AutomationCommandFailure.Type;

export const AutomationCommandResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("automation-created"),
    automation: AutomationDefinition,
  }),
  Schema.Struct({
    kind: Schema.Literal("automation-updated"),
    automation: AutomationDefinition,
  }),
  Schema.Struct({
    kind: Schema.Literal("automation-paused"),
    automation: AutomationDefinition,
  }),
  Schema.Struct({
    kind: Schema.Literal("automation-resumed"),
    automation: AutomationDefinition,
  }),
  Schema.Struct({
    kind: Schema.Literal("automation-archived"),
    automation: AutomationDefinition,
  }),
  Schema.Struct({
    kind: Schema.Literal("automation-run-accepted"),
    run: AutomationRun,
  }),
  Schema.Struct({
    kind: Schema.Literal("automation-run-confirmed"),
    run: AutomationRun,
  }),
  Schema.Struct({
    kind: Schema.Literal("automation-run-cancelled"),
    run: AutomationRun,
  }),
  Schema.Struct({
    kind: Schema.Literal("automation-run-active-conflict"),
    automationId: AutomationId,
    runId: AutomationRunId,
    lifecycle: AutomationRunLifecycle,
  }),
  AutomationCommandFailure,
]);
export type AutomationCommandResult = typeof AutomationCommandResult.Type;

export const AutomationSummary = Schema.Struct({
  latestEventRun: Schema.optional(
    Schema.Struct({
      event: AutomationIntegrationEvent,
      runId: AutomationRunId,
      lifecycle: AutomationRunLifecycle,
    }),
  ),
  eventSource: Schema.optional(AutomationEventSourceCheckpoint),
  id: AutomationId,
  displayName: boundedText(MAX_AUTOMATION_DISPLAY_NAME_LENGTH),
  hostId: HostId,
  mode: AutomationMode,
  projectId: ProjectId,
  lifecycle: AutomationLifecycle,
  definitionRevision: AutomationDefinitionRevision,
  /**
   * What this automation runs on. A row has to say what a routine *does*, and
   * one instant cannot tell a daily routine from a one-off that happens to be
   * due tomorrow — so `nextDueAt` alone can never carry that sentence.
   */
  trigger: AutomationTrigger,
  nextDueAt: Schema.NullOr(UtcTimestamp),
  fileSource: Schema.optional(AutomationFileSourceSummary),
  latestRunLifecycle: Schema.optional(AutomationRunLifecycle),
  /**
   * The last runs (at most seven), oldest first so a row of small blocks reads
   * left to right in time. `at` is when the run started. The list page shows
   * these as a pass/fail strip without a request per routine.
   */
  recentRuns: Schema.optional(
    Schema.Array(Schema.Struct({ lifecycle: AutomationRunLifecycle, at: UtcTimestamp })).check(
      Schema.isMaxLength(7),
    ),
  ),
  /** See {@link AutomationDefinition}'s `originThreadId`. */
  originThreadId: Schema.optional(AutomationThreadId),
  /** Present when the routine is a follow-up in its origin thread. */
  targetPolicy: Schema.optional(AutomationTargetPolicy),
  version: AggregateVersion,
  updatedAt: UtcTimestamp,
});
export type AutomationSummary = typeof AutomationSummary.Type;

// ── Routine proposals from a thread ────────────────────────────────────────

export const ROUTINE_PROPOSAL_TOOL_NAME = "octant_propose_routine";
/** The tool a Work or Code thread's agent reads routines with and asks the person to change one. */
export const ROUTINES_TOOL_NAME = "octant_routines";

export const RoutineProposalId = brandedUuid("RoutineProposalId");
export type RoutineProposalId = typeof RoutineProposalId.Type;

/**
 * A routine a Work or Code thread's agent proposed, waiting for the person.
 * It names only what the agent chose; the Project, mode, profile, and
 * authority are the host's, resolved from the thread when the person confirms.
 */
export const RoutineProposal = Schema.Struct({
  proposalId: RoutineProposalId,
  threadId: AutomationThreadId,
  /** Chat only for a follow-up a person set up from a Chat thread. */
  mode: AutomationMode,
  projectId: ProjectId,
  displayName: boundedText(MAX_AUTOMATION_DISPLAY_NAME_LENGTH),
  taskPrompt: boundedText(MAX_AUTOMATION_TASK_PROMPT_LENGTH),
  trigger: AutomationScheduledTrigger,
  missedRunPolicy: AutomationMissedRunPolicy,
  /** `same-thread` is a one-time follow-up in this thread; absent means a new thread per run. */
  targetPolicy: Schema.optional(AutomationTargetPolicy),
  /** The first time it would run, resolved by the host when it was proposed. */
  firstRunAt: UtcTimestamp,
  requestedAt: UtcTimestamp,
});
export type RoutineProposal = typeof RoutineProposal.Type;

/**
 * A Work or Code thread's agent asking the person to pause or archive one
 * routine, waiting for the person like a proposal. It changes nothing: only
 * the person's confirmation does, as that person's own pause or archive.
 */
export const RoutineChangeRequest = Schema.Struct({
  kind: Schema.Literal("routine-change-request"),
  proposalId: RoutineProposalId,
  threadId: AutomationThreadId,
  mode: AutomationThreadMode,
  projectId: ProjectId,
  automationId: AutomationId,
  change: Schema.Literals(["pause", "archive"]),
  displayName: boundedText(MAX_AUTOMATION_DISPLAY_NAME_LENGTH),
  /** Present when the routine is a follow-up, whose archive the person knows as cancel. */
  targetPolicy: Schema.optional(AutomationTargetPolicy),
  /** The routine's version the agent saw; a routine changed since then is left as it is. */
  expectedVersion: AggregateVersion,
  /** Why the agent asks, in its own words. */
  reason: Schema.optional(boundedText(500)),
  requestedAt: UtcTimestamp,
});
export type RoutineChangeRequest = typeof RoutineChangeRequest.Type;

/** What a thread's agent is waiting on the person for: a new routine, or a change to one. */
export const RoutineAgentRequest = Schema.Union([RoutineProposal, RoutineChangeRequest]);
export type RoutineAgentRequest = typeof RoutineAgentRequest.Type;

export const RoutineProposalList = Schema.Struct({
  kind: Schema.Literal("routine-proposal-list"),
  proposals: Schema.Array(RoutineAgentRequest).check(Schema.isMaxLength(32)),
});
export type RoutineProposalList = typeof RoutineProposalList.Type;

export const RoutineProposalDecision = Schema.Struct({
  proposalId: RoutineProposalId,
  decision: Schema.Literals(["confirm", "decline"]),
});
export type RoutineProposalDecision = typeof RoutineProposalDecision.Type;

export const RoutineProposalDecisionResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("routine-proposal-confirmed"),
    automation: AutomationDefinition,
  }),
  Schema.Struct({ kind: Schema.Literal("routine-proposal-declined") }),
  Schema.Struct({ kind: Schema.Literal("routine-proposal-gone") }),
  Schema.Struct({
    kind: Schema.Literal("routine-proposal-answer-unrecorded"),
    message: AutomationFailureMessage,
  }),
  AutomationCommandFailure,
]);
export type RoutineProposalDecisionResult = typeof RoutineProposalDecisionResult.Type;

/**
 * A person setting up, or moving, a follow-up from the thread itself. The
 * host builds the routine from the thread's own facts, exactly as for a
 * confirmed proposal; the body names only the thread, the time, and the
 * prompt.
 */
export const AutomationFollowUpRequest = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("schedule-follow-up"),
    threadId: AutomationThreadId,
    mode: AutomationMode,
    projectId: ProjectId,
    scheduledAt: UtcTimestamp,
    taskPrompt: boundedText(MAX_AUTOMATION_TASK_PROMPT_LENGTH),
  }),
  Schema.Struct({
    kind: Schema.Literal("reschedule-follow-up"),
    automationId: AutomationId,
    expectedVersion: AggregateVersion,
    scheduledAt: UtcTimestamp,
  }),
]);
export type AutomationFollowUpRequest = typeof AutomationFollowUpRequest.Type;

/**
 * A person creating a routine from a Work or Code thread's Environment. Like
 * a confirmed proposal, the host builds it from the thread's own facts; the
 * body names only the thread and what the person chose.
 */
export const AutomationThreadRoutineRequest = Schema.Struct({
  kind: Schema.Literal("create-thread-routine"),
  threadId: AutomationThreadId,
  mode: AutomationThreadMode,
  projectId: ProjectId,
  displayName: boundedText(MAX_AUTOMATION_DISPLAY_NAME_LENGTH),
  taskPrompt: boundedText(MAX_AUTOMATION_TASK_PROMPT_LENGTH),
  trigger: AutomationScheduledTrigger,
  missedRunPolicy: AutomationMissedRunPolicy,
});
export type AutomationThreadRoutineRequest = typeof AutomationThreadRoutineRequest.Type;

export const AutomationQuery = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("list-automations"),
    hostId: HostId,
    mode: Schema.Literals(["all", "chat", "work", "code"]),
    projectId: Schema.optional(ProjectId),
    search: Schema.optional(boundedText(128)),
    limit: Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(MAX_AUTOMATION_QUERY_LIMIT),
    ),
    cursor: Schema.optional(
      Schema.String.check(Schema.isMaxLength(MAX_AUTOMATION_QUERY_CURSOR_LENGTH)),
    ),
  }),
  Schema.Struct({
    kind: Schema.Literal("get-automation"),
    automationId: AutomationId,
  }),
  Schema.Struct({
    kind: Schema.Literal("list-automation-runs"),
    automationId: AutomationId,
    limit: Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(MAX_AUTOMATION_HISTORY_ENTRIES),
    ),
    cursor: Schema.optional(
      Schema.String.check(Schema.isMaxLength(MAX_AUTOMATION_QUERY_CURSOR_LENGTH)),
    ),
  }),
]);
export type AutomationQuery = typeof AutomationQuery.Type;
export const AutomationQueryRequest = AutomationQuery;
export type AutomationQueryRequest = AutomationQuery;

export const AutomationListResponse = Schema.Struct({
  kind: Schema.Literal("automation-list"),
  items: Schema.Array(AutomationSummary).check(Schema.isMaxLength(MAX_AUTOMATION_QUERY_LIMIT)),
  /**
   * Present when the host could not rebuild Automation history at start: the
   * list is empty because nothing loaded, not because none exist, and nothing
   * is scheduled.
   */
  historyUnavailable: Schema.optional(Schema.Literal(true)),
  nextCursor: Schema.optional(
    Schema.String.check(Schema.isMaxLength(MAX_AUTOMATION_QUERY_CURSOR_LENGTH)),
  ),
  /**
   * Counts over every Automation the caller may see on this host for the
   * queried mode and Project, not just this page, so the header stays true
   * while the list pages. `succeeded` counts runs that completed.
   */
  totals: Schema.optional(
    Schema.Struct({
      automations: nonNegativeInteger,
      enabled: nonNegativeInteger,
      windowDays: Schema.Literal(30),
      runs: nonNegativeInteger,
      succeeded: nonNegativeInteger,
    }),
  ),
});
export type AutomationListResponse = typeof AutomationListResponse.Type;

export const AutomationDetailResponse = Schema.Struct({
  eventSource: Schema.optional(AutomationEventSourceCheckpoint),
  fileSource: Schema.optional(AutomationFileSourceSummary),
  kind: Schema.Literal("automation-detail"),
  automation: AutomationDefinition,
  runs: Schema.Array(AutomationRun).check(Schema.isMaxLength(MAX_AUTOMATION_HISTORY_ENTRIES)),
});
export type AutomationDetailResponse = typeof AutomationDetailResponse.Type;

export const AutomationHistoryResponse = Schema.Struct({
  kind: Schema.Literal("automation-history"),
  automationId: AutomationId,
  runs: Schema.Array(AutomationRun).check(Schema.isMaxLength(MAX_AUTOMATION_HISTORY_ENTRIES)),
  nextCursor: Schema.optional(
    Schema.String.check(Schema.isMaxLength(MAX_AUTOMATION_QUERY_CURSOR_LENGTH)),
  ),
});
export type AutomationHistoryResponse = typeof AutomationHistoryResponse.Type;

export const AutomationQueryResponse = Schema.Union([
  AutomationListResponse,
  AutomationDetailResponse,
  AutomationHistoryResponse,
]);
export type AutomationQueryResponse = typeof AutomationQueryResponse.Type;
export const AutomationQueryResult = AutomationQueryResponse;
export type AutomationQueryResult = AutomationQueryResponse;

// ── Journal event payload contracts ─────────────────────────────────────────

export const AutomationDefinitionCreated = Schema.Struct({
  eventSource: Schema.optional(AutomationEventSourceCheckpoint),
  automation: AutomationPersistedDefinition,
  fileSource: Schema.optional(AutomationFileSourceCheckpoint),
}).check(
  Schema.makeFilter(
    (event) =>
      (event.eventSource === undefined ||
        (event.automation.trigger.kind === "integration-event" &&
          event.eventSource.sourceIdentity === event.automation.trigger.sourceIdentity &&
          !event.eventSource.baselineReady &&
          event.eventSource.automaticStarts === 0)) &&
      (event.fileSource === undefined ||
        (event.automation.trigger.kind === "file-arrival" &&
          !event.fileSource.baselineReady &&
          event.fileSource.observationRevision === 1 &&
          event.fileSource.armGeneration === 1)),
  ),
);
export type AutomationDefinitionCreated = typeof AutomationDefinitionCreated.Type;

export const AutomationDefinitionUpdated = Schema.Struct({
  eventSource: Schema.optional(AutomationEventSourceCheckpoint),
  automation: AutomationPersistedDefinition,
  fileSource: Schema.optional(AutomationFileSourceCheckpoint),
  previousDefinitionRevision: AutomationDefinitionRevision,
}).check(
  Schema.makeFilter(
    (event) =>
      (event.fileSource === undefined || event.automation.trigger.kind === "file-arrival") &&
      (event.eventSource === undefined ||
        (event.automation.trigger.kind === "integration-event" &&
          event.eventSource.sourceIdentity === event.automation.trigger.sourceIdentity &&
          !event.eventSource.baselineReady &&
          event.eventSource.automaticStarts === 0)),
  ),
);
export type AutomationDefinitionUpdated = typeof AutomationDefinitionUpdated.Type;

export const AutomationDefinitionLifecycleChanged = Schema.Struct({
  automation: AutomationPersistedDefinition,
  previousLifecycle: AutomationLifecycle,
  fileSource: Schema.optional(AutomationFileSourceCheckpoint),
  fileSourceReview: Schema.optional(AutomationFileSourceReview),
}).check(
  Schema.makeFilter(
    (event) =>
      (event.fileSource === undefined) === (event.fileSourceReview === undefined) &&
      (event.fileSource === undefined ||
        (event.fileSourceReview !== undefined &&
          event.automation.trigger.kind === "file-arrival" &&
          event.automation.lifecycle === "enabled" &&
          fileSourceReviewMatchesAuthor(event.fileSourceReview, event.automation.updatedBy) &&
          event.automation.version === event.fileSourceReview.expectedDefinitionVersion + 1 &&
          event.fileSource.sourceIdentity === event.fileSourceReview.previousSourceIdentity &&
          event.fileSource.observationRevision ===
            event.fileSourceReview.previousObservationRevision + 1 &&
          event.fileSource.baselineReady &&
          event.fileSource.automaticStarts ===
            (event.fileSourceReview.disposition === "run-once" ? 1 : 0))),
  ),
);
export type AutomationDefinitionLifecycleChanged = typeof AutomationDefinitionLifecycleChanged.Type;

export const AutomationFileSourceObserved = Schema.Struct({
  automationId: AutomationId,
  definitionRevision: AutomationDefinitionRevision,
  checkpoint: AutomationFileSourceCheckpoint,
  recordedAt: UtcTimestamp,
});
export type AutomationFileSourceObserved = typeof AutomationFileSourceObserved.Type;

/**
 * The person raised a file routine's activity window or cleared it. The event
 * carries the whole resulting checkpoint, so replay rebuilds the same window
 * and the same overflow as the live host saw.
 */
export const AutomationFileSourceWindowChanged = Schema.Struct({
  automationId: AutomationId,
  definitionRevision: AutomationDefinitionRevision,
  change: Schema.Literals(["raised", "cleared"]),
  checkpoint: AutomationFileSourceCheckpoint,
  recordedAt: UtcTimestamp,
}).check(
  Schema.makeFilter(
    (event) => event.change === "raised" || event.checkpoint.activityWindow.length === 0,
  ),
);
export type AutomationFileSourceWindowChanged = typeof AutomationFileSourceWindowChanged.Type;

export const AutomationEventSourceObserved = Schema.Struct({
  automationId: AutomationId,
  definitionRevision: AutomationDefinitionRevision,
  checkpoint: AutomationEventSourceCheckpoint,
  recordedAt: UtcTimestamp,
});
export type AutomationEventSourceObserved = typeof AutomationEventSourceObserved.Type;

export const AutomationDefinitionExhausted = Schema.Struct({
  automationId: AutomationId,
  definitionRevision: AutomationDefinitionRevision,
  consumedScheduledAt: UtcTimestamp,
  version: AggregateVersion,
});
export type AutomationDefinitionExhausted = typeof AutomationDefinitionExhausted.Type;

export const AutomationOccurrenceClaimed = Schema.Struct({
  automationId: AutomationId,
  runId: AutomationRunId,
  occurrence: AutomationOccurrence,
  occurrenceKey: AutomationOccurrenceKeyText,
  claimedAt: UtcTimestamp,
}).check(Schema.makeFilter(occurrenceEventMatches));
export type AutomationOccurrenceClaimed = typeof AutomationOccurrenceClaimed.Type;

export const AutomationOccurrenceSkipped = Schema.Struct({
  automationId: AutomationId,
  occurrence: AutomationScheduledOccurrence,
  occurrenceKey: AutomationOccurrenceKeyText,
  skippedAt: UtcTimestamp,
  reason: Schema.Literals(["missed-run-policy", "missed-run-cap-recovery"]),
}).check(Schema.makeFilter(occurrenceEventMatches));
export type AutomationOccurrenceSkipped = typeof AutomationOccurrenceSkipped.Type;

export const AutomationRunCreated = Schema.Struct({
  run: AutomationRun,
});
export type AutomationRunCreated = typeof AutomationRunCreated.Type;

export const AutomationRunStatusChanged = Schema.Struct({
  automationId: AutomationId,
  runId: AutomationRunId,
  previousLifecycle: AutomationRunLifecycle,
  lifecycle: AutomationRunLifecycle,
  version: AggregateVersion,
  failure: Schema.optional(AutomationRunFailure),
  updatedAt: UtcTimestamp,
}).check(
  Schema.makeFilter((event) => (event.lifecycle === "failed") === (event.failure !== undefined)),
);
export type AutomationRunStatusChanged = typeof AutomationRunStatusChanged.Type;

export const AutomationBlocked = Schema.Struct({
  automationId: AutomationId,
  runId: Schema.optional(AutomationRunId),
  reason: AutomationBlockReason,
  examinedFrom: Schema.optional(UtcTimestamp),
  examinedThrough: Schema.optional(UtcTimestamp),
  nextFutureOccurrence: Schema.optional(UtcTimestamp),
  recordedAt: UtcTimestamp,
}).check(
  Schema.makeFilter(
    (blocked) =>
      blocked.reason !== "missed-run-cap-exceeded" ||
      (blocked.examinedFrom !== undefined &&
        blocked.examinedThrough !== undefined &&
        blocked.nextFutureOccurrence !== undefined &&
        blocked.examinedFrom <= blocked.examinedThrough &&
        blocked.examinedThrough < blocked.nextFutureOccurrence),
  ),
);
export type AutomationBlocked = typeof AutomationBlocked.Type;

export const AutomationDispatchIntentRecorded = Schema.Struct({
  automationId: AutomationId,
  runId: AutomationRunId,
  intent: AutomationDispatchIntent,
});
export type AutomationDispatchIntentRecorded = typeof AutomationDispatchIntentRecorded.Type;

export const AutomationFirstTurnRuntimeClaimed = Schema.Struct({
  automationId: AutomationId,
  runId: AutomationRunId,
  claim: AutomationRuntimeLaunchClaim,
});
export type AutomationFirstTurnRuntimeClaimed = typeof AutomationFirstTurnRuntimeClaimed.Type;

export const AutomationFirstTurnDispatchCancelled = Schema.Struct({
  automationId: AutomationId,
  runId: AutomationRunId,
  tombstone: AutomationCancellationTombstone,
});
export type AutomationFirstTurnDispatchCancelled = typeof AutomationFirstTurnDispatchCancelled.Type;

export const AutomationFirstTurnAccepted = Schema.Struct({
  automationId: AutomationId,
  runId: AutomationRunId,
  receipt: AutomationFirstTurnAcceptanceReceipt,
});
export type AutomationFirstTurnAccepted = typeof AutomationFirstTurnAccepted.Type;

/** Appends an opaque notification delivery reference onto a run. */
export const AutomationNotificationRefRecorded = Schema.Struct({
  automationId: AutomationId,
  runId: AutomationRunId,
  notificationRef: AutomationOpaqueReference,
  version: AggregateVersion,
  recordedAt: UtcTimestamp,
});
export type AutomationNotificationRefRecorded = typeof AutomationNotificationRefRecorded.Type;

/**
 * A routine-dispatched turn's agent reporting how its run went. Journaled on
 * the run at most once; it annotates the run and never changes its lifecycle.
 */
export const AutomationRunResultReported = Schema.Struct({
  automationId: AutomationId,
  runId: AutomationRunId,
  result: AutomationRunReportedResult,
});
export type AutomationRunResultReported = typeof AutomationRunResultReported.Type;

export const AUTOMATION_EVENT_NAMES = [
  "automation-event-source-observed@1",
  "automation-file-source-observed@1",
  "automation-file-source-window-changed@1",
  "automation-definition-created@1",
  "automation-definition-updated@1",
  "automation-definition-lifecycle-changed@1",
  "automation-definition-exhausted@1",
  "automation-occurrence-claimed@1",
  "automation-occurrence-skipped@1",
  "automation-run-created@1",
  "automation-run-status-changed@1",
  "automation-blocked@1",
  "automation-dispatch-intent-recorded@1",
  "automation-first-turn-runtime-claimed@1",
  "automation-first-turn-dispatch-cancelled@1",
  "automation-first-turn-accepted@1",
  "automation-notification-ref-recorded@1",
  "automation-run-result-reported@1",
] as const;
export type AutomationEventName = (typeof AUTOMATION_EVENT_NAMES)[number];

export const AutomationEvent = Schema.Union([
  Schema.Struct({
    eventName: Schema.Literal("automation-event-source-observed@1"),
    payload: AutomationEventSourceObserved,
  }),
  Schema.Struct({
    eventName: Schema.Literal("automation-file-source-observed@1"),
    payload: AutomationFileSourceObserved,
  }),
  Schema.Struct({
    eventName: Schema.Literal("automation-file-source-window-changed@1"),
    payload: AutomationFileSourceWindowChanged,
  }),
  Schema.Struct({
    eventName: Schema.Literal("automation-definition-created@1"),
    payload: AutomationDefinitionCreated,
  }),
  Schema.Struct({
    eventName: Schema.Literal("automation-definition-updated@1"),
    payload: AutomationDefinitionUpdated,
  }),
  Schema.Struct({
    eventName: Schema.Literal("automation-definition-lifecycle-changed@1"),
    payload: AutomationDefinitionLifecycleChanged,
  }),
  Schema.Struct({
    eventName: Schema.Literal("automation-definition-exhausted@1"),
    payload: AutomationDefinitionExhausted,
  }),
  Schema.Struct({
    eventName: Schema.Literal("automation-occurrence-claimed@1"),
    payload: AutomationOccurrenceClaimed,
  }),
  Schema.Struct({
    eventName: Schema.Literal("automation-occurrence-skipped@1"),
    payload: AutomationOccurrenceSkipped,
  }),
  Schema.Struct({
    eventName: Schema.Literal("automation-run-created@1"),
    payload: AutomationRunCreated,
  }),
  Schema.Struct({
    eventName: Schema.Literal("automation-run-status-changed@1"),
    payload: AutomationRunStatusChanged,
  }),
  Schema.Struct({
    eventName: Schema.Literal("automation-blocked@1"),
    payload: AutomationBlocked,
  }),
  Schema.Struct({
    eventName: Schema.Literal("automation-dispatch-intent-recorded@1"),
    payload: AutomationDispatchIntentRecorded,
  }),
  Schema.Struct({
    eventName: Schema.Literal("automation-first-turn-runtime-claimed@1"),
    payload: AutomationFirstTurnRuntimeClaimed,
  }),
  Schema.Struct({
    eventName: Schema.Literal("automation-first-turn-dispatch-cancelled@1"),
    payload: AutomationFirstTurnDispatchCancelled,
  }),
  Schema.Struct({
    eventName: Schema.Literal("automation-first-turn-accepted@1"),
    payload: AutomationFirstTurnAccepted,
  }),
  Schema.Struct({
    eventName: Schema.Literal("automation-notification-ref-recorded@1"),
    payload: AutomationNotificationRefRecorded,
  }),
  Schema.Struct({
    eventName: Schema.Literal("automation-run-result-reported@1"),
    payload: AutomationRunResultReported,
  }),
]);
export type AutomationEvent = typeof AutomationEvent.Type;

// ── Decoders ────────────────────────────────────────────────────────────────

export const decodeAutomationId = Schema.decodeUnknownSync(AutomationId, STRICT_DECODE_OPTIONS);
export const decodeAutomationRunId = Schema.decodeUnknownSync(
  AutomationRunId,
  STRICT_DECODE_OPTIONS,
);
export const decodeAutomationRunNowRequestId = Schema.decodeUnknownSync(
  AutomationRunNowRequestId,
  STRICT_DECODE_OPTIONS,
);
export const decodeAutomationCancelRunRequestId = Schema.decodeUnknownSync(
  AutomationCancelRunRequestId,
  STRICT_DECODE_OPTIONS,
);
export const decodeAutomationFirstTurnRequestId = Schema.decodeUnknownSync(
  AutomationFirstTurnRequestId,
  STRICT_DECODE_OPTIONS,
);
export const decodeAutomationDefinitionRevision = Schema.decodeUnknownSync(
  AutomationDefinitionRevision,
  STRICT_DECODE_OPTIONS,
);
export const decodeAutomationTrigger = Schema.decodeUnknownSync(
  AutomationTrigger,
  STRICT_DECODE_OPTIONS,
);
export const decodeAutomationScheduledTrigger = Schema.decodeUnknownSync(
  AutomationScheduledTrigger,
  STRICT_DECODE_OPTIONS,
);
export const decodeAutomationAuthority = Schema.decodeUnknownSync(
  AutomationAuthority,
  STRICT_DECODE_OPTIONS,
);
export const decodeAutomationMissedRunCap = Schema.decodeUnknownSync(
  AutomationMissedRunCap,
  STRICT_DECODE_OPTIONS,
);
export const decodeAutomationDefinitionDraft = Schema.decodeUnknownSync(
  AutomationDefinitionDraft,
  STRICT_DECODE_OPTIONS,
);
export const decodeAutomationDefinition = Schema.decodeUnknownSync(
  AutomationDefinition,
  STRICT_DECODE_OPTIONS,
);
export const decodeAutomationOccurrence = Schema.decodeUnknownSync(
  AutomationOccurrence,
  STRICT_DECODE_OPTIONS,
);
export const decodeAutomationOccurrenceKey = Schema.decodeUnknownSync(
  AutomationOccurrenceKey,
  STRICT_DECODE_OPTIONS,
);
export const decodeAutomationRun = Schema.decodeUnknownSync(AutomationRun, STRICT_DECODE_OPTIONS);
export const decodeAutomationCommand = Schema.decodeUnknownSync(
  AutomationCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodeAutomationCommandResult = Schema.decodeUnknownSync(
  AutomationCommandResult,
  STRICT_DECODE_OPTIONS,
);
export const decodeAutomationQuery = Schema.decodeUnknownSync(
  AutomationQuery,
  STRICT_DECODE_OPTIONS,
);
export const decodeAutomationQueryResponse = Schema.decodeUnknownSync(
  AutomationQueryResponse,
  STRICT_DECODE_OPTIONS,
);
export const decodeAutomationEvent = Schema.decodeUnknownSync(
  AutomationEvent,
  STRICT_DECODE_OPTIONS,
);
export const decodeAutomationThreadId = Schema.decodeUnknownSync(
  AutomationThreadId,
  STRICT_DECODE_OPTIONS,
);
export const decodeRoutineProposalId = Schema.decodeUnknownSync(
  RoutineProposalId,
  STRICT_DECODE_OPTIONS,
);
export const decodeRoutineProposal = Schema.decodeUnknownSync(
  RoutineProposal,
  STRICT_DECODE_OPTIONS,
);
export const decodeRoutineChangeRequest = Schema.decodeUnknownSync(
  RoutineChangeRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeAutomationRunReportedResult = Schema.decodeUnknownSync(
  AutomationRunReportedResult,
  STRICT_DECODE_OPTIONS,
);
export const decodeRoutineProposalList = Schema.decodeUnknownSync(
  RoutineProposalList,
  STRICT_DECODE_OPTIONS,
);
export const decodeRoutineProposalDecision = Schema.decodeUnknownSync(
  RoutineProposalDecision,
  STRICT_DECODE_OPTIONS,
);
export const decodeRoutineProposalDecisionResult = Schema.decodeUnknownSync(
  RoutineProposalDecisionResult,
  STRICT_DECODE_OPTIONS,
);
export const decodeAutomationFollowUpRequest = Schema.decodeUnknownSync(
  AutomationFollowUpRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeAutomationThreadRoutineRequest = Schema.decodeUnknownSync(
  AutomationThreadRoutineRequest,
  STRICT_DECODE_OPTIONS,
);
