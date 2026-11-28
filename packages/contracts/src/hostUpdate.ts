import { Schema } from "effect";
import { AggregateId, EventActor, UtcTimestamp } from "./events";
import { decodeHostAnswer } from "./hostAnswer";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

const BoundedLabel = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(64));
const BoundedCount = Schema.Int.pipe(Schema.between(0, 1_000_000));
const BoundedUpdateMessage = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512));
const HOST_UPDATE_DRAIN_MAX_MINUTES = 60;

// ── Host-owned update (/api/host-control/update) ────────────────────────────

export const HostUpdateHostKind = Schema.Literal("headless", "desktop");
export type HostUpdateHostKind = typeof HostUpdateHostKind.Type;

export const HostUpdateRing = Schema.Literal("stable", "candidate", "preview");
export type HostUpdateRing = typeof HostUpdateRing.Type;

/**
 * Drain choice sent by the requesting person-paired device or local window.
 * Matches the drain options of over-SSH updates so one confirmation governs
 * the whole fleet.
 */
export const HostUpdateDrain = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("wait"),
    minutes: Schema.Int.pipe(Schema.between(1, HOST_UPDATE_DRAIN_MAX_MINUTES)),
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("stop-now") }).annotations(strict),
);
export type HostUpdateDrain = typeof HostUpdateDrain.Type;

/**
 * Intent-only request to `/api/host-control/update`. Carries ONLY request id,
 * expected current version, and drain choice — NEVER a URL, file path, version
 * choice, or command arguments. Excess properties fail decoding closed.
 */
export const HostUpdateRequest = Schema.Union(
  Schema.Struct({
    action: Schema.Literal("prepare"),
    requestId: AggregateId,
    expectedCurrentVersion: BoundedLabel,
  }).annotations(strict),
  Schema.Struct({
    action: Schema.Literal("start"),
    requestId: AggregateId,
    expectedCurrentVersion: BoundedLabel,
    drain: HostUpdateDrain,
  }).annotations(strict),
  Schema.Struct({
    action: Schema.Literal("status"),
    requestId: Schema.optional(AggregateId),
  }).annotations(strict),
);
export type HostUpdateRequest = typeof HostUpdateRequest.Type;

export const HOST_UPDATE_STEPS = [
  "prepare",
  "download",
  "verify",
  "drain",
  "swap",
  "health-check",
  "roll-back",
  "install",
] as const;
export const HostUpdateStep = Schema.Literal(...HOST_UPDATE_STEPS);
export type HostUpdateStep = typeof HostUpdateStep.Type;

/**
 * Closed failure vocabulary for host updates and journal events. Never carries
 * raw command output, file paths, or URLs.
 */
export const HOST_UPDATE_FAILURE_REASONS = [
  "ring-no-headless-build",
  "no-newer-release",
  "version-mismatch",
  "already-updating",
  "unreachable",
  "untrusted-signature",
  "digest-mismatch",
  "build-unverified",
  "downgrade-refused",
  "backup-required",
  "drain-failed",
  "runner-launch-failed",
  "owner-stop-refused",
  "health-check-failed",
  "restore-failed",
  "recovery-required",
  "unsupported-install",
  "not-writable",
  "install-failed",
] as const;
export const HostUpdateFailureReason = Schema.Literal(...HOST_UPDATE_FAILURE_REASONS);
export type HostUpdateFailureReason = typeof HostUpdateFailureReason.Type;

export const HostUpdateState = Schema.Literal(
  "idle",
  "preparing",
  "update-available",
  "up-to-date",
  "running",
  "waiting-for-work",
  "installing",
  "updated",
  "rolled-back",
  "recovery-required",
  "refused",
  "failed",
);
export type HostUpdateState = typeof HostUpdateState.Type;

/**
 * Current or terminal state of one host-owned update. Carries no URLs, file
 * paths, or raw command output.
 */
export const HostUpdateStatus = Schema.Struct({
  requestId: Schema.optional(AggregateId),
  hostKind: HostUpdateHostKind,
  state: HostUpdateState,
  fromVersion: BoundedLabel,
  toVersion: Schema.optional(BoundedLabel),
  ring: Schema.optional(HostUpdateRing),
  storeMigration: Schema.optional(Schema.Boolean),
  drain: Schema.optional(HostUpdateDrain),
  step: Schema.optional(HostUpdateStep),
  failureReason: Schema.optional(HostUpdateFailureReason),
  storeRestored: Schema.optional(Schema.Boolean),
  activeAgentCount: Schema.optional(BoundedCount),
  activityUnconfirmed: Schema.optional(Schema.Boolean),
  message: Schema.optional(BoundedUpdateMessage),
}).annotations(strict);
export type HostUpdateStatus = typeof HostUpdateStatus.Type;

