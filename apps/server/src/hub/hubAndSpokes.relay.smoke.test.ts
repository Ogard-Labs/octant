// A hub and a spoke in one process, each the real remote gateway behind a real
// TLS listener, and a device that paired with the spoke. The spoke's person
// ticks Relay and lets the device through; the hub's person turns the device
// relay on. The device then reaches the spoke through the hub's public
// entrance, running its own pinned TLS inside, while a proxy in front of the
// entrance records every byte the hub and its front could see.

import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { request as httpRequest } from "node:http";
import { createServer as createTcpServer, connect as connectTcp, type Server } from "node:net";
import { HOST_HELLO_CLIENT_NONCE_PARAMETER } from "@octant/contracts/remote-access";
import type { HubGrant } from "@octant/contracts";
import { decodeEventActor } from "@octant/contracts";
import { createRelayedListenerFetch } from "@octant/client-runtime/remote-listener-tls-node";
import { afterEach, describe, expect, it } from "vitest";
import { HubTestNetwork, startHubTestHost, type HubTestHost } from "./hubHost.test-support";
import { startPublicEntrance, type PublicEntrance } from "./publicEntrance";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const window = { kind: "local-window" } as const;
const person = decodeEventActor({
  kind: "local-user",
  actorId: "77777777-7777-4777-8777-777777777777",
});
const relayGrant: HubGrant = { items: ["roster", "introduce", "relay"], actProjects: [] };

async function join(hub: HubTestHost, member: HubTestHost) {
  const minted = hub.hub.mintJoinCode({ owner: false });
  if (minted.status !== "minted") throw new Error(minted.status);
  const started = await member.spoke.startJoin({ code: minted.code });
  if (started.status !== "awaiting-approval") throw new Error(JSON.stringify(started));
  const pending = hub.administration.listPendingPairings().at(-1);
  if (pending === undefined) throw new Error("The hub shows no pairing to approve.");
  hub.administration.approvePairing({ ticketId: pending.ticketId });
  const finished = await member.spoke.finishJoin(window);
  if (finished.status !== "joined") throw new Error(JSON.stringify(finished));
}

/** A device key as a paired phone holds one. */
function deviceKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const der = publicKey.export({ format: "der", type: "spki" });
  return {
    pem: String(publicKey.export({ format: "pem", type: "spki" })).trim(),
    spki: der.toString("base64url"),
    fingerprint: createHash("sha256").update(der).digest("hex"),
    sign: (payload: string) =>
      sign("sha256", Buffer.from(payload), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString(
        "base64url",
      ),
  };
}

/** Everything between the device and the entrance passes here, as a front would carry it. */
async function recordingFront(targetPort: number) {
  const seen: Buffer[] = [];
  const server: Server = createTcpServer((inbound) => {
    const outbound = connectTcp({ host: "127.0.0.1", port: targetPort });
    inbound.on("data", (chunk: Buffer) => {
      seen.push(chunk);
      outbound.write(chunk);
    });
    outbound.on("data", (chunk: Buffer) => {
      seen.push(chunk);
      inbound.write(chunk);
    });
    inbound.on("close", () => outbound.destroy());
    outbound.on("close", () => inbound.destroy());
    inbound.on("error", () => undefined);
    outbound.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No front port.");
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { port: address.port, seen: () => Buffer.concat(seen) };
}

async function setUp(options: { readonly grant?: HubGrant } = {}) {
  const network = new HubTestNetwork();
  const hub = await startHubTestHost({
    name: "Mac mini",
    address: "100.101.104.1",
    network,
    cleanups,
  });
  const spoke = await startHubTestHost({
    name: "Laptop",
    address: "100.101.104.2",
    network,
    cleanups,
  });
  hub.hub.enable(window);
  await join(hub, spoke);
  spoke.spoke.setGrant(options.grant ?? relayGrant, window);
  hub.relayHub.setEnabled(true, window);

  const device = deviceKey();
  const registered = spoke.gateway.admitIntroducedDevice({
    devicePublicKey: device.pem,
    deviceLabel: "Phone",
    origin: spoke.origin,
    sourceClass: "tailscale",
  });
  const deviceId = String(registered.deviceId);
  await spoke.spokeRelay.allow(deviceId, true, window);

  let paused = false;
  const entrance: PublicEntrance = await startPublicEntrance({
    port: 0,
    role: () => (paused ? "closed" : "serve"),
    handlers: () => {
      const relay = hub.relayHub.handler();
      return relay === undefined ? {} : { relay };
    },
  });
  cleanups.push(() => entrance.close());
  const front = await recordingFront(entrance.port);
  const pin = spoke.listener.tlsPin;
  if (pin === null) throw new Error("The spoke has no pinned certificate.");

  const relayedFetch = (input: { readonly key?: typeof device; readonly pin?: string } = {}) =>
    createRelayedListenerFetch({
      origin: spoke.origin,
      trust: { current: { kind: "pinned", pin: input.pin ?? pin } },
      relay: {
        url: `ws://127.0.0.1:${front.port}/relay/v1`,
        targetMemberId: spoke.hostId,
        deviceSpki: (input.key ?? device).spki,
        sign: (input.key ?? device).sign,
        timeoutMs: 5_000,
      },
    });
  return {
    hub,
    spoke,
    device,
    deviceId,
    entrance,
    front,
    relayedFetch,
    pauseHub: (value: boolean) => {
      paused = value;
      if (value) hub.relayHub.closeAll();
    },
  };
}

/** A raw upgrade to the relay route, for the answers a device never gets past. */
function upgradeStatus(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      path: "/relay/v1",
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": randomBytes(16).toString("base64"),
        "sec-websocket-version": "13",
      },
    });
    request.on("upgrade", (response, socket) => {
      socket.destroy();
      resolve(response.statusCode ?? 0);
    });
    request.on("response", (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on("error", reject);
    request.end();
  });
}

