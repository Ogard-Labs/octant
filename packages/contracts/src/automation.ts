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

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));
const boundedText = (maximum: number) =>
  Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(maximum));
const positiveInteger = Schema.Int.pipe(Schema.positive());
const nonNegativeInteger = Schema.Int.pipe(Schema.greaterThanOrEqualTo(0));

export const MAX_AUTOMATION_DISPLAY_NAME_LENGTH = 255;
export const MAX_AUTOMATION_TASK_PROMPT_LENGTH = 8_192;
export const MAX_AUTOMATION_TARGET_SUMMARY_LENGTH = 2_048;
export const MAX_AUTOMATION_FAILURE_MESSAGE_LENGTH = 1_024;
export const MAX_AUTOMATION_NOTIFICATION_REFERENCES = 32;
export const MAX_AUTOMATION_HISTORY_ENTRIES = 256;
export const MAX_AUTOMATION_QUERY_LIMIT = 100;
export const MAX_AUTOMATION_QUERY_CURSOR_LENGTH = 256;
export const MAX_AUTOMATION_MISSED_RUN_CAP = 10_000;
export const DEFAULT_AUTOMATION_MISSED_RUN_CAP = 128;
export const AutomationMissedRunCap = Schema.Int.pipe(
  Schema.greaterThanOrEqualTo(1),
  Schema.lessThanOrEqualTo(MAX_AUTOMATION_MISSED_RUN_CAP),
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
  Schema.lessThanOrEqualTo(MAX_AUTOMATION_MISSED_RUN_CAP),
  Schema.brand("AutomationDefinitionRevision"),
);
export { AutomationDefinitionRevision };
export type AutomationDefinitionRevision = typeof AutomationDefinitionRevision.Type;

const AutomationRunGeneration = positiveInteger.pipe(
  Schema.lessThanOrEqualTo(MAX_AUTOMATION_MISSED_RUN_CAP),
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

export const AutomationTriggerKind = Schema.Literal("once", "interval", "weekly-local");
export type AutomationTriggerKind = typeof AutomationTriggerKind.Type;

export const AutomationMissedRunPolicy = Schema.Literal("skip", "run-once");
export type AutomationMissedRunPolicy = typeof AutomationMissedRunPolicy.Type;

export const AutomationTargetPolicy = Schema.Literal("new-thread");
export type AutomationTargetPolicy = typeof AutomationTargetPolicy.Type;

export const AutomationLifecycle = Schema.Literal("enabled", "paused", "exhausted", "archived");
export type AutomationLifecycle = typeof AutomationLifecycle.Type;

export const AutomationRunLifecycle = Schema.Literal(
  "queued",
  "dispatching",
  "recovering-dispatch",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "skipped",
);
export type AutomationRunLifecycle = typeof AutomationRunLifecycle.Type;
const AUTOMATION_POST_LAUNCH_LIFECYCLES: ReadonlySet<AutomationRunLifecycle> = new Set([
  "running",
  "waiting",
  "completed",
  "interrupted",
]);
const AUTOMATION_PRE_LAUNCH_LIFECYCLES: ReadonlySet<AutomationRunLifecycle> = new Set([
  "queued",
  "dispatching",
  "recovering-dispatch",
]);
export const AutomationDefinitionLifecycle = AutomationLifecycle;
export type AutomationDefinitionLifecycle = AutomationLifecycle;
export const AutomationRunStatus = AutomationRunLifecycle;
export type AutomationRunStatus = AutomationRunLifecycle;

export const AutomationWeekday = Schema.Int.pipe(
  Schema.greaterThanOrEqualTo(1),
  Schema.lessThanOrEqualTo(7),
  Schema.brand("AutomationWeekday"),
);
export type AutomationWeekday = typeof AutomationWeekday.Type;

const AutomationWeekdays = Schema.NonEmptyArray(AutomationWeekday).pipe(
  Schema.maxItems(7),
  Schema.filter((weekdays) => new Set(weekdays).size === weekdays.length),
);
export { AutomationWeekdays };
export type AutomationWeekdays = typeof AutomationWeekdays.Type;

export const AutomationLocalTime = Schema.String.pipe(
  Schema.pattern(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  Schema.brand("AutomationLocalTime"),
);
export type AutomationLocalTime = typeof AutomationLocalTime.Type;

export const AutomationLocalDate = Schema.String.pipe(
  Schema.pattern(/^\d{4}-\d{2}-\d{2}$/),
  Schema.filter((date) => {
    const parsed = new Date(`${date}T00:00:00.000Z`);
    return parsed.toISOString().slice(0, 10) === date;
  }),
  Schema.brand("AutomationLocalDate"),
);
export type AutomationLocalDate = typeof AutomationLocalDate.Type;

export const AutomationWeeklyResolution = Schema.Struct({
  resolutionVersion: positiveInteger.pipe(Schema.lessThanOrEqualTo(32)),
  timeZone: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128)),
  timeZoneDatabase: boundedText(64),
  resolvedAt: UtcTimestamp,
  resolvedLocalDate: AutomationLocalDate,
  resolvedLocalTime: AutomationLocalTime,
  utcOffsetMinutes: Schema.Int.pipe(
    Schema.greaterThanOrEqualTo(-1_440),
    Schema.lessThanOrEqualTo(1_440),
  ),
  resolution: Schema.Literal("exact", "gap-forward", "fold-earlier"),
}).annotations(strict);
export type AutomationWeeklyResolution = typeof AutomationWeeklyResolution.Type;

