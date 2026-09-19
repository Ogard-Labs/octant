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
    const snapshot = { sequence: 1, active: [], recentEvidence: [], simulators: after.simulators };
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

    // The full discovery is slow; the action's result must not wait for it.
    let finishDiscovery!: (value: typeof after) => void;
    discover.mockReturnValue(
      new Promise((resolve) => {
        finishDiscovery = resolve;
      }) as never,
    );
    await result.current.execute({ kind: "boot", simulatorId: "sim-1" });
    await waitFor(() =>
      expect(result.current.discovery).toEqual({ ...before, simulators: after.simulators }),
    );
    finishDiscovery(after);
    await waitFor(() => expect(result.current.discovery).toBe(after));
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it("ignores a background re-discovery that answers after a newer action", async () => {
    const list = (state: string) => ({
      workspace: { schemes: ["Fixture"] },
      toolchain: {},
      simulators: [{ simulatorId: "sim-1", state }],
    });
    const initial = list("shutdown");
    const afterBoot = list("booted");
    const afterShutdown = list("shutdown");
    let simulators = afterBoot.simulators;
    const discover = vi.fn(async () => initial);
    const client = {
      discover,
      snapshot: vi.fn(async () => ({ sequence: 1, active: [], recentEvidence: [], simulators })),
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

    // The boot's re-discovery is slow; the shutdown's answers first.
    let finishBootDiscovery!: (value: typeof afterBoot) => void;
    discover.mockReturnValueOnce(
      new Promise((resolve) => {
        finishBootDiscovery = resolve;
      }) as never,
    );
    await result.current.execute({ kind: "boot", simulatorId: "sim-1" });
    simulators = afterShutdown.simulators;
    discover.mockResolvedValueOnce(afterShutdown as never);
    await result.current.execute({ kind: "shutdown", simulatorId: "sim-1" });
    await waitFor(() => expect(result.current.discovery).toBe(afterShutdown));

    finishBootDiscovery(afterBoot);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current.discovery).toBe(afterShutdown);
  });

  it("returns a boot's evidence even when the follow-up discovery fails", async () => {
    const before = {
      workspace: { schemes: ["Fixture"] },
      toolchain: {},
      simulators: [{ simulatorId: "sim-1", state: "shutdown" }],
    };
    const booted = [{ simulatorId: "sim-1", state: "booted" }];
    const snapshot = { sequence: 1, active: [], recentEvidence: [], simulators: booted };
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
    // The list takes the host's Simulator states from the snapshot instead of
    // keeping "shutdown" until some later discovery happens to succeed.
    await waitFor(() =>
      expect(result.current.discovery).toEqual({ ...before, simulators: booted }),
    );
  });

  it("keeps its destinations when the host's runtime list came back empty", async () => {
    const before = {
      workspace: { schemes: ["Fixture"] },
      toolchain: {},
      simulators: [
        { simulatorId: "sim-1", name: "iPhone 17", state: "booted" },
        { simulatorId: "sim-2", name: "iPad", state: "shutdown" },
      ],
    };
    const discover = vi.fn(async () => before);
    const client = {
      discover,
      // A discovery that failed its first probe clears the host's runtime list
      // while the per-project cache still lets the shutdown run.
      snapshot: vi.fn(async () => ({
        sequence: 2,
        active: [],
        recentEvidence: [],
        simulators: [],
      })),
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

    discover.mockRejectedValue(new Error("Xcode is unavailable on this host."));
    await result.current.execute({ kind: "shutdown", simulatorId: "sim-1" });

    await waitFor(() =>
      expect(result.current.discovery?.simulators).toEqual([
        { simulatorId: "sim-1", name: "iPhone 17", state: "shutdown" },
        { simulatorId: "sim-2", name: "iPad", state: "shutdown" },
      ]),
    );
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
