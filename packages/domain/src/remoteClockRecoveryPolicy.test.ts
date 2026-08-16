import { describe, expect, it } from "vitest";
import {
  REMOTE_CLOCK_FORWARD_JUMP_TOLERANCE_MS,
  REMOTE_CLOCK_ROLLBACK_TOLERANCE_MS,
  deriveClockHighWaterMark,
  evaluateClientTimestampTrust,
  evaluateMonotonicNow,
} from "./remoteClockRecoveryPolicy";
import { REMOTE_REQUEST_CLOCK_SKEW_MS } from "./remoteAccessPolicy";

describe("evaluateMonotonicNow", () => {
  it("advances the high-water mark when wall clock moves forward", () => {
    const result = evaluateMonotonicNow({ wallClockMs: 2_000, highWaterMarkMs: 1_000 });
    expect(result).toEqual({
      effectiveNowMs: 2_000,
      highWaterMarkMs: 2_000,
      advanced: true,
      rollbackMs: 0,
      forwardJumpMs: 0,
      posture: "ok",
    });
  });

  it("is a no-op when wall clock equals the high-water mark", () => {
    const result = evaluateMonotonicNow({ wallClockMs: 5_000, highWaterMarkMs: 5_000 });
    expect(result.effectiveNowMs).toBe(5_000);
    expect(result.highWaterMarkMs).toBe(5_000);
    expect(result.advanced).toBe(false);
    expect(result.posture).toBe("ok");
  });

  it("clamps a small rollback forward without lowering the high-water mark", () => {
    const highWaterMarkMs = 1_000_000;
    const wallClockMs = highWaterMarkMs - 1_000;
    const result = evaluateMonotonicNow({ wallClockMs, highWaterMarkMs });
    // Effective now never goes backwards, so expired authority cannot revive.
    expect(result.effectiveNowMs).toBe(highWaterMarkMs);
    expect(result.highWaterMarkMs).toBe(highWaterMarkMs);
    expect(result.advanced).toBe(false);
    expect(result.rollbackMs).toBe(1_000);
    expect(result.posture).toBe("ok");
  });

  it("flags recovery-required on a large rollback but still clamps forward", () => {
    const highWaterMarkMs = 10_000_000;
    const wallClockMs = highWaterMarkMs - REMOTE_CLOCK_ROLLBACK_TOLERANCE_MS - 1;
    const result = evaluateMonotonicNow({ wallClockMs, highWaterMarkMs });
    expect(result.effectiveNowMs).toBe(highWaterMarkMs);
    expect(result.highWaterMarkMs).toBe(highWaterMarkMs);
    expect(result.rollbackMs).toBe(REMOTE_CLOCK_ROLLBACK_TOLERANCE_MS + 1);
    expect(result.posture).toBe("recovery-required");
    expect(result.reason).toBe("clock-rollback");
  });

  it("treats the tolerance boundary as still within tolerance", () => {
    const highWaterMarkMs = 10_000_000;
    const wallClockMs = highWaterMarkMs - REMOTE_CLOCK_ROLLBACK_TOLERANCE_MS;
    const result = evaluateMonotonicNow({ wallClockMs, highWaterMarkMs });
    expect(result.posture).toBe("ok");
  });

  it("fails closed with recovery on a malformed wall clock", () => {
    for (const wallClockMs of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const result = evaluateMonotonicNow({ wallClockMs, highWaterMarkMs: 4_000 });
      expect(result.effectiveNowMs).toBe(4_000);
      expect(result.highWaterMarkMs).toBe(4_000);
      expect(result.posture).toBe("recovery-required");
      expect(result.reason).toBe("malformed-clock");
    }
  });

  it("treats a non-finite or negative high-water mark as zero", () => {
    const result = evaluateMonotonicNow({ wallClockMs: 3_000, highWaterMarkMs: Number.NaN });
    expect(result.effectiveNowMs).toBe(3_000);
    expect(result.highWaterMarkMs).toBe(3_000);
    expect(result.posture).toBe("ok");
  });

  it("honors an explicit tolerance override", () => {
    const highWaterMarkMs = 100_000;
    const wallClockMs = highWaterMarkMs - 500;
    expect(evaluateMonotonicNow({ wallClockMs, highWaterMarkMs, toleranceMs: 100 }).posture).toBe(
      "recovery-required",
    );
    expect(evaluateMonotonicNow({ wallClockMs, highWaterMarkMs, toleranceMs: 1_000 }).posture).toBe(
      "ok",
    );
  });

  it("accepts a forward step within the plausible monotonic bound", () => {
    const result = evaluateMonotonicNow({
      wallClockMs: 1_050,
      highWaterMarkMs: 1_000,
      monotonicElapsedMs: 40,
      forwardToleranceMs: 20,
    });
    // 50ms forward, elapsed 40ms + 20ms tolerance = 60ms bound → plausible.
    expect(result.effectiveNowMs).toBe(1_050);
    expect(result.highWaterMarkMs).toBe(1_050);
    expect(result.posture).toBe("ok");
    expect(result.forwardJumpMs).toBe(0);
  });

  it("flags an implausible forward jump and advances only by the monotonic bound", () => {
    const prior = 1_000_000;
    const jumpMs = 5 * 365 * 24 * 60 * 60 * 1_000; // ~5 years ahead
    const result = evaluateMonotonicNow({
      wallClockMs: prior + jumpMs,
      highWaterMarkMs: prior,
      monotonicElapsedMs: 100,
      forwardToleranceMs: 1_000,
    });
    // The years-ahead value is never committed; the bound advances only by the
    // plausible monotonic amount so a corrected clock recovers.
    expect(result.highWaterMarkMs).toBe(prior + 1_100);
    expect(result.effectiveNowMs).toBe(prior + 1_100);
    expect(result.posture).toBe("recovery-required");
    expect(result.reason).toBe("forward-jump");
    expect(result.forwardJumpMs).toBe(jumpMs);
  });

  it("does not detect forward jumps without a monotonic baseline", () => {
    // The first observation of a process lifetime has no monotonic baseline; a
    // legitimate long downtime must be accepted as elapsed time.
    const prior = 1_000_000;
    const result = evaluateMonotonicNow({
      wallClockMs: prior + 5 * 365 * 24 * 60 * 60 * 1_000,
      highWaterMarkMs: prior,
    });
    expect(result.posture).toBe("ok");
    expect(result.highWaterMarkMs).toBe(prior + 5 * 365 * 24 * 60 * 60 * 1_000);
    expect(result.forwardJumpMs).toBe(0);
  });

  it("uses the default forward tolerance when none is supplied", () => {
    const prior = 1_000_000;
    const withinDefault = evaluateMonotonicNow({
      wallClockMs: prior + REMOTE_CLOCK_FORWARD_JUMP_TOLERANCE_MS,
      highWaterMarkMs: prior,
      monotonicElapsedMs: 0,
    });
    expect(withinDefault.posture).toBe("ok");
    const beyondDefault = evaluateMonotonicNow({
      wallClockMs: prior + REMOTE_CLOCK_FORWARD_JUMP_TOLERANCE_MS + 1,
      highWaterMarkMs: prior,
      monotonicElapsedMs: 0,
    });
    expect(beyondDefault.posture).toBe("recovery-required");
    expect(beyondDefault.reason).toBe("forward-jump");
  });

  it("does not revive an expired session under DST/timezone-style wall-clock churn", () => {
    // DST/timezone changes never alter the UTC epoch, but a misconfigured host
    // may still report an epoch that jumps around. A session that expired at the
    // high-water mark must stay expired regardless.
    const absoluteExpiresAtMs = 1_000_000;
    const highWaterMarkMs = absoluteExpiresAtMs + 60_000; // already past expiry
    for (const wallClockMs of [
      absoluteExpiresAtMs - 3_600_000, // "fell back" an hour
      absoluteExpiresAtMs - 1, // just before expiry
      absoluteExpiresAtMs + 30_000,
    ]) {
      const { effectiveNowMs } = evaluateMonotonicNow({ wallClockMs, highWaterMarkMs });
      expect(effectiveNowMs >= absoluteExpiresAtMs).toBe(true);
    }
  });
});