/** An IANA identifier validated against the host runtime's timezone database. */
export const AutomationTimeZone = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(128),
  Schema.filter((timeZone) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone }).format();
      return true;
    } catch {
      return false;
    }
  }),
  Schema.brand("AutomationTimeZone"),
);
export type AutomationTimeZone = typeof AutomationTimeZone.Type;

export const AutomationIntervalMinutes = Schema.Int.pipe(
  Schema.greaterThanOrEqualTo(15),
  Schema.lessThanOrEqualTo(43_200),
  Schema.brand("AutomationIntervalMinutes"),
);
export type AutomationIntervalMinutes = typeof AutomationIntervalMinutes.Type;

export const AutomationOnceTrigger = Schema.Struct({
  kind: Schema.Literal("once"),
  scheduledAt: UtcTimestamp,
}).annotations(strict);
export type AutomationOnceTrigger = typeof AutomationOnceTrigger.Type;

export const AutomationIntervalTrigger = Schema.Struct({
  kind: Schema.Literal("interval"),
  anchorAt: UtcTimestamp,
  intervalMinutes: AutomationIntervalMinutes,
}).annotations(strict);
export type AutomationIntervalTrigger = typeof AutomationIntervalTrigger.Type;

export const AutomationWeeklyLocalTrigger = Schema.Struct({
  kind: Schema.Literal("weekly-local"),
  weekdays: AutomationWeekdays,
  localTime: AutomationLocalTime,
  timeZone: AutomationTimeZone,
}).annotations(strict);
export type AutomationWeeklyLocalTrigger = typeof AutomationWeeklyLocalTrigger.Type;

export const AutomationTrigger = Schema.Union(
  AutomationOnceTrigger,
  AutomationIntervalTrigger,
  AutomationWeeklyLocalTrigger,
);
export type AutomationTrigger = typeof AutomationTrigger.Type;

// ── Authority, principal, and binding receipts ─────────────────────────────

export const AutomationMode = Schema.Literal("work", "code");
export type AutomationMode = typeof AutomationMode.Type;

const AutomationLocalUserPrincipal = Schema.Struct({
  kind: Schema.Literal("local-user"),
  actorId: ActorId,
}).annotations(strict);

const AutomationLocalWindowPrincipal = Schema.Struct({
  kind: Schema.Literal("local-window"),
  windowId: AutomationOpaqueReference,
  // The current authenticated desktop principal uses generation zero until
  // a durable capability-generation counter exists on the wire.
  capabilityGeneration: nonNegativeInteger,
}).annotations(strict);

const AutomationRemoteDevicePrincipal = Schema.Struct({
  kind: Schema.Literal("remote-device"),
  hostId: HostId,
  deviceId: AutomationOpaqueReference,
  credentialGeneration: positiveInteger,
  origin: AutomationOpaqueReference,
  protocolVersion: positiveInteger,
  capabilityDigest: AutomationDigest,
  sessionId: AutomationOpaqueReference,
}).annotations(strict);

/** Authenticated principals accepted on mutation commands. */
export const AutomationClientPrincipal = Schema.Union(
  AutomationLocalWindowPrincipal,
  AutomationRemoteDevicePrincipal,
);
export type AutomationClientPrincipal = typeof AutomationClientPrincipal.Type;
export const ClientPrincipal = AutomationClientPrincipal;
export type ClientPrincipal = AutomationClientPrincipal;

/** Separate author attribution may retain the local actor identity. */
export const AutomationAuthorPrincipal = Schema.Union(
  AutomationLocalUserPrincipal,
  AutomationLocalWindowPrincipal,
  AutomationRemoteDevicePrincipal,
);
export type AutomationAuthorPrincipal = typeof AutomationAuthorPrincipal.Type;

// Keep the authenticated command principal separate from author attribution:
// a local-user actor UUID is not proof of an authenticated request.

export const AutomationOrigin = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("interactive") }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("automation-run"),
    automationId: AutomationId,
    runId: AutomationRunId,
    occurrenceKey: AutomationOpaqueReference,
  }).annotations(strict),
);
export type AutomationOrigin = typeof AutomationOrigin.Type;
export const AutomationRunOrigin = AutomationOrigin;
export type AutomationRunOrigin = AutomationOrigin;

/** Automation authority is the existing provider-neutral run authority shape. */
export const AutomationAuthority = AgentRunAuthority;
export type AutomationAuthority = AgentRunAuthority;

export const AutomationBindingReceipt = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("work"),
    hostId: HostId,
    projectId: ProjectId,
    projectVersion: AggregateVersion,
    bindingRevisionId: BindingRevisionId,
    bindingReceiptId: BindingReceiptId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("code"),
    hostId: HostId,
    projectId: ProjectId,
    projectVersion: AggregateVersion,
    bindingRevisionId: BindingRevisionId,
    repositoryId: CodeRepositoryId,
    checkoutId: CodeCheckoutId,
    worktreeReceiptId: WorktreeReceiptId,
  }).annotations(strict),
);
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
}).annotations(strict);
export type AutomationExecutionProfileReceipt = typeof AutomationExecutionProfileReceipt.Type;

