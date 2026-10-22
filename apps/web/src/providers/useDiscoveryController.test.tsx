import { act, renderHook } from "@testing-library/react";
import {
  DiscoveryClientFailure,
  type DiscoveryClient,
} from "@octant/client-runtime/discovery-client";
import { decodeProviderInstanceId, type DiscoverySnapshot } from "@octant/contracts";
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
      locateBinary: vi.fn(),
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

  it("stops scanning and says why when the host never answers the scan", async () => {
    const client: DiscoveryClient = {
      scan: vi.fn(() =>
        Promise.reject(
          new DiscoveryClientFailure(
            "timeout",
            "The provider scan took too long to answer. Try again.",
          ),
        ),
      ),
      connect: vi.fn(),
      locateBinary: vi.fn(),
    };
    const { result } = renderHook(() => useDiscoveryController({ client }));

    await act(async () => {
      await result.current.scan();
    });

    expect(result.current.scanning).toBe(false);
    expect(result.current.message).toBe("The provider scan took too long to answer. Try again.");
  });

  it("asks the host to use a scanned binary and reports its refusal in the host's words", async () => {
    const instanceId = decodeProviderInstanceId("00000000-0000-4000-8000-000000000902");
    const locateBinary = vi
      .fn<DiscoveryClient["locateBinary"]>()
      .mockResolvedValueOnce({ kind: "binary-located", instanceId, version: "2.1.306" })
      .mockRejectedValueOnce(
        new DiscoveryClientFailure(
          "unknown-candidate",
          "Use a binary from the latest discovery scan on this host.",
        ),
      );
    const client: DiscoveryClient = { scan: vi.fn(), connect: vi.fn(), locateBinary };
    const { result } = renderHook(() => useDiscoveryController({ client }));

    let accepted: Awaited<ReturnType<typeof result.current.adoptScannedBinary>> | undefined;
    let refused: typeof accepted;
    await act(async () => {
      accepted = await result.current.adoptScannedBinary(
        instanceId,
        "/Users/example/.local/bin/claude",
      );
      refused = await result.current.adoptScannedBinary(instanceId, "/tmp/elsewhere/claude");
    });

    expect(locateBinary).toHaveBeenNthCalledWith(1, {
      kind: "locate-binary",
      instanceId,
      scannedBinaryPath: "/Users/example/.local/bin/claude",
    });
    expect(accepted).toEqual({ kind: "located", version: "2.1.306" });
    expect(refused).toEqual({
      kind: "refused",
      message: "Use a binary from the latest discovery scan on this host.",
    });
  });
});
