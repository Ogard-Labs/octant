import { randomUUID as defaultRandomUUID } from "node:crypto";
import {
  decodeRemoteClockGuardV1,
  decodeRemoteTimePostureV1,
  type RemoteTimePostureV1,
} from "@octant/contracts/remote-access";
import {
  deriveClockHighWaterMark,
  evaluateMonotonicNow,
  REMOTE_CLOCK_FORWARD_JUMP_TOLERANCE_MS,
  REMOTE_CLOCK_ROLLBACK_TOLERANCE_MS,
  type ClockPostureKind,
  type ClockRecoveryReason,
} from "@octant/domain/remote-clock-recovery-policy";
import type { SqliteConnection } from "../persistence/sqlitePort";

/**
 * Phase 14H — server-owned monotonic epoch guard.
 *
 * Wraps a wall clock with a monotonic bound backed by the persisted
 * `remote_clock_guard` high-water mark and any observed timestamps already in
 * the authoritative remote stores. `nowMs()` never returns a value below the
 * greatest time the host has ever observed, so a wall-clock rollback (NTP step,
 * manual change, DST/timezone misconfiguration, restart, or restored snapshot)
 * cannot revive expired pairing tickets, sessions, devices, challenges, or
 * receipts. A large rollback is still clamped forward but is additionally
 * reported through `posture()` as `recovery-required` so the host can fail
 * closed on issuing new trust with an explicit, actionable recovery state.
 *
 * `nowMs()` is pure in-memory and safe to call inside a database transaction.
 * `persist()` writes the high-water mark durably and must be called outside a
 * transaction (for example at listener start/stop).
 */

interface ClockGuardRow {
  readonly high_water_mark_ms: number;
  readonly posture: string;
}

export interface MonotonicRemoteClockOptions {
  readonly connection: SqliteConnection;
  readonly hostId: string;
  readonly wallClock?: () => number;
  readonly toleranceMs?: number;
  readonly forwardJumpToleranceMs?: number;
  /**
   * Steady, restart-local monotonic source used to bound forward wall-clock
   * discontinuities. Defaults to `performance.now()`. Resets across process
   * restarts, so the first observation after a restart has no baseline and any
   * forward step is accepted as legitimate elapsed downtime.
   */
  readonly monotonicSource?: () => number;
  readonly correlationId?: () => string;
}

export class MonotonicRemoteClock {
  readonly #connection: SqliteConnection;
  readonly #hostId: string;
  readonly #wallClock: () => number;
  readonly #toleranceMs: number;
  readonly #forwardJumpToleranceMs: number;
  readonly #monotonicSource: () => number;
  readonly #correlationId: () => string;
  #highWaterMarkMs: number;
  #posture: ClockPostureKind = "ok";
  #reason: ClockRecoveryReason | undefined;
  #effectiveNowMs: number;
  #lastMonotonicMs: number | undefined;
  #lastPersistedHighWaterMarkMs = -1;