export const AutomationAuthorityProfileReceipt = Schema.Struct({
  profileId: AutomationAuthorityProfileId,
  profileVersion: AggregateVersion,
  requested: AgentRunAuthority,
  effective: AgentRunAuthority,
  effectiveAuthorityDigest: AutomationDigest,
}).annotations(strict);
export type AutomationAuthorityProfileReceipt = typeof AutomationAuthorityProfileReceipt.Type;

const automationAuthorityExecutionPolicyRank: Record<AgentRunAuthority["executionPolicy"], number> =
  {
    plan: 0,
    "approval-gated": 1,
    "full-access": 2,
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

function automationAuthorityFitsMode(authority: AgentRunAuthority, mode: AutomationMode): boolean {
  return mode !== "work" || (!authority.shell && !authority.git);
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
})
  .annotations(strict)
  .pipe(
    Schema.filter(
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
}).annotations(strict);
export type AutomationDeliveryTargetTemplate = typeof AutomationDeliveryTargetTemplate.Type;

export const AutomationDeliveryTargetReceipt = AutomationDeliveryTargetTemplate;
export type AutomationDeliveryTargetReceipt = AutomationDeliveryTargetTemplate;

// ── Definition, occurrence, and run aggregates ─────────────────────────────

export const AutomationBlockReason = Schema.Literal(
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
);
export type AutomationBlockReason = typeof AutomationBlockReason.Type;

export const AutomationRuntimeFailureReason = Schema.Literal(
  "dispatch-failed",
  "thread-creation-failed",
  "provider-launch-failed",
  "recovery-failed",
  "runtime-failed",
);
export type AutomationRuntimeFailureReason = typeof AutomationRuntimeFailureReason.Type;

export const AutomationRunFailureReason = Schema.Union(
  AutomationBlockReason,
  AutomationRuntimeFailureReason,
);
export type AutomationRunFailureReason = typeof AutomationRunFailureReason.Type;

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
}).annotations(strict);
export type AutomationDefinitionDraft = typeof AutomationDefinitionDraft.Type;

function automationDefinitionDraftMatchesPolicy(definition: AutomationDefinitionDraft): boolean {
  if (
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
    !automationAuthorityFitsMode(definition.authorityProfile.effective, definition.mode) ||
    !automationAuthorityProfileFitsExecutionProfile(
      definition.authorityProfile,
      definition.executionProfile,
    )
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
  createdBy: AutomationAuthorPrincipal,
  updatedBy: AutomationAuthorPrincipal,
  version: AggregateVersion,
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
}).annotations(strict);
export type AutomationDefinition = typeof AutomationDefinition.Type;

function automationPersistedDefinitionMatchesPolicy(definition: AutomationDefinition): boolean {
  const dueEvidenceMatches =
    definition.nextDueAt === null
      ? definition.nextDueResolution === undefined
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
    (definition.trigger.kind === "once"
      ? definition.nextDueAt === definition.trigger.scheduledAt
      : definition.nextDueAt !== null);
  return (
    automationDefinitionDraftMatchesPolicy(definition) &&
    dueEvidenceMatches &&
    enabledDueMatches &&
    (definition.lifecycle !== "enabled" || definition.blockedReason === undefined) &&
    !(
      (definition.lifecycle === "archived" || definition.lifecycle === "exhausted") &&
      definition.nextDueAt !== null
    )
  );
}

const AutomationPersistedDefinition = AutomationDefinition.pipe(
  Schema.filter(automationPersistedDefinitionMatchesPolicy),
);

export const AutomationDefinitionSnapshot = Schema.Struct({
  automationId: AutomationId,
  definitionRevision: AutomationDefinitionRevision,
  ...AutomationDefinitionDraft.fields,
})
  .annotations(strict)
  .pipe(Schema.filter(automationDefinitionDraftMatchesPolicy));
export type AutomationDefinitionSnapshot = typeof AutomationDefinitionSnapshot.Type;

export const AutomationScheduledOccurrence = Schema.Struct({
  kind: Schema.Literal("scheduled"),
  automationId: AutomationId,
  definitionRevision: AutomationDefinitionRevision,
  triggerKind: AutomationTriggerKind,
  scheduledAt: UtcTimestamp,
  resolutionEvidence: Schema.optional(AutomationWeeklyResolution),
})
  .annotations(strict)
  .pipe(
    Schema.filter(
      (occurrence) =>
        (occurrence.triggerKind === "weekly-local") ===
        (occurrence.resolutionEvidence !== undefined),
    ),
  );
export type AutomationScheduledOccurrence = typeof AutomationScheduledOccurrence.Type;

export const AutomationManualOccurrence = Schema.Struct({
  kind: Schema.Literal("manual"),
  automationId: AutomationId,
  definitionRevision: AutomationDefinitionRevision,
  runNowRequestId: AutomationRunNowRequestId,
}).annotations(strict);
export type AutomationManualOccurrence = typeof AutomationManualOccurrence.Type;

export const AutomationOccurrence = Schema.Union(
  AutomationScheduledOccurrence,
  AutomationManualOccurrence,
);
export type AutomationOccurrence = typeof AutomationOccurrence.Type;

export const AutomationOccurrenceKey = AutomationOccurrence;
export type AutomationOccurrenceKey = AutomationOccurrence;

