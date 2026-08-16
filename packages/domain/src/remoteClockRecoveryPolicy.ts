import { REMOTE_REQUEST_CLOCK_SKEW_MS } from "./remoteAccessPolicy";

/**
 * Phase 14H — monotonic remote expiry and clock recovery.
 *
 * The host wall clock is authoritative for issued-time and expiry, but a wall
 * clock can move backwards: NTP corrections, a manual time change, a battery-
 * less RTC reset on restart, or a restored VM snapshot. If expiry were checked
 * against a raw wall clock alone, a rollback could make `now < expiresAt` again
 * and revive already-expired authority. DST and timezone changes never alter
 * the UTC epoch, but a misconfigured host may still report an epoch that jumps.
 *
 * The guard here is a server-owned monotonic bound: a high-water mark of the
 * greatest wall-clock time ever observed. The effective "now" used for expiry
 * is never allowed to fall below that mark, so expired authority can never
 * revive. A small backwards step is clamped forward silently; a large step is
 * still clamped forward but additionally reported as `recovery-required` so the
 * host can surface an explicit, actionable recovery state instead of silently
 * issuing new trust against an unsafe clock.
 *
 * A large FORWARD discontinuity is just as dangerous as a rollback: if a host's
 * clock jumps years ahead, that value would otherwise be committed as an
 * irreversible high-water mark, freezing the guard in rollback recovery long
 * after the clock is corrected. When a monotonic elapsed measurement is
 * available (a steady, restart-local clock such as `performance.now()`), a
 * forward step larger than the elapsed monotonic time plus a small tolerance is
 * treated as an implausible discontinuity: the bound advances only by the
 * plausible monotonic amount and the posture is flagged `recovery-required`, so
 * a corrected clock recovers instead of remaining frozen in the future.
 */

/**
 * Backwards movement at or below this bound is treated as ordinary clock jitter
 * (NTP steps, brief corrections) and clamped forward silently. Movement beyond
 * it is reported as `recovery-required` because the host time is likely unsafe.
 */
export const REMOTE_CLOCK_ROLLBACK_TOLERANCE_MS = 2 * 60 * 1_000;

/**
 * Forward movement beyond the elapsed monotonic time by more than this bound is
 * treated as an implausible discontinuity (a mis-stepped wall clock) rather than
 * genuine elapsed time. The guard advances only by the plausible monotonic
 * amount and the posture is flagged `recovery-required`, so the bound is never
 * frozen far in the future and a corrected clock recovers.
 */
export const REMOTE_CLOCK_FORWARD_JUMP_TOLERANCE_MS = 2 * 60 * 1_000;

export type ClockPostureKind = "ok" | "recovery-required";

export type ClockRecoveryReason = "clock-rollback" | "malformed-clock" | "forward-jump";

export interface MonotonicNowEvaluation {
  /** Monotonic, non-decreasing effective now. Never below the high-water mark. */
  readonly effectiveNowMs: number;
  /** Updated high-water mark to persist. */
  readonly highWaterMarkMs: number;
  /** True when the wall clock advanced the high-water mark. */
  readonly advanced: boolean;
  /** How far the wall clock is behind the prior high-water mark (0 if not behind). */
  readonly rollbackMs: number;
  /**
   * How far the wall clock jumped ahead of the plausible monotonic bound (0
   * when no implausible forward discontinuity was detected). Only meaningful
   * when a monotonic elapsed measurement was supplied.
   */
  readonly forwardJumpMs: number;
  readonly posture: ClockPostureKind;
  readonly reason?: ClockRecoveryReason;
}

