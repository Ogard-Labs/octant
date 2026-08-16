import { randomUUID as defaultRandomUUID } from "node:crypto";
import { uptime } from "node:os";
import {
  decodeLocalAuthorityClockGuardV1,
  decodeLocalAuthorityTimePostureV1,
  LOCAL_AUTHORITY_CLOCK_GUARD_ID,
  type LocalAuthorityTimePostureV1,
} from "@octant/contracts/local-authority-clock";
import {
  evaluateMonotonicNow,
  REMOTE_CLOCK_FORWARD_JUMP_TOLERANCE_MS,
  REMOTE_CLOCK_ROLLBACK_TOLERANCE_MS,
  type ClockPostureKind,
  type ClockRecoveryReason,
} from "@octant/domain/remote-clock-recovery-policy";
import type { SqliteConnection } from "./persistence/sqlitePort";

/**
 * Server-owned monotonic epoch guard for local authority.
 *
 * `MonotonicRemoteClock` bounded remote pairing/session/device expiry
 * against a server-owned high-water mark so a wall-clock rollback could not
 * revive expired remote trust. Code operation approvals, launch sessions, and
 * window authority are process-local (not remote-paired) but compared raw
 * wall time the same unsafe way: a rollback of the host clock could revive an
 * already-expired approval, launch session, or window-authority capability.
 *
 * This class reuses the exact same domain policy (`evaluateMonotonicNow`) as
 * the remote guard, but is intentionally a separate, simpler persistence
 * wrapper rather than a second `MonotonicRemoteClock` instance: the remote guard's schema
 * (`RemoteClockGuardV1`) requires a `StableHostId` (a UUID-shaped remote-
 * pairing identity) and its bound is only constructed lazily, on first remote-
 * listener enable, so a disabled-by-default server never touches host-
 * identity key material. Local authority (Code approvals, launch sessions,
 * window authority) is always active regardless of remote-access
 * configuration, so it needs its own guard, constructed unconditionally at
 * server startup, keyed by the fixed `LOCAL_AUTHORITY_CLOCK_GUARD_ID`
 * singleton rather than a remote host identity.
 *
 * `nowMs()`/`clamp()` are pure in-memory and safe to call on every request.
 * During a sustained forward wall-clock step the mark is held at the bounded
 * discontinuity plus the real monotonic elapsed time since it was detected,
 * so the forward-jump tolerance is granted once, never re-granted per
 * observation. `persist()` writes the high-water mark durably;
 * `persistIfAdvanced()` is the incremental variant used on the request hot
 * path, coalescing advances at a bounded interval so a normally advancing wall
 * clock does not write the guard row on every request.
 */

interface ClockGuardRow {
  readonly high_water_mark_ms: number;
  readonly posture: string;
  readonly recovery_reason: string | null;
  readonly elapsed_checkpoint_ms: number | null;
}

interface PersistedClockGuard {
  readonly highWaterMarkMs: number;
  readonly posture: ClockPostureKind;
  readonly recoveryReason?: ClockRecoveryReason;
  /**
   * Last reading from the suspend-aware elapsed-time source. It proves normal
   * downtime across an application restart only while that source remains
   * monotonic (the expected case for `os.uptime()` on an uninterrupted host).
   */
  readonly elapsedCheckpointMs?: number;
}

// A fresh profile has no durable local authority to preserve. Treat only an
// unmistakably stale RTC (rather than every synthetic or ordinary first clock
// value) as eligible for the one-time bootstrap correction below. The floor is
// deliberately fixed in the past so it remains valid as Octant ages.
const STALE_RTC_BOOTSTRAP_EPOCH_FLOOR_MS = Date.UTC(2020, 0, 1);

// A reboot discards every local authority capability, so a modest advance of
// the durable epoch is safe to admit without replaying downtime from a reset
// uptime source. The RTC is still unauthenticated at that boundary: cap the
// exception so a bad battery or hostile host-time change cannot durably pin
// expiry years into the future. One day covers ordinary overnight shutdowns
// while keeping the recovery path explicit for longer unexplained advances.
const REBOOT_WALL_CLOCK_ADMISSION_MAX_ADVANCE_MS = 24 * 60 * 60 * 1_000;

