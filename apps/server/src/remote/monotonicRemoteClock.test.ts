import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { REMOTE_CLOCK_ROLLBACK_TOLERANCE_MS } from "@octant/domain/remote-clock-recovery-policy";
import { MonotonicRemoteClock } from "./monotonicRemoteClock";

const hostId = "11111111-1111-4111-8111-111111111111";
const directories: string[] = [];

function openMigratedDatabase(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-monotonic-clock-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "octant.sqlite"));
  applyMigrations(connection, MIGRATIONS, () => "2026-08-01T00:00:00.000Z");
  return connection;
}

function insertSession(
  connection: SqliteConnection,
  issuedAtMs: number,
  lastSeenAtMs: number,
): void {
  connection
    .prepare(
      `INSERT INTO remote_session_store (
        session_id_digest, host_id, device_id, credential_generation, origin,
        protocol_version, capability_digest, issued_at, last_seen_at,
        idle_expires_at, absolute_expires_at, csrf_digest, state
      ) VALUES (?, ?, ?, 1, 'https://mac.example.test', 1, ?, ?, ?, ?, ?, ?, 'active')`,
    )
    .run(
      "a".repeat(64),
      hostId,
      "22222222-2222-4222-8222-222222222222",
      "b".repeat(64),
      issuedAtMs,
      lastSeenAtMs,
      lastSeenAtMs + 900_000,
      issuedAtMs + 43_200_000,
      "c".repeat(64),
    );
}

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