export const AutomationOccurrenceKeyText = boundedText(512).pipe(
  Schema.brand("AutomationOccurrenceKeyText"),
);
export type AutomationOccurrenceKeyText = typeof AutomationOccurrenceKeyText.Type;

export function deriveAutomationOccurrenceKey(
  occurrence: AutomationOccurrence,
): AutomationOccurrenceKeyText {
  if (occurrence.kind === "scheduled") {
    return `scheduled:${String(occurrence.automationId)}:${occurrence.definitionRevision}:${occurrence.triggerKind}:${String(occurrence.scheduledAt)}` as AutomationOccurrenceKeyText;
  }
  return `manual:${String(occurrence.automationId)}:${occurrence.definitionRevision}:${String(occurrence.runNowRequestId)}` as AutomationOccurrenceKeyText;
}

function occurrenceKeyMatches(input: {
  readonly occurrence: AutomationOccurrence;
  readonly occurrenceKey: AutomationOccurrenceKeyText;
}): boolean {
  return input.occurrenceKey === deriveAutomationOccurrenceKey(input.occurrence);
}

const AUTOMATION_DAY_MS = 24 * 60 * 60 * 1_000;
const AUTOMATION_MINUTE_MS = 60 * 1_000;
const AUTOMATION_LOCAL_OFFSET_SAMPLE_RADIUS_HOURS = 48;
const AUTOMATION_LOCAL_OFFSET_SAMPLE_STEP_HOURS = 6;
const AUTOMATION_LOCAL_TRANSITION_PROBE_HOURS = 36;

interface AutomationLocalDateTimeParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function automationLocalDateTimeParts(
  epochMs: number,
  timeZone: string,
): AutomationLocalDateTimeParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    calendar: "iso8601",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(epochMs));
  const values = new Map(
    parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: values.get("year")!,
    month: values.get("month")!,
    day: values.get("day")!,
    hour: values.get("hour")!,
    minute: values.get("minute")!,
    second: values.get("second")!,
  };
}

function automationLocalWallAsUtc(parts: AutomationLocalDateTimeParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

function automationOffsetMinutesAt(epochMs: number, timeZone: string): number {
  const local = automationLocalDateTimeParts(epochMs, timeZone);
  return (automationLocalWallAsUtc(local) - epochMs) / AUTOMATION_MINUTE_MS;
}

function automationLocalPartsMatch(
  left: AutomationLocalDateTimeParts,
  right: AutomationLocalDateTimeParts,
): boolean {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute &&
    left.second === right.second
  );
}

function automationLocalPartsAtOrAfter(
  left: AutomationLocalDateTimeParts,
  right: AutomationLocalDateTimeParts,
): boolean {
  return automationLocalWallAsUtc(left) >= automationLocalWallAsUtc(right);
}

function automationWeeklyOccurrenceForDate(
  trigger: Extract<AutomationTrigger, { readonly kind: "weekly-local" }>,
  dateMs: number,
): number | undefined {
  const date = new Date(dateMs);
  const [hourText, minuteText] = trigger.localTime.split(":") as [string, string];
  const desired: AutomationLocalDateTimeParts = {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: Number(hourText),
    minute: Number(minuteText),
    second: 0,
  };
  const nominal = automationLocalWallAsUtc(desired);
  const offsets = new Set<number>();
  for (
    let hours = -AUTOMATION_LOCAL_OFFSET_SAMPLE_RADIUS_HOURS;
    hours <= AUTOMATION_LOCAL_OFFSET_SAMPLE_RADIUS_HOURS;
    hours += AUTOMATION_LOCAL_OFFSET_SAMPLE_STEP_HOURS
  ) {
    offsets.add(
      automationOffsetMinutesAt(nominal + hours * 60 * AUTOMATION_MINUTE_MS, trigger.timeZone),
    );
  }

  const candidates: number[] = [];
  for (const offset of offsets) {
    const candidate = nominal - offset * AUTOMATION_MINUTE_MS;
    if (
      automationLocalPartsMatch(automationLocalDateTimeParts(candidate, trigger.timeZone), desired)
    ) {
      candidates.push(candidate);
    }
  }
  if (candidates.length > 0) return Math.min(...candidates);

  const gapCandidates: number[] = [];
  for (const offset of offsets) {
    const transitionProbe = nominal - offset * AUTOMATION_MINUTE_MS;
    const beforeOffset = automationOffsetMinutesAt(
      transitionProbe - AUTOMATION_LOCAL_TRANSITION_PROBE_HOURS * 60 * AUTOMATION_MINUTE_MS,
      trigger.timeZone,
    );
    const afterOffset = automationOffsetMinutesAt(
      transitionProbe + AUTOMATION_LOCAL_TRANSITION_PROBE_HOURS * 60 * AUTOMATION_MINUTE_MS,
      trigger.timeZone,
    );
    if (afterOffset <= beforeOffset) continue;
    const candidate =
      nominal +
      (afterOffset - beforeOffset) * AUTOMATION_MINUTE_MS -
      afterOffset * AUTOMATION_MINUTE_MS;
    if (
      automationLocalPartsAtOrAfter(
        automationLocalDateTimeParts(candidate, trigger.timeZone),
        desired,
      )
    ) {
      gapCandidates.push(candidate);
    }
  }
  return gapCandidates.length > 0 ? Math.min(...gapCandidates) : undefined;
}

