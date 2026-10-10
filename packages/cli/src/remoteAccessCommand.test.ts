import { describe, expect, it } from "vitest";
import type { LocalControlRequest, LocalControlResponse } from "./localControl";
import {
  resolveAuthCliCommand,
  resolveListenerCliCommand,
  resolvePairCliCommand,
  runRemoteAccessCliCommand,
} from "./remoteAccessCommand";

const TICKET = "77777777-7777-4777-8777-777777777777";
const PENDING = {
  kind: "pending",
  ticketId: TICKET,
  hostId: "11111111-1111-4111-8111-111111111111",
  deviceLabel: "Henrik's phone",
  deviceKeyFingerprint: "c".repeat(64),
  origin: "https://station.example.ts.net:8455",
  sourceClass: "tailscale",
  comparisonCode: "482913",
  claimedAt: "2026-10-09T10:00:00.000Z",
  expiresAt: "2026-10-09T10:05:00.000Z",
};
const READY_STATUS = {
  enabled: true,
  state: "ready",
  hostname: "station.example.ts.net",
  port: 8455,
  origin: "https://station.example.ts.net:8455",
  exposureClass: "tailscale",
  certificateFingerprint: "d".repeat(64),
  certificateReady: true,
};

function fixture(
  responses: (request: LocalControlRequest) => LocalControlResponse,
  files: Readonly<Record<string, string>> = {},
) {
  const sent: LocalControlRequest[] = [];
  const out: string[] = [];
  const err: string[] = [];
  return {
    sent,
    out,
    err,
    run: (command: Parameters<typeof runRemoteAccessCliCommand>[0]["command"]) =>
      runRemoteAccessCliCommand({
        command,
        session: {
          kind: "opened",
          windowId: "11111111-1111-4111-8111-111111111111",
          send: async (request) => {
            sent.push(request);
            return responses(request);
          },
          close: async () => undefined,
        },
        stdout: { write: (chunk) => out.push(chunk) },
        stderr: { write: (chunk) => err.push(chunk) },
        readTextFile: async (path) => {
          const text = files[path];
          if (text === undefined) throw new Error(`ENOENT: ${path}`);
          return text;
        },
      }),
  };
}

describe("resolvePairCliCommand", () => {
  it("mints a loopback token unless another network class is named", () => {
    expect(resolvePairCliCommand([], {})).toEqual({ action: "pair", sourceClass: "loopback" });
    expect(resolvePairCliCommand([], { source: "tailscale" })).toEqual({
      action: "pair",
      sourceClass: "tailscale",
    });
  });

  it("refuses a network class Octant does not pair over", () => {
    expect(resolvePairCliCommand([], { source: "public" })).toBeUndefined();
  });

  it("lists, approves, and denies pairing requests by ticket", () => {
    expect(resolvePairCliCommand(["requests"], {})).toEqual({ action: "list-pairing-requests" });
    expect(resolvePairCliCommand(["approve", TICKET], {})).toEqual({
      action: "approve-pairing",
      ticketId: TICKET,
    });
    expect(resolvePairCliCommand(["deny", TICKET], {})).toEqual({
      action: "deny-pairing",
      ticketId: TICKET,
    });
  });

  it("refuses a decision that names no recognizable ticket", () => {
    expect(resolvePairCliCommand(["approve"], {})).toBeUndefined();
    expect(resolvePairCliCommand(["approve", "482913"], {})).toBeUndefined();
    expect(resolvePairCliCommand(["deny", TICKET], { source: "tailscale" })).toBeUndefined();
  });
});

describe("resolveListenerCliCommand", () => {
  it("shows the listener status by default", () => {
    expect(resolveListenerCliCommand([], {})).toEqual({ action: "listener-status" });
    expect(resolveListenerCliCommand(["status"], {})).toEqual({ action: "listener-status" });
  });

  it("enables the listener on an address and port with certificate and key paths", () => {
    expect(
      resolveListenerCliCommand(["enable"], {
        hostname: "station.example.ts.net",
        port: "8455",
        cert: "/etc/octant/station.crt",
        key: "/etc/octant/station.key",
      }),
    ).toEqual({
      action: "listener-enable",
      hostname: "station.example.ts.net",
      port: 8455,
      certificatePath: "/etc/octant/station.crt",
      privateKeyPath: "/etc/octant/station.key",
    });
    expect(resolveListenerCliCommand(["disable"], {})).toEqual({ action: "listener-disable" });
  });

  it("refuses an enable missing its address, port, certificate, or key", () => {
    const complete = { hostname: "100.64.0.7", port: "8455", cert: "/c.pem", key: "/k.pem" };
    for (const missing of ["hostname", "port", "cert", "key"] as const) {
      const { [missing]: _omitted, ...flags } = complete;
      expect(resolveListenerCliCommand(["enable"], flags)).toBeUndefined();
    }
    expect(resolveListenerCliCommand(["enable"], { ...complete, port: "99999" })).toBeUndefined();
    expect(resolveListenerCliCommand(["enable"], { ...complete, port: "84a" })).toBeUndefined();
    expect(resolveListenerCliCommand(["disable"], { hostname: "100.64.0.7" })).toBeUndefined();
  });
});

