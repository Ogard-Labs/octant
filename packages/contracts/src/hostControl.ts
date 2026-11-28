import { Schema } from "effect";
import { AggregateId, EventActor, UtcTimestamp } from "./events";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * Host control wire contract for the shared web shell's Settings host card.
 *
 * The report is served only to an authorized local principal over the
 * loopback listener. It intentionally carries no secrets and no raw
 * filesystem paths — endpoints, sockets, and backup destinations stay in
 * local diagnostic tooling, never on this wire.
 */

const BoundedLabel = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(64));
const BoundedText = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255));
const BoundedCount = Schema.Int.pipe(Schema.between(0, 1_000_000));
const BoundedUptimeSeconds = Schema.Int.pipe(Schema.between(0, 31_536_000));

/** Owner service modes a running host may report. `maintenance` owners never
 *  serve the web shell, so the report cannot claim that mode. */
export const HostControlServiceMode = Schema.Literal("desktop", "foreground", "web", "service");
export type HostControlServiceMode = typeof HostControlServiceMode.Type;

export const HostControlIdentity = Schema.Struct({
  hostId: BoundedLabel,
  instanceId: BoundedLabel,
  serviceMode: HostControlServiceMode,
}).annotations(strict);
export type HostControlIdentity = typeof HostControlIdentity.Type;

export const HostControlVersions = Schema.Struct({
  server: BoundedLabel,
  wire: BoundedLabel,
}).annotations(strict);
export type HostControlVersions = typeof HostControlVersions.Type;

/** Service policy is reported honestly: a read failure is `unavailable`,
 *  never guessed as enabled or disabled. */
export const HostControlPolicy = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("known"),
    enabled: Schema.Boolean,
    updatedAt: BoundedText,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("unavailable"),
    reason: BoundedText,
  }).annotations(strict),
);
export type HostControlPolicy = typeof HostControlPolicy.Type;

export const HostControlReadiness = Schema.Struct({
  store: Schema.Struct({
    state: BoundedLabel,
    integrity: BoundedLabel,
  }).annotations(strict),
  replay: Schema.Struct({
    journalHead: BoundedCount,
    projections: BoundedCount,
  }).annotations(strict),
  clientsConnected: BoundedCount,
  uptimeSeconds: BoundedUptimeSeconds,
}).annotations(strict);
export type HostControlReadiness = typeof HostControlReadiness.Type;

export const HostLifecycleControlAvailability = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("available") }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("unavailable"),
    reason: BoundedText,
  }).annotations(strict),
);
export type HostLifecycleControlAvailability = typeof HostLifecycleControlAvailability.Type;

export const HostMemoryPressureLevel = Schema.Literal("normal", "elevated", "critical");
export type HostMemoryPressureLevel = typeof HostMemoryPressureLevel.Type;

const BoundedMegabytes = Schema.Int.pipe(Schema.between(0, 16_777_216));

/**
 * What the host did the last time memory ran short. Counts and flags only:
 * no provider, thread, or path is named, so the report is as safe to show as
 * the rest of the host card. `activeTurnsKept` is how many running turns were
 * left alone, because relief never stops one.
 */
export const HostMemoryRelief = Schema.Struct({
  at: BoundedText,
  pressure: Schema.Literal("elevated", "critical"),
  source: Schema.Literal("system", "process", "both"),
  idleProviderRuntimesStopped: BoundedCount,
  idleSessionsReleased: BoundedCount,
  cachesTrimmed: Schema.Boolean,
  activeTurnsKept: BoundedCount,
}).annotations(strict);
export type HostMemoryRelief = typeof HostMemoryRelief.Type;

/**
 * The previous host process ended without a clean stop. The cause is not
 * known; the last reading before it went silent is what the person can judge
 * it by.
 */
export const HostPreviousStop = Schema.Struct({
  lastSeenAt: BoundedText,
  pressure: HostMemoryPressureLevel,
  processMegabytes: BoundedMegabytes,
  /** The local crash record kept for that exit, when one could be kept. */
  crashRecord: Schema.optional(
    Schema.Struct({ recordedAt: BoundedText, exitReason: BoundedText }).annotations(strict),
  ),
}).annotations(strict);
export type HostPreviousStop = typeof HostPreviousStop.Type;

/** Bounds of a custom memory limit, in GB of 1024 MB each. */
export const HOST_MEMORY_LIMIT_MIN_GB = 0.5;
export const HOST_MEMORY_LIMIT_MAX_GB = 64;

const LimitGb = Schema.Number.pipe(
  Schema.between(HOST_MEMORY_LIMIT_MIN_GB, HOST_MEMORY_LIMIT_MAX_GB),
);

