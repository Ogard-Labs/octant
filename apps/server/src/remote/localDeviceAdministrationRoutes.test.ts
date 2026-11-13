import { describe, expect, it, vi } from "vitest";
import { decodeWindowId, type UtcTimestamp } from "@octant/contracts";
import type { DeviceRegistrationV1, StableHostId } from "@octant/contracts/remote-access";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { createRemoteDevicePrincipal } from "../clientPrincipal";
import { bindPrincipalRouteContext } from "../principalRouteContext";
import {
  createLocalDeviceAdministrationRouteHandler,
  type LocalDeviceAdministrationPort,
} from "./localDeviceAdministrationRoutes";

const hostId = "11111111-1111-4111-8111-111111111111" as StableHostId;
const deviceId = "22222222-2222-4222-8222-222222222222";
const windowId = decodeWindowId("33333333-3333-4333-8333-333333333333");
const capability = "A".repeat(43);
const secret = "desktop-secret";
const timestamp = "2026-08-01T10:00:00.000Z" as UtcTimestamp;
const expiry = "2026-10-30T10:00:00.000Z" as UtcTimestamp;

function device(): DeviceRegistrationV1 {
  return {
    hostId,
    deviceId: deviceId as DeviceRegistrationV1["deviceId"],
    deviceKeyFingerprint: "a".repeat(64),
    devicePublicKey: "-----BEGIN PUBLIC KEY-----\npublic\n-----END PUBLIC KEY-----",
    deviceLabel: "Safari",
    origin: "https://mac.example.test",
    protocolFloor: 1,
    credentialGeneration: 1,
    createdAt: timestamp,
    expiresAt: expiry,
    lastSeenAt: timestamp,
    state: "active",
  };
}

function setup(overrides: Partial<LocalDeviceAdministrationPort> = {}) {
  const authority = new WindowAuthorityStore();
  authority.register({ windowId, capability, now: Date.now() });
  const control: LocalDeviceAdministrationPort = {
    createPairingTicket: vi.fn(() => ({
      ticketId: "88888888-8888-4888-8888-888888888888" as never,
      ticketProof: "ticket-proof",
      expiresAt: Date.parse("2026-08-01T10:05:00.000Z"),
      sourceClass: "loopback" as const,
    })),
    listPendingPairings: vi.fn(() => []),
    approvePairing: vi.fn(() => ({
      decision: {
        ticketId: "44444444-4444-4444-8444-444444444444" as never,
        hostId,
        decision: "approved" as const,
        decidedAt: timestamp,
        reasonCode: "user-approved",
      },
      device: device(),
    })),
    denyPairing: vi.fn(() => ({
      ticketId: "44444444-4444-4444-8444-444444444444" as never,
      hostId,
      decision: "denied" as const,
      decidedAt: timestamp,
      reasonCode: "user-denied",
    })),
    listDevices: vi.fn(() => [device()]),
    renameDevice: vi.fn(() => device()),
    revokeDevice: vi.fn(() => ({
      commandId: "55555555-5555-4555-8555-555555555555",
      result: "applied" as const,
      occurredAt: timestamp,
    })),
    revokeAll: vi.fn(() => ({
      commandId: "66666666-6666-4666-8666-666666666666",
      result: "applied" as const,
      occurredAt: timestamp,
    })),
    reconcileExpired: vi.fn(() => ({
      commandId: "77777777-7777-4777-8777-777777777777",
      result: "applied" as const,
      occurredAt: timestamp,
    })),
    ...overrides,
  };
  return {
    control,
    handle: createLocalDeviceAdministrationRouteHandler({
      desktopBridgeSecret: secret,
      windowAuthorityStore: authority,
      control,
      now: () => Date.parse("2026-08-01T10:00:00.000Z"),
    }),
  };
}

function request(path: string, init: RequestInit = {}) {
  return new Request(`http://127.0.0.1${path}`, {
    ...init,
    headers: {
      "x-octant-desktop-secret": secret,
      "x-octant-window-capability": capability,
      ...init.headers,
    },
  });
}

