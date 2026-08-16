import { describe, expect, it, vi } from "vitest";
import { createRemoteRequestRegistry } from "./remoteRequestRegistry";

const hostId = "11111111-1111-4111-8111-111111111111";
const deviceA = "22222222-2222-4222-8222-222222222222";
const deviceB = "33333333-3333-4333-8333-333333333333";
const sessionA = "a".repeat(64);
const sessionB = "b".repeat(64);
const sessionC = "c".repeat(64);

describe("remoteRequestRegistry", () => {
  it("registers active work and unregisters on release without canceling", () => {
    const registry = createRemoteRequestRegistry();
    const cancel = vi.fn();
    const release = registry.register({
      hostId,
      deviceId: deviceA,
      sessionIdDigest: sessionA,
      cancel,
    });
    expect(registry.size()).toBe(1);
    release();
    expect(registry.size()).toBe(0);
    expect(cancel).not.toHaveBeenCalled();
    release();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("cancels matching session work synchronously and is idempotent", () => {
    const registry = createRemoteRequestRegistry();
    const cancelA = vi.fn();
    const cancelB = vi.fn();
    const cancelOther = vi.fn();
    registry.register({
      hostId,
      deviceId: deviceA,
      sessionIdDigest: sessionA,
      cancel: cancelA,
    });
    registry.register({
      hostId,
      deviceId: deviceA,
      sessionIdDigest: sessionA,
      cancel: cancelB,
    });
    registry.register({
      hostId,
      deviceId: deviceA,
      sessionIdDigest: sessionB,
      cancel: cancelOther,
    });

    expect(registry.cancelBySession(sessionA).canceled).toBe(2);
    expect(cancelA).toHaveBeenCalledTimes(1);
    expect(cancelB).toHaveBeenCalledTimes(1);
    expect(cancelOther).not.toHaveBeenCalled();
    expect(registry.size()).toBe(1);
    expect(registry.cancelBySession(sessionA).canceled).toBe(0);
  });

  it("cancels all active work for a device without touching other devices", () => {
    const registry = createRemoteRequestRegistry();
    const cancelA = vi.fn();
    const cancelB = vi.fn();
    registry.register({
      hostId,
      deviceId: deviceA,
      sessionIdDigest: sessionA,
      cancel: cancelA,
    });
    registry.register({
      hostId,
      deviceId: deviceB,
      sessionIdDigest: sessionC,
      cancel: cancelB,
    });

    expect(registry.cancelByDevice({ hostId, deviceId: deviceA }).canceled).toBe(1);
    expect(cancelA).toHaveBeenCalledTimes(1);
    expect(cancelB).not.toHaveBeenCalled();
    expect(registry.size()).toBe(1);
  });

  it("cancels every entry on restart/disable sweep and stays bounded", () => {
    const registry = createRemoteRequestRegistry({ maxEntries: 2 });
    const first = vi.fn();
    const second = vi.fn();
    registry.register({
      hostId,
      deviceId: deviceA,
      sessionIdDigest: sessionA,
      cancel: first,
    });
    registry.register({
      hostId,
      deviceId: deviceB,
      sessionIdDigest: sessionB,
      cancel: second,
    });
    expect(() =>
      registry.register({
        hostId,
        deviceId: deviceA,
        sessionIdDigest: sessionC,
        cancel: vi.fn(),
      }),
    ).toThrow(/capacity/i);

    expect(registry.cancelAll().canceled).toBe(2);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(registry.size()).toBe(0);
    expect(registry.cancelAll().canceled).toBe(0);
  });

  it("exposes aggregate-only diagnostics with no entry, session, or device material", () => {
    const registry = createRemoteRequestRegistry();
    registry.register({
      hostId,
      deviceId: deviceA,
      sessionIdDigest: sessionA,
      cancel: vi.fn(),
    });
    const diagnostics = registry.diagnostics();
    expect(Object.keys(diagnostics).sort()).toEqual(["maxEntries", "size"]);
    expect(diagnostics).toEqual({
      size: 1,
      maxEntries: expect.any(Number),
    });
    expect(diagnostics).not.toHaveProperty("entries");
    expect(diagnostics).not.toHaveProperty("sessions");
    expect(diagnostics).not.toHaveProperty("devices");
    expect(diagnostics).not.toHaveProperty("sessionIdDigest");
    expect(diagnostics).not.toHaveProperty("deviceId");
    expect(diagnostics).not.toHaveProperty("hostId");
    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain(hostId);
    expect(serialized).not.toContain(deviceA);
    expect(serialized).not.toContain(sessionA);
  });

  it("reports a truthful cancellation outcome even when a cancel hook throws", () => {
    const registry = createRemoteRequestRegistry();
    const throwingCancel = vi.fn(() => {
      throw new Error("cancel boom");
    });
    const cleanCancel = vi.fn();
    registry.register({
      hostId,
      deviceId: deviceA,
      sessionIdDigest: sessionA,
      cancel: throwingCancel,
    });
    registry.register({
      hostId,
      deviceId: deviceA,
      sessionIdDigest: sessionB,
      cancel: cleanCancel,
    });

    const result = registry.cancelByDevice({ hostId, deviceId: deviceA });
    expect(result.canceled).toBe(2);
    expect(result.cancelHookFailures).toBe(1);
    expect(throwingCancel).toHaveBeenCalledTimes(1);
    expect(cleanCancel).toHaveBeenCalledTimes(1);
    // S2: The failed entry is RETAINED for retry — only the clean entry is released.
    expect(registry.size()).toBe(1);
  });

  it("cancelBySession reports truthful cancellation outcome with hook failure count", () => {
    const registry = createRemoteRequestRegistry();
    const throwingCancel = vi.fn(() => {
      throw new Error("boom");
    });
    registry.register({
      hostId,
      deviceId: deviceA,
      sessionIdDigest: sessionA,
      cancel: throwingCancel,
    });
    const result = registry.cancelBySession(sessionA);
    expect(result.canceled).toBe(1);
    expect(result.cancelHookFailures).toBe(1);
  });

  it("cancelAll reports truthful cancellation outcome with hook failure count", () => {
    const registry = createRemoteRequestRegistry();
    const throwingCancel = vi.fn(() => {
      throw new Error("boom");
    });
    registry.register({
      hostId,
      deviceId: deviceA,
      sessionIdDigest: sessionA,
      cancel: throwingCancel,
    });
    const result = registry.cancelAll();
    expect(result.canceled).toBe(1);
    expect(result.cancelHookFailures).toBe(1);
  });

  // S2: A failed cancel hook retains the entry so the same hook can be retried.
  it("retains a failed entry for retry and succeeds on subsequent cancellation", () => {
    const registry = createRemoteRequestRegistry();
    let shouldFail = true;
    const cancelHook = vi.fn(() => {
      if (shouldFail) throw new Error("transient");
    });
    registry.register({
      hostId,
      deviceId: deviceA,
      sessionIdDigest: sessionA,
      cancel: cancelHook,
    });
    // First cancel — hook fails, entry retained.
    const first = registry.cancelBySession(sessionA);
    expect(first.canceled).toBe(1);
    expect(first.cancelHookFailures).toBe(1);
    expect(registry.size()).toBe(1);
    expect(cancelHook).toHaveBeenCalledTimes(1);
    // Retry — hook succeeds, entry released.
    shouldFail = false;
    const second = registry.cancelBySession(sessionA);
    expect(second.canceled).toBe(1);
    expect(second.cancelHookFailures).toBe(0);
    expect(registry.size()).toBe(0);
    expect(cancelHook).toHaveBeenCalledTimes(2);
  });

  // S2: A failed entry retained by device can be retried by device.
  it("retains a failed entry by device for retry and succeeds on subsequent cancelByDevice", () => {
    const registry = createRemoteRequestRegistry();
    let shouldFail = true;
    const cancelHook = vi.fn(() => {
      if (shouldFail) throw new Error("transient");
    });
    registry.register({
      hostId,
      deviceId: deviceA,
      sessionIdDigest: sessionA,
      cancel: cancelHook,
    });
    const first = registry.cancelByDevice({ hostId, deviceId: deviceA });
    expect(first.cancelHookFailures).toBe(1);
    expect(registry.size()).toBe(1);
    shouldFail = false;
    const second = registry.cancelByDevice({ hostId, deviceId: deviceA });
    expect(second.cancelHookFailures).toBe(0);
    expect(registry.size()).toBe(0);
  });
});
