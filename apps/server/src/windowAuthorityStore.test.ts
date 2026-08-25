import { randomBytes } from "node:crypto";
import { decodeWindowId } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  WINDOW_AUTHORITY_TTL_MS,
  WindowAuthorityError,
  WindowAuthorityStore,
} from "./windowAuthorityStore";

const firstWindow = decodeWindowId("00000000-0000-4000-8000-000000000501");
const secondWindow = decodeWindowId("00000000-0000-4000-8000-000000000502");
const capability = () => randomBytes(32).toString("base64url");
const rendererIdentity = () => randomBytes(32).toString("base64url");

describe("WindowAuthorityStore", () => {
  it("authenticates a canonical 256-bit capability until its exact expiry boundary", () => {
    const store = new WindowAuthorityStore();
    const token = capability();
    store.register({ windowId: firstWindow, capability: token, now: 1_000 });

    expect(store.authenticate(token, 1_000)).toBe(firstWindow);
    expect(store.authenticate(token, 1_000 + WINDOW_AUTHORITY_TTL_MS - 1)).toBe(firstWindow);
    expect(() => store.authenticate(token, 1_000 + WINDOW_AUTHORITY_TTL_MS)).toThrow(
      WindowAuthorityError,
    );
  });

  it("revokes by trusted window identity", () => {
    const revoked: string[] = [];
    const store = new WindowAuthorityStore((windowId) => revoked.push(windowId));
    const token = capability();
    store.register({ windowId: firstWindow, capability: token, now: 0 });
    store.revoke(firstWindow);

    expect(() => store.authenticate(token, 1)).toThrow(WindowAuthorityError);
    expect(revoked).toEqual([firstWindow]);
  });

  it("requires the renderer identity bound at window registration", () => {
    const store = new WindowAuthorityStore();
    const token = capability();
    const identity = rendererIdentity();
    store.register({
      windowId: firstWindow,
      capability: token,
      rendererIdentity: identity,
      now: 0,
    });

    expect(store.authenticateRenderer(token, identity, 0)).toBe(firstWindow);
    expect(() => store.authenticateRenderer(token, rendererIdentity(), 0)).toThrow(
      WindowAuthorityError,
    );
    expect(() => store.authenticateRenderer(token, "not-an-identity", 0)).toThrow(
      WindowAuthorityError,
    );
  });

  it("invalidates the previous authority generation at expiry", () => {
    const revoked: string[] = [];
    const store = new WindowAuthorityStore((windowId) => revoked.push(windowId));
    const token = capability();
    store.register({ windowId: firstWindow, capability: token, now: 0 });

    expect(() => store.authenticate(token, WINDOW_AUTHORITY_TTL_MS)).toThrow(WindowAuthorityError);
    expect(revoked).toEqual([firstWindow]);
    const replacement = capability();
    store.register({
      windowId: firstWindow,
      capability: replacement,
      now: WINDOW_AUTHORITY_TTL_MS,
    });
    expect(store.authenticate(replacement, WINDOW_AUTHORITY_TTL_MS)).toBe(firstWindow);
  });

  it("rejects forged shapes and duplicate window or capability registration without confusion", () => {
    const store = new WindowAuthorityStore();
    const token = capability();
    store.register({ windowId: firstWindow, capability: token, now: 0 });

    expect(() => store.authenticate("not-a-capability", 0)).toThrow(WindowAuthorityError);
    expect(() => store.authenticate(capability(), 0)).toThrow(WindowAuthorityError);
    expect(() =>
      store.register({ windowId: firstWindow, capability: capability(), now: 0 }),
    ).toThrow(WindowAuthorityError);
    expect(() => store.register({ windowId: secondWindow, capability: token, now: 0 })).toThrow(
      WindowAuthorityError,
    );
    expect(store.authenticate(token, 0)).toBe(firstWindow);
  });

  it("registerOrRefresh refreshes the TTL when the same capability and window re-register", () => {
    const store = new WindowAuthorityStore();
    const token = capability();
    store.register({ windowId: firstWindow, capability: token, now: 0 });
    store.registerOrRefresh({ windowId: firstWindow, capability: token, now: 10_000 });
    expect(store.authenticate(token, 10_000)).toBe(firstWindow);
    expect(store.authenticate(token, 10_000 + WINDOW_AUTHORITY_TTL_MS - 1)).toBe(firstWindow);
    expect(() => store.authenticate(token, 10_000 + WINDOW_AUTHORITY_TTL_MS)).toThrow(
      WindowAuthorityError,
    );
  });

  it("registerOrRefresh rejects a mismatched capability for an existing window", () => {
    const store = new WindowAuthorityStore();
    store.register({ windowId: firstWindow, capability: capability(), now: 0 });
    expect(() =>
      store.registerOrRefresh({ windowId: firstWindow, capability: capability(), now: 0 }),
    ).toThrow(WindowAuthorityError);
  });

  it("registerOrRefresh rejects a mismatched window for an existing capability", () => {
    const store = new WindowAuthorityStore();
    const token = capability();
    store.register({ windowId: firstWindow, capability: token, now: 0 });
    expect(() =>
      store.registerOrRefresh({ windowId: secondWindow, capability: token, now: 0 }),
    ).toThrow(WindowAuthorityError);
  });

  describe("monotonic clamp against wall-clock rollback", () => {
    function monotonicClampNow(): (wallClockMs: number) => number {
      let highWaterMark = 0;
      return (wallClockMs: number) => {
        highWaterMark = Math.max(highWaterMark, wallClockMs);
        return highWaterMark;
      };
    }

    it("cannot be revived by a backward wall-clock jump once expiry has been observed", () => {
      const store = new WindowAuthorityStore(undefined, { clampNow: monotonicClampNow() });
      const token = capability();
      store.register({ windowId: firstWindow, capability: token, now: 1_000 });
      // Real time advances past expiry and is observed (advances the shared bound).
      expect(() => store.authenticate(token, 1_000 + WINDOW_AUTHORITY_TTL_MS)).toThrow(
        WindowAuthorityError,
      );
      // Host wall clock rolls back below the already-observed high-water mark.
      // Without clamping this raw value would be back inside the TTL window and
      // would revive the expired authority; the clamp must still fail closed.
      expect(() => store.authenticate(token, 1_000)).toThrow(WindowAuthorityError);
    });

    it("clamps a rolled-back registration time forward so a fresh grant is not immediately expired nor extended", () => {
      const clampNow = monotonicClampNow();
      const store = new WindowAuthorityStore(undefined, { clampNow });
      // Observe a high wall-clock reading first (as another caller on the same
      // shared clamp would across the process).
      clampNow(10_000_000);
      const token = capability();
      // A rolled-back registration is clamped forward to the shared bound, not
      // trusted at face value.
      store.register({ windowId: firstWindow, capability: token, now: 1_000 });
      expect(store.authenticate(token, 10_000_000)).toBe(firstWindow);
      expect(() => store.authenticate(token, 10_000_000 + WINDOW_AUTHORITY_TTL_MS)).toThrow(
        WindowAuthorityError,
      );
    });

    it("still authenticates normally within the TTL window when the clamp is a no-op", () => {
      const store = new WindowAuthorityStore(undefined, { clampNow: (n) => n });
      const token = capability();
      store.register({ windowId: firstWindow, capability: token, now: 1_000 });
      expect(store.authenticate(token, 1_000 + WINDOW_AUTHORITY_TTL_MS - 1)).toBe(firstWindow);
    });

    it("refuses to register a new window capability while clock posture is recovery-required", () => {
      const store = new WindowAuthorityStore(undefined, {
        clampNow: (n) => n,
        clockPosture: () => "recovery-required",
      });
      expect(() =>
        store.register({ windowId: firstWindow, capability: capability(), now: 1_000 }),
      ).toThrow(WindowAuthorityError);
      expect(() =>
        store.registerOrRefresh({ windowId: firstWindow, capability: capability(), now: 1_000 }),
      ).toThrow(WindowAuthorityError);
      expect(store.size()).toBe(0);
    });

    it("registerOrRefresh refuses to extend a window grant while clock posture is recovery-required", () => {
      let posture: "ok" | "recovery-required" = "ok";
      const store = new WindowAuthorityStore(undefined, {
        clampNow: (n) => n,
        clockPosture: () => posture,
      });
      const token = capability();
      store.register({ windowId: firstWindow, capability: token, now: 1_000 });
      expect(store.authenticate(token, 1_000)).toBe(firstWindow);
      posture = "recovery-required";
      expect(() =>
        store.registerOrRefresh({ windowId: firstWindow, capability: token, now: 2_000 }),
      ).toThrow(WindowAuthorityError);
      expect(store.size()).toBe(1);
    });

    it("still authenticates an existing grant during clock recovery via the monotonic clamp", () => {
      let posture: "ok" | "recovery-required" = "ok";
      const store = new WindowAuthorityStore(undefined, {
        clampNow: (n) => n,
        clockPosture: () => posture,
      });
      const token = capability();
      store.register({ windowId: firstWindow, capability: token, now: 1_000 });
      posture = "recovery-required";
      expect(store.authenticate(token, 1_000 + WINDOW_AUTHORITY_TTL_MS - 1)).toBe(firstWindow);
    });
  });
});
