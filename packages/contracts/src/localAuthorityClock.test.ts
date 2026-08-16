import { describe, expect, it } from "vitest";
import {
  decodeLocalAuthorityClockGuardV1,
  decodeLocalAuthorityTimePostureV1,
  LOCAL_AUTHORITY_CLOCK_GUARD_ID,
} from "./localAuthorityClock";

describe("LocalAuthorityClockGuardV1", () => {
  it("decodes a well-formed guard row", () => {
    const guard = decodeLocalAuthorityClockGuardV1({
      guardId: LOCAL_AUTHORITY_CLOCK_GUARD_ID,
      highWaterMarkMs: 1_000,
      observedAt: "2026-08-01T00:00:00.000Z",
      posture: "ok",
    });
    expect(guard.guardId).toBe("local-authority");
  });

  it("retains a recovery reason for restart-safe clock recovery", () => {
    const guard = decodeLocalAuthorityClockGuardV1({
      guardId: LOCAL_AUTHORITY_CLOCK_GUARD_ID,
      highWaterMarkMs: 1_000,
      observedAt: "2026-08-01T00:00:00.000Z",
      posture: "recovery-required",
      recoveryReason: "forward-jump",
    });
    expect(guard.recoveryReason).toBe("forward-jump");
  });

  it("rejects a guard id other than the fixed singleton value", () => {
    expect(() =>
      decodeLocalAuthorityClockGuardV1({
        guardId: "not-local-authority",
        highWaterMarkMs: 1_000,
        observedAt: "2026-08-01T00:00:00.000Z",
        posture: "ok",
      }),
    ).toThrow();
  });

  it("rejects a negative high-water mark", () => {
    expect(() =>
      decodeLocalAuthorityClockGuardV1({
        guardId: LOCAL_AUTHORITY_CLOCK_GUARD_ID,
        highWaterMarkMs: -1,
        observedAt: "2026-08-01T00:00:00.000Z",
        posture: "ok",
      }),
    ).toThrow();
  });

  it("rejects excess properties", () => {
    expect(() =>
      decodeLocalAuthorityClockGuardV1({
        guardId: LOCAL_AUTHORITY_CLOCK_GUARD_ID,
        highWaterMarkMs: 1_000,
        observedAt: "2026-08-01T00:00:00.000Z",
        posture: "ok",
        extra: true,
      }),
    ).toThrow();
  });
});

describe("LocalAuthorityTimePostureV1", () => {
  it("decodes an ok posture", () => {
    const posture = decodeLocalAuthorityTimePostureV1({
      posture: "ok",
      highWaterMarkMs: 1_000,
      effectiveNowMs: 1_000,
    });
    expect(posture.posture).toBe("ok");
  });

  it("decodes a recovery-required posture with reason and correlation id", () => {
    const posture = decodeLocalAuthorityTimePostureV1({
      posture: "recovery-required",
      reason: "clock-rollback",
      highWaterMarkMs: 1_000,
      effectiveNowMs: 1_000,
      correlationId: "11111111-1111-4111-8111-111111111111",
    });
    expect(posture).toMatchObject({ posture: "recovery-required", reason: "clock-rollback" });
  });

  it("rejects a recovery-required posture missing its correlation id", () => {
    expect(() =>
      decodeLocalAuthorityTimePostureV1({
        posture: "recovery-required",
        reason: "clock-rollback",
        highWaterMarkMs: 1_000,
        effectiveNowMs: 1_000,
      }),
    ).toThrow();
  });
});