function automationScheduledAtMatchesTrigger(
  trigger: AutomationTrigger,
  scheduledAt: UtcTimestamp,
): boolean {
  const scheduledMs = new Date(scheduledAt).getTime();
  switch (trigger.kind) {
    case "once":
      return scheduledAt === trigger.scheduledAt;
    case "interval": {
      const anchorMs = new Date(trigger.anchorAt).getTime();
      const intervalMs = trigger.intervalMinutes * AUTOMATION_MINUTE_MS;
      return scheduledMs >= anchorMs && (scheduledMs - anchorMs) % intervalMs === 0;
    }
    case "weekly-local": {
      const local = automationLocalDateTimeParts(scheduledMs, trigger.timeZone);
      const localDateMs = Date.UTC(local.year, local.month - 1, local.day);
      for (let dayOffset = -2; dayOffset <= 2; dayOffset += 1) {
        const candidateDateMs = localDateMs + dayOffset * AUTOMATION_DAY_MS;
        const weekday = new Date(candidateDateMs).getUTCDay() || 7;
        if (!trigger.weekdays.includes(weekday as (typeof trigger.weekdays)[number])) continue;
        if (automationWeeklyOccurrenceForDate(trigger, candidateDateMs) === scheduledMs) {
          return true;
        }
      }
      return false;
    }
  }
}

function automationLocalTimeMinutes(localTime: string): number {
  const [hour = 0, minute = 0] = localTime.split(":").map(Number);
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
  const resolvedLocal = new Date(
    new Date(scheduledAt).getTime() + evidence.utcOffsetMinutes * AUTOMATION_MINUTE_MS,
  );
  if (
    resolvedLocal.toISOString().slice(0, 10) !== evidence.resolvedLocalDate ||
    resolvedLocal.toISOString().slice(11, 16) !== evidence.resolvedLocalTime
  ) {
    return false;
  }
  const weekday = resolvedLocal.getUTCDay() || 7;
  if (!trigger.weekdays.includes(weekday as (typeof trigger.weekdays)[number])) return false;
  if (evidence.resolution === "gap-forward") {
    return (
      automationLocalTimeMinutes(evidence.resolvedLocalTime) >=
      automationLocalTimeMinutes(trigger.localTime)
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
}).annotations(strict);
export type AutomationDispatchIntent = typeof AutomationDispatchIntent.Type;

export const AutomationRuntimeLaunchClaim = Schema.Struct({
  firstTurnRequestId: AutomationFirstTurnRequestId,
  generation: AutomationRunGeneration,
  leaseExpiresAt: UtcTimestamp,
  claimedAt: UtcTimestamp,
})
  .annotations(strict)
  .pipe(Schema.filter((claim) => claim.leaseExpiresAt > claim.claimedAt));
export type AutomationRuntimeLaunchClaim = typeof AutomationRuntimeLaunchClaim.Type;

export const AutomationCancellationTombstone = Schema.Struct({
  requestId: AutomationCancelRunRequestId,
  cancelledAt: UtcTimestamp,
}).annotations(strict);
export type AutomationCancellationTombstone = typeof AutomationCancellationTombstone.Type;

export const AutomationFirstTurnAcceptanceReceipt = Schema.Struct({
  firstTurnRequestId: AutomationFirstTurnRequestId,
  runtimeReceipt: AutomationOpaqueReference,
  acceptedAt: UtcTimestamp,
}).annotations(strict);
export type AutomationFirstTurnAcceptanceReceipt = typeof AutomationFirstTurnAcceptanceReceipt.Type;

export const AutomationRunFailure = Schema.Struct({
  reason: AutomationRunFailureReason,
  message: AutomationFailureMessage,
}).annotations(strict);
export type AutomationRunFailure = typeof AutomationRunFailure.Type;

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
  notificationRefs: Schema.Array(AutomationOpaqueReference).pipe(
    Schema.maxItems(MAX_AUTOMATION_NOTIFICATION_REFERENCES),
  ),
  completedAt: Schema.optional(UtcTimestamp),
  version: AggregateVersion,
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
})
  .annotations(strict)
  .pipe(
    Schema.filter((run) => {
      const occurrenceIdentityMatches =
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
          : run.scheduledAt === null);
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
      const authoritySnapshotMatchesDefinition =
        automationAuthoritySnapshotMatchesDefinition(
          run.authoritySnapshot,
          run.definitionSnapshot,
        ) &&
        automationAuthorityFitsMode(run.authoritySnapshot.effective, run.definitionSnapshot.mode);
      const cancellationTombstoneMatchesLifecycle =
        run.cancellationTombstone === undefined ||
        (run.lifecycle === "cancelled" && run.firstTurnAcceptance === undefined);
      const postLaunchEvidenceMatches =
        !AUTOMATION_POST_LAUNCH_LIFECYCLES.has(run.lifecycle) ||
        (run.threadId !== undefined &&
          run.dispatchIntent !== undefined &&
          run.firstTurnAcceptance !== undefined);
      const preLaunchAcceptanceAbsent =
        !AUTOMATION_PRE_LAUNCH_LIFECYCLES.has(run.lifecycle) ||
        run.firstTurnAcceptance === undefined;
      const queuedLaunchEvidenceAbsent =
        run.lifecycle !== "queued" ||
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

export const AutomationCommand = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("create-automation"),
    ...AutomationCommandFields,
    definition: AutomationDefinitionDraft,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("update-automation"),
    ...AutomationCommandFields,
    definition: AutomationDefinitionDraft,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("pause-automation"),
    ...AutomationCommandFields,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("resume-automation"),
    ...AutomationCommandFields,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("archive-automation"),
    ...AutomationCommandFields,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("run-now-automation"),
    ...AutomationCommandFields,
    runNowRequestId: AutomationRunNowRequestId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("cancel-current-automation-run"),
    ...AutomationCommandFields,
    runId: AutomationRunId,
    cancelRunRequestId: AutomationCancelRunRequestId,
    expectedRunVersion: AggregateVersion,
  }).annotations(strict),
);
export type AutomationCommand = typeof AutomationCommand.Type;
export const AutomationDefinitionCommand = AutomationCommand;
export type AutomationDefinitionCommand = AutomationCommand;