export interface LocalAuthorityClockOptions {
  readonly connection: SqliteConnection;
  readonly wallClock?: () => number;
  readonly toleranceMs?: number;
  readonly forwardJumpToleranceMs?: number;
  /**
   * System elapsed-time source that includes system suspension. Defaults to
   * `os.uptime() * 1_000`, which advances across a sleeping host, so a normal
   * wake cannot leave a short-lived approval or launch session valid for hours
   * merely because a process-local timer paused. It takes precedence over
   * `monotonicSource` when both are supplied.
   */
  readonly suspendAwareElapsedSource?: () => number;
  /**
   * Legacy/test seam for a steady, restart-local monotonic source used to
   * bound forward wall-clock discontinuities. The production default is the
   * suspend-aware system elapsed source above.
   */
  readonly monotonicSource?: () => number;
  readonly correlationId?: () => string;
  /**
   * Minimum wall-clock advance (in milliseconds) that must accumulate beyond
   * the last durable write before `persistIfAdvanced()` checkpoints again.
   * Coalesces the near-continuous advances of a normally running wall clock
   * so the request hot path does not write the SQLite guard row on every
   * request. An advance smaller than this bound stays authoritative in memory
   * and is captured by a later coalesced write or the clean-shutdown
   * `persist()`. Defaults to one second.
   */
  readonly persistIntervalMs?: number;
}

export class LocalAuthorityClock {
  readonly #connection: SqliteConnection;
  readonly #wallClock: () => number;
  readonly #toleranceMs: number;
  readonly #forwardJumpToleranceMs: number;
  readonly #monotonicSource: () => number;
  readonly #correlationId: () => string;
  readonly #persistIntervalMs: number;
  #highWaterMarkMs: number;
  #posture: ClockPostureKind = "ok";
  #reason: ClockRecoveryReason | undefined;
  #effectiveNowMs: number;
  #lastMonotonicMs: number | undefined;
  #lastPersistedHighWaterMarkMs = -1;
  #lastPersistedPosture: ClockPostureKind | undefined;
  #lastPersistedRecoveryReason: ClockRecoveryReason | undefined;
  #restoredElapsedCheckpointMs: number | undefined;
  // A guard that has never been written has no previously-issued durable local
  // authority behind it. Keep that distinction until the first successful
  // persistence so a stale RTC on an initial install can be corrected forward
  // instead of pinning the epoch near the stale value for years.
  #bootstrapWithoutDurableGuard = false;
  #bootstrapObservedWallClock = false;
  // The first reading in a new process has no process-local elapsed baseline.
  // A healthy persisted guard therefore needs its own bounded admission check;
  // otherwise a far-future reading while the server was down is accepted as
  // legitimate downtime and becomes a durable authority epoch.
  #restoredOkGuard = false;
  #restoredRecoveryPosture = false;
  /**
   * Forward-jump recovery anchor. Set at the moment an implausible forward
   * wall-clock discontinuity is first detected: the bounded mark granted at
   * that observation and the steady-clock reading when it was established.
   * While a sustained forward step keeps the wall clock ahead, the mark
   * advances by only the real monotonic elapsed time since this anchor, so
   * fresh forward-jump tolerance is never granted again on every observation.
   */
  #forwardJumpAnchorMarkMs: number | undefined;
  #forwardJumpAnchorMonotonicMs: number | undefined;

