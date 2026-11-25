import type { RemoteSessionBridge } from "@octant/client-runtime";
import type { FederatedHostLifecycleSnapshot } from "@octant/client-runtime/host-federation-lifecycle";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import { renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useActiveWorkHosts } from "./useActiveWorkHosts";

const local = {
  baseUrl: "http://127.0.0.1:4100",
  fetch: vi.fn() as unknown as typeof globalThis.fetch,
  windowCapability: "cap",
};

function snapshot(
  hostId: string,
  state: FederatedHostLifecycleSnapshot["state"],
): FederatedHostLifecycleSnapshot {
  return {
    hostId,
    kind: "remote",
    displayName: hostId,
    state,
    lastReadyAt: "2026-11-25T10:00:00.000Z",
  } as unknown as FederatedHostLifecycleSnapshot;
}

it("lists this computer and each paired one over its own session, and gives none to one whose session is down", () => {
  const bridge = {} as RemoteSessionBridge;
  const { result, rerender } = renderHook(() =>
    useActiveWorkHosts({
      localName: "Studio",
      local,
      localRevision: 1,
      snapshots: [
        snapshot(String(LOCAL_HOST_ID), "ready"),
        snapshot("mini", "ready"),
        snapshot("devbox", "unavailable"),
        snapshot("held", "unauthorized"),
      ],
      transports: {
        get: (hostId) =>
          String(hostId) === "mini"
            ? ({ bridge } as unknown as ReturnType<
                NonNullable<Parameters<typeof useActiveWorkHosts>[0]["transports"]>["get"]
              >)
            : undefined,
      },
      pairedRevision: 1,
    }),
  );
  expect(result.current.map((host) => [host.name, host.reach, host.client !== undefined])).toEqual([
    ["Studio", "ready", true],
    ["mini", "ready", true],
    ["devbox", "unreachable", false],
    ["held", "refused", false],
  ]);
  const before = result.current[1]?.client;
  rerender();
  expect(result.current[1]?.client).toBe(before);
});
