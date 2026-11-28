import { Schema, SchemaTransformation } from "effect";
import { NonNegativeInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { UtcTimestamp } from "./events";

/**
 * Host control wire contract for the shared web shell's Settings host card.
 *
 * The report is served only to an authorized local principal over the
 * loopback listener. It intentionally carries no secrets and no raw
 * filesystem paths — endpoints, sockets, and backup destinations stay in
 * local diagnostic tooling, never on this wire.
 */

const BoundedLabel = Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(64));
const BoundedText = Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(255));
const BoundedCount = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 }));
const BoundedUptimeSeconds = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: 31_536_000 }),
);

/** Owner service modes a running host may report. `maintenance` owners never
 *  serve the web shell, so the report cannot claim that mode. */
export const HostControlServiceMode = Schema.Literals(["desktop", "foreground", "web", "service"]);
export type HostControlServiceMode = typeof HostControlServiceMode.Type;

export const HostControlIdentity = Schema.Struct({
  hostId: BoundedLabel,
  instanceId: BoundedLabel,
  serviceMode: HostControlServiceMode,
});
export type HostControlIdentity = typeof HostControlIdentity.Type;

export const HostControlVersions = Schema.Struct({
  server: BoundedLabel,
  wire: BoundedLabel,
});
export type HostControlVersions = typeof HostControlVersions.Type;

/** Service policy is reported honestly: a read failure is `unavailable`,
 *  never guessed as enabled or disabled. */
export const HostControlPolicy = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("known"),
    enabled: Schema.Boolean,
    updatedAt: BoundedText,
  }),
  Schema.Struct({
    kind: Schema.Literal("unavailable"),
    reason: BoundedText,
  }),
]);
export type HostControlPolicy = typeof HostControlPolicy.Type;

export const HostControlReadiness = Schema.Struct({
  store: Schema.Struct({
    state: BoundedLabel,
    integrity: BoundedLabel,
  }),
  replay: Schema.Struct({
    journalHead: BoundedCount,
    projections: BoundedCount,
  }),
  clientsConnected: BoundedCount,
  uptimeSeconds: BoundedUptimeSeconds,
});
export type HostControlReadiness = typeof HostControlReadiness.Type;

export const HostLifecycleControlAvailability = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("available") }),
  Schema.Struct({
    kind: Schema.Literal("unavailable"),
    reason: BoundedText,
  }),
]);
export type HostLifecycleControlAvailability = typeof HostLifecycleControlAvailability.Type;

export const HostMemoryPressureLevel = Schema.Literals(["normal", "elevated", "critical"]);
export type HostMemoryPressureLevel = typeof HostMemoryPressureLevel.Type;

const BoundedMegabytes = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 16_777_216 }));

/**
 * What the host did the last time memory ran short. Counts and flags only:
 * no provider, thread, or path is named, so the report is as safe to show as
 * the rest of the host card. `activeTurnsKept` is how many running turns were
 * left alone, because relief never stops one.
 */
export const HostMemoryRelief = Schema.Struct({
  at: BoundedText,
  pressure: Schema.Literals(["elevated", "critical"]),
  source: Schema.Literals(["system", "process", "both"]),
  idleProviderRuntimesStopped: BoundedCount,
  idleSessionsReleased: BoundedCount,
  cachesTrimmed: Schema.Boolean,
  activeTurnsKept: BoundedCount,
});
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
  crashRecord: Schema.optional(Schema.Struct({ recordedAt: BoundedText, exitReason: BoundedText })),
});
export type HostPreviousStop = typeof HostPreviousStop.Type;

/** Bounds of a custom memory limit, in GB of 1024 MB each. */
export const HOST_MEMORY_LIMIT_MIN_GB = 0.5;
export const HOST_MEMORY_LIMIT_MAX_GB = 64;

const LimitGb = Schema.Number.check(
  Schema.isBetween({ minimum: HOST_MEMORY_LIMIT_MIN_GB, maximum: HOST_MEMORY_LIMIT_MAX_GB }),
);

/**
 * When the host counts its own size as memory pressure. Automatic is the
 * built-in pair that shrinks on a small machine; custom is the person's pair,
 * used exactly as given. Critical must sit above pressured so the host never
 * reaches the harder level first.
 */
