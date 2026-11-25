import type { RemoteConnection, RemoteSessionBridge } from "@octant/client-runtime";
import type {
  FederatedHostTransportSlot,
  HostFederationTransports,
} from "@octant/client-runtime/host-federation-transports";
import { decodeHostId } from "@octant/contracts/host";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useBootstrapDestinations } from "./useBootstrapDestinations";

const DEVBOX_HOST_ID = decodeHostId("55555555-5555-4555-8555-555555555555");

function makeMockBridge(standing: { readonly actsAsHostPerson: boolean }): RemoteSessionBridge {
  const connection: RemoteConnection = {
    authenticatedFetch: vi.fn(async (input) => {
      if (input.path === "/api/remote/auth/device") {
        return Response.json({
          deviceId: "11111111-1111-4111-8111-111111111111",
          deviceLabel: "MacBook Pro",
          origin: "https://octant.example",
          credentialGeneration: 1,
          createdAt: "2026-11-24T20:00:00.000Z",
          expiresAt: "2026-12-24T20:00:00.000Z",
          lastSeenAt: "2026-11-24T20:00:00.000Z",
          state: "active",
          actsAsHostPerson: standing.actsAsHostPerson,
        });
      }
      if (input.path === "/api/projects/bootstrap") {
        return Response.json({
          active: [],
          archived: [],
          lastSequence: 0,
        });
      }
      return Response.json({}, { status: 404 });
    }),
  } as unknown as RemoteConnection;

  return {
    connection: () => connection,
    subscribe: () => () => undefined,
  } as unknown as RemoteSessionBridge;
}

describe("useBootstrapDestinations", () => {
  it("subscribes to transport updates so paired computers connecting after mount become eligible and disconnecting removes them", async () => {
    const listeners = new Set<() => void>();
    const bridge = makeMockBridge({ actsAsHostPerson: true });
    let slots: ReadonlyArray<FederatedHostTransportSlot> = [
      {
        hostId: DEVBOX_HOST_ID,
        kind: "remote",
        displayName: "Linux Devbox",
        state: {
          kind: "connecting",
          hostId: String(DEVBOX_HOST_ID),
          displayName: "Linux Devbox",
        } as unknown as FederatedHostTransportSlot["state"],
        bridge,
      },
    ];

    const transports = {
      list: () => slots,
      get: (id: string) => slots.find((slot) => String(slot.hostId) === String(id)),
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    } as unknown as HostFederationTransports;

    const { result } = renderHook(() => useBootstrapDestinations(transports));
    expect(result.current).toEqual([]);

    // Transition the slot from connecting -> ready without replacing the transports object.
    slots = [
      {
        hostId: DEVBOX_HOST_ID,
        kind: "remote",
        displayName: "Linux Devbox",
        state: { kind: "ready", sessionId: "sess-1" },
        bridge,
      } as unknown as FederatedHostTransportSlot,
    ];
    act(() => {
      for (const listener of listeners) listener();
    });

    await waitFor(
      () => {
        expect(result.current).toHaveLength(1);
      },
      { timeout: 5_000 },
    );
    expect(result.current[0]?.displayName).toBe("Linux Devbox");
    expect(result.current[0]?.actsAsHostPerson).toBe(true);

    // Disconnect removes the destination immediately.
    slots = [
      {
        hostId: DEVBOX_HOST_ID,
        kind: "remote",
        displayName: "Linux Devbox",
        state: { kind: "disconnected" },
        bridge,
      } as unknown as FederatedHostTransportSlot,
    ];
    act(() => {
      for (const listener of listeners) listener();
    });

    await waitFor(() => {
      expect(result.current).toHaveLength(0);
    });
  });
});