describe("local device administration routes", () => {
  it("returns redacted pending claims and inventory only to the owned loopback window", async () => {
    const { handle, control } = setup();
    const response = await handle(request("/api/desktop/remote/pairing-requests"));
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ pending: [] });

    const inventory = await handle(request("/api/desktop/remote/devices"));
    expect(inventory?.status).toBe(200);
    const body = await inventory?.json();
    expect(body).toMatchObject({ devices: [{ deviceId, deviceKeyFingerprint: "a".repeat(64) }] });
    expect(JSON.stringify(body)).not.toContain("BEGIN PUBLIC KEY");
    expect(control.listDevices).toHaveBeenCalledOnce();
  });

  it("mints a pairing token for the network class the local caller names", async () => {
    const { handle, control } = setup();
    const response = await handle(
      request("/api/desktop/remote/pairing-tickets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceClass: "lan-private" }),
      }),
    );
    expect(response?.status).toBe(201);
    expect(await response?.json()).toMatchObject({ ticket: { ticketProof: "ticket-proof" } });
    expect(control.createPairingTicket).toHaveBeenCalledWith({ sourceClass: "lan-private" });
  });

  it("refuses to mint a pairing token for a network class it cannot pair over", async () => {
    const { handle, control } = setup();
    const response = await handle(
      request("/api/desktop/remote/pairing-tickets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceClass: "unknown" }),
      }),
    );
    expect(response?.status).toBe(400);
    expect(control.createPairingTicket).not.toHaveBeenCalled();
  });

  it("maps approve, deny, rename, revoke, revoke-all, and expiry to fixed local actions", async () => {
    const { handle, control } = setup();
    const approve = await handle(
      request("/api/desktop/remote/pairing-requests/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticketId: "44444444-4444-4444-8444-444444444444" }),
      }),
    );
    expect(approve?.status).toBe(201);
    expect(JSON.stringify(await approve?.json())).not.toContain("PUBLIC KEY");

    const deny = await handle(
      request("/api/desktop/remote/pairing-requests/deny", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ticketId: "44444444-4444-4444-8444-444444444444",
          reasonCode: "user-denied",
        }),
      }),
    );
    expect(deny?.status).toBe(201);

    for (const [path, body] of [
      ["/api/desktop/remote/devices/rename", { deviceId, deviceLabel: "Living Room" }],
      ["/api/desktop/remote/devices/revoke", { deviceId }],
      ["/api/desktop/remote/devices/revoke-all", {}],
      ["/api/desktop/remote/devices/reconcile-expired", {}],
    ] as const) {
      const response = await handle(
        request(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      expect(response?.status).toBe(201);
    }
    expect(control.approvePairing).toHaveBeenCalledWith({ ticketId: expect.any(String) });
    expect(control.denyPairing).toHaveBeenCalledWith({
      ticketId: expect.any(String),
      reasonCode: "user-denied",
    });
    expect(control.renameDevice).toHaveBeenCalledWith({ deviceId, deviceLabel: "Living Room" });
    expect(control.revokeDevice).toHaveBeenCalledWith({ deviceId });
    expect(control.revokeAll).toHaveBeenCalledOnce();
    expect(control.reconcileExpired).toHaveBeenCalledOnce();
  });

  it("fails closed for missing secret, origin, and window authority", async () => {
    const { handle } = setup();
    await expect(
      handle(new Request("http://127.0.0.1/api/desktop/remote/devices")),
    ).resolves.toMatchObject({
      status: 401,
    });
    await expect(
      handle(
        request("/api/desktop/remote/devices", {
          headers: { origin: "http://evil.example" },
        }),
      ),
    ).resolves.toMatchObject({ status: 401 });
    await expect(
      handle(
        new Request("http://127.0.0.1/api/desktop/remote/devices", {
          headers: {
            "x-octant-desktop-secret": secret,
            "x-octant-window-capability": "B".repeat(43),
          },
        }),
      ),
    ).resolves.toMatchObject({ status: 401 });
  });
});