  constructor(options: LocalAuthorityClockOptions) {
    this.#connection = options.connection;
    this.#wallClock = options.wallClock ?? (() => Date.now());
    this.#toleranceMs = options.toleranceMs ?? REMOTE_CLOCK_ROLLBACK_TOLERANCE_MS;
    this.#forwardJumpToleranceMs =
      options.forwardJumpToleranceMs ?? REMOTE_CLOCK_FORWARD_JUMP_TOLERANCE_MS;
    this.#monotonicSource =
      options.suspendAwareElapsedSource ?? options.monotonicSource ?? (() => uptime() * 1_000);
    this.#correlationId = options.correlationId ?? defaultRandomUUID;
    this.#persistIntervalMs =
      options.persistIntervalMs !== undefined &&
      Number.isFinite(options.persistIntervalMs) &&
      options.persistIntervalMs >= 0
        ? options.persistIntervalMs
        : 1_000;
    const persisted = this.#loadPersistedClockGuard();
    this.#highWaterMarkMs = persisted?.highWaterMarkMs ?? 0;
    this.#effectiveNowMs = this.#highWaterMarkMs;
    this.#bootstrapWithoutDurableGuard = persisted === undefined;
    if (persisted !== undefined) {
      this.#lastPersistedHighWaterMarkMs = persisted.highWaterMarkMs;
      this.#lastPersistedPosture = persisted.posture;
      this.#lastPersistedRecoveryReason = persisted.recoveryReason;
      this.#restoredElapsedCheckpointMs = persisted.elapsedCheckpointMs;
      this.#restoredOkGuard = persisted.posture === "ok";
      if (persisted.posture === "recovery-required") {
        this.#posture = "recovery-required";
        // Guard rows written before recovery reasons were persisted must stay
        // conservative: treat an unknown prior recovery as a forward jump and
        // do not re-admit a still-far-future raw clock on restart.
        this.#reason = persisted.recoveryReason ?? "forward-jump";
        this.#restoredRecoveryPosture = true;
      }
    }
  }

  /**
   * Monotonic effective now in epoch milliseconds, reading the injected wall
   * clock. Advances the in-memory high-water mark; never writes to the
   * database.
   */
  nowMs(): number {
    const { elapsedMs, nowMs, sourceResetSinceCheckpoint } = this.#observeMonotonicElapsed();
    return this.#evaluate(this.#wallClock(), elapsedMs, nowMs, sourceResetSinceCheckpoint);
  }

  /**
   * Clamp a caller-supplied wall-clock reading (for example a route handler's
   * own `Date.now()`) against the same shared monotonic bound, without
   * reading this instance's own wall-clock source. Used by stores whose
   * public API already accepts a per-call `now`/timestamp value (window
   * authority, launch-session exchange, managed-root grants) so they can be
   * made rollback-safe without changing every calling route.
   *
   * Shares the same steady-clock forward-jump check as `nowMs()`: a far-future
   * caller-supplied reading with no plausible monotonic elapsed time is
   * treated as an implausible discontinuity and bounded, never committed, so a
   * single clamp cannot expire existing authority and freeze the guard in the
   * future.
   */
  clamp(wallClockMs: number): number {
    const { elapsedMs, nowMs, sourceResetSinceCheckpoint } = this.#observeMonotonicElapsed();
    return this.#evaluate(wallClockMs, elapsedMs, nowMs, sourceResetSinceCheckpoint);
  }