export const AutomationCommandFailure = Schema.Struct({
  kind: Schema.Literal("automation-command-failed"),
  reason: Schema.Literal(
    "invalid",
    "unauthorized",
    "not-found",
    "stale-version",
    "active-occurrence",
    "blocked",
    "terminal",
    "unsupported",
  ),
  message: AutomationFailureMessage,
  automationId: Schema.optional(AutomationId),
  runId: Schema.optional(AutomationRunId),
}).annotations(strict);
export type AutomationCommandFailure = typeof AutomationCommandFailure.Type;

export const AutomationCommandResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("automation-created"),
    automation: AutomationDefinition,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("automation-updated"),
    automation: AutomationDefinition,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("automation-paused"),
    automation: AutomationDefinition,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("automation-resumed"),
    automation: AutomationDefinition,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("automation-archived"),
    automation: AutomationDefinition,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("automation-run-accepted"),
    run: AutomationRun,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("automation-run-cancelled"),
    run: AutomationRun,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("automation-run-active-conflict"),
    automationId: AutomationId,
    runId: AutomationRunId,
    lifecycle: AutomationRunLifecycle,
  }).annotations(strict),
  AutomationCommandFailure,
);
export type AutomationCommandResult = typeof AutomationCommandResult.Type;

export const AutomationSummary = Schema.Struct({
  id: AutomationId,
  displayName: boundedText(MAX_AUTOMATION_DISPLAY_NAME_LENGTH),
  hostId: HostId,
  mode: AutomationMode,
  projectId: ProjectId,
  lifecycle: AutomationLifecycle,
  definitionRevision: AutomationDefinitionRevision,
  nextDueAt: Schema.NullOr(UtcTimestamp),
  latestRunLifecycle: Schema.optional(AutomationRunLifecycle),
  version: AggregateVersion,
  updatedAt: UtcTimestamp,
}).annotations(strict);
export type AutomationSummary = typeof AutomationSummary.Type;

export const AutomationQuery = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("list-automations"),
    hostId: HostId,
    mode: Schema.Literal("all", "work", "code"),
    projectId: Schema.optional(ProjectId),
    search: Schema.optional(boundedText(128)),
    limit: Schema.Int.pipe(
      Schema.greaterThanOrEqualTo(1),
      Schema.lessThanOrEqualTo(MAX_AUTOMATION_QUERY_LIMIT),
    ),
    cursor: Schema.optional(
      Schema.String.pipe(Schema.maxLength(MAX_AUTOMATION_QUERY_CURSOR_LENGTH)),
    ),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("get-automation"),
    automationId: AutomationId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("list-automation-runs"),
    automationId: AutomationId,
    limit: Schema.Int.pipe(
      Schema.greaterThanOrEqualTo(1),
      Schema.lessThanOrEqualTo(MAX_AUTOMATION_HISTORY_ENTRIES),
    ),
    cursor: Schema.optional(
      Schema.String.pipe(Schema.maxLength(MAX_AUTOMATION_QUERY_CURSOR_LENGTH)),
    ),
  }).annotations(strict),
);
export type AutomationQuery = typeof AutomationQuery.Type;
export const AutomationQueryRequest = AutomationQuery;
export type AutomationQueryRequest = AutomationQuery;

export const AutomationListResponse = Schema.Struct({
  kind: Schema.Literal("automation-list"),
  items: Schema.Array(AutomationSummary).pipe(Schema.maxItems(MAX_AUTOMATION_QUERY_LIMIT)),
  nextCursor: Schema.optional(
    Schema.String.pipe(Schema.maxLength(MAX_AUTOMATION_QUERY_CURSOR_LENGTH)),
  ),
}).annotations(strict);
export type AutomationListResponse = typeof AutomationListResponse.Type;

export const AutomationDetailResponse = Schema.Struct({
  kind: Schema.Literal("automation-detail"),
  automation: AutomationDefinition,
  runs: Schema.Array(AutomationRun).pipe(Schema.maxItems(MAX_AUTOMATION_HISTORY_ENTRIES)),
}).annotations(strict);
export type AutomationDetailResponse = typeof AutomationDetailResponse.Type;

