import type { AppleToolchainClient } from "@octant/client-runtime/apple-toolchain-client";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

let useAppleWorkbench: (options: Record<string, unknown>) => any;

beforeAll(async () => {
  const path = "./useAppleWorkbench";
  const loaded = await import(path).catch(() => undefined);
  expect(loaded).toBeDefined();
  expect(loaded?.useAppleWorkbench).toBeTypeOf("function");
  useAppleWorkbench = loaded!.useAppleWorkbench;
});

describe("useAppleWorkbench", () => {
  it("loads discovery before replay-safe runtime state and refreshes after an action", async () => {
    const discovery = { workspace: { schemes: ["Fixture"] }, toolchain: {}, simulators: [] };
    const snapshot = { sequence: 1, active: [], recentEvidence: [{}] };
    const execute = vi.fn(async () => ({ outcome: "succeeded" }));
    const client = {
      discover: vi.fn(async () => discovery),
      snapshot: vi.fn(async () => snapshot),
      execute,
      cancel: vi.fn(),
    } as unknown as AppleToolchainClient;
    const { result } = renderHook(() =>
      useAppleWorkbench({
        client,
        discoveryRequest: { projectPath: "Fixture.xcodeproj" },
        snapshotRequest: { kind: "apple-snapshot-request" },
      }),
    );
    expect(result.current.status).toBe("loading");
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(client.discover).toHaveBeenCalledBefore(client.snapshot as any);
    await result.current.execute({ kind: "build" });
    expect(execute).toHaveBeenCalled();
    expect(client.snapshot).toHaveBeenCalledTimes(2);
  });

  it("exposes successful discovery even before the first action produces evidence", async () => {
    const discovery = { workspace: { schemes: ["Fixture"] }, toolchain: {}, simulators: [] };
    const snapshot = { sequence: 0, active: [], recentEvidence: [] };
    const client = {
      discover: vi.fn(async () => discovery),
      snapshot: vi.fn(async () => snapshot),
      execute: vi.fn(),
      cancel: vi.fn(),
    } as unknown as AppleToolchainClient;
    const { result } = renderHook(() =>
      useAppleWorkbench({
        client,
        discoveryRequest: { projectPath: "Fixture.xcodeproj" },
        snapshotRequest: { kind: "apple-snapshot-request" },
      }),
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.discovery).toBe(discovery);
    expect(result.current.runtime).toBe(snapshot);
  });
});