export const HostMemoryLimits = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("automatic") }),
  Schema.Struct({
    kind: Schema.Literal("custom"),
    pressuredGb: LimitGb,
    criticalGb: LimitGb,
  }).check(
    Schema.makeFilter((limits) =>
      limits.criticalGb > limits.pressuredGb
        ? true
        : "The critical limit must be above the pressured limit.",
    ),
  ),
]);
export type HostMemoryLimits = typeof HostMemoryLimits.Type;

/** The limits the guard is applying right now, resolved for this machine. */
export const HostMemoryEffectiveLimits = Schema.Struct({
  pressuredMegabytes: BoundedMegabytes,
  criticalMegabytes: BoundedMegabytes,
});
export type HostMemoryEffectiveLimits = typeof HostMemoryEffectiveLimits.Type;

/**
 * A request to change the limits. The host's policy checks the numbers, not
 * this schema, so an out-of-range value comes back as a refusal with a plain
 * message rather than as a malformed request.
 */
export const SetHostMemoryLimitsRequest = Schema.Struct({
  limits: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("automatic") }),
    Schema.Struct({
      kind: Schema.Literal("custom"),
      pressuredGb: Schema.Number,
      criticalGb: Schema.Number,
    }),
  ]),
});
export type SetHostMemoryLimitsRequest = typeof SetHostMemoryLimitsRequest.Type;

export const HostMemoryLimitsRefusalCode = Schema.Literals([
  "out-of-range",
  "critical-not-above-pressured",
  "unauthorized",
]);
export type HostMemoryLimitsRefusalCode = typeof HostMemoryLimitsRefusalCode.Type;

export const SetHostMemoryLimitsOutcome = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("saved"),
    limits: HostMemoryLimits,
  }),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    code: HostMemoryLimitsRefusalCode,
    message: BoundedText,
  }),
]);
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
  changedBy: Schema.Literals(["local-window", "remote-device"]),
  changedAt: UtcTimestamp,
});
export type HostMemoryLimitsChanged = typeof HostMemoryLimitsChanged.Type;

export const HostMemoryStatus = Schema.Struct({
  pressure: HostMemoryPressureLevel,
  processMegabytes: BoundedMegabytes,
  limits: HostMemoryLimits,
  effectiveLimits: HostMemoryEffectiveLimits,
  lastRelief: Schema.optional(HostMemoryRelief),
  previousStop: Schema.optional(HostPreviousStop),
});
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
export const HostRestartRecoveryHold = Schema.Literals([
  "turned-off",
  "opted-out",
  "uncertain-external-action",
  "uncertain-tool-call",
  "quit",
  "crash-loop",
  "cannot-resume",
  "refused",
  "other",
]);
export type HostRestartRecoveryHold = typeof HostRestartRecoveryHold.Type;

/**
 * A hold's reason as it crosses the wire. A reason this build does not know
 * decodes to `other` and keeps its detail, which the host wrote for a person,
 * so the status of a newer host still decodes. (`uncertain-tool-call`
 * shipped with this in Octant 0.1.0-preview.20261114.3; a client of
 * 0.1.0-preview.20261113.2 or earlier reads the reasons as a closed list and
 * refuses the whole status of a host that reports one.)
 */
const RestartRecoveryHoldOnWire = BoundedLabel.pipe(
  Schema.decodeTo(
    HostRestartRecoveryHold,
    SchemaTransformation.transform({
      decode: (reason) => (Schema.is(HostRestartRecoveryHold)(reason) ? reason : "other"),
      encode: (reason) => reason,
    }),
  ),
);

const RestartRecoveryMode = Schema.Literals(["chat", "work", "code"]);
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
    Schema.Struct({ mode: RestartRecoveryMode, threadId: BoundedLabel }),
  ).check(Schema.isMaxLength(MAX_RESTART_RECOVERY_THREADS)),
  held: Schema.Array(
    Schema.Struct({
      mode: RestartRecoveryMode,
      threadId: BoundedLabel,
      reason: RestartRecoveryHoldOnWire,
      detail: BoundedText,
    }),
  ).check(Schema.isMaxLength(MAX_RESTART_RECOVERY_THREADS)),
});
export type HostRestartRecovery = typeof HostRestartRecovery.Type;

