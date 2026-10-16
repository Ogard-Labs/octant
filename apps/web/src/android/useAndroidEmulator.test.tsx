import type { AndroidToolchainClient } from "@octant/client-runtime/android-toolchain-client";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAndroidEmulator } from "./useAndroidEmulator";

function setVisibility(value: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, value });
}

describe("useAndroidEmulator", () => {
  afterEach(() => {
    vi.useRealTimers();
    setVisibility("visible");
  });

  it("reads state at most every three seconds while a tool runs, pauses while hidden, and catches up when shown", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const running = { sequence: 1, active: [{}], recentEvidence: [], emulators: [] };
    const progressed = { sequence: 2, active: [{}], recentEvidence: [{}], emulators: [] };
    let current: unknown = running;
    const snapshot = vi.fn(async () => current);
    const client = {
      discover: vi.fn(async () => ({ emulators: [] })),
      snapshot,
      execute: vi.fn(),
      cancel: vi.fn(),
    } as unknown as AndroidToolchainClient;
    const { result } = renderHook(() =>
      useAndroidEmulator({
        client,
        discoveryRequest: { kind: "android-discovery-request" } as never,
        snapshotRequest: { kind: "android-snapshot-request" } as never,
      }),
    );
    // waitFor polls on a faked interval, so flush the loading promises by hand.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.status).toBe("ready");
    const settled = snapshot.mock.calls.length;

    current = progressed;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(result.current.runtime).toBe(progressed);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000);
    });
    // Twelve seconds used to cost twelve reads; it now costs four at most.
    expect(snapshot.mock.calls.length - settled).toBeLessThanOrEqual(4);

    current = running;
    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    const hiddenAt = snapshot.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(snapshot.mock.calls.length).toBe(hiddenAt);

    setVisibility("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(snapshot.mock.calls.length).toBe(hiddenAt + 1);
    expect(result.current.runtime).toBe(running);
  });
});
