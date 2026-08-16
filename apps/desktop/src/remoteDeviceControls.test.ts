import { describe, expect, it, vi } from "vitest";
import {
  RemoteDeviceControlFailure,
  createRemoteDeviceControlHttpRuntime,
  createRemoteDeviceControlService,
  type DeviceInventoryEntry,
  type PendingPairingRequest,
  type RemoteDeviceControlRuntime,
} from "./remoteDeviceControls";

const ticketId = "11111111-1111-4111-8111-111111111111";
const deviceId = "22222222-2222-4222-8222-222222222222";
const fingerprint = "a".repeat(64);

const pending: PendingPairingRequest = {
  kind: "pending",
  ticketId,
  hostId: "33333333-3333-4333-8333-333333333333",
  deviceLabel: "Safari",
  deviceKeyFingerprint: fingerprint,
  origin: "https://mac.example.test",
  sourceClass: "lan-private",
  comparisonCode: "123456",
  claimedAt: "2026-08-01T10:00:00.000Z",
  expiresAt: "2026-08-01T10:05:00.000Z",
};

const device: DeviceInventoryEntry = {
  hostId: pending.hostId,
  deviceId,
  deviceKeyFingerprint: fingerprint,
  deviceLabel: "Safari",
  origin: pending.origin,
  protocolFloor: 1,
  credentialGeneration: 1,
  createdAt: pending.claimedAt,
  expiresAt: "2026-10-30T10:00:00.000Z",
  lastSeenAt: pending.claimedAt,
  state: "active",
};

function runtime(): RemoteDeviceControlRuntime & Record<string, ReturnType<typeof vi.fn>> {
  return {
    listPairingRequests: vi.fn(async () => [pending]),
    approvePairingRequest: vi.fn(async () => ({ decision: "approved" as const, device })),
    denyPairingRequest: vi.fn(async () => ({ decision: "denied" as const })),
    getDeviceInventory: vi.fn(async () => [device]),
    renameDevice: vi.fn(async (input) => ({ ...device, deviceLabel: input.deviceLabel })),
    revokeDevice: vi.fn(async () => ({
      commandId: "44444444-4444-4444-8444-444444444444",
      result: "applied" as const,
      occurredAt: pending.claimedAt,
    })),
    revokeAllDevices: vi.fn(async () => ({
      commandId: "55555555-5555-4555-8555-555555555555",
      result: "applied" as const,
      occurredAt: pending.claimedAt,
    })),
    reconcileExpiredDevices: vi.fn(async () => ({
      commandId: "66666666-6666-4666-8666-666666666666",
      result: "applied" as const,
      occurredAt: pending.claimedAt,
    })),
  };
}

describe("remote device control service", () => {
  it("keeps local pairing and inventory operations deterministic and bounded", async () => {
    const port = runtime();
    const service = createRemoteDeviceControlService({
      runtime: port,
      uuid: () => "77777777-7777-4777-8777-777777777777",
    });

    await expect(service.listPairingRequests()).resolves.toEqual([pending]);
    await expect(service.approvePairingRequest(ticketId)).resolves.toMatchObject({
      decision: "approved",
      device: { deviceId },
    });
    await expect(service.denyPairingRequest(ticketId, "user-denied")).resolves.toEqual({
      decision: "denied",
    });
    await expect(service.getDeviceInventory()).resolves.toEqual([device]);
    await expect(service.renameDevice(deviceId, "Living Room")).resolves.toMatchObject({
      deviceLabel: "Living Room",
    });
    await expect(service.revokeDevice(deviceId)).resolves.toMatchObject({ result: "applied" });
    await expect(service.revokeAllDevices()).resolves.toMatchObject({ result: "applied" });
    await expect(service.reconcileExpiredDevices()).resolves.toMatchObject({ result: "applied" });

    expect(port.revokeDevice).toHaveBeenCalledWith({
      deviceId,
      commandId: "77777777-7777-4777-8777-777777777777",
    });
    expect(JSON.stringify(await service.getDeviceInventory())).not.toMatch(
      /PRIVATE KEY|cookie|csrf|session secret/i,
    );
  });

  it("rejects malformed identities and preserves typed unavailable failures", async () => {
    const port = runtime();
    const service = createRemoteDeviceControlService({ runtime: port });
    await expect(service.approvePairingRequest("not-a-ticket")).rejects.toMatchObject({
      code: "invalid",
    });
    await expect(service.renameDevice(deviceId, "bad\nlabel")).rejects.toMatchObject({
      code: "invalid",
    });
    (port.getDeviceInventory as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new RemoteDeviceControlFailure("unavailable"),
    );
    await expect(service.getDeviceInventory()).rejects.toMatchObject({ code: "unavailable" });
  });

  it("authenticates the loopback bridge and rejects secret-bearing inventory responses", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("http://127.0.0.1:13773/api/desktop/remote/devices");
      expect(new Headers(init?.headers).get("x-octant-desktop-secret")).toBe("bridge-secret");
      expect(new Headers(init?.headers).get("x-octant-window-capability")).toBe("C".repeat(43));
      return Response.json({
        devices: [{ ...device, devicePublicKey: "-----BEGIN PUBLIC KEY-----" }],
      });
    });
    const runtime = createRemoteDeviceControlHttpRuntime({
      serverUrl: "http://127.0.0.1:13773",
      desktopBridgeSecret: "bridge-secret",
      windowCapability: "C".repeat(43),
      fetch,
    });
    await expect(runtime.getDeviceInventory()).rejects.toMatchObject({ code: "failed" });
  });

  it.each([
    ["malformed claimedAt", { claimedAt: "not-a-timestamp" }],
    ["non-UTC expiresAt", { expiresAt: "2026-08-01T10:05:00.000+02:00" }],
  ] as const)("rejects %s in pending pairing responses", async (_label, override) => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("http://127.0.0.1:13773/api/desktop/remote/pairing-requests");
      return Response.json({ pending: [{ ...pending, ...override }] });
    });
    const runtime = createRemoteDeviceControlHttpRuntime({
      serverUrl: "http://127.0.0.1:13773",
      desktopBridgeSecret: "bridge-secret",
      windowCapability: "C".repeat(43),
      fetch,
    });

    await expect(runtime.listPairingRequests()).rejects.toMatchObject({ code: "failed" });
  });
});
