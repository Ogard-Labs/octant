import { decodeRelayAddress } from "@octant/contracts";
import type { StableHostId } from "@octant/contracts/remote-access";
import { describe, expect, it, vi } from "vitest";
import { ListenerTrustRefused, ListenerUnreachable } from "./remoteListenerTrust";
import {
  createRelayAdmissionSigner,
  createRelayFallbackFetch,
  relayRouteFor,
} from "./pairedHostRelay";
import { parseRelayAdmissionPayload } from "./relayTunnel";

const ORIGIN = "https://laptop.tail1234.ts.net:8443";
const HOST = "22222222-2222-4222-8222-222222222222";
const HUB = "11111111-1111-4111-8111-111111111111";
const ADDRESS = decodeRelayAddress({
  hubMemberId: HUB,
  relayUrl: "wss://hub.example.com/relay/v1",
});
const CHALLENGE = "A".repeat(43);

function fetchOf(answer: () => Promise<Response>) {
  return vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(answer);
}

describe("reaching a paired host through the hub", () => {
  it("never relays while the device's choice is off, even with an address and no direct path", async () => {
    const direct = fetchOf(() => Promise.reject(new ListenerUnreachable()));
    const relayed = fetchOf(() => Promise.resolve(new Response("relayed")));
    const fetch = createRelayFallbackFetch({
      direct,
      relayed: () =>
        relayRouteFor({ choice: { enabled: false, address: ADDRESS } }) === undefined
          ? undefined
          : relayed,
    });
    await expect(fetch(`${ORIGIN}/api/remote/hello`)).rejects.toBeInstanceOf(ListenerUnreachable);
    expect(relayed).not.toHaveBeenCalled();
  });

  it("relays only once the direct connection failed before sending anything", async () => {
    const direct = fetchOf(() => Promise.reject(new ListenerUnreachable()));
    const relayed = fetchOf(() => Promise.resolve(new Response("relayed")));
    const fetch = createRelayFallbackFetch({ direct, relayed: () => relayed });
    expect(await (await fetch(`${ORIGIN}/api/remote/hello`)).text()).toBe("relayed");
    expect(direct).toHaveBeenCalledTimes(1);
  });

  it("uses the direct path while it answers", async () => {
    const direct = fetchOf(() => Promise.resolve(new Response("direct")));
    const relayed = fetchOf(() => Promise.resolve(new Response("relayed")));
    const fetch = createRelayFallbackFetch({ direct, relayed: () => relayed });
    expect(await (await fetch(`${ORIGIN}/api/remote/hello`)).text()).toBe("direct");
    expect(relayed).not.toHaveBeenCalled();
  });

  it("never relays after a refusal of the host's key or a failure once the request was sent", async () => {
    const relayed = fetchOf(() => Promise.resolve(new Response("relayed")));
    for (const failure of [
      new ListenerTrustRefused("pin-mismatch"),
      new TypeError("The listener connection failed."),
    ]) {
      const direct = fetchOf(() => Promise.reject(failure));
      const fetch = createRelayFallbackFetch({ direct, relayed: () => relayed });
      await expect(fetch(`${ORIGIN}/api/work/turns`, { method: "POST" })).rejects.toBe(failure);
    }
    expect(relayed).not.toHaveBeenCalled();
  });

  it("goes straight to the relay for a while after the direct path failed, then tries it again", async () => {
    let now = 1_000;
    const direct = fetchOf(() => Promise.reject(new ListenerUnreachable()));
    const relayed = fetchOf(() => Promise.resolve(new Response("relayed")));
    const fetch = createRelayFallbackFetch({ direct, relayed: () => relayed, now: () => now });
    await fetch(`${ORIGIN}/api/remote/hello`);
    now += 10_000;
    await fetch(`${ORIGIN}/api/remote/hello`);
    expect(direct).toHaveBeenCalledTimes(1);
    now += 60_000;
    await fetch(`${ORIGIN}/api/remote/hello`);
    expect(direct).toHaveBeenCalledTimes(2);
  });

  it("tries home again after a preferred relay failed, without sending that request twice", async () => {
    const direct = fetchOf(() => Promise.reject(new ListenerUnreachable()));
    const relayed = fetchOf(() => Promise.resolve(new Response("relayed")));
    const fetch = createRelayFallbackFetch({ direct, relayed: () => relayed });
    await fetch(`${ORIGIN}/api/remote/hello`);
    const lost = new TypeError("The listener could not be reached.");
    relayed.mockImplementationOnce(() => Promise.reject(lost));
    await expect(fetch(`${ORIGIN}/api/work/turns`, { method: "POST" })).rejects.toBe(lost);
    expect(direct).toHaveBeenCalledTimes(1);
    await fetch(`${ORIGIN}/api/remote/hello`);
    expect(direct).toHaveBeenCalledTimes(2);
  });

  it("names no route without a stored address, and holds the route to the hub the host named", () => {
    const admit = async () => ({ signature: "signature", deviceSpki: "spki" });
    expect(relayRouteFor({ choice: { enabled: true } })).toBeUndefined();
    expect(
      relayRouteFor({
        choice: { enabled: true, address: ADDRESS },
        signer: { targetMemberId: HOST, admit },
      }),
    ).toEqual({
      url: ADDRESS.relayUrl,
      targetMemberId: HOST,
      hubMemberId: HUB,
      admit,
    });
    for (const relayUrl of ["wss://evil/x", "ws://127.0.0.1:8443/relay/v1"]) {
      expect(
        relayRouteFor({
          choice: { enabled: true, address: { ...ADDRESS, relayUrl } },
          signer: { targetMemberId: HOST, admit },
        }),
      ).toBeUndefined();
    }
  });
});

