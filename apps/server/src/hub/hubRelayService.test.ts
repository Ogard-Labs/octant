import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { decodeRelayAddress, relayAdmissionPayload } from "@octant/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { HubState, type HubStatePort } from "./hubStateStore";
import { Schema } from "effect";

const decodeHubState = Schema.decodeUnknownSync(HubState);
import { HubRelayService, hubRelayAddress, type RelayTunnelEnd } from "./hubRelayService";
import { startPublicEntrance } from "./publicEntrance";

const HUB = "22222222-2222-4222-8222-222222222222";
const HOST = "11111111-1111-4111-8111-111111111111";
const window = { kind: "local-window" } as const;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function memoryState(): HubStatePort {
  let state: HubState = {};
  return { load: () => state, save: (next) => void (state = next) };
}

function deviceKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const der = publicKey.export({ format: "der", type: "spki" });
  return {
    spki: der.toString("base64url"),
    fingerprint: createHash("sha256").update(der).digest("hex"),
    sign: (payload: string) =>
      sign("sha256", Buffer.from(payload), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString(
        "base64url",
      ),
  };
}

async function relay(maxTunnels: number, members?: () => ReadonlyArray<string>) {
  const pending: Array<(end: RelayTunnelEnd | undefined) => void> = [];
  const service = new HubRelayService({
    state: memoryState(),
    serving: () => true,
    ...(members === undefined ? {} : { members }),
    hubMemberId: () => HUB,
    openTunnel: () => new Promise((resolve) => pending.push(resolve)),
    record: () => undefined,
    maxTunnels,
  });
  service.setEnabled(true, window);
  const entrance = await startPublicEntrance({
    port: 0,
    role: () => "serve",
    handlers: () => {
      const handler = service.handler();
      return handler === undefined ? {} : { relay: handler };
    },
  });
  cleanups.push(async () => {
    for (const resolve of pending) resolve(undefined);
    service.closeAll();
    await entrance.close();
  });
  return { service, url: `ws://127.0.0.1:${entrance.port}/relay/v1`, pending };
}

/** Opens a relay, answers the challenge, and reports how the hub ended it. */
function connect(
  url: string,
  key: ReturnType<typeof deviceKey>,
  signedFor: { readonly target?: string; readonly hub?: string } = {},
): Promise<{ readonly closeCode: number | undefined; readonly socket: WebSocket }> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url);
    socket.addEventListener("message", (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      const challenge = JSON.parse(event.data) as { challenge: string; hubMemberId: string };
      socket.send(
        JSON.stringify({
          targetMemberId: HOST,
          deviceSpki: key.spki,
          signature: key.sign(
            relayAdmissionPayload({
              challenge: challenge.challenge,
              targetMemberId: signedFor.target ?? HOST,
              hubMemberId: signedFor.hub ?? challenge.hubMemberId,
            }),
          ),
        }),
      );
      setTimeout(() => resolve({ closeCode: undefined, socket }), 200);
    });
    socket.addEventListener("close", (event) => resolve({ closeCode: event.code, socket }));
    socket.addEventListener("error", () => resolve({ closeCode: -1, socket }));
  });
}

