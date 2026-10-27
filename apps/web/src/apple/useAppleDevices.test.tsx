import type { AppleDeviceClient } from "@octant/client-runtime/apple-device-client";
import type { AppleDeviceRequest, AppleDeviceResponse } from "@octant/contracts/apple-toolchain";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppleDevices } from "./useAppleDevices";

const deviceId = "61000000-0000-4000-8000-000000000001";
const scope = {
  authority: {
    hostId: "4f70656e-4f72-4269-9474-4c6f63616c31",
    mode: "code",
    projectId: "61000000-0000-4000-8000-000000000002",
    providerInstanceId: "61000000-0000-4000-8000-000000000003",
    extension: { kind: "core" },
  },
  threadId: "61000000-0000-4000-8000-000000000004",
  checkoutId: "61000000-0000-4000-8000-000000000005",
} as unknown as Pick<AppleDeviceRequest, "authority" | "threadId" | "checkoutId">;

function discovery(extra: Record<string, unknown> = {}): AppleDeviceResponse {
  return {
    kind: "apple-device-discovery",
    discovery: {
      devices: [
        {
          deviceId,
          name: "Henrik's iPhone",
          model: "iPhone 16 Pro",
          platform: "ios",
          osVersion: "26.1",
          connection: "wired",
          state: "connected",
        },
      ],
      tooling: ["list-devices", "screenshot"],
      leases: [],
      discoveredAt: "2026-10-27T12:00:00.000Z",
      ...extra,
    },
  } as unknown as AppleDeviceResponse;
}

let uuid = 0;
const createUuid = () => `62000000-0000-4000-8000-${String((uuid += 1)).padStart(12, "0")}`;

function fakeClient(answer: (request: AppleDeviceRequest) => AppleDeviceResponse) {
  const sent: AppleDeviceRequest[] = [];
  const client: AppleDeviceClient = {
    request: vi.fn(async (request: AppleDeviceRequest) => {
      sent.push(request);
      return answer(request);
    }),
    readScreenshot: vi.fn(async () => ({
      status: "succeeded" as const,
      blob: new Blob([new Uint8Array([0x89, 0x50])], { type: "image/png" }),
    })),
  };
  return { client, sent };
}

describe("useAppleDevices", () => {
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => "blob:latest");
    URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it("asks the person at the Mac before a lease, and sends nothing when they decline", async () => {
    const { client, sent } = fakeClient((request) =>
      request.kind === "use-device"
        ? ({
            kind: "apple-device-leased",
            deviceId,
            grantedAt: "2026-10-27T12:00:01.000Z",
          } as never)
        : discovery(),
    );
    const requestLease = vi.fn(
      async (_request: AppleDeviceRequest) => undefined as string | undefined,
    );
    const { result } = renderHook(() =>
      useAppleDevices({ client, scope, createUuid, requestLease, teamKey: "team" }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.selectedDeviceId).toBe(deviceId);

    await act(async () => await result.current.leaseDevice(deviceId as never));
    expect(requestLease).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "use-device", deviceId, approval: { kind: "not-required" } }),
    );
    expect(sent.some((request) => request.kind === "use-device")).toBe(false);
    expect(result.current.problem).toBe("The device was not given to this thread.");

    requestLease.mockResolvedValueOnce("63000000-0000-4000-8000-000000000001");
    await act(async () => await result.current.leaseDevice(deviceId as never));
    const lease = sent.find((request) => request.kind === "use-device");
    expect(lease?.approval).toEqual({
      kind: "approved",
      approvalId: "63000000-0000-4000-8000-000000000001",
    });
    // The confirmation was for exactly the request the host then received.
    expect(requestLease.mock.calls[1]?.[0].actionId).toBe(lease?.actionId);
    expect(lease?.requestedBy.kind).toBe("local-user");
  });

  it("offers no lease where the window cannot raise the confirmation", async () => {
    const { client, sent } = fakeClient(() => discovery());
    const { result } = renderHook(() =>
      useAppleDevices({ client, scope, createUuid, teamKey: "team" }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.canConfirmLease).toBe(false);
    await act(async () => await result.current.leaseDevice(deviceId as never));
    expect(sent.map((request) => request.kind)).toEqual(["discover"]);
  });

  it("shows the screenshot a capture took, read as this window's own image", async () => {
    const { client } = fakeClient((request) =>
      request.kind === "screenshot"
        ? ({
            kind: "apple-device-evidence",
            evidence: {
              kind: "screenshot",
              outcome: "succeeded",
              artifacts: [{ kind: "screenshot", reference: "apple-device-screenshot-1" }],
            },
          } as never)
        : discovery({ leases: [{ deviceId, holder: "this-thread" }] }),
    );
    const { result } = renderHook(() =>
      useAppleDevices({ client, scope, createUuid, teamKey: "team" }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.screenshotUrl).toBeUndefined();
    await act(async () => await result.current.capture(deviceId as never));
    await waitFor(() => expect(result.current.screenshotUrl).toBe("blob:latest"));
    expect(client.readScreenshot).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "apple-artifact-request",
        reference: "apple-device-screenshot-1",
        threadId: scope.threadId,
      }),
      expect.anything(),
    );
  });

  it("names why the device layer is missing instead of showing no devices", async () => {
    const { client } = fakeClient(
      () => ({ kind: "apple-device-refused", reason: "toolchain-unavailable" }) as never,
    );
    const { result } = renderHook(() =>
      useAppleDevices({ client, scope, createUuid, teamKey: "team" }),
    );
    await waitFor(() => expect(result.current.status).toBe("failed"));
    expect(result.current.failure).toBe(
      "Physical devices need Xcode selected on the Mac that runs this thread.",
    );
  });

  it("remembers the Team ID for this viewer", async () => {
    const { client } = fakeClient(() => discovery());
    const first = renderHook(() =>
      useAppleDevices({ client, scope, createUuid, teamKey: "octant.apple-team.project" }),
    );
    act(() => first.result.current.setTeam("A1B2C3D4E5"));
    first.unmount();
    const again = renderHook(() =>
      useAppleDevices({ client, scope, createUuid, teamKey: "octant.apple-team.project" }),
    );
    expect(again.result.current.team).toBe("A1B2C3D4E5");
    await waitFor(() => expect(again.result.current.status).toBe("ready"));
  });
});
