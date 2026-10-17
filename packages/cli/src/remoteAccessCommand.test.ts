import { describe, expect, it } from "vitest";
import { readPairingCode } from "@octant/domain";
import type { LocalControlRequest, LocalControlResponse } from "./localControl";
import {
  resolveAuthCliCommand,
  resolveListenerCliCommand,
  resolvePairCliCommand,
  resolveServerPairingFlags,
  runRemoteAccessCliCommand,
  runServerPairing,
} from "./remoteAccessCommand";
import { renderTerminalQr } from "./terminalQr";

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
const TLS_PIN = `sha256-${"Q".repeat(42)}A`;
const TICKET_PROOF = `${"p".repeat(42)}A`;
const SELF_MADE_STATUS = {
  ...READY_STATUS,
  certificateFingerprint: "e".repeat(64),
  certificateSource: "self-made",
  tlsPin: TLS_PIN,
};
const MINTED = {
  ticket: {
    ticketId: TICKET,
    ticketProof: TICKET_PROOF,
    expiresAt: 1_767_225_600_000,
    sourceClass: "tailscale",
  },
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
    respond: async (request: LocalControlRequest): Promise<LocalControlResponse> => {
      sent.push(request);
      return responses(request);
    },
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
  it("leaves the network class to the listener unless one is named", () => {
    expect(resolvePairCliCommand([], {})).toEqual({ action: "pair" });
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
      pasted: {
        certificatePath: "/etc/octant/station.crt",
        privateKeyPath: "/etc/octant/station.key",
      },
    });
    expect(resolveListenerCliCommand(["disable"], {})).toEqual({ action: "listener-disable" });
  });

  it("asks the host for its own certificate when neither a certificate nor a key is named", () => {
    expect(resolveListenerCliCommand(["enable"], { hostname: "100.64.0.7", port: "8455" })).toEqual(
      {
        action: "listener-enable",
        hostname: "100.64.0.7",
        port: 8455,
      },
    );
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
    const test = fixture((request) =>
      request.path === "/api/desktop/private-listener/status"
        ? { status: 200, body: { status: { ...READY_STATUS, certificateSource: "pasted" } } }
        : {
            status: 201,
            body: {
              ticket: {
                ticketId: "77777777-7777-4777-8777-777777777777",
                ticketProof: "proof",
                expiresAt: 1_767_225_600_000,
                sourceClass: "lan-private",
              },
            },
          },
    );
    expect(await test.run({ action: "pair", sourceClass: "lan-private" })).toBe(0);
    expect(test.sent[1]).toMatchObject({
      path: "/api/desktop/remote/pairing-tickets",
      body: { sourceClass: "lan-private" },
    });
    expect(test.out.join("")).toContain("77777777-7777-4777-8777-777777777777");
    expect(test.out.join("")).toContain("proof");
    expect(test.out.join("")).not.toContain("octant-pair-");
  });

  it("prints a pairing code and its QR for a listener serving its own certificate", async () => {
    const test = fixture((request) =>
      request.path === "/api/desktop/private-listener/status"
        ? { status: 200, body: { status: SELF_MADE_STATUS } }
        : { status: 201, body: MINTED },
    );
    expect(await test.run({ action: "pair" })).toBe(0);
    // The device claims over the listener itself, so the ticket names its network.
    expect(test.sent[1]).toEqual({
      path: "/api/desktop/remote/pairing-tickets",
      method: "POST",
      body: { sourceClass: "tailscale" },
    });
    const out = test.out.join("");
    const code = /^Pairing code (\S+)$/m.exec(out)?.[1] ?? "";
    expect(readPairingCode(code)).toEqual({
      status: "read",
      contents: {
        origin: "https://station.example.ts.net:8455",
        ticketId: TICKET,
        ticketProof: TICKET_PROOF,
        pin: TLS_PIN,
      },
    });
    // Piped output carries no colour codes; the QR above the code encodes it.
    expect(out.startsWith(renderTerminalQr(code, { color: false }))).toBe(true);
    expect(out).not.toContain("\u001b[");
    expect(out).toContain(`Ticket ${TICKET}`);
    expect(out).toContain("no browser link");
    expect(out).toContain("Paste the code into Octant's desktop app");
    expect(out).not.toContain("can't read pairing codes");
    expect(out).not.toMatch(/PRIVATE KEY|BEGIN/);
  });

  it("colours the QR itself on a terminal so a dark theme does not invert it", async () => {
    const out: string[] = [];
    const exit = await runRemoteAccessCliCommand({
      command: { action: "pair" },
      session: {
        kind: "opened",
        windowId: "11111111-1111-4111-8111-111111111111",
        send: async (request) =>
          request.path === "/api/desktop/private-listener/status"
            ? { status: 200, body: { status: SELF_MADE_STATUS } }
            : { status: 201, body: MINTED },
        close: async () => undefined,
      },
      stdout: { write: (chunk) => out.push(chunk), isTTY: true },
      stderr: { write: () => undefined },
    });
    expect(exit).toBe(0);
    const code = /^Pairing code (\S+)$/m.exec(out.join(""))?.[1] ?? "";
    expect(out.join("").startsWith(renderTerminalQr(code, { color: true }))).toBe(true);
  });

  it("refuses a pairing code for another network than the listener's and mints nothing", async () => {
    const test = fixture(() => ({ status: 200, body: { status: SELF_MADE_STATUS } }));
    expect(await test.run({ action: "pair", sourceClass: "lan-private" })).toBe(1);
    expect(test.sent).toHaveLength(1);
    expect(test.err.join("")).toContain("listener's own network (tailscale)");
  });

  it("mints no ticket for a listener a pairing code cannot name", async () => {
    const test = fixture(() => ({
      status: 200,
      body: { status: { ...SELF_MADE_STATUS, tlsPin: `sha512-${"Q".repeat(86)}` } },
    }));
    expect(await test.run({ action: "pair" })).toBe(1);
    expect(test.sent).toHaveLength(1);
    expect(test.err.join("")).toContain("needs a newer version of Octant");
  });

  it("mints nothing when the listener status cannot be read", async () => {
    const test = fixture(() => ({
      status: 503,
      body: { message: "Local device administration is unavailable." },
    }));
    expect(await test.run({ action: "pair" })).toBe(1);
    expect(test.sent).toHaveLength(1);
    expect(test.out).toEqual([]);
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
        pasted: {
          certificatePath: "/etc/octant/station.crt",
          privateKeyPath: "/etc/octant/station.key",
        },
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

  it("sends no certificate or key for a self-made listener and prints its key pin", async () => {
    const test = fixture(() => ({
      status: 200,
      body: {
        status: {
          ...READY_STATUS,
          certificateSource: "self-made",
          tlsPin: "sha256-47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU",
        },
      },
    }));
    expect(await test.run({ action: "listener-enable", hostname: "100.64.0.7", port: 8455 })).toBe(
      0,
    );
    expect(test.sent[0]).toEqual({
      path: "/api/desktop/private-listener/enable",
      method: "POST",
      body: { hostname: "100.64.0.7", port: 8455, origin: "https://100.64.0.7:8455" },
    });
    const printed = test.out.join("");
    expect(printed).toContain("Certificate source self-made");
    expect(printed).toContain("Key pin sha256-47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU");
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
      pasted: { certificatePath: "/c.pem", privateKeyPath: "/k.pem" },
    });
    expect(test.sent[0]?.body).toMatchObject({ origin: "https://192.168.1.20" });
  });

  it("brackets an IPv6 listener address in the origin", async () => {
    const test = fixture(() => ({ status: 200, body: { status: READY_STATUS } }), {
      "/c.pem": "cert",
      "/k.pem": "key",
    });
    await test.run({
      action: "listener-enable",
      hostname: "fd7a:115c:a1e0::7033:4105",
      port: 8455,
      pasted: { certificatePath: "/c.pem", privateKeyPath: "/k.pem" },
    });
    expect(test.sent[0]?.body).toMatchObject({
      hostname: "fd7a:115c:a1e0::7033:4105",
      origin: "https://[fd7a:115c:a1e0::7033:4105]:8455",
    });
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
        pasted: { certificatePath: "/c.pem", privateKeyPath: "/missing.pem" },
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
        pasted: { certificatePath: "/c.pem", privateKeyPath: "/k.pem" },
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

describe("resolveServerPairingFlags", () => {
  it("leaves flags untouched without --pair so other flags stay usage errors", () => {
    expect(resolveServerPairingFlags({ artifact: "/a" })).toEqual({ rest: { artifact: "/a" } });
    expect(resolveServerPairingFlags({ hostname: "x" })).toEqual({ rest: { hostname: "x" } });
  });

  it("defaults the listener to port 8443 and a self-made certificate", () => {
    expect(resolveServerPairingFlags({ pair: true, artifact: "/a" })).toEqual({
      rest: { artifact: "/a" },
      pairing: { port: 8443 },
    });
  });

  it("takes an address, a port, and a certificate with its key", () => {
    expect(
      resolveServerPairingFlags({
        pair: true,
        hostname: "100.64.0.1",
        port: "9000",
        cert: "c",
        key: "k",
      }),
    ).toEqual({
      rest: {},
      pairing: {
        hostname: "100.64.0.1",
        port: 9000,
        pasted: { certificatePath: "c", privateKeyPath: "k" },
      },
    });
  });

  it("refuses a certificate without its key and a bad port", () => {
    expect(resolveServerPairingFlags({ pair: true, cert: "c" })).toBeUndefined();
    expect(resolveServerPairingFlags({ pair: true, port: "70000" })).toBeUndefined();
    expect(resolveServerPairingFlags({ pair: "yes" })).toBeUndefined();
  });
});

describe("runServerPairing", () => {
  const WAITING = { ...PENDING, ticketId: TICKET };
  function pairing(options: {
    readonly answer: string | undefined;
    readonly claimed?: boolean;
    readonly interfaces?: Record<string, { address: string; family: string; internal: boolean }[]>;
    readonly hostname?: string;
  }) {
    let clock = 1_767_225_000_000;
    const test = fixture((request) => {
      if (request.path === "/api/desktop/remote/pairing-requests" && request.method === "GET") {
        return { status: 200, body: { pending: options.claimed === false ? [] : [WAITING] } };
      }
      if (request.path === "/api/desktop/remote/pairing-tickets") {
        return { status: 201, body: MINTED };
      }
      if (request.path.startsWith("/api/desktop/private-listener/")) {
        return { status: 200, body: { status: SELF_MADE_STATUS } };
      }
      return { status: 201, body: {} };
    });
    const asked: string[] = [];
    const run = () =>
      runServerPairing({
        options: {
          port: 8443,
          ...(options.hostname === undefined ? {} : { hostname: options.hostname }),
        },
        session: {
          kind: "opened",
          windowId: "11111111-1111-4111-8111-111111111111",
          send: async (request) => test.respond(request),
          close: async () => undefined,
        },
        stdout: { write: (chunk) => test.out.push(chunk) },
        stderr: { write: (chunk) => test.err.push(chunk) },
        networkInterfaces: () =>
          options.interfaces ?? {
            en0: [{ address: "192.168.1.20", family: "IPv4", internal: false }],
            tailscale0: [{ address: "100.101.102.103", family: "IPv4", internal: false }],
            lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
          },
        ask: async (question) => {
          asked.push(question);
          return options.answer;
        },
        // A wait that never sees a claim runs the clock past the ticket's end.
        now: () => clock,
        sleep: async (ms) => {
          clock += ms * 100_000;
        },
      });
    return { test, asked, run };
  }

  it("listens on the Tailscale address, prints the code, and approves on a typed y", async () => {
    const run = pairing({ answer: "y" });
    expect(await run.run()).toBe(0);
    expect(run.test.sent[0]).toMatchObject({
      path: "/api/desktop/private-listener/enable",
      body: { hostname: "100.101.102.103", port: 8443, origin: "https://100.101.102.103:8443" },
    });
    expect(run.test.sent[0]?.body).not.toHaveProperty("certificatePem");
    const out = run.test.out.join("");
    expect(out).toMatch(/^Pairing code octant-pair-1\./m);
    expect(out).toContain("Comparison code 482913");
    expect(out).toContain("Key fingerprint");
    expect(run.asked).toEqual(["Approve? [y/N] "]);
    expect(run.test.sent.at(-1)).toMatchObject({
      path: "/api/desktop/remote/pairing-requests/approve",
      body: { ticketId: TICKET },
    });
  });

  it("denies the request on any answer but y", async () => {
    const run = pairing({ answer: "" });
    await run.run();
    expect(run.test.sent.at(-1)).toMatchObject({
      path: "/api/desktop/remote/pairing-requests/deny",
    });
  });

  it("leaves the request pending when no answer can be read", async () => {
    const run = pairing({ answer: undefined });
    expect(await run.run()).toBe(1);
    expect(run.test.sent.some((r) => r.path.endsWith("/approve") || r.path.endsWith("/deny"))).toBe(
      false,
    );
    expect(run.test.err.join("")).toContain("octant pair approve");
  });

  it("gives up after the ticket expires without a claim", async () => {
    const run = pairing({ answer: "y", claimed: false });
    expect(await run.run()).toBe(1);
    expect(run.test.err.join("")).toContain("No device used the pairing code within five minutes");
    expect(run.asked).toEqual([]);
  });

  it("enables nothing when several private addresses are found", async () => {
    const run = pairing({
      answer: "y",
      interfaces: {
        a: [{ address: "192.168.1.20", family: "IPv4", internal: false }],
        b: [{ address: "10.0.0.5", family: "IPv4", internal: false }],
      },
    });
    expect(await run.run()).toBe(1);
    expect(run.test.sent).toEqual([]);
    expect(run.test.err.join("")).toContain("192.168.1.20, 10.0.0.5");
  });

  it("refuses a --hostname that is public before enabling anything", async () => {
    const run = pairing({ answer: "y", hostname: "203.0.113.9" });
    expect(await run.run()).toBe(1);
    expect(run.test.sent).toEqual([]);
  });
});