describe("the hub's device relay", () => {
  it("admits a listed key and refuses a key with a forged signature", async () => {
    const { service, url, pending } = await relay(32);
    const key = deviceKey();
    service.receiveDevices(HOST, { fingerprints: [key.fingerprint] });
    const admitted = await connect(url, key);
    expect(admitted.closeCode).toBeUndefined();
    expect(pending).toHaveLength(1);
    admitted.socket.close();

    const forged = { ...deviceKey(), spki: key.spki };
    const refused = await connect(url, forged);
    expect(refused.closeCode).toBe(4401);
  });

  it("holds at most the tunnel cap open at once", async () => {
    const { service, url } = await relay(1);
    const first = deviceKey();
    const second = deviceKey();
    service.receiveDevices(HOST, { fingerprints: [first.fingerprint, second.fingerprint] });
    const open = await connect(url, first);
    expect(open.closeCode).toBeUndefined();
    expect(service.status().tunnels).toBe(1);
    const turnedAway = await connect(url, second);
    expect(turnedAway.closeCode).not.toBeUndefined();
    expect(service.status().tunnels).toBe(1);
    open.socket.close();
  });

  it("refuses an admission signed for another host or another hub", async () => {
    const { service, url } = await relay(32);
    const key = deviceKey();
    service.receiveDevices(HOST, { fingerprints: [key.fingerprint] });
    const otherHost = await connect(url, key, { target: "33333333-3333-4333-8333-333333333333" });
    expect(otherHost.closeCode).toBe(4401);
    const otherHub = await connect(url, key, { hub: "44444444-4444-4444-8444-444444444444" });
    expect(otherHub.closeCode).toBe(4401);
  });

  it("withdrawing a device's key ends its open relay", async () => {
    const { service, url } = await relay(32);
    const key = deviceKey();
    service.receiveDevices(HOST, { fingerprints: [key.fingerprint] });
    const open = await connect(url, key);
    expect(open.closeCode).toBeUndefined();
    const closed = new Promise<number>((resolve) =>
      open.socket.addEventListener("close", (event) => resolve(event.code)),
    );
    service.receiveDevices(HOST, { fingerprints: [] });
    expect(await closed).toBe(1001);
    expect(service.status().tunnels).toBe(0);
  });

  it("a host the roster no longer lists keeps no relay, open or new", async () => {
    let members: ReadonlyArray<string> = [HUB, HOST];
    const { service, url } = await relay(32, () => members);
    const key = deviceKey();
    service.receiveDevices(HOST, { fingerprints: [key.fingerprint] });
    const open = await connect(url, key);
    expect(open.closeCode).toBeUndefined();
    const closed = new Promise<number>((resolve) =>
      open.socket.addEventListener("close", (event) => resolve(event.code)),
    );
    members = [HUB];
    service.sweep();
    expect(await closed).toBe(1001);
    expect(service.status().hosts).toBe(0);
    expect((await connect(url, key)).closeCode).not.toBeUndefined();
  });

  it("a former hub that joined another hub keeps its own hosts' keys, and prunes by its own roster once its role is back", () => {
    let hubRole = true;
    let members: ReadonlyArray<string> = [HUB, HOST];
    const OTHER = "33333333-3333-4333-8333-333333333333";
    const service = new HubRelayService({
      state: memoryState(),
      serving: () => hubRole,
      members: () => members,
      hubMemberId: () => HUB,
      openTunnel: async () => undefined,
      record: () => undefined,
    });
    service.setEnabled(false, window);
    service.receiveDevices(HOST, { fingerprints: [deviceKey().fingerprint] });
    // Its role off and a member of another hub, whose roster does not list HOST.
    hubRole = false;
    members = [OTHER, HUB];
    service.sweep();
    expect(service.status().hosts).toBe(1);
    // Back as hub, with the relay switch still off, its own roster prunes again.
    hubRole = true;
    members = [HUB];
    service.sweep();
    expect(service.status().hosts).toBe(0);
  });

  it("closes every relay when its switch goes off", async () => {
    const { service, url } = await relay(32);
    const key = deviceKey();
    service.receiveDevices(HOST, { fingerprints: [key.fingerprint] });
    const open = await connect(url, key);
    const closed = new Promise<number>((resolve) =>
      open.socket.addEventListener("close", (event) => resolve(event.code)),
    );
    service.setEnabled(false, window);
    expect(await closed).toBe(1001);
    expect(service.status().tunnels).toBe(0);
    expect(service.handler()).toBeUndefined();
  });
});