function normalizeHighWaterMark(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Evaluate a monotonic effective now against a prior high-water mark. The
 * effective now is never below the prior mark, so any wall-clock rollback
 * (including DST/timezone misconfiguration) cannot revive expired authority.
 */
export function evaluateMonotonicNow(input: {
  readonly wallClockMs: number;
  readonly highWaterMarkMs: number;
  readonly toleranceMs?: number;
  /**
   * Elapsed time on a steady, restart-local monotonic clock (e.g.
   * `performance.now()`) since the prior evaluation. When provided, a forward
   * wall-clock step larger than this elapsed time plus `forwardToleranceMs` is
   * treated as an implausible discontinuity. Omit on the first observation of a
   * process lifetime, where no monotonic baseline exists yet.
   */
  readonly monotonicElapsedMs?: number;
  readonly forwardToleranceMs?: number;
}): MonotonicNowEvaluation {
  const tolerance =
    input.toleranceMs !== undefined && Number.isFinite(input.toleranceMs) && input.toleranceMs >= 0
      ? input.toleranceMs
      : REMOTE_CLOCK_ROLLBACK_TOLERANCE_MS;
  const prior = normalizeHighWaterMark(input.highWaterMarkMs);

  if (!Number.isFinite(input.wallClockMs) || input.wallClockMs < 0) {
    return {
      effectiveNowMs: prior,
      highWaterMarkMs: prior,
      advanced: false,
      rollbackMs: 0,
      forwardJumpMs: 0,
      posture: "recovery-required",
      reason: "malformed-clock",
    };
  }

  if (input.wallClockMs >= prior) {
    const forwardStepMs = input.wallClockMs - prior;
    const monotonicElapsedMs =
      input.monotonicElapsedMs !== undefined &&
      Number.isFinite(input.monotonicElapsedMs) &&
      input.monotonicElapsedMs >= 0
        ? input.monotonicElapsedMs
        : undefined;
    if (monotonicElapsedMs !== undefined) {
      const forwardTolerance =
        input.forwardToleranceMs !== undefined &&
        Number.isFinite(input.forwardToleranceMs) &&
        input.forwardToleranceMs >= 0
          ? input.forwardToleranceMs
          : REMOTE_CLOCK_FORWARD_JUMP_TOLERANCE_MS;
      const plausibleForwardMs = monotonicElapsedMs + forwardTolerance;
      if (forwardStepMs > plausibleForwardMs) {
        // Implausible forward discontinuity: advance the bound only by the
        // plausible monotonic amount, never by the raw jump. This keeps expired
        // authority from reviving while ensuring the guard is not frozen far in
        // the future once the wall clock is corrected. Floor to whole
        // milliseconds because the monotonic elapsed measurement may be
        // fractional but epoch bounds are integers.
        const boundedMark = Math.floor(prior + plausibleForwardMs);
        return {
          effectiveNowMs: boundedMark,
          highWaterMarkMs: boundedMark,
          advanced: boundedMark > prior,
          rollbackMs: 0,
          forwardJumpMs: forwardStepMs,
          posture: "recovery-required",
          reason: "forward-jump",
        };
      }
    }
    return {
      effectiveNowMs: input.wallClockMs,
      highWaterMarkMs: input.wallClockMs,
      advanced: forwardStepMs > 0,
      rollbackMs: 0,
      forwardJumpMs: 0,
      posture: "ok",
    };
  }

  const rollbackMs = prior - input.wallClockMs;
  if (rollbackMs > tolerance) {
    return {
      effectiveNowMs: prior,
      highWaterMarkMs: prior,
      advanced: false,
      rollbackMs,
      forwardJumpMs: 0,
      posture: "recovery-required",
      reason: "clock-rollback",
    };
  }
  return {
    effectiveNowMs: prior,
    highWaterMarkMs: prior,
    advanced: false,
    rollbackMs,
    forwardJumpMs: 0,
    posture: "ok",
  };
}

/**
 * Derive a durable high-water mark from a persisted value plus any durable
 * timestamps already committed to authoritative stores (device/session/ticket
 * expiries, receipt expiries, journal times). Restart therefore preserves the
 * monotonic bound even if the persisted guard row is missing.
 */
export function deriveClockHighWaterMark(input: {
  readonly persistedHighWaterMarkMs?: number;
  readonly durableTimestampsMs?: ReadonlyArray<number>;
}): number {
  let mark = 0;
  const candidates = [
    ...(input.persistedHighWaterMarkMs === undefined ? [] : [input.persistedHighWaterMarkMs]),
    ...(input.durableTimestampsMs ?? []),
  ];
  for (const candidate of candidates) {
    if (Number.isFinite(candidate) && candidate >= 0 && candidate > mark) {
      mark = candidate;
    }
  }
  return mark;
}

export type ClientTimestampTrust =
  | { readonly kind: "accepted" }
  | { readonly kind: "rejected"; readonly reason: "future-skew" | "past-skew" | "malformed" };

/**
 * A client-supplied timestamp is only ever used to bound freshness, never to
 * extend trust. A future timestamp beyond the skew window is rejected so a
 * client clock ahead of the host cannot keep authority alive.
 */
export function evaluateClientTimestampTrust(input: {
  readonly clientTimestampMs: number;
  readonly serverNowMs: number;
  readonly skewToleranceMs?: number;
}): ClientTimestampTrust {
  if (!Number.isFinite(input.clientTimestampMs) || !Number.isFinite(input.serverNowMs)) {
    return { kind: "rejected", reason: "malformed" };
  }
  const skew =
    input.skewToleranceMs !== undefined &&
    Number.isFinite(input.skewToleranceMs) &&
    input.skewToleranceMs >= 0
      ? input.skewToleranceMs
      : REMOTE_REQUEST_CLOCK_SKEW_MS;
  const delta = input.clientTimestampMs - input.serverNowMs;
  if (delta > skew) return { kind: "rejected", reason: "future-skew" };
  if (-delta > skew) return { kind: "rejected", reason: "past-skew" };
  return { kind: "accepted" };
}