export const HOST_UPDATE_AGGREGATE_TYPE = "host-update";
export const HOST_UPDATE_REQUESTED_EVENT_NAME = "host-update.requested@1";
export const HOST_UPDATE_STEP_EVENT_NAME = "host-update.step@1";

export const HostUpdateRequested = Schema.Struct({
  requestId: AggregateId,
  actor: EventActor,
  hostKind: HostUpdateHostKind,
  fromVersion: BoundedLabel,
  toVersion: BoundedLabel,
  ring: HostUpdateRing,
  drain: HostUpdateDrain,
  requestedAt: UtcTimestamp,
}).annotations(strict);
export type HostUpdateRequested = typeof HostUpdateRequested.Type;

export const HostUpdateStepOutcome = Schema.Literal(
  "succeeded",
  "failed",
  "rolled-back",
  "recovery-required",
  "waiting-for-work",
);
export type HostUpdateStepOutcome = typeof HostUpdateStepOutcome.Type;

export const HostUpdateStepRecorded = Schema.Struct({
  requestId: AggregateId,
  actor: EventActor,
  hostKind: HostUpdateHostKind,
  fromVersion: BoundedLabel,
  toVersion: BoundedLabel,
  ring: HostUpdateRing,
  drain: HostUpdateDrain,
  step: HostUpdateStep,
  outcome: HostUpdateStepOutcome,
  failureReason: Schema.optional(HostUpdateFailureReason),
  storeRestored: Schema.optional(Schema.Boolean),
  recordedAt: UtcTimestamp,
}).annotations(strict);
export type HostUpdateStepRecorded = typeof HostUpdateStepRecorded.Type;

/**
 * Loopback-only server-to-desktop-main handoff payloads for `/api/desktop/host-update`.
 * Never forwarded on the private remote listener.
 */
export const DesktopHostUpdatePending = Schema.Struct({
  pending: Schema.NullOr(
    Schema.Struct({
      requestId: AggregateId,
      action: Schema.Literal("prepare", "start"),
      expectedCurrentVersion: BoundedLabel,
      drain: Schema.optional(HostUpdateDrain),
    }).annotations(strict),
  ),
}).annotations(strict);
export type DesktopHostUpdatePending = typeof DesktopHostUpdatePending.Type;

export const DesktopHostUpdateReport = Schema.Struct({
  requestId: AggregateId,
  state: Schema.Literal(
    "update-available",
    "up-to-date",
    "running",
    "waiting-for-work",
    "installing",
    "updated",
    "refused",
    "failed",
  ),
  fromVersion: BoundedLabel,
  toVersion: Schema.optional(BoundedLabel),
  ring: Schema.optional(HostUpdateRing),
  step: Schema.optional(HostUpdateStep),
  failureReason: Schema.optional(HostUpdateFailureReason),
  activeAgentCount: Schema.optional(BoundedCount),
  activityUnconfirmed: Schema.optional(Schema.Boolean),
  message: Schema.optional(BoundedUpdateMessage),
}).annotations(strict);
export type DesktopHostUpdateReport = typeof DesktopHostUpdateReport.Type;

// ── Decoders ────────────────────────────────────────────────────────────────

export const decodeHostUpdateRequest = Schema.decodeUnknownSync(HostUpdateRequest, {
  onExcessProperty: "error",
});
export const decodeHostUpdateStatus = Schema.decodeUnknownSync(HostUpdateStatus, {
  onExcessProperty: "error",
});
export const decodeHostUpdateStatusAnswer = decodeHostAnswer(HostUpdateStatus);
export const decodeHostUpdateRequested = Schema.decodeUnknownSync(HostUpdateRequested, {
  onExcessProperty: "error",
});
export const decodeHostUpdateStepRecorded = Schema.decodeUnknownSync(HostUpdateStepRecorded, {
  onExcessProperty: "error",
});
export const decodeDesktopHostUpdatePending = Schema.decodeUnknownSync(DesktopHostUpdatePending, {
  onExcessProperty: "error",
});
export const decodeDesktopHostUpdateReport = Schema.decodeUnknownSync(DesktopHostUpdateReport, {
  onExcessProperty: "error",
});
