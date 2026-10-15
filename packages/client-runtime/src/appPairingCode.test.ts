import { buildPairingCode } from "@octant/domain";
import { describe, expect, it, vi } from "vitest";
import {
  NO_PINNED_TRANSPORT_COPY,
  openAppPairingCode,
  readAppPairingCode,
  type PinnedListenerTransportPort,
} from "./appPairingCode";
import { HOST_KEY, signTestHostHello } from "./remoteConnectionFixtures";
import { createInMemoryDeviceKeyStore } from "./remotePairingClient";
import { LISTENER_TRUST_REFUSAL_COPY, ListenerTrustRefused } from "./remoteListenerTrust";

const ORIGIN = "https://100.101.102.103:8443";
const HOST_ID = "11111111-1111-4111-8111-111111111111";
const TICKET = {
  ticketId: "3f6c1d2e-8a4b-4c5d-9e6f-7a8b9c0d1e2f",
  ticketProof: Buffer.alloc(32, 7).toString("base64url"),
};
const PIN = `sha256-${Buffer.alloc(32, 9).toString("base64url")}`;

function code(origin = ORIGIN): string {
  const built = buildPairingCode({ origin, ...TICKET, pin: PIN });
  if (built.status !== "built") throw new Error(built.reason);
  return built.code;
}

/** A host that answers hello, claim, and approval, as the listener would over the pinned connection. */
function hostFetch(seen: string[] = []): typeof globalThis.fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    seen.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname === "/api/remote/hello") {
      return Response.json(
        signTestHostHello(HOST_KEY, {
          productId: "octant",
          hostId: HOST_ID,
          displayName: "Studio Mac",
          serverBuildVersion: "0.1.0",
          supportedProtocolRange: { min: 1, max: 1 },
          authenticationProtocolVersions: [1],
          securityFloor: 1,
          remoteOrigin: ORIGIN,
          nonce: "host-nonce-1234567890",
          clientNonce: url.searchParams.get("clientNonce") ?? "",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      );
    }
    if (url.pathname === "/api/remote/pairing") {
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      return Response.json({
        kind: "pending",
        ticketId: body.ticketId,
        hostId: HOST_ID,
        deviceLabel: body.deviceLabel,
        deviceKeyFingerprint: body.deviceKeyFingerprint,
        origin: ORIGIN,
        sourceClass: "tailscale",
        comparisonCode: "123456",
        claimedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
    }
    return Response.json({
      status: "approved",
      deviceId: "00000000-0000-4000-8000-000000000002",
      credentialGeneration: 1,
    });
  });
}

describe("reading an app pairing code", () => {
  it("takes the origin, ticket, and pin from the code", () => {
    expect(readAppPairingCode(`  ${code()}\n`)).toEqual({
      status: "read",
      origin: ORIGIN,
      ticket: TICKET,
      listenerTrust: { kind: "pinned", pin: PIN },
    });
  });

  it("refuses a tampered code with the reason the person reads", () => {
    const valid = code();
    const tampered = `${valid.slice(0, -2)}${valid.endsWith("A") ? "B" : "A"}${valid.slice(-1)}`;
    expect(readAppPairingCode(tampered)).toMatchObject({ status: "refused", reason: "damaged" });
    expect(readAppPairingCode("https://100.101.102.103:8443/#ticketId=x")).toMatchObject({
      status: "refused",
      reason: "not-a-pairing-code",
    });
  });
});

describe("opening an app pairing code", () => {
  it("pairs through the pinned transport and records the pin with the approved device", async () => {
    const seen: string[] = [];
    const transport = vi.fn<PinnedListenerTransportPort>(() => ({
      status: "available",
      fetch: hostFetch(seen),
    }));
    const deviceKeyStore = createInMemoryDeviceKeyStore();

    const opened = await openAppPairingCode({
      code: code(),
      transport,
      webBuildVersion: "0.1.0",
      deviceKeyStore,
    });
    if (opened.status !== "opened") throw new Error(opened.message);
    const claimed = await opened.claim("Ada's phone");
    if (claimed.status !== "claimed") throw new Error(claimed.message);
    const status = await opened.client.pollPairingStatus({
      ticket: opened.ticket,
      claim: claimed.claim,
    });

    expect(transport).toHaveBeenCalledWith({
      origin: ORIGIN,
      trust: { current: { kind: "pinned", pin: PIN } },
    });
    expect(seen).toEqual([
      "GET /api/remote/hello",
      "POST /api/remote/pairing",
      "POST /api/remote/pairing/status",
    ]);
    expect(status).toMatchObject({
      kind: "approved",
      approval: { origin: ORIGIN, listenerTrust: { current: { kind: "pinned", pin: PIN } } },
    });
    await expect(deviceKeyStore.findByOrigin(ORIGIN)).resolves.toMatchObject({
      listenerTrust: { current: { kind: "pinned", pin: PIN } },
    });
  });

  it("asks no transport for a code it cannot read", async () => {
    const transport = vi.fn<PinnedListenerTransportPort>();

    const opened = await openAppPairingCode({
      code: `${code()}x`,
      transport,
      webBuildVersion: "0.1.0",
    });

    expect(opened).toMatchObject({ status: "refused", reason: "damaged" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("stops when the client has no pinned transport rather than using its own fetch", async () => {
    const platformFetch = vi.spyOn(globalThis, "fetch");

    const opened = await openAppPairingCode({
      code: code(),
      transport: () => ({ status: "unavailable" }),
      webBuildVersion: "0.1.0",
    });

    expect(opened).toEqual({
      status: "refused",
      reason: "no-pinned-transport",
      message: NO_PINNED_TRANSPORT_COPY,
    });
    expect(platformFetch).not.toHaveBeenCalled();
    platformFetch.mockRestore();
  });

  it("says the computer's key changed when the listener serves another key", async () => {
    const opened = await openAppPairingCode({
      code: code(),
      transport: () => ({
        status: "available",
        fetch: async () => {
          throw new ListenerTrustRefused("pin-mismatch");
        },
      }),
      webBuildVersion: "0.1.0",
    });

    expect(opened).toEqual({
      status: "refused",
      reason: "pin-mismatch",
      message: LISTENER_TRUST_REFUSAL_COPY["pin-mismatch"],
    });
  });

  it("refuses a hello that does not answer this client's nonce", async () => {
    const answering = hostFetch();
    const opened = await openAppPairingCode({
      code: code(),
      transport: () => ({
        status: "available",
        fetch: async (input, init) => {
          const url = new URL(typeof input === "string" ? input : input.toString());
          // A recorded hello answers another request's nonce.
          url.searchParams.set("clientNonce", Buffer.alloc(32, 1).toString("base64url"));
          return answering(url, init);
        },
      }),
      webBuildVersion: "0.1.0",
    });

    expect(opened).toMatchObject({ status: "failed" });
  });
});