/**
 * When the host counts its own size as memory pressure. Automatic is the
 * built-in pair that shrinks on a small machine; custom is the person's pair,
 * used exactly as given. Critical must sit above pressured so the host never
 * reaches the harder level first.
 */
export const HostMemoryLimits = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("automatic") }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("custom"),
    pressuredGb: LimitGb,
    criticalGb: LimitGb,
  })
    .annotations(strict)
    .pipe(
      Schema.filter((limits) =>
        limits.criticalGb > limits.pressuredGb
          ? true
          : "The critical limit must be above the pressured limit.",
      ),
    ),
);
export type HostMemoryLimits = typeof HostMemoryLimits.Type;

/** The limits the guard is applying right now, resolved for this machine. */
export const HostMemoryEffectiveLimits = Schema.Struct({
  pressuredMegabytes: BoundedMegabytes,
  criticalMegabytes: BoundedMegabytes,
}).annotations(strict);
export type HostMemoryEffectiveLimits = typeof HostMemoryEffectiveLimits.Type;

/**
 * A request to change the limits. The host's policy checks the numbers, not
 * this schema, so an out-of-range value comes back as a refusal with a plain
 * message rather than as a malformed request.
 */
export const SetHostMemoryLimitsRequest = Schema.Struct({
  limits: Schema.Union(
    Schema.Struct({ kind: Schema.Literal("automatic") }).annotations(strict),
    Schema.Struct({
      kind: Schema.Literal("custom"),
      pressuredGb: Schema.Number,
      criticalGb: Schema.Number,
    }).annotations(strict),
  ),
}).annotations(strict);
export type SetHostMemoryLimitsRequest = typeof SetHostMemoryLimitsRequest.Type;

export const HostMemoryLimitsRefusalCode = Schema.Literal(
  "out-of-range",
  "critical-not-above-pressured",
  "unauthorized",
);
export type HostMemoryLimitsRefusalCode = typeof HostMemoryLimitsRefusalCode.Type;

export const SetHostMemoryLimitsOutcome = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("saved"),
    limits: HostMemoryLimits,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    code: HostMemoryLimitsRefusalCode,
    message: BoundedText,
  }).annotations(strict),
);
export type SetHostMemoryLimitsOutcome = typeof SetHostMemoryLimitsOutcome.Type;

export const HOST_MEMORY_LIMITS_AGGREGATE_TYPE = "host-memory-limits";
export const HOST_MEMORY_LIMITS_EVENT_NAME = "host-memory-limits.changed@1";

/**
 * One journaled change: who made it, when, and the values before and after.
 * `changedBy` says whether a window of the host or a paired device made it;
 * the event's actor names the device.
 */
export const HostMemoryLimitsChanged = Schema.Struct({
  kind: Schema.Literal("memory-limits-changed"),
  previous: HostMemoryLimits,
  next: HostMemoryLimits,
  changedBy: Schema.Literal("local-window", "remote-device"),
  changedAt: UtcTimestamp,
}).annotations(strict);
export type HostMemoryLimitsChanged = typeof HostMemoryLimitsChanged.Type;

export const HostMemoryStatus = Schema.Struct({
  pressure: HostMemoryPressureLevel,
  processMegabytes: BoundedMegabytes,
  limits: HostMemoryLimits,
  effectiveLimits: HostMemoryEffectiveLimits,
  lastRelief: Schema.optional(HostMemoryRelief),
  previousStop: Schema.optional(HostPreviousStop),
}).annotations(strict);
export type HostMemoryStatus = typeof HostMemoryStatus.Type;

/**
 * Why one start of the host held a thread a restart cut off instead of
 * continuing it. `uncertain-external-action` is a push or pull request step
 * whose outcome the host never learned; `uncertain-tool-call` is a tool call
 * of the cut-off turn that may change something and has no record of having
 * finished, named in the detail by its tool; `crash-loop` is a thread whose own
 * automatic continuations were cut off by a restart twice; `quit` is a thread
 * whose turn ended because a person quit Octant, not because it crashed or
 * the system restarted. `other` is never sent: it is what a client reads when
 * a later host names a reason this build does not know.
 */
export const HostRestartRecoveryHold = Schema.Literal(
  "turned-off",
  "opted-out",
  "uncertain-external-action",
  "uncertain-tool-call",
  "quit",
  "crash-loop",
  "cannot-resume",
  "refused",
  "other",
);
export type HostRestartRecoveryHold = typeof HostRestartRecoveryHold.Type;

