import { decodeRelayAddress } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { ListenerTrustRefused, ListenerUnreachable } from "./remoteListenerTrust";
import { createRelayFallbackFetch, relayRouteFor } from "./pairedHostRelay";
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
    expect(
      relayRouteFor({
        choice: { enabled: true, address: { ...ADDRESS, relayUrl: "wss://evil/x" } },
        signer: { targetMemberId: HOST, admit },
      }),
    ).toBeUndefined();
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
