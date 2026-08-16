import { randomUUID } from "node:crypto";
import { decodeWindowId } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  LaunchSessionError,
  LaunchSessionStore,
  LAUNCH_SESSION_DEFAULT_TTL_MS,
} from "./launchSessionStore";

const windowId = decodeWindowId(randomUUID());
const capability = `${"A".repeat(42)}A`;

function deterministicBytes(): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = (index + 1) * 7;
  }
  return bytes;
}

describe("LaunchSessionStore", () => {
  it("creates a single-use launch session with a canonical token and positive expiry", () => {
    const store = new LaunchSessionStore({ now: () => 1_000, randomBytes: deterministicBytes });
    const receipt = store.create({ windowId, capability, ttlMs: 60_000 });
    expect(receipt.launchToken).toMatch(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
    expect(receipt.expiresAt).toBe(61_000);
  });

  it("exchanges a valid token once for the window identity and capability", () => {
    const store = new LaunchSessionStore({ now: () => 1_000, randomBytes: deterministicBytes });
    const receipt = store.create({ windowId, capability, ttlMs: 60_000 });
    const exchanged = store.exchange({ launchToken: receipt.launchToken, now: 1_500 });
    expect(exchanged).toEqual({ windowId, capability });
  });

  it("rejects a second exchange of the same token as consumed", () => {
    const store = new LaunchSessionStore({ now: () => 1_000, randomBytes: deterministicBytes });
    const receipt = store.create({ windowId, capability, ttlMs: 60_000 });
    store.exchange({ launchToken: receipt.launchToken, now: 1_500 });
    expect(() => store.exchange({ launchToken: receipt.launchToken, now: 1_600 })).toThrow(
      LaunchSessionError,
    );
    try {
      store.exchange({ launchToken: receipt.launchToken, now: 1_600 });
    } catch (error) {
      expect((error as LaunchSessionError).category).toBe("invalid");
    }
  });

  it("rejects an expired token as invalid", () => {
    const store = new LaunchSessionStore({ now: () => 1_000, randomBytes: deterministicBytes });
    const receipt = store.create({ windowId, capability, ttlMs: 60_000 });
    expect(() => store.exchange({ launchToken: receipt.launchToken, now: 62_001 })).toThrow(
      LaunchSessionError,
    );
  });

  it("rejects an unknown token as invalid without echoing it", () => {
    const store = new LaunchSessionStore({ now: () => 1_000, randomBytes: deterministicBytes });
    const unknown = `${"B".repeat(42)}Q`;
    try {
      store.exchange({ launchToken: unknown, now: 1_500 });
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(LaunchSessionError);
      expect(String(error)).not.toContain(unknown);
    }
  });

  it("rejects a malformed token shape as invalid", () => {
    const store = new LaunchSessionStore({ now: () => 1_000, randomBytes: deterministicBytes });
    expect(() => store.exchange({ launchToken: "short", now: 1_500 })).toThrow(LaunchSessionError);
  });

  it("purges expired sessions so the store does not grow unbounded", () => {
    let now = 1_000;
    const store = new LaunchSessionStore({ now: () => now, randomBytes: deterministicBytes });
    const first = store.create({ windowId, capability, ttlMs: 1_000 });
    now = 3_000;
    store.purgeExpired();
    expect(() => store.exchange({ launchToken: first.launchToken, now })).toThrow(
      LaunchSessionError,
    );
  });

  it("uses the documented default TTL when none is supplied", () => {
    const store = new LaunchSessionStore({ now: () => 1_000, randomBytes: deterministicBytes });
    const receipt = store.create({ windowId, capability });
    expect(receipt.expiresAt).toBe(1_000 + LAUNCH_SESSION_DEFAULT_TTL_MS);
    expect(LAUNCH_SESSION_DEFAULT_TTL_MS).toBe(5 * 60_000);
  });

  describe("monotonic clamp and fail-closed posture", () => {
    function monotonicClampNow(): (wallClockMs: number) => number {
      let highWaterMark = 0;
      return (wallClockMs: number) => {
        highWaterMark = Math.max(highWaterMark, wallClockMs);
        return highWaterMark;
      };
    }

    it("cannot be revived by a backward wall-clock jump at exchange time", () => {
      const clampNow = monotonicClampNow();
      const store = new LaunchSessionStore({
        now: () => 1_000,
        randomBytes: deterministicBytes,
        clampNow,
      });
      const receipt = store.create({ windowId, capability, ttlMs: 1_000 }); // expiresAt = 2_000
      // Real time legitimately advances past this session's expiry and is
      // observed by the shared clamp (for example via other activity on the
      // same host clock), without this specific record being deleted yet.
      clampNow(5_000);
      // Host wall clock then rolls back to a raw reading that is, at face
      // value, still inside the original TTL window. Without the clamp this
      // would revive the expired session; with it, the shared bound refuses.
      expect(() => store.exchange({ launchToken: receipt.launchToken, now: 1_500 })).toThrow(
        LaunchSessionError,
      );
    });

    it("cannot be revived by a backward wall-clock jump at purge/create time", () => {
      const clampNow = monotonicClampNow();
      let now = 5_000;
      const store = new LaunchSessionStore({
        now: () => now,
        randomBytes: deterministicBytes,
        clampNow,
      });
      const receipt = store.create({ windowId, capability, ttlMs: 1_000 });
      now = 6_001; // observed past expiry
      store.purgeExpired();
      now = 5_000; // wall clock rolled back
      expect(() => store.exchange({ launchToken: receipt.launchToken, now })).toThrow(
        LaunchSessionError,
      );
    });

    it("refuses to mint a new launch session while clock posture is recovery-required", () => {
      const store = new LaunchSessionStore({
        now: () => 1_000,
        randomBytes: deterministicBytes,
        clockPosture: () => "recovery-required",
      });
      expect(() => store.create({ windowId, capability })).toThrow(LaunchSessionError);
      try {
        store.create({ windowId, capability });
      } catch (error) {
        expect((error as LaunchSessionError).category).toBe("unavailable");
      }
    });

    it("mints normally when clock posture is ok", () => {
      const store = new LaunchSessionStore({
        now: () => 1_000,
        randomBytes: deterministicBytes,
        clockPosture: () => "ok",
      });
      expect(store.create({ windowId, capability })).toBeDefined();
    });
  });
});