/**
 * A hold's reason as it crosses the wire. A reason this build does not know
 * decodes to `other` and keeps its detail, which the host wrote for a person,
 * so the status of a newer host still decodes. (`uncertain-tool-call`
 * shipped with this in Octant 0.1.0-preview.20261114.3; a client of
 * 0.1.0-preview.20261113.2 or earlier reads the reasons as a closed list and
 * refuses the whole status of a host that reports one.)
 */
const RestartRecoveryHoldOnWire = Schema.transform(BoundedLabel, HostRestartRecoveryHold, {
  strict: true,
  decode: (reason) => (Schema.is(HostRestartRecoveryHold)(reason) ? reason : "other"),
  encode: (reason) => reason,
});

const RestartRecoveryMode = Schema.Literal("chat", "work", "code");
const MAX_RESTART_RECOVERY_THREADS = 500;

/**
 * What this start of the host did with the turns the previous one left cut
 * off: the threads it continued by itself and the ones it held for a person.
 * Absent when no turn was cut off. Thread ids only: a window resolves titles
 * through the threads it may open, so the report names nothing it could not.
 */
export const HostRestartRecovery = Schema.Struct({
  at: UtcTimestamp,
  continued: Schema.Array(
    Schema.Struct({ mode: RestartRecoveryMode, threadId: BoundedLabel }).annotations(strict),
  ).pipe(Schema.maxItems(MAX_RESTART_RECOVERY_THREADS)),
  held: Schema.Array(
    Schema.Struct({
      mode: RestartRecoveryMode,
      threadId: BoundedLabel,
      reason: RestartRecoveryHoldOnWire,
      detail: BoundedText,
    }).annotations(strict),
  ).pipe(Schema.maxItems(MAX_RESTART_RECOVERY_THREADS)),
}).annotations(strict);
export type HostRestartRecovery = typeof HostRestartRecovery.Type;

export const HostControlStatus = Schema.Struct({
  identity: HostControlIdentity,
  versions: HostControlVersions,
  policy: HostControlPolicy,
  readiness: HostControlReadiness,
  capabilities: Schema.Array(BoundedLabel).pipe(Schema.maxItems(64)),
  work: Schema.Struct({
    active: BoundedCount,
    attentionRequired: Schema.Boolean,
  }).annotations(strict),
  /** Absent while the host runs without a memory guard (a test seam). */
  memory: Schema.optional(HostMemoryStatus),
  restartRecovery: Schema.optional(HostRestartRecovery),
  lifecycle: Schema.Struct({
    stop: HostLifecycleControlAvailability,
    restart: HostLifecycleControlAvailability,
    enable: HostLifecycleControlAvailability,
    disable: HostLifecycleControlAvailability,
  }).annotations(strict),
}).annotations(strict);
export type HostControlStatus = typeof HostControlStatus.Type;

// ── Lifecycle command ───────────────────────────────────────────────────────

export const HOST_LIFECYCLE_ACTIONS = ["stop", "restart", "enable", "disable"] as const;

export const HostLifecycleAction = Schema.Literal(...HOST_LIFECYCLE_ACTIONS);
export type HostLifecycleAction = typeof HostLifecycleAction.Type;

export const HostLifecycleRequest = Schema.Struct({
  action: HostLifecycleAction,
}).annotations(strict);
export type HostLifecycleRequest = typeof HostLifecycleRequest.Type;

export const HostLifecycleRefusalCode = Schema.Literal(
  "restart-unavailable",
  "policy-unavailable",
  "unsupported",
);
export type HostLifecycleRefusalCode = typeof HostLifecycleRefusalCode.Type;

export const HostLifecycleOutcome = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("accepted"),
    action: HostLifecycleAction,
    message: BoundedText,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    action: HostLifecycleAction,
    code: HostLifecycleRefusalCode,
    guidance: BoundedText,
  }).annotations(strict),
);
export type HostLifecycleOutcome = typeof HostLifecycleOutcome.Type;

// ── Backup and recovery ─────────────────────────────────────────────────────

export const HostBackupRequest = Schema.Struct({
  label: Schema.optional(
    Schema.NonEmptyTrimmedString.pipe(
      Schema.maxLength(64),
      Schema.pattern(/^[a-z0-9][a-z0-9._-]{0,63}$/),
    ),
  ),
}).annotations(strict);
export type HostBackupRequest = typeof HostBackupRequest.Type;

/** Backup receipts on this wire are path-free: the snapshot is confined to
 *  the host data directory and located through local tooling. */
