import { describe, expect, it } from "vitest";
import { createPairedDeviceAdministrationClient } from "./pairedDeviceAdministrationClient";

const deviceId = "22222222-2222-4222-8222-222222222222";
const ticketId = "33333333-3333-4333-8333-333333333333";
const device = {
  hostId: "host",
  deviceId,
  deviceKeyFingerprint: "ab:cd",
  deviceLabel: "Phone",
  origin: "https://host.example:13774",
  protocolFloor: 1,
  credentialGeneration: 1,
  createdAt: "2026-11-12T10:00:00.000Z",
  expiresAt: "2027-11-12T10:00:00.000Z",
  lastSeenAt: "2026-11-12T10:00:00.000Z",
  state: "active",
};
const pending = {
  kind: "pending",
  ticketId,
  hostId: "host",
  deviceLabel: "Tablet",
  deviceKeyFingerprint: "ef:01",
  origin: "https://host.example:13774",
  sourceClass: "lan-private",
  comparisonCode: "123-456",
  claimedAt: "2026-11-12T10:00:00.000Z",
  expiresAt: "2026-11-12T10:05:00.000Z",
};

function host(answer: (path: string) => Response) {
  const sent: Array<{ readonly method: string; readonly path: string; readonly body: unknown }> =
    [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    sent.push({
      method: init?.method ?? "GET",
      path,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    return answer(path);
  };
  return {
    sent,
    client: createPairedDeviceAdministrationClient({ baseUrl: "http://127.0.0.1", fetch }),
  };
}

describe("paired devices as a device the host's own person paired administers them", () => {
  it("lists devices and pairing requests, and renames, revokes and approves by the host's routes", async () => {
    const { client, sent } = host((path) =>
      path === "/api/remote/devices"
        ? Response.json({ devices: [device] })
        : path === "/api/remote/pairing-requests"
          ? Response.json({ pending: [pending] })
          : path === "/api/remote/pairing-tickets"
            ? Response.json(
                {
                  ticket: {
                    ticketId,
                    ticketProof: "proof",
                    expiresAt: 1,
                    sourceClass: "tailscale",
                  },
                },
                { status: 201 },
              )
            : Response.json({}, { status: 201 }),
    );

    expect(await client.listDevices()).toEqual({ status: "ok", value: [device] });
    expect(await client.listPairingRequests()).toEqual({ status: "ok", value: [pending] });
    expect(await client.renameDevice(deviceId, "Work phone")).toEqual({ status: "ok" });
    expect(await client.revokeDevice(deviceId)).toEqual({ status: "ok" });
    expect(await client.revokeAllDevices()).toEqual({ status: "ok" });
    expect(await client.reconcileExpiredDevices()).toEqual({ status: "ok" });
    expect(await client.approvePairingRequest(ticketId)).toEqual({ status: "ok" });
    expect(await client.denyPairingRequest(ticketId)).toEqual({ status: "ok" });
    expect(await client.createPairingTicket("tailscale")).toEqual({
      status: "ok",
      value: { ticketId, ticketProof: "proof", expiresAt: 1, sourceClass: "tailscale" },
    });

    expect(sent).toEqual([
      { method: "GET", path: "/api/remote/devices", body: undefined },
      { method: "GET", path: "/api/remote/pairing-requests", body: undefined },
      {
        method: "POST",
        path: "/api/remote/devices/rename",
        body: { deviceId, deviceLabel: "Work phone" },
      },
      { method: "POST", path: "/api/remote/devices/revoke", body: { deviceId } },
      { method: "POST", path: "/api/remote/devices/revoke-all", body: {} },
      { method: "POST", path: "/api/remote/devices/reconcile-expired", body: {} },
      { method: "POST", path: "/api/remote/pairing-requests/approve", body: { ticketId } },
      {
        method: "POST",
        path: "/api/remote/pairing-requests/deny",
        body: { ticketId, reasonCode: "user-denied" },
      },
      { method: "POST", path: "/api/remote/pairing-tickets", body: { sourceClass: "tailscale" } },
    ]);
  });

  it("says plainly that a device cannot approve its own pairing request", async () => {
    const { client } = host(() =>
      Response.json(
        { category: "unauthorized", message: "Local device administration is unauthorized." },
        { status: 401 },
      ),
    );

    expect(await client.approvePairingRequest(ticketId)).toEqual({
      status: "refused",
      message:
        "The host did not take this approval. A device cannot approve its own pairing request; approve it from another paired device or at the host.",
    });
  });

  it("reports a restricted session's refusal, and a host it cannot reach, as refusals", async () => {
    const refusing = host(() =>
      Response.json({ category: "unauthorized", message: "No." }, { status: 401 }),
    );
    expect(await refusing.client.listDevices()).toMatchObject({ status: "refused" });
    expect(await refusing.client.revokeDevice(deviceId)).toMatchObject({ status: "refused" });

    const unreachable = createPairedDeviceAdministrationClient({
      baseUrl: "http://127.0.0.1",
      fetch: async () => {
        throw new Error("offline");
      },
    });
    expect(await unreachable.listPairingRequests()).toMatchObject({ status: "refused" });
  });
});
