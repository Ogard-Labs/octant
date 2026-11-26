import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { relayAdmissionPayload } from "@octant/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { HubState, HubStatePort } from "./hubStateStore";
import { HubRelayService, type RelayTunnelEnd } from "./hubRelayService";
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
