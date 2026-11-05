import { randomBytes } from "node:crypto";
import { decodeWindowId } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { WindowAuthorityStore, WindowAuthorityError } from "./windowAuthorityStore";

const windowId = decodeWindowId("00000000-0000-4000-8000-000000000593");
const token = () => randomBytes(32).toString("base64url");
const source = {
  kind: "native-nightly" as const,
  processRegistration: token(),
  incarnation: "4".repeat(64),
  generation: 1,
};

function fixture() {
  let elapsed = 0;
  const timers: Array<{ readonly callback: () => void; cancelled: boolean }> = [];
  const revoked: string[] = [];
  const capability = token();
  const rendererIdentity = token();
  const store = new WindowAuthorityStore((id) => revoked.push(String(id)), {
    elapsedNow: () => elapsed,
    schedule: (_delay, callback) => {
      const timer = { callback, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  });
  const register = () =>
    store.registerNative({ windowId, capability, rendererIdentity, source, now: 1_000 });
  return {
    store,
    capability,
    rendererIdentity,
    register,
    revoked,
    timers,
    advance: (value: number) => {
      elapsed = value;
    },
  };
}

describe("Native client window authority", () => {
  it("refuses native window and renderer requests at the exact short lease boundary", () => {
    const f = fixture();
    f.register();
    expect(f.store.authenticate(f.capability, 15_999)).toBe(windowId);
    expect(f.store.authenticateRenderer(f.capability, f.rendererIdentity, 15_999)).toBe(windowId);
    expect(() => f.store.authenticateRenderer(f.capability, f.rendererIdentity, 16_000)).toThrow(
      WindowAuthorityError,
    );
    expect(() => f.store.authenticate(f.capability, 16_000)).toThrow(WindowAuthorityError);
    expect(f.revoked).toEqual([String(windowId)]);
  });

  it("expires by elapsed time even while a clamped wall clock has stopped advancing", () => {
    const f = fixture();
    f.register();
    f.advance(15_000);
    expect(() => f.store.authenticate(f.capability, 1_000)).toThrow(WindowAuthorityError);
    expect(f.revoked).toEqual([String(windowId)]);
  });

  it("renews only the current source and generation before expiry", () => {
    const f = fixture();
    f.register();
    f.advance(5_000);
    expect(() =>
      f.store.renewNative({
        windowId,
        capability: f.capability,
        source: { ...source, generation: 2 },
        now: 6_000,
      }),
    ).toThrow(WindowAuthorityError);
    expect(() =>
      f.store.renewNative({
        windowId,
        capability: f.capability,
        source: { ...source, incarnation: "5".repeat(64) },
        now: 6_000,
      }),
    ).toThrow(WindowAuthorityError);
    f.store.renewNative({ windowId, capability: f.capability, source, now: 6_000 });
    expect(f.timers[0]?.cancelled).toBe(true);
    f.timers[0]?.callback();
    expect(f.store.authenticate(f.capability, 16_000)).toBe(windowId);
    f.advance(20_000);
    expect(() =>
      f.store.renewNative({ windowId, capability: f.capability, source, now: 21_000 }),
    ).toThrow(WindowAuthorityError);
    expect(() => f.store.authenticate(f.capability, 21_000)).toThrow(WindowAuthorityError);
  });

  it("revokes idle native windows without waiting for another authenticated request", () => {
    const f = fixture();
    f.register();
    f.advance(15_000);
    f.timers[0]?.callback();
    expect(f.revoked).toEqual([String(windowId)]);
    expect(f.store.size()).toBe(0);
  });

  it("cannot refresh a native lease through the ordinary local registration path", () => {
    const f = fixture();
    f.register();
    expect(() =>
      f.store.registerOrRefresh({
        windowId,
        capability: f.capability,
        rendererIdentity: f.rendererIdentity,
        now: 6_000,
      }),
    ).toThrow(WindowAuthorityError);
    expect(f.store.authenticate(f.capability, 15_999)).toBe(windowId);
    expect(() => f.store.authenticate(f.capability, 16_000)).toThrow(WindowAuthorityError);
  });

  it("revokes state and held requests before reporting a throwing expiry cleanup", () => {
    let elapsed = 0;
    let expire = () => {};
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new WindowAuthorityStore(
      () => {
        throw new Error("private failure");
      },
      {
        elapsedNow: () => elapsed,
        schedule: (_delay, callback) => {
          expire = callback;
          return () => {};
        },
      },
    );
    const capability = token();
    try {
      store.registerNative({ windowId, capability, rendererIdentity: token(), source, now: 0 });
      const signal = store.nativeRequestSignal(capability, 0);
      elapsed = 15_000;
      expect(() => expire()).not.toThrow();
      expect(signal?.aborted).toBe(true);
      expect(store.size()).toBe(0);
      expect(() => store.authenticate(capability, 15_000)).toThrow(WindowAuthorityError);
      expect(warning).toHaveBeenCalledWith(
        "Octant could not finish cleaning up a revoked native window.",
      );
      expect(warning.mock.calls.flat().join(" ")).not.toContain("private failure");
    } finally {
      warning.mockRestore();
    }
  });

  it("cancels native timers and closes issuance at server shutdown while keeping legacy records", () => {
    const f = fixture();
    f.register();
    const signal = f.store.nativeRequestSignal(f.capability, 1_000);
    const localId = decodeWindowId("00000000-0000-4000-8000-000000000594");
    const local = token();
    f.store.register({ windowId: localId, capability: local, now: 1_000 });
    f.store.revokeNativeLeases();
    expect(signal?.aborted).toBe(true);
    expect(f.timers[0]?.cancelled).toBe(true);
    expect(f.store.authenticate(local, 2_000)).toBe(localId);
    expect(() => f.register()).toThrow(WindowAuthorityError);
    expect(() =>
      f.store.renewNative({ windowId, capability: f.capability, source, now: 2_000 }),
    ).toThrow(WindowAuthorityError);
    f.store.revokeNativeLeases();
    expect(f.revoked).toEqual([String(windowId)]);
  });

  it("returns stored native generation while preserving the legacy local principal shape", () => {
    const f = fixture();
    f.register();
    expect(f.store.authenticateAuthority(f.capability, 1_000)).toEqual({ windowId, generation: 1 });
    f.store.revoke(windowId);
    const local = token();
    f.store.register({ windowId, capability: local, now: 1_000 });
    expect(f.store.authenticateAuthority(local, 1_000)).toEqual({ windowId });
    expect(f.timers[0]?.cancelled).toBe(true);
  });
});
