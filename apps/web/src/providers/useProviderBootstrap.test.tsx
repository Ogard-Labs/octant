import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ProviderInstance } from "@octant/contracts";
import type { DiscoveryController } from "./useDiscoveryController";
import type { ProviderController } from "./useProviderController";
import { useProviderBootstrap } from "./useProviderBootstrap";

describe("useProviderBootstrap", () => {
  it("probes an enabled provider that has no runtime observation after restart", async () => {
    const instance = {
      id: "00000000-0000-4000-8000-000000000902",
      driverKind: "codex",
      displayName: "Codex CLI",
      enabled: true,
      version: 1,
      configuration: { kind: "codex-cli", binaryPath: "/opt/homebrew/bin/codex" },
      createdAt: "2026-08-06T00:00:00.000Z",
      updatedAt: "2026-08-06T00:00:00.000Z",
    } as ProviderInstance;
    const probe = vi.fn(async () => true);
    const providerController = {
      status: "ready",
      instances: [instance],
      observedByInstance: new Map(),
      readInstances: () => [instance],
      retry: vi.fn(async () => true),
      probe,
      setEnabled: vi.fn(async () => true),
    } as unknown as ProviderController;
    const discoveryController = {
      scanning: false,
      scan: vi.fn(async () => ({
        hostId: "local",
        candidates: [],
        autoRegisteredInstanceIds: [],
        scannedAt: "2026-08-06T00:00:00.000Z",
        scanDurationMs: 1,
        status: "completed",
      })),
      connect: vi.fn(async () => false),
      connectingPaths: new Set(),
    } as unknown as DiscoveryController;

    renderHook(() =>
      useProviderBootstrap({
        discoveryController,
        enabled: true,
        providerController,
        providerGroups: [],
      }),
    );

    await waitFor(() => expect(probe).toHaveBeenCalledWith(instance.id));
  });

  it("tries the next enabled provider when the preferred runtime probe fails", async () => {
    const first = {
      id: "00000000-0000-4000-8000-000000000902",
      driverKind: "codex",
      displayName: "Codex CLI",
      enabled: true,
      version: 1,
      configuration: { kind: "codex-cli", binaryPath: "/usr/local/bin/codex" },
      createdAt: "2026-08-06T00:00:00.000Z",
      updatedAt: "2026-08-06T00:00:00.000Z",
    } as ProviderInstance;
    const second = {
      ...first,
      id: "00000000-0000-4000-8000-000000000903",
      driverKind: "opencode",
      displayName: "OpenCode CLI",
      configuration: { kind: "opencode-cli", binaryPath: "/usr/local/bin/opencode" },
    } as ProviderInstance;
    const probe = vi.fn(async (instanceId) => instanceId === second.id);
    const providerController = {
      status: "ready",
      instances: [first, second],
      observedByInstance: new Map(),
      readInstances: () => [first, second],
      retry: vi.fn(async () => true),
      probe,
      setEnabled: vi.fn(async () => true),
    } as unknown as ProviderController;
    const discoveryController = {
      scanning: false,
      scan: vi.fn(async () => ({
        hostId: "local",
        candidates: [],
        autoRegisteredInstanceIds: [],
        scannedAt: "2026-08-06T00:00:00.000Z",
        scanDurationMs: 1,
        status: "completed",
      })),
      connect: vi.fn(async () => false),
      connectingPaths: new Set(),
    } as unknown as DiscoveryController;

    const { rerender } = renderHook(
      ({ renderKey }) => {
        void renderKey;
        return useProviderBootstrap({
          discoveryController,
          enabled: true,
          providerController,
          providerGroups: [],
        });
      },
      { initialProps: { renderKey: 0 } },
    );

    await waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
    expect(probe).toHaveBeenNthCalledWith(1, first.id);
    expect(probe).toHaveBeenNthCalledWith(2, second.id);
    expect(providerController.setEnabled).not.toHaveBeenCalled();
    rerender({ renderKey: 1 });
    await Promise.resolve();
    expect(probe).toHaveBeenCalledTimes(2);
  });
});
