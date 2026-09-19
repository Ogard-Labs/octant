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

  it("re-discovers destinations after a Simulator boot so the pane stops reading Shutdown", async () => {
    // Observed 2026-09-19: a boot passed, simctl reported the device Booted,
    // and the pane kept "Simulator is unavailable" with the row on "Shutdown"
    // until the tool was closed and re-opened.
    const before = {
      workspace: { schemes: ["Fixture"] },
      toolchain: {},
      simulators: [{ simulatorId: "sim-1", state: "shutdown" }],
    };
    const after = {
      workspace: { schemes: ["Fixture"] },
      toolchain: {},
      simulators: [{ simulatorId: "sim-1", state: "booted" }],
    };
    const snapshot = { sequence: 1, active: [], recentEvidence: [] };
    const discover = vi.fn(async () => before);
    const client = {
      discover,
      snapshot: vi.fn(async () => snapshot),
      execute: vi.fn(async () => ({ outcome: "succeeded" })),
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
    expect(result.current.discovery).toBe(before);

    discover.mockResolvedValue(after);
    await result.current.execute({ kind: "boot", simulatorId: "sim-1" });
    await waitFor(() => expect(result.current.discovery).toBe(after));
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it("returns a boot's evidence even when the follow-up discovery fails", async () => {
    const before = {
      workspace: { schemes: ["Fixture"] },
      toolchain: {},
      simulators: [{ simulatorId: "sim-1", state: "shutdown" }],
    };
    const snapshot = { sequence: 1, active: [], recentEvidence: [] };
    const discover = vi.fn(async () => before);
    const evidence = { outcome: "succeeded" };
    const client = {
      discover,
      snapshot: vi.fn(async () => snapshot),
      execute: vi.fn(async () => evidence),
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

    discover.mockRejectedValue(new Error("Apple toolchain service is unavailable."));
    await expect(result.current.execute({ kind: "boot", simulatorId: "sim-1" })).resolves.toBe(
      evidence,
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.discovery).toBe(before);
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