  /**
   * Read the steady, restart-local monotonic source and return the elapsed
   * time since the previous observation (or `undefined` when no baseline exists
   * yet — the first observation of a process lifetime) together with the raw
   * reading, which anchors forward-jump recovery. Updates the baseline so a
   * forward wall-clock step must be justified by real elapsed steady time.
   */
  #observeMonotonicElapsed(): {
    readonly elapsedMs: number | undefined;
    readonly nowMs: number;
    /** A persisted boot-uptime checkpoint is higher than this first reading. */
    readonly sourceResetSinceCheckpoint: boolean;
  } {
    const monotonicNowMs = this.#monotonicSource();
    const hasValidMonotonicNow = Number.isFinite(monotonicNowMs) && monotonicNowMs >= 0;
    const restoredCheckpointMs = this.#restoredElapsedCheckpointMs;
    const previousMonotonicMs = this.#lastMonotonicMs ?? restoredCheckpointMs;
    const sourceResetSinceCheckpoint =
      hasValidMonotonicNow &&
      this.#lastMonotonicMs === undefined &&
      restoredCheckpointMs !== undefined &&
      monotonicNowMs < restoredCheckpointMs;
    const elapsedMs =
      hasValidMonotonicNow && previousMonotonicMs !== undefined
        ? Math.max(0, monotonicNowMs - previousMonotonicMs)
        : undefined;
    // A checkpoint only bridges the first reading after a process restart.
    // If the elapsed source reset (for example after a host reboot), the
    // zero elapsed result deliberately leaves the first wall-clock advance
    // subject to the normal fail-closed forward-jump bound.
    this.#restoredElapsedCheckpointMs = undefined;
    this.#lastMonotonicMs = hasValidMonotonicNow ? monotonicNowMs : undefined;
    return { elapsedMs, nowMs: monotonicNowMs, sourceResetSinceCheckpoint };
  }

  #isBoundedRebootWallClockAdvance(wallClockMs: number): boolean {
    return (
      Number.isFinite(wallClockMs) &&
      wallClockMs >= this.#highWaterMarkMs &&
      wallClockMs <= this.#highWaterMarkMs + REBOOT_WALL_CLOCK_ADMISSION_MAX_ADVANCE_MS
    );
  }

  #admitRebootWallClock(wallClockMs: number): number {
    this.#highWaterMarkMs = wallClockMs;
    this.#effectiveNowMs = wallClockMs;
    this.#posture = "ok";
    this.#reason = undefined;
    this.#forwardJumpAnchorMarkMs = undefined;
    this.#forwardJumpAnchorMonotonicMs = undefined;
    return wallClockMs;
  }

  #evaluate(
    wallClockMs: number,
    monotonicElapsedMs: number | undefined,
    monotonicNowMs: number,
    sourceResetSinceCheckpoint: boolean,
  ): number {
    // With no durable guard, a stale RTC on a brand-new installation is not an
    // authority epoch that must be preserved. If time synchronization corrects
    // it forward before the first durable checkpoint, accepting the correction
    // can only expire the process-local capabilities minted against the stale
    // reading; bounding it instead would leave every issuance route unavailable
    // until the wall clock replayed the stale-to-current gap. Once persisted,
    // all subsequent forward corrections use the normal fail-closed policy.
    if (
      this.#bootstrapWithoutDurableGuard &&
      this.#bootstrapObservedWallClock &&
      Number.isFinite(wallClockMs) &&
      wallClockMs >= STALE_RTC_BOOTSTRAP_EPOCH_FLOOR_MS &&
      this.#highWaterMarkMs < STALE_RTC_BOOTSTRAP_EPOCH_FLOOR_MS &&
      monotonicElapsedMs !== undefined &&
      wallClockMs > this.#highWaterMarkMs + monotonicElapsedMs + this.#forwardJumpToleranceMs
    ) {
      this.#highWaterMarkMs = wallClockMs;
      this.#effectiveNowMs = wallClockMs;
      this.#posture = "ok";
      this.#reason = undefined;
      this.#forwardJumpAnchorMarkMs = undefined;
      this.#forwardJumpAnchorMonotonicMs = undefined;
      return wallClockMs;
    }

    // A restarted process normally has a durable, suspend-aware elapsed-time
    // checkpoint from its previous observation. Use it to admit ordinary
    // downtime (including a closed app overnight) while still rejecting a
    // first wall-clock advance that exceeds provable elapsed time plus the
    // forward-jump tolerance. If the source reset or is unavailable, this
    // intentionally falls back to the bounded fail-closed admission path.
    if (this.#restoredOkGuard) {
      this.#restoredOkGuard = false;
      // A lower boot-uptime on the first observation proves a host reboot, not
      // merely a restarted server. Window authorities, launch sessions, Code
      // approvals, and managed-root grants are all in-memory and have therefore
      // been discarded at that boot boundary. A bounded reboot advance admits
      // ordinary overnight downtime without replaying it from boot uptime,
      // but an arbitrary far-ahead RTC remains subject to the fail-closed
      // forward-jump policy below.
      if (sourceResetSinceCheckpoint && this.#isBoundedRebootWallClockAdvance(wallClockMs)) {
        return this.#admitRebootWallClock(wallClockMs);
      }
      if (
        !Number.isFinite(wallClockMs) ||
        wallClockMs >
          this.#highWaterMarkMs + (monotonicElapsedMs ?? 0) + this.#forwardJumpToleranceMs
      ) {
        this.#effectiveNowMs = this.#highWaterMarkMs;
        this.#posture = "recovery-required";
        this.#reason = "forward-jump";
        this.#forwardJumpAnchorMarkMs = this.#highWaterMarkMs;
        this.#forwardJumpAnchorMonotonicMs = monotonicNowMs;
        return this.#effectiveNowMs;
      }
    }

    // A monotonic source resets on process restart. If the previous process
    // persisted a recovery posture, do not let the first unanchored observation
    // re-admit a still-far-future wall clock as legitimate downtime. Hold the
    // durable bound until the wall clock is again close enough to it to resume
    // ordinary policy evaluation; this also prevents one tolerance grant per
    // restart during a sustained forward jump.
    if (this.#restoredRecoveryPosture) {
      // A reboot also discards the capabilities protected by a recovery
      // posture. Once the RTC is corrected to a bounded advance, it is safe
      // to clear that posture; retaining it would leave local issuance
      // unavailable indefinitely because the new boot uptime cannot prove the
      // time elapsed before reboot. The same bounded policy prevents a bogus
      // far-future RTC from becoming durable recovery evidence.
      if (sourceResetSinceCheckpoint && this.#isBoundedRebootWallClockAdvance(wallClockMs)) {
        this.#restoredRecoveryPosture = false;
        return this.#admitRebootWallClock(wallClockMs);
      }
      const lowerBound = this.#highWaterMarkMs - this.#toleranceMs;
      const upperBound =
        this.#highWaterMarkMs + (monotonicElapsedMs ?? 0) + this.#forwardJumpToleranceMs;
      if (!Number.isFinite(wallClockMs) || wallClockMs < lowerBound || wallClockMs > upperBound) {
        this.#effectiveNowMs = this.#highWaterMarkMs;
        this.#posture = "recovery-required";
        return this.#effectiveNowMs;
      }
      this.#restoredRecoveryPosture = false;
      // Retain the elapsed evidence for every restored recovery reason. A
      // corrected wall clock may advance only by the persisted elapsed time
      // plus the fixed tolerance; recursively evaluating without it would let
      // a rollback or malformed-clock recovery accept an arbitrary future epoch.
      return this.#evaluate(wallClockMs, monotonicElapsedMs, monotonicNowMs, false);
    }

    // While a sustained forward step keeps the wall clock ahead of the bounded
    // discontinuity, hold the mark at the original discontinuity plus the real
    // monotonic elapsed time since it was detected. Re-running the policy here
    // would compare against the previously bounded mark and re-grant the full
    // forward-jump tolerance on every observation, letting a handful of
    // loopback requests ratchet the mark past short authorities (for example a
    // five-minute Code approval) and persist the inflated bound.
    if (
      this.#posture === "recovery-required" &&
      this.#reason === "forward-jump" &&
      this.#forwardJumpAnchorMarkMs !== undefined &&
      this.#forwardJumpAnchorMonotonicMs !== undefined &&
      wallClockMs > this.#forwardJumpAnchorMarkMs
    ) {
      const elapsedSinceJumpMs = Math.max(0, monotonicNowMs - this.#forwardJumpAnchorMonotonicMs);
      const recoveredMarkMs = Math.floor(this.#forwardJumpAnchorMarkMs + elapsedSinceJumpMs);
      // The wall clock caught back up to within the plausible monotonic
      // envelope of the bounded mark: clear the anchor and resume ordinary
      // tracking, which re-evaluates from the recovered mark.
      if (wallClockMs <= recoveredMarkMs + this.#forwardJumpToleranceMs) {
        this.#forwardJumpAnchorMarkMs = undefined;
        this.#forwardJumpAnchorMonotonicMs = undefined;
        return this.#evaluate(wallClockMs, monotonicElapsedMs, monotonicNowMs, false);
      }
      this.#highWaterMarkMs = recoveredMarkMs;
      this.#effectiveNowMs = recoveredMarkMs;
      this.#posture = "recovery-required";
      this.#reason = "forward-jump";
      return recoveredMarkMs;
    }

    const priorHighWaterMarkMs = this.#highWaterMarkMs;
    const evaluation = evaluateMonotonicNow({
      wallClockMs,
      highWaterMarkMs: priorHighWaterMarkMs,
      toleranceMs: this.#toleranceMs,
      forwardToleranceMs: this.#forwardJumpToleranceMs,
      ...(monotonicElapsedMs === undefined ? {} : { monotonicElapsedMs }),
    });

    // A rollback must not leave the effective authority epoch frozen until the
    // raw wall clock catches up. The same suspend-aware elapsed source used to
    // admit a normal wake gives us a safe lower bound on real time elapsed, so
    // advance expiry from that source while keeping recovery-required posture.
    // Without this, a five-minute approval issued just before a multi-day
    // rollback could remain usable for the whole rollback interval.
    const rollbackElapsedMs =
      Number.isFinite(wallClockMs) &&
      wallClockMs < priorHighWaterMarkMs &&
      monotonicElapsedMs !== undefined &&
      Number.isFinite(monotonicElapsedMs) &&
      monotonicElapsedMs > 0
        ? Math.floor(monotonicElapsedMs)
        : 0;
    if (rollbackElapsedMs > 0) {
      this.#forwardJumpAnchorMarkMs = undefined;
      this.#forwardJumpAnchorMonotonicMs = undefined;
      this.#highWaterMarkMs = priorHighWaterMarkMs + rollbackElapsedMs;
      this.#effectiveNowMs = this.#highWaterMarkMs;
      this.#posture = evaluation.posture;
      this.#reason = evaluation.reason;
      return this.#effectiveNowMs;
    }
    if (evaluation.reason === "forward-jump") {
      this.#forwardJumpAnchorMarkMs = evaluation.highWaterMarkMs;
      this.#forwardJumpAnchorMonotonicMs = monotonicNowMs;
    } else {
      this.#forwardJumpAnchorMarkMs = undefined;
      this.#forwardJumpAnchorMonotonicMs = undefined;
    }
    this.#highWaterMarkMs = evaluation.highWaterMarkMs;
    this.#effectiveNowMs = evaluation.effectiveNowMs;
    this.#posture = evaluation.posture;
    this.#reason = evaluation.reason;
    if (Number.isFinite(wallClockMs) && wallClockMs >= 0) {
      this.#bootstrapObservedWallClock = true;
    }
    return evaluation.effectiveNowMs;
  }

  /** A `now` function compatible with services that inject `() => number`. */
  now(): () => number {
    return () => this.nowMs();
  }

  highWaterMarkMs(): number {
    return this.#highWaterMarkMs;
  }

  /** Coarse posture only (`"ok" | "recovery-required"`), for fail-closed gating. */
  postureKind(): ClockPostureKind {
    this.nowMs();
    return this.#posture;
  }

  /**
   * Current, redacted time posture. Advances the monotonic bound as a side
   * effect (equivalent to observing the clock now) so a live rollback is
   * reflected immediately.
   */
  posture(): LocalAuthorityTimePostureV1 {
    this.nowMs();
    if (this.#posture === "recovery-required") {
      return decodeLocalAuthorityTimePostureV1({
        posture: "recovery-required",
        reason: this.#reason ?? "clock-rollback",
        highWaterMarkMs: this.#highWaterMarkMs,
        effectiveNowMs: this.#effectiveNowMs,
        correlationId: this.#correlationId(),
      });
    }
    return decodeLocalAuthorityTimePostureV1({
      posture: "ok",
      highWaterMarkMs: this.#highWaterMarkMs,
      effectiveNowMs: this.#effectiveNowMs,
    });
  }

  /** Durably persist the current high-water mark and posture. */
  persist(): void {
    this.nowMs();
    // Do not turn a clearly stale RTC into the first durable authority epoch.
    // A later synchronization can safely establish the first guard because
    // any process-local capability minted at this stale epoch is already
    // expired at a modern wall time. This keeps the no-guard bootstrap path
    // available even when the request-finally checkpoint runs before NTP.
    if (
      this.#bootstrapWithoutDurableGuard &&
      this.#highWaterMarkMs < STALE_RTC_BOOTSTRAP_EPOCH_FLOOR_MS
    ) {
      return;
    }
    const guard = decodeLocalAuthorityClockGuardV1({
      guardId: LOCAL_AUTHORITY_CLOCK_GUARD_ID,
      highWaterMarkMs: this.#highWaterMarkMs,
      observedAt: new Date(this.#effectiveNowMs).toISOString(),
      posture: this.#posture,
      ...(this.#posture === "recovery-required" && this.#reason !== undefined
        ? { recoveryReason: this.#reason }
        : {}),
    });
    this.#connection
      .prepare(
        `INSERT INTO local_authority_clock_guard (
           guard_id, high_water_mark_ms, observed_at, posture, recovery_reason, elapsed_checkpoint_ms
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(guard_id) DO UPDATE SET
           high_water_mark_ms = MAX(local_authority_clock_guard.high_water_mark_ms, excluded.high_water_mark_ms),
           observed_at = excluded.observed_at,
           posture = excluded.posture,
           recovery_reason = excluded.recovery_reason,
           elapsed_checkpoint_ms = excluded.elapsed_checkpoint_ms`,
      )
      .run(
        guard.guardId,
        guard.highWaterMarkMs,
        guard.observedAt,
        guard.posture,
        guard.recoveryReason ?? null,
        Number.isFinite(this.#lastMonotonicMs) && (this.#lastMonotonicMs ?? -1) >= 0
          ? this.#lastMonotonicMs
          : null,
      );
    this.#lastPersistedHighWaterMarkMs = this.#highWaterMarkMs;
    this.#lastPersistedPosture = this.#posture;
    this.#lastPersistedRecoveryReason =
      this.#posture === "recovery-required" ? this.#reason : undefined;
    this.#bootstrapWithoutDurableGuard = false;
  }

  /**
   * Persist the high-water mark only when it advanced at least
   * `persistIntervalMs` beyond the last durable write. Called on the request
   * hot path so an expiry-boundary advance is durable even if the process
   * crashes before a clean stop, while coalescing the near-continuous advances
   * of a normally running wall clock so an SQLite guard row is not written for
   * every request (including `/health`, `/api/hosts`, and static assets that
   * never touched time-bounded authority). Smaller advances remain
   * authoritative in memory and are captured by a later coalesced write or the
   * clean-shutdown `persist()`. Returns true when a write occurred.
   */
  persistIfAdvanced(): boolean {
    this.nowMs();
    if (
      this.#bootstrapWithoutDurableGuard &&
      this.#highWaterMarkMs < STALE_RTC_BOOTSTRAP_EPOCH_FLOOR_MS
    ) {
      return false;
    }
    const recoveryReason = this.#posture === "recovery-required" ? this.#reason : undefined;
    if (
      this.#highWaterMarkMs - this.#lastPersistedHighWaterMarkMs < this.#persistIntervalMs &&
      this.#posture === this.#lastPersistedPosture &&
      recoveryReason === this.#lastPersistedRecoveryReason
    ) {
      return false;
    }
    this.persist();
    return true;
  }

  #loadPersistedClockGuard(): PersistedClockGuard | undefined {
    try {
      const row = this.#connection
        .prepare(
          `SELECT high_water_mark_ms, posture, recovery_reason, elapsed_checkpoint_ms
           FROM local_authority_clock_guard WHERE guard_id = ?`,
        )
        .get(LOCAL_AUTHORITY_CLOCK_GUARD_ID) as ClockGuardRow | undefined;
      if (
        row === undefined ||
        !Number.isFinite(row.high_water_mark_ms) ||
        row.high_water_mark_ms < 0 ||
        (row.posture !== "ok" && row.posture !== "recovery-required")
      ) {
        return undefined;
      }
      const recoveryReason =
        row.recovery_reason === "clock-rollback" ||
        row.recovery_reason === "malformed-clock" ||
        row.recovery_reason === "forward-jump"
          ? row.recovery_reason
          : undefined;
      const elapsedCheckpointMs =
        typeof row.elapsed_checkpoint_ms === "number" &&
        Number.isFinite(row.elapsed_checkpoint_ms) &&
        row.elapsed_checkpoint_ms >= 0
          ? row.elapsed_checkpoint_ms
          : undefined;
      return {
        highWaterMarkMs: row.high_water_mark_ms,
        posture: row.posture,
        ...(recoveryReason === undefined ? {} : { recoveryReason }),
        ...(elapsedCheckpointMs === undefined ? {} : { elapsedCheckpointMs }),
      };
    } catch {
      return undefined;
    }
  }
}
