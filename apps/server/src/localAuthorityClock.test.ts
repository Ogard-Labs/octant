import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqlite, type SqliteConnection } from "./persistence/sqlitePort";
import { applyMigrations, MIGRATIONS } from "./persistence/migrations";
import { REMOTE_CLOCK_ROLLBACK_TOLERANCE_MS } from "@octant/domain/remote-clock-recovery-policy";
import { LocalAuthorityClock } from "./localAuthorityClock";

const directories: string[] = [];
const stableEpochMs = Date.UTC(2026, 7, 11);

function openMigratedDatabase(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-local-authority-clock-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "octant.sqlite"));
  applyMigrations(connection, MIGRATIONS, () => "2026-08-01T00:00:00.000Z");
  return connection;
}

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

describe("LocalAuthorityClock", () => {
  it("advances with a forward-moving wall clock", () => {
    const connection = openMigratedDatabase();
    let wall = 1_000_000;
    const clock = new LocalAuthorityClock({
      connection,
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
    const clock = new LocalAuthorityClock({
      connection,
      wallClock: () => wall,
      monotonicSource: () => 0,
    });
    expect(clock.nowMs()).toBe(5_000_000);
    wall = 5_000_000 - 1_000;
    expect(clock.nowMs()).toBe(5_000_000);
    expect(clock.postureKind()).toBe("ok");
    connection.close();
  });

  it("reports recovery-required on a large backward wall-clock jump but never moves backwards", () => {
    const connection = openMigratedDatabase();
    let wall = 9_000_000_000;
    // Pinned steady source: a held mark advances by real elapsed steady time,
    // so leaving this to `os.uptime()` makes the exact assertions below depend
    // on how long the calls took — green on an idle machine, off by the
    // elapsed milliseconds on a loaded runner.
    const clock = new LocalAuthorityClock({
      connection,
      wallClock: () => wall,
      monotonicSource: () => 0,
    });
    expect(clock.nowMs()).toBe(9_000_000_000);
    wall = 9_000_000_000 - REMOTE_CLOCK_ROLLBACK_TOLERANCE_MS - 60_000;
    expect(clock.nowMs()).toBe(9_000_000_000);
    expect(clock.posture()).toMatchObject({
      posture: "recovery-required",
      reason: "clock-rollback",
    });
    expect(clock.postureKind()).toBe("recovery-required");
    connection.close();
  });

  it("continues advancing expiry time from suspend-aware elapsed time during a rollback", () => {
    const connection = openMigratedDatabase();
    let wall = 9_000_000;
    let elapsedSinceBootMs = 10_000;
    const clock = new LocalAuthorityClock({
      connection,
      wallClock: () => wall,
      suspendAwareElapsedSource: () => elapsedSinceBootMs,
    });
    expect(clock.nowMs()).toBe(9_000_000);

    // The host clock rolls back while real elapsed time continues. Holding the
    // high-water mark frozen here would keep short-lived authority valid until
    // the erroneous wall clock catches up, potentially for days.
    wall -= REMOTE_CLOCK_ROLLBACK_TOLERANCE_MS + 60_000;
    elapsedSinceBootMs += 60_000;
    expect(clock.nowMs()).toBe(9_060_000);
    expect(clock.postureKind()).toBe("recovery-required");

    elapsedSinceBootMs += 4 * 60_000;
    expect(clock.nowMs()).toBe(9_300_000);
    connection.close();
  });

  it("fails closed with recovery on a malformed wall clock", () => {
    const connection = openMigratedDatabase();
    let wall = 7_000_000;
    // Pinned steady source: a held mark advances by real elapsed steady time,
    // so leaving this to `os.uptime()` makes the exact assertions below depend
    // on how long the calls took — green on an idle machine, off by the
    // elapsed milliseconds on a loaded runner.
    const clock = new LocalAuthorityClock({
      connection,
      wallClock: () => wall,
      monotonicSource: () => 0,
    });
    expect(clock.nowMs()).toBe(7_000_000);
    wall = Number.NaN;
    expect(clock.nowMs()).toBe(7_000_000);
    expect(clock.posture()).toMatchObject({
      posture: "recovery-required",
      reason: "malformed-clock",
    });
    connection.close();
  });

  it("flags an implausible forward jump and never commits the far-future value", () => {
    const connection = openMigratedDatabase();
    let wall = 1_000_000;
    let mono = 0;
    const clock = new LocalAuthorityClock({
      connection,
      wallClock: () => wall,
      monotonicSource: () => mono,
      forwardJumpToleranceMs: 1_000,
    });
    expect(clock.nowMs()).toBe(1_000_000);
    const jump = 5 * 365 * 24 * 60 * 60 * 1_000;
    wall = 1_000_000 + jump;
    mono = 100;
    const bounded = clock.nowMs();
    expect(bounded).toBe(1_000_000 + 1_100);
    expect(clock.postureKind()).toBe("recovery-required");
    connection.close();
  });

  it("expires local authority across suspend by using a system elapsed-time source", () => {
    const connection = openMigratedDatabase();
    let wall = 1_000_000;
    let elapsedSinceBootMs = 10_000;
    const clock = new LocalAuthorityClock({
      connection,
      wallClock: () => wall,
      forwardJumpToleranceMs: 1_000,
      suspendAwareElapsedSource: () => elapsedSinceBootMs,
    });

    expect(clock.nowMs()).toBe(1_000_000);
    // The process stays alive while the machine sleeps. A process-local timer
    // may pause here, but boot uptime advances with the suspended interval.
    wall += 3 * 60 * 60 * 1_000;
    elapsedSinceBootMs += 3 * 60 * 60 * 1_000;
    expect(clock.nowMs()).toBe(wall);
    expect(clock.postureKind()).toBe("ok");

    connection.close();
  });

  it("persists and restores the high-water mark across a restart with a rolled-back clock", () => {
    const connection = openMigratedDatabase();
    let elapsedSinceBootMs = 10_000;
    const clock = new LocalAuthorityClock({
      connection,
      wallClock: () => stableEpochMs,
      suspendAwareElapsedSource: () => elapsedSinceBootMs,
    });
    clock.nowMs();
    clock.persist();

    // Restart: the wall clock has rolled back well below the persisted mark.
    const restarted = new LocalAuthorityClock({
      connection,
      wallClock: () => stableEpochMs - 6_000_000,
      suspendAwareElapsedSource: () => elapsedSinceBootMs,
    });
    expect(restarted.highWaterMarkMs()).toBe(stableEpochMs);
    expect(restarted.nowMs()).toBe(stableEpochMs);
    connection.close();
  });

  it("continues advancing expiry time after restart when the wall clock remains rolled back", () => {
    const connection = openMigratedDatabase();
    let wall = stableEpochMs;
    let elapsedSinceBootMs = 10_000;
    const clock = new LocalAuthorityClock({
      connection,
      wallClock: () => wall,
      suspendAwareElapsedSource: () => elapsedSinceBootMs,
    });
    expect(clock.nowMs()).toBe(wall);
    clock.persist();

    // The app restarts after real elapsed time has passed, but the host wall
    // clock is still rolled back. The durable suspend-aware checkpoint must
    // advance expiry rather than freeze local authority at the old epoch.
    wall = stableEpochMs - 6_000_000;
    elapsedSinceBootMs += 60_000;
    const restarted = new LocalAuthorityClock({
      connection,
      wallClock: () => wall,
      suspendAwareElapsedSource: () => elapsedSinceBootMs,
    });
    expect(restarted.nowMs()).toBe(stableEpochMs + 60_000);
    expect(restarted.postureKind()).toBe("recovery-required");
    connection.close();
  });

  it("bounds an unanchored far-forward first reading after restoring an ok guard", () => {
    const connection = openMigratedDatabase();
    let wall = stableEpochMs;
    let mono = 0;
    const clock = new LocalAuthorityClock({
      connection,
      wallClock: () => wall,
      monotonicSource: () => mono,
      forwardJumpToleranceMs: 1_000,
    });
    expect(clock.nowMs()).toBe(wall);
    clock.persist();

    // The previous process stopped with a healthy guard. A later arbitrary
    // wall-clock jump cannot be distinguished from downtime by a fresh
    // process-local monotonic source, so the first reading must fail closed
    // rather than admit a future high-water mark and mint long-lived trust.
    wall += 5 * 365 * 24 * 60 * 60 * 1_000;
    mono = 10;
    const restarted = new LocalAuthorityClock({
      connection,
      wallClock: () => wall,
      monotonicSource: () => mono,
      forwardJumpToleranceMs: 1_000,
    });
    expect(restarted.nowMs()).toBe(stableEpochMs);
    expect(restarted.postureKind()).toBe("recovery-required");
    expect(restarted.highWaterMarkMs()).toBe(stableEpochMs);
    connection.close();
  });

  it("admits legitimate elapsed wall time after restart when a suspend-aware checkpoint proves it", () => {
    const connection = openMigratedDatabase();
    let wall = stableEpochMs;
    let elapsedSinceBootMs = 10_000;
    const clock = new LocalAuthorityClock({
      connection,
      wallClock: () => wall,
      suspendAwareElapsedSource: () => elapsedSinceBootMs,
    });
    expect(clock.nowMs()).toBe(wall);
    clock.persist();

    // The app is closed overnight while the host remains running. Unlike a
    // raw first reading, the persisted suspend-aware checkpoint proves the
    // matching elapsed interval is legitimate rather than a forward jump.
    const overnightMs = 8 * 60 * 60 * 1_000;
    wall += overnightMs;
    elapsedSinceBootMs += overnightMs;
    const restarted = new LocalAuthorityClock({
      connection,
      wallClock: () => wall,
      suspendAwareElapsedSource: () => elapsedSinceBootMs,
    });
    expect(restarted.nowMs()).toBe(wall);
    expect(restarted.postureKind()).toBe("ok");
    restarted.persist();
    expect(
      connection
        .prepare(
          "SELECT posture, recovery_reason FROM local_authority_clock_guard WHERE guard_id = 'local-authority'",
        )
        .get(),
    ).toEqual({ posture: "ok", recovery_reason: null });
    connection.close();
  });

  it("admits ordinary post-reboot wall time without replaying the shutdown duration", () => {
    const connection = openMigratedDatabase();
    let wall = stableEpochMs;
    let elapsedSinceBootMs = 8 * 60 * 60 * 1_000;
    const clock = new LocalAuthorityClock({
      connection,
      wallClock: () => wall,
      suspendAwareElapsedSource: () => elapsedSinceBootMs,
    });
    expect(clock.nowMs()).toBe(wall);
    clock.persist();

    // `os.uptime()` resetting below the durable checkpoint proves that the
    // machine rebooted. The overnight advance must not be replayed at boot
    // uptime speed, because all local capabilities were process-local.
    const overnightMs = 8 * 60 * 60 * 1_000;
    wall += overnightMs;
    elapsedSinceBootMs = 250;
    const restarted = new LocalAuthorityClock({
      connection,
      wallClock: () => wall,
      suspendAwareElapsedSource: () => elapsedSinceBootMs,
    });
    expect(restarted.nowMs()).toBe(wall);
    expect(restarted.postureKind()).toBe("ok");
    connection.close();
  });

  it("bounds an arbitrary far-ahead RTC after a reboot instead of persisting it", () => {
    const connection = openMigratedDatabase();
    let wall = stableEpochMs;
    let elapsedSinceBootMs = 8 * 60 * 60 * 1_000;
    const clock = new LocalAuthorityClock({
      connection,
      wallClock: () => wall,
      suspendAwareElapsedSource: () => elapsedSinceBootMs,
      forwardJumpToleranceMs: 1_000,
    });
    expect(clock.nowMs()).toBe(wall);
    clock.persist();

    // A reset boot-uptime proves reboot, but does not authenticate an
    // unbounded RTC advance. A bad battery or host-time manipulation cannot
    // permanently advance the durable authority epoch by years.
    wall += 5 * 365 * 24 * 60 * 60 * 1_000;
    elapsedSinceBootMs = 250;
    const restarted = new LocalAuthorityClock({
      connection,
      wallClock: () => wall,
      suspendAwareElapsedSource: () => elapsedSinceBootMs,
      forwardJumpToleranceMs: 1_000,
    });
    expect(restarted.nowMs()).toBe(stableEpochMs);
    expect(restarted.postureKind()).toBe("recovery-required");
    restarted.persist();
    expect(
      connection
        .prepare(
          "SELECT high_water_mark_ms AS mark FROM local_authority_clock_guard WHERE guard_id = 'local-authority'",
        )
        .get(),
    ).toEqual({ mark: stableEpochMs });
    connection.close();
  });

  it("accepts initial RTC synchronization before a no-guard bootstrap becomes durable", () => {
    const connection = openMigratedDatabase();
    let wall = 1_000_000;
    let mono = 0;
    const clock = new LocalAuthorityClock({
      connection,
      wallClock: () => wall,
      monotonicSource: () => mono,
      forwardJumpToleranceMs: 1_000,
    });
    expect(clock.nowMs()).toBe(wall);
    // The request-finally persistence path must not harden the stale reading
    // before time synchronization has a chance to establish the first guard.
    clock.persist();
    expect(
      connection
        .prepare(
          "SELECT high_water_mark_ms FROM local_authority_clock_guard WHERE guard_id = 'local-authority'",
        )
        .get(),
    ).toBeUndefined();

    // A fresh store has no authority epoch to preserve. A battery-less RTC can
    // start far in the past and then be synchronized shortly after launch.
    wall = Date.UTC(2026, 7, 11);
    mono += 100;
    expect(clock.nowMs()).toBe(wall);
    expect(clock.postureKind()).toBe("ok");
    clock.persist();
    expect(
      connection
        .prepare(
          "SELECT high_water_mark_ms AS mark FROM local_authority_clock_guard WHERE guard_id = 'local-authority'",
        )
        .get(),
    ).toEqual({ mark: wall });
    connection.close();
  });

  it("preserves a forward-jump recovery posture across restart without re-admitting the jump", () => {
    const connection = openMigratedDatabase();
    let wall = stableEpochMs;
    let mono = 0;
    const jump = 5 * 365 * 24 * 60 * 60 * 1_000;
    const clock = new LocalAuthorityClock({
      connection,
      wallClock: () => wall,
      monotonicSource: () => mono,
      forwardJumpToleranceMs: 1_000,
    });
    expect(clock.nowMs()).toBe(stableEpochMs);
    wall += jump;
    mono = 100;
    expect(clock.nowMs()).toBe(stableEpochMs + 1_100);
    expect(clock.postureKind()).toBe("recovery-required");
    clock.persist();

    // A restarted process has no local monotonic baseline, but must not treat
    // the still-far-future wall clock as legitimate downtime and mint trust.
    let restartedMono = 0;
    const restarted = new LocalAuthorityClock({
      connection,
      wallClock: () => wall,
      monotonicSource: () => restartedMono,
      forwardJumpToleranceMs: 1_000,
    });
    expect(restarted.nowMs()).toBe(stableEpochMs + 1_100);
    expect(restarted.postureKind()).toBe("recovery-required");
    restartedMono = 10;
    expect(restarted.nowMs()).toBe(stableEpochMs + 1_100);
    expect(restarted.highWaterMarkMs()).toBe(stableEpochMs + 1_100);
    connection.close();
  });

  it("allows a corrected rollback to advance after restart only with elapsed evidence", () => {
    const connection = openMigratedDatabase();
    let wall = stableEpochMs;
    const clock = new LocalAuthorityClock({
      connection,
      wallClock: () => wall,
      monotonicSource: () => wall,
    });
    expect(clock.nowMs()).toBe(stableEpochMs);
    // Persist a rollback recovery state with the durable high-water mark.
    wall = stableEpochMs - 1_000_000;
    expect(clock.nowMs()).toBe(stableEpochMs);
    expect(clock.postureKind()).toBe("recovery-required");
    clock.persist();

    // The machine is down for longer than the forward-jump tolerance and its
    // clock is corrected before restart. Persisted recovery cause lets this
    // genuine rollback recovery progress, while persisted forward jumps remain
    // held by the preceding test.
    wall = stableEpochMs + 10 * 60_000;
    const restarted = new LocalAuthorityClock({
      connection,
      wallClock: () => wall,
      // The source did not reset and proves the correction's elapsed interval.
      monotonicSource: () => stableEpochMs + 10 * 60_000,
    });
    expect(restarted.nowMs()).toBe(wall);
    expect(restarted.postureKind()).toBe("ok");
    connection.close();
  });

  it("clears a persisted rollback recovery posture after a reboot and bounded clock correction", () => {
    const connection = openMigratedDatabase();
    let wall = stableEpochMs;
    let elapsedSinceBootMs = 10_000;
    const clock = new LocalAuthorityClock({
      connection,
      wallClock: () => wall,
      suspendAwareElapsedSource: () => elapsedSinceBootMs,
      forwardJumpToleranceMs: 1_000,
    });
    expect(clock.nowMs()).toBe(stableEpochMs);
    wall -= REMOTE_CLOCK_ROLLBACK_TOLERANCE_MS + 1;
    expect(clock.nowMs()).toBe(stableEpochMs);
    expect(clock.postureKind()).toBe("recovery-required");
    clock.persist();

    // The host reboots and its corrected wall time is now ahead of the
    // durable mark. The reset uptime means old local capabilities are gone;
    // a bounded correction should restore issuance instead of permanently
    // retaining the stale recovery posture.
    wall = stableEpochMs + 10 * 60_000;
    elapsedSinceBootMs = 250;
    const restarted = new LocalAuthorityClock({
      connection,
      wallClock: () => wall,
      suspendAwareElapsedSource: () => elapsedSinceBootMs,
      forwardJumpToleranceMs: 1_000,
    });
    expect(restarted.nowMs()).toBe(wall);
    expect(restarted.postureKind()).toBe("ok");
    connection.close();
  });

  it.each(["clock-rollback", "malformed-clock"] as const)(
    "does not admit a far-future first reading after restored %s recovery without elapsed evidence",
    (recoveryReason) => {
      const connection = openMigratedDatabase();
      let wall = stableEpochMs;
      let mono = 10_000;
      const clock = new LocalAuthorityClock({
        connection,
        wallClock: () => wall,
        monotonicSource: () => mono,
        forwardJumpToleranceMs: 1_000,
      });
      expect(clock.nowMs()).toBe(wall);
      if (recoveryReason === "clock-rollback") {
        wall -= REMOTE_CLOCK_ROLLBACK_TOLERANCE_MS + 1;
      } else {
        wall = Number.NaN;
      }
      expect(clock.nowMs()).toBe(stableEpochMs);
      expect(clock.postureKind()).toBe("recovery-required");
      clock.persist();

      wall = stableEpochMs + 5 * 365 * 24 * 60 * 60 * 1_000;
      // A reset source cannot prove the new wall time is a legitimate
      // correction, so recovery remains bounded at the durable mark.
      const restarted = new LocalAuthorityClock({
        connection,
        wallClock: () => wall,
        monotonicSource: () => 0,
        forwardJumpToleranceMs: 1_000,
      });
      expect(restarted.nowMs()).toBe(stableEpochMs);
      expect(restarted.highWaterMarkMs()).toBe(stableEpochMs);
      expect(restarted.postureKind()).toBe("recovery-required");
      connection.close();
    },
  );

  it("persistIfAdvanced writes only when the high-water mark advances", () => {
    const connection = openMigratedDatabase();
    let wall = stableEpochMs;
    const clock = new LocalAuthorityClock({
      connection,
      wallClock: () => wall,
      monotonicSource: () => wall,
    });
    expect(clock.persistIfAdvanced()).toBe(true);
    const stored = () =>
      (
        connection
          .prepare(
            "SELECT high_water_mark_ms AS m FROM local_authority_clock_guard WHERE guard_id = 'local-authority'",
          )
          .get() as { readonly m: number } | undefined
      )?.m;
    expect(stored()).toBe(stableEpochMs);
    expect(clock.persistIfAdvanced()).toBe(false);
    wall = stableEpochMs + 1_000_000;
    expect(clock.persistIfAdvanced()).toBe(true);
    expect(stored()).toBe(stableEpochMs + 1_000_000);
    connection.close();
  });

  it("persistIfAdvanced coalesces small advances until the bounded checkpoint interval is reached", () => {
    const connection = openMigratedDatabase();
    let wall = stableEpochMs;
    const clock = new LocalAuthorityClock({
      connection,
      wallClock: () => wall,
      monotonicSource: () => wall,
      persistIntervalMs: 1_000,
    });
    const stored = () =>
      (
        connection
          .prepare(
            "SELECT high_water_mark_ms AS m FROM local_authority_clock_guard WHERE guard_id = 'local-authority'",
          )
          .get() as { readonly m: number } | undefined
      )?.m;
    // The first observation checkpoints immediately.
    expect(clock.persistIfAdvanced()).toBe(true);
    expect(stored()).toBe(stableEpochMs);
    // A small advance below the bounded interval stays in memory only.
    wall = stableEpochMs + 500;
    expect(clock.persistIfAdvanced()).toBe(false);
    expect(stored()).toBe(stableEpochMs);
    // Once the accumulated advance reaches the bounded interval, it is durable.
    wall = stableEpochMs + 1_000;
    expect(clock.persistIfAdvanced()).toBe(true);
    expect(stored()).toBe(stableEpochMs + 1_000);
    connection.close();
  });

  it("clamps an externally supplied wall-clock reading against the same shared bound", () => {
    const connection = openMigratedDatabase();
    let wall = 10_000_000;
    const clock = new LocalAuthorityClock({
      connection,
      wallClock: () => wall,
      // A steady clock that tracks real elapsed time, so legitimate advances
      // are not mistaken for implausible forward jumps.
      monotonicSource: () => wall,
    });
    // Advance the bound via the clock's own reading.
    expect(clock.nowMs()).toBe(10_000_000);
    // A caller-supplied reading below the bound (e.g. a route handler's own
    // `Date.now()`) is clamped forward, never revived.
    expect(clock.clamp(1_000)).toBe(10_000_000);
    // A caller-supplied reading above the bound advances it.
    wall = 11_000_000;
    expect(clock.clamp(11_000_000)).toBe(11_000_000);
    expect(clock.highWaterMarkMs()).toBe(11_000_000);
    connection.close();
  });

  it("clamp participates in the steady-clock forward-jump check and never commits a far-future value", () => {
    const connection = openMigratedDatabase();
    let wall = 1_000_000;
    let mono = 0;
    const clock = new LocalAuthorityClock({
      connection,
      wallClock: () => wall,
      monotonicSource: () => mono,
      forwardJumpToleranceMs: 1_000,
    });
    // Establish the shared steady-clock baseline through the clock's own reading.
    expect(clock.nowMs()).toBe(1_000_000);
    // The host clock jumps years ahead while the steady clock barely moves:
    // a caller-supplied far-future reading must be treated as an implausible
    // discontinuity, not a legitimate advance.
    const jump = 5 * 365 * 24 * 60 * 60 * 1_000;
    wall = 1_000_000 + jump;
    mono = 100;
    const bounded = clock.clamp(wall);
    expect(bounded).toBe(1_000_000 + 1_100);
    expect(clock.highWaterMarkMs()).toBe(1_000_000 + 1_100);
    expect(clock.postureKind()).toBe("recovery-required");
    connection.close();
  });

  it("never re-grants forward-jump tolerance on every observation during a sustained forward step", () => {
    const connection = openMigratedDatabase();
    let wall = 1_000_000;
    let mono = 0;
    const clock = new LocalAuthorityClock({
      connection,
      wallClock: () => wall,
      monotonicSource: () => mono,
      forwardJumpToleranceMs: 120_000,
    });
    expect(clock.nowMs()).toBe(1_000_000);
    // The host clock steps years ahead while the steady clock advances slowly.
    wall = 1_000_000 + 5 * 365 * 24 * 60 * 60 * 1_000;
    mono = 10_000;
    // The first observation grants the tolerance once when bounding the jump.
    expect(clock.nowMs()).toBe(1_000_000 + 10_000 + 120_000);
    // Follow-up observations (a handful of loopback requests, each running the
    // request `finally` persistIfAdvanced plus authority-path clamp/posture
    // evaluations) advance the steady clock only a few milliseconds. They must
    // advance the mark by exactly that real elapsed time, never re-granting the
    // two-minute tolerance per observation.
    for (let i = 0; i < 5; i += 1) {
      mono += 1;
      expect(clock.nowMs()).toBe(1_000_000 + 10_000 + 120_000 + (i + 1));
    }
    // The bound stays well inside a five-minute Code approval expiry instead of
    // ratcheting past it after only a handful of requests.
    expect(clock.highWaterMarkMs()).toBeLessThan(1_000_000 + 5 * 60_000);
    connection.close();
  });

  it("holds a bounded forward jump at the discontinuity plus real elapsed time and recovers once the wall clock catches up", () => {
    const connection = openMigratedDatabase();
    let wall = 1_000_000;
    let mono = 0;
    const clock = new LocalAuthorityClock({
      connection,
      wallClock: () => wall,
      monotonicSource: () => mono,
      forwardJumpToleranceMs: 60_000,
    });
    expect(clock.nowMs()).toBe(1_000_000);
    const jump = 5 * 365 * 24 * 60 * 60 * 1_000;
    wall = 1_000_000 + jump;
    mono = 1_000;
    expect(clock.nowMs()).toBe(1_000_000 + 61_000);
    expect(clock.postureKind()).toBe("recovery-required");
    // The wall clock is corrected back to just past the bounded discontinuity.
    // The mark holds at the bounded mark plus real elapsed steady time, and the
    // posture returns to ok once the wall clock is again plausible.
    wall = 1_000_000 + 61_500;
    mono = 1_500;
    expect(clock.nowMs()).toBe(1_000_000 + 61_500);
    expect(clock.postureKind()).toBe("ok");
    connection.close();
  });

  it("keeps a compatible now function", () => {
    const connection = openMigratedDatabase();
    let wall = 1_700_000_000_000;
    // The monotonic source is pinned because a backward wall clock holds at the
    // mark *plus real elapsed steady time*, so leaving it to `os.uptime()` made
    // this exact assertion depend on how long the two calls took: it passed on
    // an idle machine and failed by the elapsed milliseconds on a loaded one.
    const clock = new LocalAuthorityClock({
      connection,
      wallClock: () => wall,
      monotonicSource: () => 0,
    });
    const nowFn = clock.now();
    expect(nowFn()).toBe(1_700_000_000_000);
    wall = 1_699_000_000_000;
    expect(nowFn()).toBe(1_700_000_000_000);
    connection.close();
  });
});