describe("the text a device key signs for the relay", () => {
  it("reads only the exact relay admission text", () => {
    expect(parseRelayAdmissionPayload(`octant/relay/v1|${CHALLENGE}|${HOST}|${HUB}`)).toEqual({
      challenge: CHALLENGE,
      targetMemberId: HOST,
      hubMemberId: HUB,
    });
    for (const refused of [
      `octant/relay/v1|${CHALLENGE}|${HOST}|${HUB}|`,
      `octant/relay/v1|${CHALLENGE}|${HOST}|${HUB}\n`,
      ` octant/relay/v1|${CHALLENGE}|${HOST}|${HUB}`,
      `octant/relay/v2|${CHALLENGE}|${HOST}|${HUB}`,
      `octant/relay/v1|${CHALLENGE.slice(1)}|${HOST}|${HUB}`,
      `octant/relay/v1|${CHALLENGE}|not-a-host|${HUB}`,
      "POST\n/api/remote/auth/session\n…",
      `octant/remote/request/v1|${CHALLENGE}|${HOST}|${HUB}`,
      42,
      undefined,
    ]) {
      expect(parseRelayAdmissionPayload(refused), String(refused)).toBeUndefined();
    }
  });
});

describe("the device key's signer for the relay", () => {
  async function signerFor(hostId: string) {
    const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
      "sign",
      "verify",
    ]);
    const signer = createRelayAdmissionSigner({
      findByOrigin: async (origin) =>
        origin === ORIGIN
          ? {
              keyId: "key",
              origin,
              hostId: hostId as StableHostId,
              deviceId: "device",
              credentialGeneration: 1,
              hostKeyFingerprint: "f".repeat(64),
              listenerTrust: { current: { kind: "pinned", pin: "sha256-pin" } },
            }
          : undefined,
      get: async (keyId) => (keyId === "key" ? keyPair : undefined),
    });
    return { signer, keyPair };
  }

  it("signs the exact admission text for the host the origin is paired with", async () => {
    const { signer, keyPair } = await signerFor(HOST);
    const payload = `octant/relay/v1|${CHALLENGE}|${HOST}|${HUB}`;
    const answer = await signer({ origin: ORIGIN, payload });
    if (answer === undefined) throw new Error("Nothing was signed.");
    const signature = Uint8Array.from(
      atob(answer.signature.replaceAll("-", "+").replaceAll("_", "/")),
      (character) => character.charCodeAt(0),
    );
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        keyPair.publicKey,
        signature,
        new TextEncoder().encode(payload),
      ),
    ).toBe(true);
    expect(answer.deviceSpki).toMatch(/^[A-Za-z0-9_-]{80,}$/);
  });

  it("refuses any other text, another host, or an origin it holds no key for", async () => {
    const { signer } = await signerFor(HOST);
    for (const request of [
      { origin: ORIGIN, payload: "POST\n/api/remote/auth/session\n{}" },
      { origin: ORIGIN, payload: `octant/relay/v1|${CHALLENGE}|${HOST}|${HUB}|extra` },
      { origin: ORIGIN, payload: `octant/relay/v1|${CHALLENGE}|${HUB}|${HUB}` },
      {
        origin: "https://other.tail1234.ts.net:8443",
        payload: `octant/relay/v1|${CHALLENGE}|${HOST}|${HUB}`,
      },
      {
        origin: ORIGIN,
        payload: { toString: () => `octant/relay/v1|${CHALLENGE}|${HOST}|${HUB}` },
      },
    ]) {
      expect(await signer(request), JSON.stringify(request.payload)).toBeUndefined();
    }
  });
});
