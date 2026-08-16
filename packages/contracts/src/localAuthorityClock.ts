import { Schema } from "effect";
import { UtcTimestamp, CorrelationId } from "./events";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const nonNegativeInteger = Schema.Int.pipe(Schema.nonNegative());

/**
 * Extends the server-owned monotonic epoch guard introduced for remote
 * expiry (see `RemoteClockGuardV1`/`RemoteTimePostureV1`) to
 * process-local, time-bounded authority: Code operation approvals, launch
 * sessions, window authority, and managed-root grants. Unlike remote pairing,
 * this authority has no per-device host identity to key on — there is exactly
 * one guard for the local host process, keyed by the fixed
 * `LOCAL_AUTHORITY_CLOCK_GUARD_ID` singleton value rather than a `StableHostId`
 * (which is reserved for remote-pairing identity and would not describe a
 * purely local, non-paired process).
 */
export const LOCAL_AUTHORITY_CLOCK_GUARD_ID = "local-authority" as const;

/**
 * Server-owned monotonic epoch guard for local authority. `highWaterMarkMs` is
 * the greatest wall-clock time ever observed by this host process for local
 * authority purposes; effective expiry never uses a "now" below it, so a clock
 * rollback (NTP, DST/timezone misconfiguration, restart, restore) cannot
 * revive expired Code operation approvals, launch sessions, or window
 * authority. The record is non-sensitive: it carries only a coarse epoch bound
 * and the derived posture.
 */
export const LocalAuthorityClockGuardV1 = Schema.Struct({
  guardId: Schema.Literal(LOCAL_AUTHORITY_CLOCK_GUARD_ID),
  highWaterMarkMs: nonNegativeInteger,
  observedAt: UtcTimestamp,
  posture: Schema.Literal("ok", "recovery-required"),
  /**
   * Persisted only while recovery is required. Retaining the cause across a
   * restart lets the server keep a prior forward jump fail-closed without
   * indefinitely blocking a corrected rollback after legitimate downtime.
   */
  recoveryReason: Schema.optional(
    Schema.Literal("clock-rollback", "malformed-clock", "forward-jump"),
  ),
}).annotations(strict);
export type LocalAuthorityClockGuardV1 = typeof LocalAuthorityClockGuardV1.Type;

/**
 * Typed, redacted time-posture diagnostic for local authority. `recovery-
 * required` is surfaced when the host wall clock is unsafe for issuing new
 * local trust; it carries only a coarse reason and correlation id, never raw
 * times beyond the monotonic bound.
 */
export const LocalAuthorityTimePostureV1 = Schema.Union(
  Schema.Struct({
    posture: Schema.Literal("ok"),
    highWaterMarkMs: nonNegativeInteger,
    effectiveNowMs: nonNegativeInteger,
  }).annotations(strict),
  Schema.Struct({
    posture: Schema.Literal("recovery-required"),
    reason: Schema.Literal("clock-rollback", "malformed-clock", "forward-jump"),
    highWaterMarkMs: nonNegativeInteger,
    effectiveNowMs: nonNegativeInteger,
    correlationId: CorrelationId,
  }).annotations(strict),
);
export type LocalAuthorityTimePostureV1 = typeof LocalAuthorityTimePostureV1.Type;

export const decodeLocalAuthorityClockGuardV1 = Schema.decodeUnknownSync(
  LocalAuthorityClockGuardV1,
);
export const decodeLocalAuthorityTimePostureV1 = Schema.decodeUnknownSync(
  LocalAuthorityTimePostureV1,
);
