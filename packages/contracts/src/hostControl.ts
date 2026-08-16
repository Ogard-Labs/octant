import { Schema } from "effect";

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
