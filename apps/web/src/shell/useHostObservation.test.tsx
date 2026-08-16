import type { HostClient } from "@octant/client-runtime/host-client";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useHostObservation } from "./useHostObservation";

describe("useHostObservation", () => {
  it("starts neutral and publishes the server observation when it arrives", async () => {
    let resolve!: (value: Awaited<ReturnType<HostClient["list"]>>) => void;
    const list = vi.fn(
      () =>
        new Promise<Awaited<ReturnType<HostClient["list"]>>>((done) => {
          resolve = done;
        }),
    );
    const client: HostClient = { list };
    const { result } = renderHook(() => useHostObservation(client));

    expect(result.current).toEqual([]);
    act(() =>
      resolve([
        {
          hostId: LOCAL_HOST_ID,
          displayName: "This Mac",
          health: "healthy" as const,
          capabilities: ["chat", "work", "code"] as const,
        },
      ]),
    );
    await waitFor(() => expect(result.current[0]?.health).toBe("healthy"));
  });

  it("keeps the selector neutral when observation fails", async () => {
    const client: HostClient = { list: vi.fn(async () => Promise.reject(new Error("offline"))) };
    const { result } = renderHook(() => useHostObservation(client));

    await waitFor(() => expect(client.list).toHaveBeenCalledOnce());
    expect(result.current).toEqual([]);
  });

  it("retries the startup observation after the local server becomes ready", async () => {
    let attempts = 0;
    const list = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("server starting");
      return [
        {
          hostId: LOCAL_HOST_ID,
          displayName: "This Mac",
          health: "healthy" as const,
          capabilities: ["chat", "work", "code"] as const,
        },
      ];
    });
    const client: HostClient = { list };
    const { result } = renderHook(() => useHostObservation(client));

    await waitFor(() => expect(list).toHaveBeenCalledOnce());
    expect(result.current).toEqual([]);

    await waitFor(() => expect(list).toHaveBeenCalledTimes(2), { timeout: 2_000 });
    await waitFor(() => expect(result.current[0]?.health).toBe("healthy"));
  });

  it("bounds startup retries instead of polling a permanent failure forever", async () => {
    vi.useFakeTimers();
    try {
      const list = vi.fn(async () => Promise.reject(new Error("permanent failure")));
      const client: HostClient = { list };
      renderHook(() => useHostObservation(client));

      await act(async () => void (await Promise.resolve()));
      await act(async () => void (await vi.advanceTimersByTimeAsync(60_000)));

      expect(list).toHaveBeenCalledTimes(6);
      await act(async () => void (await vi.advanceTimersByTimeAsync(60_000)));
      expect(list).toHaveBeenCalledTimes(6);
    } finally {
      vi.useRealTimers();
    }
  });
});