describe("the relay address a hub hands its hosts", () => {
  /** A hub whose own roster entry has the tailnet name, with its relay and entrance as given. */
  function hubState(
    entrance: HubState["publicEntrance"],
    relayOn = true,
    listener: { readonly privateNames: string[]; readonly addresses: string[] } = {
      privateNames: ["mac-mini.tail1234.ts.net"],
      addresses: [],
    },
  ): HubState {
    return decodeHubState({
      hub: {
        enabled: true,
        members: [],
        joinTickets: [],
        roster: {
          roster: {
            sequence: 1,
            members: [
              {
                memberId: HUB,
                name: "Mac mini",
                role: "hub",
                identityKeyFingerprint: "f".repeat(64),
                listenerPin: "e".repeat(64),
                ...listener,
                owner: false,
              },
            ],
            standbyOrder: [],
            failoverAfterSeconds: 60,
          },
          signedBy: { kind: "hub", memberId: HUB },
          signature: "signature",
        },
      },
      relayHub: { enabled: relayOn, hosts: [] },
      ...(entrance === undefined ? {} : { publicEntrance: entrance }),
    });
  }

  it("names its Funnel front on its own tailnet name and port", () => {
    expect(hubRelayAddress(hubState({ enabled: true, funnel: { port: 443 } }), HUB)).toEqual({
      hubMemberId: HUB,
      relayUrl: "wss://mac-mini.tail1234.ts.net/relay/v1",
    });
    expect(
      hubRelayAddress(hubState({ enabled: true, funnel: { port: 10000 } }), HUB)?.relayUrl,
    ).toBe("wss://mac-mini.tail1234.ts.net:10000/relay/v1");
  });

  it("names its Funnel front when its private listener is bound to an IP address only", () => {
    const state = hubState({ enabled: true, funnel: { port: 8443 } }, true, {
      privateNames: [],
      addresses: ["100.101.104.1"],
    });
    expect(hubRelayAddress(state, HUB)).toBeUndefined();
    expect(hubRelayAddress(state, HUB, "mac-mini.tail1234.ts.net")?.relayUrl).toBe(
      "wss://mac-mini.tail1234.ts.net:8443/relay/v1",
    );
    expect(
      hubRelayAddress(
        hubState(
          { enabled: true, funnel: { port: 443 }, ownFrontOrigin: "https://octant.example.com" },
          true,
          { privateNames: [], addresses: ["100.101.104.1"] },
        ),
        HUB,
        "mac-mini.tail1234.ts.net",
      )?.relayUrl,
    ).toBe("wss://octant.example.com/relay/v1");
  });

  it("names the address the person typed for their own front over Funnel", () => {
    expect(
      hubRelayAddress(
        hubState({
          enabled: true,
          funnel: { port: 443 },
          ownFrontOrigin: "https://octant.example.com",
        }),
        HUB,
      )?.relayUrl,
    ).toBe("wss://octant.example.com/relay/v1");
  });

  it("names none while the relay or the entrance is off, or no public address is known", () => {
    expect(hubRelayAddress(hubState({ enabled: true, funnel: { port: 443 } }, false), HUB)).toBe(
      undefined,
    );
    expect(hubRelayAddress(hubState({ enabled: false, funnel: { port: 443 } }), HUB)).toBe(
      undefined,
    );
    expect(hubRelayAddress(hubState({ enabled: true }), HUB)).toBeUndefined();
    expect(hubRelayAddress(hubState(undefined), HUB)).toBeUndefined();
  });

  it("tells a host its relay address in the answer to the host's device list", () => {
    let state: HubState = {};
    const address = decodeRelayAddress({
      hubMemberId: HUB,
      relayUrl: "wss://octant.example.com/relay/v1",
    });
    const service = new HubRelayService({
      state: { load: () => state, save: (next) => void (state = next) },
      serving: () => true,
      hubMemberId: () => HUB,
      openTunnel: async () => undefined,
      record: () => undefined,
      address: () => address,
    });
    expect(service.receiveDevices(HOST, { fingerprints: [] })).toEqual({
      status: "recorded",
      count: 0,
      relay: address,
    });
  });
});