describe("resolveAuthCliCommand", () => {
  it("lists paired devices by default", () => {
    expect(resolveAuthCliCommand([], {})).toEqual({ action: "list-devices" });
    expect(resolveAuthCliCommand(["list"], {})).toEqual({ action: "list-devices" });
  });

  it("revokes one device or every device", () => {
    expect(resolveAuthCliCommand(["revoke", "66666666-6666-4666-8666-666666666666"], {})).toEqual({
      action: "revoke-device",
      deviceId: "66666666-6666-4666-8666-666666666666",
    });
    expect(resolveAuthCliCommand(["revoke"], { all: true })).toEqual({
      action: "revoke-all-devices",
    });
  });

  it("refuses a revocation that names no recognizable device", () => {
    expect(resolveAuthCliCommand(["revoke", "device-2"], {})).toBeUndefined();
  });
});

describe("runRemoteAccessCliCommand", () => {
  it("prints the pairing token a device claims and the host approves", async () => {
    const test = fixture(() => ({
      status: 201,
      body: {
        ticket: {
          ticketId: "77777777-7777-4777-8777-777777777777",
          ticketProof: "proof",
          expiresAt: 1_767_225_600_000,
          sourceClass: "lan-private",
        },
      },
    }));
    expect(await test.run({ action: "pair", sourceClass: "lan-private" })).toBe(0);
    expect(test.sent[0]).toMatchObject({
      path: "/api/desktop/remote/pairing-tickets",
      body: { sourceClass: "lan-private" },
    });
    expect(test.out.join("")).toContain("77777777-7777-4777-8777-777777777777");
    expect(test.out.join("")).toContain("proof");
  });

  it("says so when no device is paired with the host", async () => {
    const test = fixture(() => ({ status: 200, body: { devices: [] } }));
    expect(await test.run({ action: "list-devices" })).toBe(0);
    expect(test.out.join("")).toContain("No devices are paired");
  });

  it("lists each paired device with the state Octant records", async () => {
    const test = fixture(() => ({
      status: 200,
      body: {
        devices: [
          {
            deviceId: "88888888-8888-4888-8888-888888888888",
            deviceLabel: "Phone",
            state: "active",
          },
        ],
      },
    }));
    expect(await test.run({ action: "list-devices" })).toBe(0);
    expect(test.out.join("")).toContain("Phone");
    expect(test.out.join("")).toContain("active");
  });

  it("reports the reason Octant refused a revocation", async () => {
    const test = fixture(() => ({ status: 401, body: { category: "unauthorized" } }));
    expect(
      await test.run({ action: "revoke-device", deviceId: "99999999-9999-4999-8999-999999999999" }),
    ).toBe(1);
    expect(test.err.join("")).toContain("refused");
  });

  it("enables the listener with the certificate and key read from their paths", async () => {
    const test = fixture(() => ({ status: 200, body: { status: READY_STATUS } }), {
      "/etc/octant/station.crt": "-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n",
      "/etc/octant/station.key": "-----BEGIN PRIVATE KEY-----\nBBB\n-----END PRIVATE KEY-----\n",
    });
    expect(
      await test.run({
        action: "listener-enable",
        hostname: "station.example.ts.net",
        port: 8455,
        certificatePath: "/etc/octant/station.crt",
        privateKeyPath: "/etc/octant/station.key",
      }),
    ).toBe(0);
    expect(test.sent[0]).toEqual({
      path: "/api/desktop/private-listener/enable",
      method: "POST",
      body: {
        hostname: "station.example.ts.net",
        port: 8455,
        origin: "https://station.example.ts.net:8455",
        certificatePem: "-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n",
        privateKeyPem: "-----BEGIN PRIVATE KEY-----\nBBB\n-----END PRIVATE KEY-----\n",
      },
    });
    const printed = test.out.join("");
    expect(printed).toContain("ready");
    expect(printed).toContain("https://station.example.ts.net:8455");
    expect(printed).not.toContain("PRIVATE KEY");
  });

  it("drops the default HTTPS port from the origin as Settings does", async () => {
    const test = fixture(() => ({ status: 200, body: { status: READY_STATUS } }), {
      "/c.pem": "cert",
      "/k.pem": "key",
    });
    await test.run({
      action: "listener-enable",
      hostname: "192.168.1.20",
      port: 443,
      certificatePath: "/c.pem",
      privateKeyPath: "/k.pem",
    });
    expect(test.sent[0]?.body).toMatchObject({ origin: "https://192.168.1.20" });
  });

  it("sends nothing when a certificate or key file cannot be read", async () => {
    const test = fixture(() => ({ status: 200, body: { status: READY_STATUS } }), {
      "/c.pem": "cert",
    });
    expect(
      await test.run({
        action: "listener-enable",
        hostname: "192.168.1.20",
        port: 8455,
        certificatePath: "/c.pem",
        privateKeyPath: "/missing.pem",
      }),
    ).toBe(1);
    expect(test.sent).toHaveLength(0);
    expect(test.err.join("")).toContain("/missing.pem");
  });

  it("reports the listener failure Octant names", async () => {
    const test = fixture(
      () => ({
        status: 503,
        body: {
          category: "unavailable",
          errorCode: "occupied-port",
          message: "Octant private listener occupied port.",
        },
      }),
      { "/c.pem": "cert", "/k.pem": "key" },
    );
    expect(
      await test.run({
        action: "listener-enable",
        hostname: "192.168.1.20",
        port: 8455,
        certificatePath: "/c.pem",
        privateKeyPath: "/k.pem",
      }),
    ).toBe(1);
    expect(test.err.join("")).toContain("occupied port");
  });

  it("shows a disabled listener and turns it off", async () => {
    const disabled = {
      enabled: false,
      state: "disabled",
      hostname: null,
      port: null,
      origin: null,
      exposureClass: null,
      certificateFingerprint: null,
      certificateReady: false,
    };
    const test = fixture(() => ({ status: 200, body: { status: disabled } }));
    expect(await test.run({ action: "listener-status" })).toBe(0);
    expect(test.sent[0]).toEqual({ path: "/api/desktop/private-listener/status", method: "GET" });
    expect(test.out.join("")).toContain("disabled");
    expect(await test.run({ action: "listener-disable" })).toBe(0);
    expect(test.sent[1]).toEqual({ path: "/api/desktop/private-listener/disable", method: "POST" });
  });

  it("names the failure a listener that could not come back reports", async () => {
    const test = fixture(() => ({
      status: 200,
      body: {
        status: {
          enabled: false,
          state: "failed",
          hostname: null,
          port: null,
          origin: null,
          exposureClass: null,
          certificateFingerprint: null,
          certificateReady: false,
          errorCode: "interface-unavailable",
        },
      },
    }));
    expect(await test.run({ action: "listener-status" })).toBe(0);
    expect(test.out.join("")).toContain("interface-unavailable");
  });

  it("lists each pending pairing request with the code and device Settings shows", async () => {
    const test = fixture(() => ({ status: 200, body: { pending: [PENDING] } }));
    expect(await test.run({ action: "list-pairing-requests" })).toBe(0);
    expect(test.sent[0]).toEqual({ path: "/api/desktop/remote/pairing-requests", method: "GET" });
    const printed = test.out.join("");
    expect(printed).toContain(TICKET);
    expect(printed).toContain("482913");
    expect(printed).toContain("Henrik's phone");
    expect(printed).toContain("https://station.example.ts.net:8455");
    expect(printed).toContain("c".repeat(64));
  });

  it("says so when no device is waiting for approval", async () => {
    const test = fixture(() => ({ status: 200, body: { pending: [] } }));
    expect(await test.run({ action: "list-pairing-requests" })).toBe(0);
    expect(test.out.join("")).toContain("No pairing requests");
  });

  it("points at the listener when pairing administration is unavailable", async () => {
    const test = fixture(() => ({
      status: 503,
      body: { category: "unavailable", message: "Local device administration is unavailable." },
    }));
    expect(await test.run({ action: "list-pairing-requests" })).toBe(1);
    expect(test.err.join("")).toContain("octant listener enable");
  });

  it("approves a pending request and names the device and code it approved", async () => {
    const test = fixture((request) =>
      request.method === "GET"
        ? { status: 200, body: { pending: [PENDING] } }
        : {
            status: 201,
            body: {
              decision: { decision: "approved" },
              device: {
                deviceId: "88888888-8888-4888-8888-888888888888",
                deviceLabel: "Henrik's phone",
              },
            },
          },
    );
    expect(await test.run({ action: "approve-pairing", ticketId: TICKET })).toBe(0);
    expect(test.sent[1]).toEqual({
      path: "/api/desktop/remote/pairing-requests/approve",
      method: "POST",
      body: { ticketId: TICKET },
    });
    const printed = test.out.join("");
    expect(printed).toContain("Henrik's phone");
    expect(printed).toContain("482913");
  });

  it("denies a pending request with the reason Settings records", async () => {
    const test = fixture((request) =>
      request.method === "GET"
        ? { status: 200, body: { pending: [PENDING] } }
        : { status: 201, body: { decision: { decision: "denied" } } },
    );
    expect(await test.run({ action: "deny-pairing", ticketId: TICKET })).toBe(0);
    expect(test.sent[1]).toEqual({
      path: "/api/desktop/remote/pairing-requests/deny",
      method: "POST",
      body: { ticketId: TICKET, reasonCode: "user-denied" },
    });
    expect(test.out.join("")).toContain("Denied Henrik's phone");
  });

  it("decides nothing for a ticket that is not waiting for approval", async () => {
    const test = fixture(() => ({ status: 200, body: { pending: [] } }));
    expect(await test.run({ action: "approve-pairing", ticketId: TICKET })).toBe(1);
    expect(test.sent).toHaveLength(1);
    expect(test.err.join("")).toContain("No pending pairing request");
  });
});