describe("device administration from a paired device", () => {
  const approver = "73000000-0000-4000-8000-000000000080";
  const actor = { kind: "remote-device", actorId: approver, deviceId: approver };
  const ticketId = "44444444-4444-4444-8444-444444444444";

  /** The request as the product dispatch hands it on: loopback-shaped, with the device bound. */
  function fromDevice(
    path: string,
    body?: unknown,
    admittedBy?: "host-person" | "hub-roster",
  ): Request {
    const remote = new Request(`http://127.0.0.1${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        origin: "http://127.0.0.1",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    bindPrincipalRouteContext(remote, {
      principal: createRemoteDevicePrincipal({
        hostId: hostId as never,
        deviceId: approver as never,
        credentialGeneration: 1,
        origin: "https://octant.invalid",
        protocolVersion: 1,
        capabilityDigest: "b".repeat(64),
        sessionId: "73000000-0000-4000-8000-000000000081" as never,
        ...(admittedBy === undefined ? {} : { admittedBy }),
      }),
      scopeId: approver as never,
    });
    return remote;
  }

  function pending(deviceKeyFingerprint: string) {
    return {
      kind: "pending" as const,
      ticketId: ticketId as never,
      hostId,
      deviceLabel: "New phone",
      deviceKeyFingerprint,
      origin: "https://mac.example.test",
      sourceClass: "lan-private" as const,
      comparisonCode: "123-456",
      claimedAt: timestamp,
      expiresAt: expiry,
    };
  }

  it("lets a device the host's own person paired list, rename, revoke and approve, each as that device", async () => {
    const { handle, control } = setup({
      listPendingPairings: vi.fn(() => [pending("c".repeat(64))]),
    });
    const person = "host-person" as const;

    const inventory = await handle(fromDevice("/api/remote/devices", undefined, person));
    expect(inventory?.status).toBe(200);
    expect(JSON.stringify(await inventory?.json())).not.toContain("BEGIN PUBLIC KEY");
    expect(
      (await handle(fromDevice("/api/remote/pairing-requests", undefined, person)))?.status,
    ).toBe(200);

    expect(
      (await handle(fromDevice("/api/remote/pairing-requests/approve", { ticketId }, person)))
        ?.status,
    ).toBe(201);
    expect(control.approvePairing).toHaveBeenCalledWith({ ticketId, actor });

    expect(
      (
        await handle(
          fromDevice(
            "/api/remote/pairing-requests/deny",
            { ticketId, reasonCode: "user-denied" },
            person,
          ),
        )
      )?.status,
    ).toBe(201);
    expect(control.denyPairing).toHaveBeenCalledWith({
      ticketId,
      reasonCode: "user-denied",
      actor,
    });

    expect(
      (
        await handle(
          fromDevice("/api/remote/devices/rename", { deviceId, deviceLabel: "Kitchen" }, person),
        )
      )?.status,
    ).toBe(201);
    expect(control.renameDevice).toHaveBeenCalledWith({ deviceId, deviceLabel: "Kitchen", actor });

    expect(
      (await handle(fromDevice("/api/remote/devices/revoke", { deviceId }, person)))?.status,
    ).toBe(201);
    expect(control.revokeDevice).toHaveBeenCalledWith({ deviceId, actor });

    // Revoking every device takes the asking device with the rest, as it
    // does when a window on the host asks.
    expect((await handle(fromDevice("/api/remote/devices/revoke-all", {}, person)))?.status).toBe(
      201,
    );
    expect(control.revokeAll).toHaveBeenCalledWith({ actor });
  });

  it("refuses a pairing request made with the asking device's own key", async () => {
    const own = { ...device(), deviceId: approver as never, deviceKeyFingerprint: "d".repeat(64) };
    const { handle, control } = setup({
      listDevices: vi.fn(() => [device(), own]),
      listPendingPairings: vi.fn(() => [pending("d".repeat(64))]),
    });

    const refused = await handle(
      fromDevice("/api/remote/pairing-requests/approve", { ticketId }, "host-person"),
    );
    expect(refused?.status).toBe(401);
    expect(control.approvePairing).not.toHaveBeenCalled();
  });

  it("refuses a hub-introduced device, an unproved pairing, and a caller with no paired device, and keeps the bridge's routes from every device", async () => {
    const { handle, control } = setup();
    for (const remote of [
      fromDevice("/api/remote/devices", undefined, "hub-roster"),
      fromDevice("/api/remote/devices"),
      fromDevice("/api/remote/devices/revoke", { deviceId }, "hub-roster"),
      fromDevice("/api/remote/pairing-requests/approve", { ticketId }),
      // The bridge secret opens the bridge's own paths only.
      request("/api/remote/devices"),
      fromDevice("/api/desktop/remote/devices", undefined, "host-person"),
    ]) {
      expect((await handle(remote))?.status).toBe(401);
    }
    expect(control.listDevices).not.toHaveBeenCalled();
    expect(control.revokeDevice).not.toHaveBeenCalled();
    expect(control.approvePairing).not.toHaveBeenCalled();
  });
});
