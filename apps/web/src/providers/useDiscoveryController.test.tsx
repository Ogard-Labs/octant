import { act, renderHook } from "@testing-library/react";
import type { DiscoveryClient } from "@octant/client-runtime/discovery-client";
import type { DiscoverySnapshot } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { useDiscoveryController } from "./useDiscoveryController";

const snapshot: DiscoverySnapshot = {
  hostId: "local",
  candidates: [],
  scannedAt: "2026-07-26T20:00:00.000Z",
  scanDurationMs: 150,
  status: "completed",
  autoRegisteredInstanceIds: ["00000000-0000-4000-8000-000000000901"],
} as unknown as DiscoverySnapshot;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("useDiscoveryController", () => {
  it("dedupes in-flight scans and waits for post-scan refresh before publishing", async () => {
    const scanResult = deferred<DiscoverySnapshot>();
    const refreshComplete = deferred<void>();
    const client: DiscoveryClient = {
      scan: vi.fn(() => scanResult.promise),
      connect: vi.fn(),
    };
    const afterScan = vi.fn(() => refreshComplete.promise);
    const { result } = renderHook(() => useDiscoveryController({ client, afterScan }));

    let firstScan!: Promise<DiscoverySnapshot | undefined>;
    let secondScan!: Promise<DiscoverySnapshot | undefined>;
    act(() => {
      firstScan = result.current.scan();
      secondScan = result.current.scan();
    });

    expect(client.scan).toHaveBeenCalledOnce();
    expect(result.current.scanning).toBe(true);

    await act(async () => {
      scanResult.resolve(snapshot);
      await Promise.resolve();
    });

    expect(afterScan).toHaveBeenCalledOnce();
    expect(afterScan).toHaveBeenCalledWith(snapshot);
    expect(result.current.snapshot).toBeUndefined();

    await act(async () => {
      refreshComplete.resolve();
      await firstScan;
      await secondScan;
    });

    expect(result.current.snapshot).toEqual(snapshot);
    expect(result.current.scanning).toBe(false);
  });
});