describe("your own devices through the hub", () => {
  it("carries a paired device's pinned TLS to its host, and the hub sees only ciphertext", async () => {
    const { relayedFetch, spoke, front } = await setUp();
    const marker = randomBytes(32).toString("base64url");
    const url = new URL("/api/remote/hello", spoke.origin);
    url.searchParams.set(HOST_HELLO_CLIENT_NONCE_PARAMETER, marker);
    const response = await relayedFetch()(url, { headers: { "x-octant-probe": marker } });
    expect(response.status).toBe(200);
    const hello = JSON.stringify(await response.json());
    // The host answered this very request: its hello echoes the nonce.
    expect(hello).toContain(marker);
    // Neither the request nor the answer crossed the hub readable.
    expect(front.seen().byteLength).toBeGreaterThan(0);
    expect(front.seen().includes(Buffer.from(marker))).toBe(false);
    expect(front.seen().includes(Buffer.from("/api/remote/hello"))).toBe(false);
  }, 30_000);

  it("a relayed connection cannot reach pairing", async () => {
    const { relayedFetch, spoke } = await setUp();
    for (const [method, path] of [
      ["POST", "/api/remote/pairing/claim"],
      ["POST", "/api/remote/pairing-tickets"],
      ["POST", "/api/remote/devices/revoke"],
      ["POST", "/api/hub/join"],
    ] as const) {
      const response = await relayedFetch()(new URL(path, spoke.origin), {
        method,
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(response.status, path).toBe(403);
      expect(await response.json(), path).toEqual({
        status: "refused",
        kind: "relayed-admin-refused",
      });
    }
  }, 30_000);

  it("a relayed connection reaches only the routes a paired device uses", async () => {
    const { relayedFetch, spoke } = await setUp();
    // Pre-auth routes for the private network, which exist on the listener
    // but are never for the relay: agent access and the server proxy sign-in.
    for (const path of ["/api/agent-access/claim", "/api/remote/auth/server-proxy-session"]) {
      const response = await relayedFetch()(new URL(path, spoke.origin), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(response.status, path).toBe(403);
      expect(await response.json(), path).toEqual({
        status: "refused",
        kind: "relayed-admin-refused",
      });
    }
  }, 30_000);

  it("the relayed device rejects a host whose pin differs", async () => {
    const { relayedFetch, spoke } = await setUp();
    const otherPin = `sha256-${randomBytes(32).toString("base64url")}`;
    await expect(
      relayedFetch({ pin: otherPin })(new URL("/api/remote/hello", spoke.origin)),
    ).rejects.toThrow();
  }, 30_000);

  it("a relay from a key the target did not list is refused", async () => {
    const { relayedFetch, spoke, hub } = await setUp();
    const stranger = deviceKey();
    await expect(
      relayedFetch({ key: stranger })(new URL("/api/remote/hello", spoke.origin)),
    ).rejects.toThrow("could not be reached");
    expect(hub.relayHub.status().tunnels).toBe(0);
  }, 30_000);

  it("refuses every relay while the host's person has not ticked Relay", async () => {
    const { relayedFetch, spoke, hub, device } = await setUp({
      grant: { items: ["roster", "introduce"], actProjects: [] },
    });
    expect(hub.state.load().relayHub?.hosts ?? []).toEqual([]);
    expect(
      spoke.spokeRelay.openTunnel({
        deviceFingerprint: device.fingerprint,
        hubAddress: "100.101.104.1",
      }),
    ).toEqual({ status: "refused", kind: "relay-not-granted" });
    await expect(relayedFetch()(new URL("/api/remote/hello", spoke.origin))).rejects.toThrow();
  }, 30_000);

  it("answers 404 on the relay route while the hub's switch is off or the hub is paused", async () => {
    const { hub, front, pauseHub } = await setUp();
    expect(await upgradeStatus(front.port)).toBe(101);
    hub.relayHub.setEnabled(false, window);
    expect(await upgradeStatus(front.port)).toBe(404);
    hub.relayHub.setEnabled(true, window);
    pauseHub(true);
    expect(await upgradeStatus(front.port)).toBe(404);
  }, 30_000);

  it("refuses a relayed session while the host's own remote access is paused", async () => {
    const { relayedFetch, spoke } = await setUp();
    spoke.administration.setRemoteAccessPaused({ paused: true, actor: person });
    await expect(relayedFetch()(new URL("/api/remote/hello", spoke.origin))).rejects.toThrow();
    spoke.administration.setRemoteAccessPaused({ paused: false, actor: person });
    const response = await relayedFetch()(new URL("/api/remote/hello", spoke.origin));
    expect(response.status).not.toBe(403);
  }, 30_000);

  it("revoking a device removes its key from the hub's relay list", async () => {
    const { spoke, hub, device, deviceId, relayedFetch } = await setUp();
    const listed = () =>
      (hub.state.load().relayHub?.hosts ?? []).flatMap((host) => host.fingerprints);
    expect(listed()).toEqual([device.fingerprint]);
    spoke.administration.revokeDevice({ deviceId });
    await expect.poll(listed, { timeout: 5_000 }).toEqual([]);
    await expect(relayedFetch()(new URL("/api/remote/hello", spoke.origin))).rejects.toThrow();
  }, 30_000);
});