  constructor(options: MonotonicRemoteClockOptions) {
    this.#connection = options.connection;
    this.#hostId = options.hostId;
    this.#wallClock = options.wallClock ?? (() => Date.now());
    this.#toleranceMs = options.toleranceMs ?? REMOTE_CLOCK_ROLLBACK_TOLERANCE_MS;
    this.#forwardJumpToleranceMs =
      options.forwardJumpToleranceMs ?? REMOTE_CLOCK_FORWARD_JUMP_TOLERANCE_MS;
    this.#monotonicSource = options.monotonicSource ?? (() => performance.now());
    this.#correlationId = options.correlationId ?? defaultRandomUUID;
    const persisted = this.#loadPersistedHighWaterMark();
    this.#highWaterMarkMs = deriveClockHighWaterMark({
      ...(persisted === undefined ? {} : { persistedHighWaterMarkMs: persisted }),
      durableTimestampsMs: this.#deriveDurableObservedTimestamps(),
    });
    this.#effectiveNowMs = this.#highWaterMarkMs;
  }

  /**
   * Monotonic effective now in epoch milliseconds. Advances the in-memory
   * high-water mark; never writes to the database.
   */
  nowMs(): number {
    const monotonicNowMs = this.#monotonicSource();
    const monotonicElapsedMs =
      this.#lastMonotonicMs === undefined
        ? undefined
        : Math.max(0, monotonicNowMs - this.#lastMonotonicMs);
    const evaluation = evaluateMonotonicNow({
      wallClockMs: this.#wallClock(),
      highWaterMarkMs: this.#highWaterMarkMs,
      toleranceMs: this.#toleranceMs,
      forwardToleranceMs: this.#forwardJumpToleranceMs,
      ...(monotonicElapsedMs === undefined ? {} : { monotonicElapsedMs }),
    });
    this.#lastMonotonicMs = monotonicNowMs;
    this.#highWaterMarkMs = evaluation.highWaterMarkMs;
    this.#effectiveNowMs = evaluation.effectiveNowMs;
    this.#posture = evaluation.posture;
    this.#reason = evaluation.reason;
    return evaluation.effectiveNowMs;
  }

  /** Monotonic effective now as a UTC ISO-8601 timestamp. */
  nowIso(): string {
    return new Date(this.nowMs()).toISOString();
  }

  /** A `now` function compatible with services that inject `() => number`. */
  now(): () => number {
    return () => this.nowMs();
  }

  /** A `clock` function compatible with services that inject `() => string`. */
  clock(): () => string {
    return () => this.nowIso();
  }

  highWaterMarkMs(): number {
    return this.#highWaterMarkMs;
  }

  /**
   * Current, redacted time posture. Advances the monotonic bound as a side
   * effect (equivalent to observing the clock now) so a live rollback is
   * reflected immediately.
   */
  posture(): RemoteTimePostureV1 {
    this.nowMs();
    if (this.#posture === "recovery-required") {
      return decodeRemoteTimePostureV1({
        posture: "recovery-required",
        reason: this.#reason ?? "clock-rollback",
        highWaterMarkMs: this.#highWaterMarkMs,
        effectiveNowMs: this.#effectiveNowMs,
        correlationId: this.#correlationId(),
      });
    }
    return decodeRemoteTimePostureV1({
      posture: "ok",
      highWaterMarkMs: this.#highWaterMarkMs,
      effectiveNowMs: this.#effectiveNowMs,
    });
  }

  /**
   * Durably persist the current high-water mark and posture. Must be called
   * outside a database transaction.
   */
  persist(): void {
    this.nowMs();
    const guard = decodeRemoteClockGuardV1({
      hostId: this.#hostId,
      highWaterMarkMs: this.#highWaterMarkMs,
      observedAt: new Date(this.#effectiveNowMs).toISOString(),
      posture: this.#posture,
    });
    this.#connection
      .prepare(
        `INSERT INTO remote_clock_guard (host_id, high_water_mark_ms, observed_at, posture)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(host_id) DO UPDATE SET
           high_water_mark_ms = MAX(remote_clock_guard.high_water_mark_ms, excluded.high_water_mark_ms),
           observed_at = excluded.observed_at,
           posture = excluded.posture`,
      )
      .run(guard.hostId, guard.highWaterMarkMs, guard.observedAt, guard.posture);
    this.#lastPersistedHighWaterMarkMs = this.#highWaterMarkMs;
  }

  /**
   * Persist the high-water mark only if it advanced beyond the last durable
   * write. Called during normal request handling so an expiry-boundary advance
   * (for example an idle-expired session rejected mid-operation) is durable
   * even if the process crashes before a clean stop, rather than being lost as
   * a start/stop optimization. Returns true when a write occurred.
   */
  persistIfAdvanced(): boolean {
    this.nowMs();
    if (this.#highWaterMarkMs <= this.#lastPersistedHighWaterMarkMs) return false;
    this.persist();
    return true;
  }

  #loadPersistedHighWaterMark(): number | undefined {
    try {
      const row = this.#connection
        .prepare("SELECT high_water_mark_ms, posture FROM remote_clock_guard WHERE host_id = ?")
        .get(this.#hostId) as ClockGuardRow | undefined;
      return row === undefined ? undefined : row.high_water_mark_ms;
    } catch {
      return undefined;
    }
  }

  /**
   * Greatest OBSERVED timestamp already committed to the authoritative remote
   * stores. Only issued/created/last-seen columns are used — never future-dated
   * expiry columns, which would over-advance the bound and prematurely expire
   * live authority.
   */
  #deriveDurableObservedTimestamps(): ReadonlyArray<number> {
    const timestamps: number[] = [];
    this.#collectIntegerMax("SELECT MAX(last_seen_at) AS m FROM remote_session_store", timestamps);
    this.#collectIntegerMax("SELECT MAX(issued_at) AS m FROM remote_session_store", timestamps);
    this.#collectIntegerMax(
      "SELECT MAX(issued_at) AS m FROM remote_auth_challenge_store",
      timestamps,
    );
    this.#collectIsoMax("SELECT MAX(created_at) AS m FROM remote_device_projection", timestamps);
    this.#collectIsoMax("SELECT MAX(last_seen_at) AS m FROM remote_device_projection", timestamps);
    this.#collectIsoMax(
      "SELECT MAX(created_at) AS m FROM remote_command_receipt_projection",
      timestamps,
    );
    return timestamps;
  }

  #collectIntegerMax(sql: string, into: number[]): void {
    try {
      const row = this.#connection.prepare(sql).get() as { readonly m: number | null } | undefined;
      if (row?.m != null && Number.isFinite(row.m)) into.push(row.m);
    } catch {
      // Table absent (migrations not applied) — ignore.
    }
  }

  #collectIsoMax(sql: string, into: number[]): void {
    try {
      const row = this.#connection.prepare(sql).get() as { readonly m: string | null } | undefined;
      if (row?.m != null) {
        const parsed = Date.parse(row.m);
        if (Number.isFinite(parsed)) into.push(parsed);
      }
    } catch {
      // Table absent (migrations not applied) — ignore.
    }
  }
}