export const HostBackupOutcome = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("created"),
    label: BoundedLabel,
    migrationVersion: BoundedCount,
    journalHead: BoundedCount,
    byteLength: Schema.Int.pipe(Schema.greaterThanOrEqualTo(0)),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("failed"),
    code: BoundedLabel,
  }).annotations(strict),
);
export type HostBackupOutcome = typeof HostBackupOutcome.Type;

/** Destructive restore never runs against a live store; the online surface
 *  reports the honest refusal plus offline recovery guidance. */
export const HostRestoreOutcome = Schema.Struct({
  kind: Schema.Literal("refused-online"),
  guidance: BoundedText,
}).annotations(strict);
export type HostRestoreOutcome = typeof HostRestoreOutcome.Type;

// ── Drain before an update ──────────────────────────────────────────────────

/** The longest a drain waits for running turns before the update stops the host anyway. */
export const HOST_DRAIN_MAX_MINUTES = 60;

/**
 * `octant server drain`. Draining refuses every new Chat, Work and Code turn
 * and routine run and lets running turns go on; reading changes nothing;
 * lifting admits new turns again. Canonical: docs/architecture.md
 * § Draining before an update.
 */
export const HostDrainRequest = Schema.Union(
  Schema.Struct({
    action: Schema.Literal("drain"),
    minutes: Schema.Int.pipe(Schema.between(1, HOST_DRAIN_MAX_MINUTES)),
  }).annotations(strict),
  Schema.Struct({ action: Schema.Literal("read") }).annotations(strict),
  Schema.Struct({ action: Schema.Literal("lift") }).annotations(strict),
);
export type HostDrainRequest = typeof HostDrainRequest.Type;

const RunningTurns = Schema.Int.pipe(Schema.between(1, 100_000));

/**
 * How a drain stands. `drained` once no turn runs; `timed-out` once the wait
 * the drain was given passed with turns still running. Both keep refusing
 * new turns until the host stops or the drain lifts.
 */
export const HostDrainStatus = Schema.Union(
  Schema.Struct({ state: Schema.Literal("not-draining") }).annotations(strict),
  Schema.Struct({ state: Schema.Literal("draining"), running: RunningTurns }).annotations(strict),
  Schema.Struct({ state: Schema.Literal("drained") }).annotations(strict),
  Schema.Struct({ state: Schema.Literal("timed-out"), running: RunningTurns }).annotations(strict),
);
export type HostDrainStatus = typeof HostDrainStatus.Type;

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
    minutes: Schema.Int.pipe(Schema.between(1, HOST_DRAIN_MAX_MINUTES)),
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

const BoundedUpdateMessage = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512));

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

export const decodeHostControlStatus = Schema.decodeUnknownSync(HostControlStatus, {
  onExcessProperty: "error",
});
export const decodeHostLifecycleRequest = Schema.decodeUnknownSync(HostLifecycleRequest, {
  onExcessProperty: "error",
});
export const decodeHostLifecycleOutcome = Schema.decodeUnknownSync(HostLifecycleOutcome, {
  onExcessProperty: "error",
});
export const decodeHostBackupRequest = Schema.decodeUnknownSync(HostBackupRequest, {
  onExcessProperty: "error",
});
export const decodeHostBackupOutcome = Schema.decodeUnknownSync(HostBackupOutcome, {
  onExcessProperty: "error",
});
export const decodeHostRestoreOutcome = Schema.decodeUnknownSync(HostRestoreOutcome, {
  onExcessProperty: "error",
});
export const decodeHostMemoryLimits = Schema.decodeUnknownSync(HostMemoryLimits, {
  onExcessProperty: "error",
});
export const decodeSetHostMemoryLimitsRequest = Schema.decodeUnknownSync(
  SetHostMemoryLimitsRequest,
  { onExcessProperty: "error" },
);
export const decodeSetHostMemoryLimitsOutcome = Schema.decodeUnknownSync(
  SetHostMemoryLimitsOutcome,
  { onExcessProperty: "error" },
);
export const decodeHostMemoryLimitsChanged = Schema.decodeUnknownSync(HostMemoryLimitsChanged, {
  onExcessProperty: "error",
});
export const decodeHostDrainRequest = Schema.decodeUnknownSync(HostDrainRequest, {
  onExcessProperty: "error",
});
export const decodeHostDrainStatus = Schema.decodeUnknownSync(HostDrainStatus, {
  onExcessProperty: "error",
});
export const decodeHostUpdateRequest = Schema.decodeUnknownSync(HostUpdateRequest, {
  onExcessProperty: "error",
});
export const decodeHostUpdateStatus = Schema.decodeUnknownSync(HostUpdateStatus, {
  onExcessProperty: "error",
});
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