describe("deriveClockHighWaterMark", () => {
  it("returns zero with no inputs", () => {
    expect(deriveClockHighWaterMark({})).toBe(0);
  });

  it("returns the maximum finite non-negative timestamp", () => {
    expect(
      deriveClockHighWaterMark({
        persistedHighWaterMarkMs: 5_000,
        durableTimestampsMs: [1_000, 9_000, 3_000],
      }),
    ).toBe(9_000);
  });

  it("ignores malformed and negative timestamps", () => {
    expect(
      deriveClockHighWaterMark({
        persistedHighWaterMarkMs: Number.NaN,
        durableTimestampsMs: [-10, Number.POSITIVE_INFINITY, 42],
      }),
    ).toBe(42);
  });
});

describe("evaluateClientTimestampTrust", () => {
  it("accepts a timestamp within the skew window", () => {
    expect(evaluateClientTimestampTrust({ clientTimestampMs: 1_000, serverNowMs: 1_010 })).toEqual({
      kind: "accepted",
    });
  });

  it("never extends trust from a future client timestamp", () => {
    expect(
      evaluateClientTimestampTrust({
        clientTimestampMs: 1_000 + REMOTE_REQUEST_CLOCK_SKEW_MS + 1,
        serverNowMs: 1_000,
      }),
    ).toEqual({ kind: "rejected", reason: "future-skew" });
  });

  it("rejects a stale client timestamp", () => {
    expect(
      evaluateClientTimestampTrust({
        clientTimestampMs: 1_000,
        serverNowMs: 1_000 + REMOTE_REQUEST_CLOCK_SKEW_MS + 1,
      }),
    ).toEqual({ kind: "rejected", reason: "past-skew" });
  });

  it("rejects malformed timestamps", () => {
    expect(
      evaluateClientTimestampTrust({ clientTimestampMs: Number.NaN, serverNowMs: 1_000 }),
    ).toEqual({ kind: "rejected", reason: "malformed" });
    expect(
      evaluateClientTimestampTrust({ clientTimestampMs: 1_000, serverNowMs: Number.NaN }),
    ).toEqual({ kind: "rejected", reason: "malformed" });
  });
});
