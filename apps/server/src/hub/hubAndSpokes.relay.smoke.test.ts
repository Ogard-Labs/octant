// A hub and a spoke in one process, each the real remote gateway behind a real
// TLS listener, and a device that paired with the spoke. The spoke's person
// ticks Relay and lets the device through; the hub's person turns the device
// relay on. The device then reaches the spoke through the hub's public
// entrance, running its own pinned TLS inside, while a proxy in front of the
// entrance records every byte the hub and its front could see.

import { execFileSync, spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { request as httpRequest } from "node:http";
import { createServer as createTcpServer, connect as connectTcp, type Server } from "node:net";
import { HOST_HELLO_CLIENT_NONCE_PARAMETER } from "@octant/contracts/remote-access";
import type { HubGrant } from "@octant/contracts";
import { decodeEventActor } from "@octant/contracts";
import {
  createRelayedListenerFetch,
  testOnlyListenerTls,
} from "@octant/client-runtime/remote-listener-tls-node";
import {
  ListenerTrustRefused,
  createExchangeListenerFetch,
  createRelayFallbackFetch,
  createRelayedExchangePort,
  createRemoteConnection,
  type PinnedTlsStreamEvent,
  type PinnedTlsStreamPort,
  parseRelayAdmissionPayload,
  relayAddressFromResponse,
  relayRouteFor,
  type PairedHostRelayChoice,
} from "@octant/client-runtime";
import { decodeRelayAddress, type RelayAddress } from "@octant/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
  // What the hub names as its relay: its entrance through the recording front,
  // known once both are listening.
  let relayAddress: RelayAddress | undefined;
  const hub = await startHubTestHost({
    name: "Mac mini",
    address: "100.101.104.1",
    network,
    cleanups,
    relayAddress: () => relayAddress,
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
  relayAddress = decodeRelayAddress({
    hubMemberId: hub.hostId,
    relayUrl: `wss://127.0.0.1:${front.port}/relay/v1`,
  });
  await spoke.spokeRelay.publish();

  const relayedFetch = (input: { readonly key?: typeof device; readonly pin?: string } = {}) =>
    createRelayedListenerFetch({
      origin: spoke.origin,
      trust: { current: { kind: "pinned", pin: input.pin ?? pin } },
      relay: {
        url: `ws://127.0.0.1:${front.port}/relay/v1`,
        targetMemberId: spoke.hostId,
        admit: async (payload) => ({
          signature: (input.key ?? device).sign(payload),
          deviceSpki: (input.key ?? device).spki,
        }),
        timeoutMs: 5_000,
      },
    });
  return {
    hub,
    spoke,
    device,
    registered,
    network,
    pin,
    relayAddress,
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
      // Where the hub's relay is: told only on the private network.
      ["GET", "/api/remote/relay-address"],
    ] as const) {
      const response = await relayedFetch()(new URL(path, spoke.origin), {
        method,
        ...(method === "GET"
          ? {}
          : { headers: { "content-type": "application/json" }, body: "{}" }),
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
    // Refused inside the tunnel: the TLS the device runs to its host there is
    // judged against its stored pin, exactly as at home.
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

  it("the desktop's client path learns the address at home, and relays only away and only by choice", async () => {
    const { spoke, device, registered, network, pin, relayAddress } = await setUp();
    if (relayAddress === undefined) throw new Error("The hub names no relay address.");
    const trust = { current: { kind: "pinned", pin } } as const;
    let home = true;
    // The device's own choice for this host; off until the person turns it on.
    let choice: PairedHostRelayChoice = { enabled: false };
    // The private network as the device sees it: away, the host does not answer.
    const direct = testOnlyListenerTls.createListenerFetchOver(
      { origin: spoke.origin, trust },
      {
        resolve: async (hostname) => [hostname],
        dial: (address, port) =>
          home
            ? network.network.dial(address, port, new AbortController().signal)
            : Promise.reject(new Error("Away from the private network.")),
        handshakeTimeoutMs: 5_000,
      },
    );
    // As the desktop window signs: only the exact relay admission text.
    const signed: string[] = [];
    const windowSigner = async (payload: string) => {
      if (parseRelayAdmissionPayload(payload) === undefined) {
        throw new Error("The window signs only a relay admission.");
      }
      signed.push(payload);
      return { signature: device.sign(payload), deviceSpki: device.spki };
    };
    let relayedRequests = 0;
    const fetch = createRelayFallbackFetch({
      direct,
      relayed: () => {
        const route = relayRouteFor({
          choice,
          signer: { targetMemberId: spoke.hostId, admit: windowSigner },
        });
        if (route === undefined) return undefined;
        // The device took the hub's `wss:` address; the test's entrance has no
        // front to terminate it, so only this dial goes to it unencrypted.
        const relayed = createRelayedListenerFetch({
          origin: spoke.origin,
          trust,
          relay: { ...route, url: route.url.replace(/^wss:/, "ws:"), timeoutMs: 5_000 },
        });
        return (input, init) => {
          relayedRequests += 1;
          return relayed(input, init);
        };
      },
    });
    const connection = createRemoteConnection({
      origin: spoke.origin,
      webBuildVersion: "0.1.0",
      fetch,
      deviceKey: {
        loadOrCreate: async () => ({ publicKeyPem: device.pem, fingerprint: device.fingerprint }),
        current: async () => ({ publicKeyPem: device.pem, fingerprint: device.fingerprint }),
        sign: async (payload) => device.sign(payload),
        clear: async () => undefined,
      },
      knownDevice: {
        hostId: spoke.hostId,
        deviceId: String(registered.deviceId),
        credentialGeneration: registered.credentialGeneration,
        hostKeyFingerprint: createHash("sha256")
          .update(Buffer.from(spoke.hostPublicKey, "base64url"))
          .digest("hex"),
      },
    });

    // At home: the device signs in directly and learns where the hub's relay is.
    await connection.connect();
    const learned = await connection.authenticatedFetch({
      method: "GET",
      path: "/api/remote/relay-address",
    });
    expect(learned.status).toBe(200);
    const address = await relayAddressFromResponse(learned);
    expect(address).toEqual(relayAddress);
    if (address === undefined || address === "unchanged") throw new Error("No address learned.");
    choice = { ...choice, address };
    expect(relayedRequests).toBe(0);

    // Away with the choice off: nothing goes through the hub.
    home = false;
    connection.disconnect();
    await expect(connection.reconnect()).rejects.toThrow();
    expect(relayedRequests).toBe(0);
    expect(signed).toEqual([]);

    // Away with the choice on: the same client signs in through the relay.
    choice = { ...choice, enabled: true };
    await connection.reconnect();
    expect(relayedRequests).toBeGreaterThan(0);
    expect(
      signed.every((payload) => payload.endsWith(`|${spoke.hostId}|${relayAddress.hubMemberId}`)),
    ).toBe(true);
    const own = await connection.authenticatedFetch({
      method: "GET",
      path: "/api/remote/auth/device",
    });
    expect(own.status).toBe(200);
    // The address route stays at home.
    const refused = await connection.authenticatedFetch({
      method: "GET",
      path: "/api/remote/relay-address",
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ status: "refused", kind: "relayed-admin-refused" });
  }, 60_000);
});

// The phone's native TLS stream, built from the module's own sources and run
// as a command-line harness, carried through the same relay: the pin check
// inside the tunnel is the phone's own, not Node's.
const PHONE_MODULE = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../mobile/modules/octant-pinned-tls",
);

function has(command: string, args: ReadonlyArray<string>): boolean {
  try {
    execFileSync(command, [...args], { stdio: "ignore", timeout: 60_000 });
    return true;
  } catch {
    return false;
  }
}

const swiftcFound = process.platform === "darwin" && has("xcrun", ["--find", "swiftc"]);
const kotlincFound = has("kotlinc", ["-version"]) && has("java", ["-version"]);
const kotlincRequired = process.env.OCTANT_REQUIRE_KOTLINC === "1";
const nativeBuild = mkdtempSync(joinPath(tmpdir(), "octant-pinned-tls-stream-"));
let swiftStream: string | undefined;
let kotlinStream: string | undefined;

beforeAll(() => {
  if (swiftcFound) {
    const binary = joinPath(nativeBuild, "pinned-tls-stream");
    execFileSync(
      "xcrun",
      [
        "swiftc",
        "-o",
        binary,
        joinPath(PHONE_MODULE, "ios/PinnedTlsExchange.swift"),
        joinPath(PHONE_MODULE, "ios/PinnedTlsStream.swift"),
        joinPath(PHONE_MODULE, "test/stream/main.swift"),
      ],
      { stdio: "inherit", timeout: 240_000 },
    );
    if (existsSync(binary)) swiftStream = binary;
  }
  if (kotlincFound) {
    const jar = joinPath(nativeBuild, "pinned-tls-stream.jar");
    execFileSync(
      "kotlinc",
      [
        joinPath(PHONE_MODULE, "android/src/main/java/sh/octant/pinnedtls/PinnedTlsExchange.kt"),
        joinPath(PHONE_MODULE, "android/src/main/java/sh/octant/pinnedtls/PinnedTlsStream.kt"),
        joinPath(PHONE_MODULE, "test/android/StreamMain.kt"),
        joinPath(PHONE_MODULE, "test/android/Base64.kt"),
        "-include-runtime",
        "-d",
        jar,
      ],
      { stdio: "inherit", timeout: 240_000 },
    );
    if (existsSync(jar)) kotlinStream = jar;
  }
}, 480_000);

afterAll(() => {
  rmSync(nativeBuild, { recursive: true, force: true });
});

/** The native stream port over one harness process per stream, as the module would run it. */
function harnessStreams(
  command: () => readonly [string, ReadonlyArray<string>],
): PinnedTlsStreamPort {
  const running = new Map<
    string,
    {
      readonly write: (line: object) => void;
      readonly next: () => Promise<PinnedTlsStreamEvent>;
      readonly kill: () => void;
    }
  >();
  return {
    open: (id, input) => {
      const [binary, args] = command();
      const child = spawn(binary, [...args], { stdio: ["pipe", "pipe", "inherit"] });
      cleanups.push(() => void child.kill());
      const queued: PinnedTlsStreamEvent[] = [];
      const waiting: Array<(event: PinnedTlsStreamEvent) => void> = [];
      const deliver = (event: PinnedTlsStreamEvent) => {
        const taker = waiting.shift();
        if (taker === undefined) queued.push(event);
        else taker(event);
      };
      createInterface({ input: child.stdout }).on("line", (line) => {
        const event = JSON.parse(line) as Record<string, string>;
        const chunk =
          event.chunk === undefined
            ? undefined
            : Uint8Array.from(Buffer.from(event.chunk, "base64"));
        deliver(
          (chunk === undefined ? event : { ...event, chunk }) as unknown as PinnedTlsStreamEvent,
        );
      });
      child.on("exit", () => deliver({ status: "end" }));
      const write = (line: object) => {
        if (child.stdin.writable) child.stdin.write(`${JSON.stringify(line)}\n`);
      };
      write({
        pins: kotlinStream !== undefined && binary === "java" ? input.pins.join(",") : input.pins,
        request: Buffer.from(input.request).toString("base64"),
      });
      running.set(id, {
        write,
        next: () =>
          new Promise((resolveEvent) => {
            const event = queued.shift();
            if (event === undefined) waiting.push(resolveEvent);
            else resolveEvent(event);
          }),
        kill: () => void child.kill(),
      });
    },
    push: (id, chunk) => running.get(id)?.write({ push: Buffer.from(chunk).toString("base64") }),
    pushEnd: (id) => running.get(id)?.write({ end: true }),
    pull: async (id) => (await running.get(id)?.next()) ?? { status: "end" },
    cancel: (id) => running.get(id)?.kill(),
  };
}

const phoneStreams = [
  {
    name: "the phone's iOS stream",
    runs: () => swiftcFound,
    command: (): readonly [string, ReadonlyArray<string>] => {
      if (swiftStream === undefined) throw new Error("The iOS stream was not built.");
      return [swiftStream, []];
    },
  },
  {
    name: "the phone's Android stream",
    runs: () => kotlincFound || kotlincRequired,
    command: (): readonly [string, ReadonlyArray<string>] => {
      if (kotlinStream === undefined) throw new Error("The Android stream was not built.");
      return ["java", ["-cp", kotlinStream, "sh.octant.pinnedtls.StreamMainKt"]];
    },
  },
];

describe.each(phoneStreams)("a phone through the hub over $name", ({ runs, command }) => {
  async function phoneFetch(pinOverride?: string) {
    const scene = await setUp();
    const fetch = createExchangeListenerFetch({
      origin: scene.spoke.origin,
      trust: { current: { kind: "pinned", pin: pinOverride ?? scene.pin } },
      throughRelay: true,
      port: createRelayedExchangePort({
        stream: harnessStreams(command),
        route: {
          url: `ws://127.0.0.1:${scene.front.port}/relay/v1`,
          targetMemberId: scene.spoke.hostId,
          admit: async (payload) => ({
            signature: scene.device.sign(payload),
            deviceSpki: scene.device.spki,
          }),
          timeoutMs: 5_000,
        },
      }),
    });
    return { ...scene, fetch };
  }

  it.runIf(runs())(
    "carries the phone's own pinned TLS to its host, and the hub sees only ciphertext",
    async () => {
      const { fetch, spoke, front } = await phoneFetch();
      const marker = randomBytes(32).toString("base64url");
      const url = new URL("/api/remote/hello", spoke.origin);
      url.searchParams.set(HOST_HELLO_CLIENT_NONCE_PARAMETER, marker);
      const response = await fetch(url.href);
      expect(response.status).toBe(200);
      expect(JSON.stringify(await response.json())).toContain(marker);
      expect(front.seen().includes(Buffer.from(marker))).toBe(false);
    },
    60_000,
  );

  it.runIf(runs())(
    "refuses a host whose pin differs inside the tunnel, before any request byte",
    async () => {
      const { fetch, spoke } = await phoneFetch(`sha256-${randomBytes(32).toString("base64url")}`);
      await expect(fetch(`${spoke.origin}/api/remote/hello`)).rejects.toBeInstanceOf(
        ListenerTrustRefused,
      );
    },
    60_000,
  );
});