export const AutomationHistoryResponse = Schema.Struct({
  kind: Schema.Literal("automation-history"),
  automationId: AutomationId,
  runs: Schema.Array(AutomationRun).pipe(Schema.maxItems(MAX_AUTOMATION_HISTORY_ENTRIES)),
  nextCursor: Schema.optional(
    Schema.String.pipe(Schema.maxLength(MAX_AUTOMATION_QUERY_CURSOR_LENGTH)),
  ),
}).annotations(strict);
export type AutomationHistoryResponse = typeof AutomationHistoryResponse.Type;

export const AutomationQueryResponse = Schema.Union(
  AutomationListResponse,
  AutomationDetailResponse,
  AutomationHistoryResponse,
);
export type AutomationQueryResponse = typeof AutomationQueryResponse.Type;
export const AutomationQueryResult = AutomationQueryResponse;
export type AutomationQueryResult = AutomationQueryResponse;

// ── Journal event payload contracts ─────────────────────────────────────────

export const AutomationDefinitionCreated = Schema.Struct({
  automation: AutomationPersistedDefinition,
}).annotations(strict);
export type AutomationDefinitionCreated = typeof AutomationDefinitionCreated.Type;

export const AutomationDefinitionUpdated = Schema.Struct({
  automation: AutomationPersistedDefinition,
  previousDefinitionRevision: AutomationDefinitionRevision,
}).annotations(strict);
export type AutomationDefinitionUpdated = typeof AutomationDefinitionUpdated.Type;

export const AutomationDefinitionLifecycleChanged = Schema.Struct({
  automation: AutomationPersistedDefinition,
  previousLifecycle: AutomationLifecycle,
}).annotations(strict);
export type AutomationDefinitionLifecycleChanged = typeof AutomationDefinitionLifecycleChanged.Type;

export const AutomationDefinitionExhausted = Schema.Struct({
  automationId: AutomationId,
  definitionRevision: AutomationDefinitionRevision,
  consumedScheduledAt: UtcTimestamp,
  version: AggregateVersion,
}).annotations(strict);
export type AutomationDefinitionExhausted = typeof AutomationDefinitionExhausted.Type;

export const AutomationOccurrenceClaimed = Schema.Struct({
  automationId: AutomationId,
  runId: AutomationRunId,
  occurrence: AutomationOccurrence,
  occurrenceKey: AutomationOccurrenceKeyText,
  claimedAt: UtcTimestamp,
})
  .annotations(strict)
  .pipe(Schema.filter(occurrenceEventMatches));
export type AutomationOccurrenceClaimed = typeof AutomationOccurrenceClaimed.Type;

export const AutomationOccurrenceSkipped = Schema.Struct({
  automationId: AutomationId,
  occurrence: AutomationScheduledOccurrence,
  occurrenceKey: AutomationOccurrenceKeyText,
  skippedAt: UtcTimestamp,
  reason: Schema.Literal("missed-run-policy", "missed-run-cap-recovery"),
})
  .annotations(strict)
  .pipe(Schema.filter(occurrenceEventMatches));
export type AutomationOccurrenceSkipped = typeof AutomationOccurrenceSkipped.Type;

export const AutomationRunCreated = Schema.Struct({
  run: AutomationRun,
}).annotations(strict);
export type AutomationRunCreated = typeof AutomationRunCreated.Type;

export const AutomationRunStatusChanged = Schema.Struct({
  automationId: AutomationId,
  runId: AutomationRunId,
  previousLifecycle: AutomationRunLifecycle,
  lifecycle: AutomationRunLifecycle,
  version: AggregateVersion,
  failure: Schema.optional(AutomationRunFailure),
  updatedAt: UtcTimestamp,
})
  .annotations(strict)
  .pipe(Schema.filter((event) => (event.lifecycle === "failed") === (event.failure !== undefined)));
export type AutomationRunStatusChanged = typeof AutomationRunStatusChanged.Type;

export const AutomationBlocked = Schema.Struct({
  automationId: AutomationId,
  runId: Schema.optional(AutomationRunId),
  reason: AutomationBlockReason,
  examinedFrom: Schema.optional(UtcTimestamp),
  examinedThrough: Schema.optional(UtcTimestamp),
  nextFutureOccurrence: Schema.optional(UtcTimestamp),
  recordedAt: UtcTimestamp,
})
  .annotations(strict)
  .pipe(
    Schema.filter(
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
}).annotations(strict);
export type AutomationDispatchIntentRecorded = typeof AutomationDispatchIntentRecorded.Type;

export const AutomationFirstTurnRuntimeClaimed = Schema.Struct({
  automationId: AutomationId,
  runId: AutomationRunId,
  claim: AutomationRuntimeLaunchClaim,
}).annotations(strict);
export type AutomationFirstTurnRuntimeClaimed = typeof AutomationFirstTurnRuntimeClaimed.Type;

export const AutomationFirstTurnDispatchCancelled = Schema.Struct({
  automationId: AutomationId,
  runId: AutomationRunId,
  tombstone: AutomationCancellationTombstone,
}).annotations(strict);
export type AutomationFirstTurnDispatchCancelled = typeof AutomationFirstTurnDispatchCancelled.Type;

export const AutomationFirstTurnAccepted = Schema.Struct({
  automationId: AutomationId,
  runId: AutomationRunId,
  receipt: AutomationFirstTurnAcceptanceReceipt,
}).annotations(strict);
export type AutomationFirstTurnAccepted = typeof AutomationFirstTurnAccepted.Type;

