import type { HostMemoryReading } from "./hostMemoryNotice";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useHostMemoryNotice } from "./useHostMemoryNotice";

const stop = {
  lastSeenAt: "2026-10-31T09:00:00.000Z",
  pressure: "critical",
  processMegabytes: 4100,
} as const;

function clientWith(memory: HostMemoryReading | undefined) {
  const status = vi.fn(async () => ({ memory }));
  return { status };
}

describe("useHostMemoryNotice", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.useRealTimers());

  it("shows a notice from the host status and keeps it dismissed across reloads", async () => {
    const client = clientWith({ pressure: "normal", processMegabytes: 300, previousStop: stop });
    const first = renderHook(() => useHostMemoryNotice(client));
    await waitFor(() => expect(first.result.current[0]?.title).toBe("Octant stopped unexpectedly"));
    act(() => first.result.current[1]());
    expect(first.result.current[0]).toBeUndefined();
    first.unmount();

    const second = renderHook(() => useHostMemoryNotice(client));
    await waitFor(() => expect(client.status).toHaveBeenCalledTimes(2));
    expect(second.result.current[0]).toBeUndefined();
  });

  it("offers the next notice after the first is dismissed and ignores an unreachable host", async () => {
    const client = clientWith({
      pressure: "elevated",
      processMegabytes: 2300,
      previousStop: stop,
      lastRelief: {
        at: "2026-10-31T10:00:00.000Z",
        pressure: "critical",
        source: "system",
        idleProviderRuntimesStopped: 0,
        idleSessionsReleased: 0,
        cachesTrimmed: true,
        activeTurnsKept: 0,
      },
    });
    const { result } = renderHook(() => useHostMemoryNotice(client));
    await waitFor(() => expect(result.current[0]?.title).toBe("Octant stopped unexpectedly"));
    act(() => result.current[1]());
    expect(result.current[0]?.title).toBe("Octant freed memory");

    const broken = { status: vi.fn(async () => Promise.reject(new Error("unreachable"))) };
    const quiet = renderHook(() => useHostMemoryNotice(broken));
    await waitFor(() => expect(broken.status).toHaveBeenCalled());
    expect(quiet.result.current[0]).toBeUndefined();
  });

  it("rereads the status on an interval so a later relief appears", async () => {
    vi.useFakeTimers();
    let memory: HostMemoryReading = { pressure: "normal", processMegabytes: 300 };
    const client = { status: vi.fn(async () => ({ memory })) };
    const { result } = renderHook(() => useHostMemoryNotice(client));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current[0]).toBeUndefined();
    memory = {
      pressure: "elevated",
      processMegabytes: 2300,
      lastRelief: {
        at: "2026-10-31T10:00:00.000Z",
        pressure: "elevated",
        source: "system",
        idleProviderRuntimesStopped: 1,
        idleSessionsReleased: 0,
        cachesTrimmed: true,
        activeTurnsKept: 0,
      },
    };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(result.current[0]?.title).toBe("Octant freed memory");
  });

  it("does nothing without a host control client", () => {
    const { result } = renderHook(() => useHostMemoryNotice(undefined));
    expect(result.current[0]).toBeUndefined();
  });
});