describe("MonotonicRemoteClock", () => {
  it("advances with a forward-moving wall clock", () => {
    const connection = openMigratedDatabase();
    let wall = 1_000_000;
    // Monotonic time advances in lockstep with the wall clock: this is genuine
    // elapsed time, not an implausible discontinuity.
    const clock = new MonotonicRemoteClock({
      connection,
      hostId,
      wallClock: () => wall,
      monotonicSource: () => wall,
    });
    expect(clock.nowMs()).toBe(1_000_000);
    wall = 2_000_000;
    expect(clock.nowMs()).toBe(2_000_000);
    expect(clock.highWaterMarkMs()).toBe(2_000_000);
    connection.close();
  });

  it("clamps a small rollback forward so expired authority cannot revive", () => {
    const connection = openMigratedDatabase();
    let wall = 5_000_000;
    const clock = new MonotonicRemoteClock({ connection, hostId, wallClock: () => wall });
    expect(clock.nowMs()).toBe(5_000_000);
    wall = 5_000_000 - 1_000;
    expect(clock.nowMs()).toBe(5_000_000);
    expect(clock.posture().posture).toBe("ok");
    connection.close();
  });

  it("reports recovery-required on a large rollback but never moves backwards", () => {
    const connection = openMigratedDatabase();
    let wall = 9_000_000_000;
    const clock = new MonotonicRemoteClock({ connection, hostId, wallClock: () => wall });
    expect(clock.nowMs()).toBe(9_000_000_000);
    wall = 9_000_000_000 - REMOTE_CLOCK_ROLLBACK_TOLERANCE_MS - 60_000;
    expect(clock.nowMs()).toBe(9_000_000_000);
    const posture = clock.posture();
    expect(posture).toMatchObject({ posture: "recovery-required", reason: "clock-rollback" });
    connection.close();
  });

  it("fails closed with recovery on a malformed wall clock", () => {
    const connection = openMigratedDatabase();
    let wall = 7_000_000;
    const clock = new MonotonicRemoteClock({ connection, hostId, wallClock: () => wall });
    expect(clock.nowMs()).toBe(7_000_000);
    wall = Number.NaN;
    expect(clock.nowMs()).toBe(7_000_000);
    expect(clock.posture()).toMatchObject({
      posture: "recovery-required",
      reason: "malformed-clock",
    });
    connection.close();
  });

  it("persists and restores the high-water mark across a restart with a rolled-back clock", () => {
    const connection = openMigratedDatabase();
    const clock = new MonotonicRemoteClock({ connection, hostId, wallClock: () => 12_000_000 });
    clock.nowMs();
    clock.persist();

    // Restart: the wall clock has rolled back well below the persisted mark.
    const restarted = new MonotonicRemoteClock({
      connection,
      hostId,
      wallClock: () => 6_000_000,
    });
    expect(restarted.highWaterMarkMs()).toBe(12_000_000);
    expect(restarted.nowMs()).toBe(12_000_000);
    connection.close();
  });

  it("seeds the bound from durable observed session timestamps after a restart", () => {
    const connection = openMigratedDatabase();
    insertSession(connection, 8_000_000, 8_500_000);

    // Fresh clock (no persisted guard row) with a wall clock behind the last
    // observed session time still refuses to move backwards.
    const clock = new MonotonicRemoteClock({ connection, hostId, wallClock: () => 4_000_000 });
    expect(clock.highWaterMarkMs()).toBe(8_500_000);
    expect(clock.nowMs()).toBe(8_500_000);
    connection.close();
  });

  it("does not over-advance from future-dated expiry columns", () => {
    const connection = openMigratedDatabase();
    // absolute_expires_at is issued + 12h; last_seen is the observed time.
    insertSession(connection, 8_000_000, 8_500_000);
    const clock = new MonotonicRemoteClock({ connection, hostId, wallClock: () => 9_000_000 });
    // Bound seeds from observed (8.5M), not the far-future expiry (~51.2M).
    expect(clock.highWaterMarkMs()).toBe(8_500_000);
    expect(clock.nowMs()).toBe(9_000_000);
    connection.close();
  });

  it("flags an implausible forward jump and never commits the far-future value", () => {
    const connection = openMigratedDatabase();
    let wall = 1_000_000;
    let mono = 0;
    const clock = new MonotonicRemoteClock({
      connection,
      hostId,
      wallClock: () => wall,
      monotonicSource: () => mono,
      forwardJumpToleranceMs: 1_000,
    });
    // First observation establishes the monotonic baseline (no jump detection).
    expect(clock.nowMs()).toBe(1_000_000);
    // Wall clock jumps ~5 years ahead while only 100ms of monotonic time elapsed.
    const jump = 5 * 365 * 24 * 60 * 60 * 1_000;
    wall = 1_000_000 + jump;
    mono = 100;
    const bounded = clock.nowMs();
    // The bound advances only by the plausible monotonic amount (100ms + 1s).
    expect(bounded).toBe(1_000_000 + 1_100);
    expect(clock.highWaterMarkMs()).toBe(1_000_000 + 1_100);
    expect(clock.posture()).toMatchObject({ posture: "recovery-required", reason: "forward-jump" });
    connection.close();
  });

  it("recovers to ok after a spurious forward jump is corrected", () => {
    const connection = openMigratedDatabase();
    let wall = 1_000_000;
    let mono = 0;
    const clock = new MonotonicRemoteClock({
      connection,
      hostId,
      wallClock: () => wall,
      monotonicSource: () => mono,
      forwardJumpToleranceMs: 1_000,
    });
    expect(clock.nowMs()).toBe(1_000_000);
    // Spurious jump forward — flagged and bounded, not committed.
    wall = 1_000_000 + 5 * 365 * 24 * 60 * 60 * 1_000;
    mono = 100;
    clock.nowMs();
    // Clock corrected back near real time; monotonic advances normally.
    wall = 1_010_000;
    mono = 9_100;
    const recovered = clock.nowMs();
    expect(recovered).toBe(1_010_000);
    expect(clock.posture().posture).toBe("ok");
    connection.close();
  });

  it("persistIfAdvanced writes only when the high-water mark advances", () => {
    const connection = openMigratedDatabase();
    let wall = 3_000_000;
    const clock = new MonotonicRemoteClock({
      connection,
      hostId,
      wallClock: () => wall,
      monotonicSource: () => wall,
    });
    expect(clock.persistIfAdvanced()).toBe(true);
    const stored = () =>
      (
        connection
          .prepare("SELECT high_water_mark_ms AS m FROM remote_clock_guard WHERE host_id = ?")
          .get(hostId) as { readonly m: number } | undefined
      )?.m;
    expect(stored()).toBe(3_000_000);
    // No advance → no write.
    expect(clock.persistIfAdvanced()).toBe(false);
    // Advance → durable write of the higher mark.
    wall = 4_000_000;
    expect(clock.persistIfAdvanced()).toBe(true);
    expect(stored()).toBe(4_000_000);
    connection.close();
  });

  it("persistIfAdvanced durably preserves an expiry-boundary advance across restart", () => {
    const connection = openMigratedDatabase();
    // A session was observed at 8.5M (its idle expiry is last_seen + 900k).
    insertSession(connection, 8_000_000, 8_500_000);
    let wall = 8_500_000;
    const clock = new MonotonicRemoteClock({
      connection,
      hostId,
      wallClock: () => wall,
      monotonicSource: () => wall,
    });
    // Time advances past the idle expiry while the process is running.
    wall = 8_500_000 + 900_000 + 60_000;
    clock.persistIfAdvanced();

    // Simulated crash + restart with the wall clock rolled back between the
    // observed last-seen and the idle expiry. Without the persisted advance the
    // derived bound would be only the observed last-seen (8.5M), reviving the
    // idle-expired session. With it, the bound stays past the expiry.
    const restarted = new MonotonicRemoteClock({
      connection,
      hostId,
      wallClock: () => 8_500_000 + 300_000,
    });
    expect(restarted.nowMs()).toBe(8_500_000 + 900_000 + 60_000);
    connection.close();
  });

  it("keeps a monotonic ISO clock and a compatible now function", () => {
    const connection = openMigratedDatabase();
    let wall = 1_700_000_000_000;
    const clock = new MonotonicRemoteClock({ connection, hostId, wallClock: () => wall });
    const nowFn = clock.now();
    expect(nowFn()).toBe(1_700_000_000_000);
    expect(clock.nowIso()).toBe(new Date(1_700_000_000_000).toISOString());
    wall = 1_699_000_000_000;
    expect(nowFn()).toBe(1_700_000_000_000);
    connection.close();
  });
});