/** Appends an opaque notification delivery reference onto a run. */
export const AutomationNotificationRefRecorded = Schema.Struct({
  automationId: AutomationId,
  runId: AutomationRunId,
  notificationRef: AutomationOpaqueReference,
  version: AggregateVersion,
  recordedAt: UtcTimestamp,
}).annotations(strict);
export type AutomationNotificationRefRecorded = typeof AutomationNotificationRefRecorded.Type;

export const AUTOMATION_EVENT_NAMES = [
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
] as const;
export type AutomationEventName = (typeof AUTOMATION_EVENT_NAMES)[number];

export const AutomationEvent = Schema.Union(
  Schema.Struct({
    eventName: Schema.Literal("automation-definition-created@1"),
    payload: AutomationDefinitionCreated,
  }).annotations(strict),
  Schema.Struct({
    eventName: Schema.Literal("automation-definition-updated@1"),
    payload: AutomationDefinitionUpdated,
  }).annotations(strict),
  Schema.Struct({
    eventName: Schema.Literal("automation-definition-lifecycle-changed@1"),
    payload: AutomationDefinitionLifecycleChanged,
  }).annotations(strict),
  Schema.Struct({
    eventName: Schema.Literal("automation-definition-exhausted@1"),
    payload: AutomationDefinitionExhausted,
  }).annotations(strict),
  Schema.Struct({
    eventName: Schema.Literal("automation-occurrence-claimed@1"),
    payload: AutomationOccurrenceClaimed,
  }).annotations(strict),
  Schema.Struct({
    eventName: Schema.Literal("automation-occurrence-skipped@1"),
    payload: AutomationOccurrenceSkipped,
  }).annotations(strict),
  Schema.Struct({
    eventName: Schema.Literal("automation-run-created@1"),
    payload: AutomationRunCreated,
  }).annotations(strict),
  Schema.Struct({
    eventName: Schema.Literal("automation-run-status-changed@1"),
    payload: AutomationRunStatusChanged,
  }).annotations(strict),
  Schema.Struct({
    eventName: Schema.Literal("automation-blocked@1"),
    payload: AutomationBlocked,
  }).annotations(strict),
  Schema.Struct({
    eventName: Schema.Literal("automation-dispatch-intent-recorded@1"),
    payload: AutomationDispatchIntentRecorded,
  }).annotations(strict),
  Schema.Struct({
    eventName: Schema.Literal("automation-first-turn-runtime-claimed@1"),
    payload: AutomationFirstTurnRuntimeClaimed,
  }).annotations(strict),
  Schema.Struct({
    eventName: Schema.Literal("automation-first-turn-dispatch-cancelled@1"),
    payload: AutomationFirstTurnDispatchCancelled,
  }).annotations(strict),
  Schema.Struct({
    eventName: Schema.Literal("automation-first-turn-accepted@1"),
    payload: AutomationFirstTurnAccepted,
  }).annotations(strict),
  Schema.Struct({
    eventName: Schema.Literal("automation-notification-ref-recorded@1"),
    payload: AutomationNotificationRefRecorded,
  }).annotations(strict),
);
export type AutomationEvent = typeof AutomationEvent.Type;

// ── Decoders ────────────────────────────────────────────────────────────────

export const decodeAutomationId = Schema.decodeUnknownSync(AutomationId);
export const decodeAutomationRunId = Schema.decodeUnknownSync(AutomationRunId);
export const decodeAutomationRunNowRequestId = Schema.decodeUnknownSync(AutomationRunNowRequestId);
export const decodeAutomationCancelRunRequestId = Schema.decodeUnknownSync(
  AutomationCancelRunRequestId,
);
export const decodeAutomationFirstTurnRequestId = Schema.decodeUnknownSync(
  AutomationFirstTurnRequestId,
);
export const decodeAutomationDefinitionRevision = Schema.decodeUnknownSync(
  AutomationDefinitionRevision,
);
export const decodeAutomationTrigger = Schema.decodeUnknownSync(AutomationTrigger);
export const decodeAutomationAuthority = Schema.decodeUnknownSync(AutomationAuthority);
export const decodeAutomationMissedRunCap = Schema.decodeUnknownSync(AutomationMissedRunCap);
export const decodeAutomationDefinitionDraft = Schema.decodeUnknownSync(AutomationDefinitionDraft);
export const decodeAutomationDefinition = Schema.decodeUnknownSync(AutomationDefinition);
export const decodeAutomationOccurrence = Schema.decodeUnknownSync(AutomationOccurrence);
export const decodeAutomationOccurrenceKey = Schema.decodeUnknownSync(AutomationOccurrenceKey);
export const decodeAutomationRun = Schema.decodeUnknownSync(AutomationRun);
export const decodeAutomationCommand = Schema.decodeUnknownSync(AutomationCommand);
export const decodeAutomationCommandResult = Schema.decodeUnknownSync(AutomationCommandResult);
export const decodeAutomationQuery = Schema.decodeUnknownSync(AutomationQuery);
export const decodeAutomationQueryResponse = Schema.decodeUnknownSync(AutomationQueryResponse);
export const decodeAutomationEvent = Schema.decodeUnknownSync(AutomationEvent);
