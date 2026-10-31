import { Schema } from "effect";
import { UtcTimestamp } from "./events";

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

/** One journaled change: who made it, when, and the values before and after. */
export const HostMemoryLimitsChanged = Schema.Struct({
  kind: Schema.Literal("memory-limits-changed"),
  previous: HostMemoryLimits,
  next: HostMemoryLimits,
  changedBy: Schema.Literal("local-window"),
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