export const HostControlStatus = Schema.Struct({
  identity: HostControlIdentity,
  versions: HostControlVersions,
  policy: HostControlPolicy,
  readiness: HostControlReadiness,
  capabilities: Schema.Array(BoundedLabel).check(Schema.isMaxLength(64)),
  work: Schema.Struct({
    active: BoundedCount,
    attentionRequired: Schema.Boolean,
  }),
  /** Absent while the host runs without a memory guard (a test seam). */
  memory: Schema.optional(HostMemoryStatus),
  restartRecovery: Schema.optional(HostRestartRecovery),
  lifecycle: Schema.Struct({
    stop: HostLifecycleControlAvailability,
    restart: HostLifecycleControlAvailability,
    enable: HostLifecycleControlAvailability,
    disable: HostLifecycleControlAvailability,
  }),
});
export type HostControlStatus = typeof HostControlStatus.Type;

// ── Lifecycle command ───────────────────────────────────────────────────────

export const HOST_LIFECYCLE_ACTIONS = ["stop", "restart", "enable", "disable"] as const;

export const HostLifecycleAction = Schema.Literals(HOST_LIFECYCLE_ACTIONS);
export type HostLifecycleAction = typeof HostLifecycleAction.Type;

export const HostLifecycleRequest = Schema.Struct({
  action: HostLifecycleAction,
});
export type HostLifecycleRequest = typeof HostLifecycleRequest.Type;

export const HostLifecycleRefusalCode = Schema.Literals([
  "restart-unavailable",
  "policy-unavailable",
  "unsupported",
]);
export type HostLifecycleRefusalCode = typeof HostLifecycleRefusalCode.Type;

export const HostLifecycleOutcome = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("accepted"),
    action: HostLifecycleAction,
    message: BoundedText,
  }),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    action: HostLifecycleAction,
    code: HostLifecycleRefusalCode,
    guidance: BoundedText,
  }),
]);
export type HostLifecycleOutcome = typeof HostLifecycleOutcome.Type;

// ── Backup and recovery ─────────────────────────────────────────────────────

export const HostBackupRequest = Schema.Struct({
  label: Schema.optional(
    Schema.Trimmed.check(
      Schema.isNonEmpty(),
      Schema.isMaxLength(64),
      Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,63}$/),
    ),
  ),
});
export type HostBackupRequest = typeof HostBackupRequest.Type;

/** Backup receipts on this wire are path-free: the snapshot is confined to
 *  the host data directory and located through local tooling. */
export const HostBackupOutcome = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("created"),
    label: BoundedLabel,
    migrationVersion: BoundedCount,
    journalHead: BoundedCount,
    byteLength: NonNegativeInt,
  }),
  Schema.Struct({
    kind: Schema.Literal("failed"),
    code: BoundedLabel,
  }),
]);
export type HostBackupOutcome = typeof HostBackupOutcome.Type;

/** Destructive restore never runs against a live store; the online surface
 *  reports the honest refusal plus offline recovery guidance. */
export const HostRestoreOutcome = Schema.Struct({
  kind: Schema.Literal("refused-online"),
  guidance: BoundedText,
});
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
export const HostDrainRequest = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("drain"),
    minutes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: HOST_DRAIN_MAX_MINUTES })),
  }),
  Schema.Struct({ action: Schema.Literal("read") }),
  Schema.Struct({ action: Schema.Literal("lift") }),
]);
export type HostDrainRequest = typeof HostDrainRequest.Type;

const RunningTurns = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100_000 }));

/**
 * How a drain stands. `drained` once no turn runs; `timed-out` once the wait
 * the drain was given passed with turns still running. Both keep refusing
 * new turns until the host stops or the drain lifts.
 */
export const HostDrainStatus = Schema.Union([
  Schema.Struct({ state: Schema.Literal("not-draining") }),
  Schema.Struct({ state: Schema.Literal("draining"), running: RunningTurns }),
  Schema.Struct({ state: Schema.Literal("drained") }),
  Schema.Struct({ state: Schema.Literal("timed-out"), running: RunningTurns }),
]);
export type HostDrainStatus = typeof HostDrainStatus.Type;

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
  STRICT_DECODE_OPTIONS,
);
export const decodeSetHostMemoryLimitsOutcome = Schema.decodeUnknownSync(
  SetHostMemoryLimitsOutcome,
  STRICT_DECODE_OPTIONS,
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
