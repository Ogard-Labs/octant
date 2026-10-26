import { Either } from "effect";
import { describe, expect, it } from "vitest";
import { decodeRelayFrameV1, decodeRelayGrantV1 } from "./hostedRelay";

const routeId = "q3V0Yb6Hc8bE1pVmJx0T4d2Gf5aN9sK7wL1uR3yZ0cE";
const streamId = "Zx9cV8bN7mL6kJ5hG4fD3sA2qW1eR0tY9uI8oP7aB6c";
const challenge = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE";
// An Ed25519 SubjectPublicKeyInfo: the fixed 12-byte prefix, then 32 key bytes.
const routeKey = "MCowBQYDK2VwAyEA" + "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";
const signature = `${"A".repeat(85)}g`;

function decodes(decode: (value: unknown) => Either.Either<unknown, unknown>, value: unknown) {
  return Either.isRight(decode(value));
}

describe("hosted relay frame contract", () => {
  it("decodes every frame the relay protocol exchanges before a splice", () => {
    const frames: ReadonlyArray<unknown> = [
      { kind: "control-open" },
      { kind: "control-ready" },
      { kind: "route-challenge-request" },
      { kind: "route-challenge", challenge },
      { kind: "route-register", routeId, routeKey, challenge, signature },
      { kind: "route-registered", routeId },
      { kind: "route-unregister", routeId },
      { kind: "route-unregistered", routeId },
      { kind: "stream-offer", routeId, streamId },
      { kind: "stream-accept", streamId },
      { kind: "route-open", routeId },
      { kind: "splice-ready" },
      { kind: "refused", reason: "route-unavailable" },
      { kind: "refused", reason: "proof-refused", routeId },
    ];
    for (const frame of frames) {
      expect(decodes(decodeRelayFrameV1, frame), JSON.stringify(frame)).toBe(true);
    }
  });

  it("refuses a frame carrying a field its kind does not define", () => {
    expect(decodes(decodeRelayFrameV1, { kind: "route-open", routeId, hostName: "studio" })).toBe(
      false,
    );
    expect(decodes(decodeRelayFrameV1, { kind: "splice-ready", sni: "studio.ts.net" })).toBe(false);
    expect(
      decodes(decodeRelayFrameV1, { kind: "stream-accept", streamId, deviceId: "phone" }),
    ).toBe(false);
  });

  it("refuses an unknown frame kind and a refusal reason the protocol does not name", () => {
    expect(decodes(decodeRelayFrameV1, { kind: "route-list" })).toBe(false);
    expect(decodes(decodeRelayFrameV1, { kind: "refused", reason: "maintenance" })).toBe(false);
  });

  it("refuses route ids, stream ids, and challenges that are not exactly 32 bytes", () => {
    expect(decodes(decodeRelayFrameV1, { kind: "route-open", routeId: routeId.slice(1) })).toBe(
      false,
    );
    expect(decodes(decodeRelayFrameV1, { kind: "route-open", routeId: `${routeId}A` })).toBe(false);
    // The last character of a 32-byte value carries two unused bits that must be zero.
    expect(
      decodes(decodeRelayFrameV1, { kind: "stream-accept", streamId: `${streamId.slice(0, 42)}d` }),
    ).toBe(false);
    expect(
      decodes(decodeRelayFrameV1, { kind: "route-challenge", challenge: `${challenge}==` }),
    ).toBe(false);
  });

  it("refuses a route registration whose key is not an Ed25519 public key", () => {
    // An X25519 SubjectPublicKeyInfo differs from Ed25519 only in the algorithm identifier.
    const x25519Key = "MCowBQYDK2VuAyEA" + routeKey.slice(16);
    expect(
      decodes(decodeRelayFrameV1, {
        kind: "route-register",
        routeId,
        routeKey: x25519Key,
        challenge,
        signature,
      }),
    ).toBe(false);
    expect(
      decodes(decodeRelayFrameV1, {
        kind: "route-register",
        routeId,
        routeKey,
        challenge,
        signature: signature.slice(1),
      }),
    ).toBe(false);
  });
});

describe("hosted relay grant contract", () => {
  it("decodes a grant naming the relay origin, an optional relay pin, and the route", () => {
    expect(decodes(decodeRelayGrantV1, { relayOrigin: "https://relay.example.org", routeId })).toBe(
      true,
    );
    expect(
      decodes(decodeRelayGrantV1, {
        relayOrigin: "https://relay.example.org:8443",
        relayPin: `sha256-${routeId}`,
        routeId,
      }),
    ).toBe(true);
    for (const relayOrigin of [
      "https://127.0.0.1:8443",
      "https://[::1]:8443",
      "https://[::]",
      "https://[2001:db8::1:0:0:1]",
      "https://[1:0:0:2::3]",
      "https://[1:2:3:4:5:6:7:8]",
      "https://0x7f.relay.example",
    ]) {
      expect(decodes(decodeRelayGrantV1, { relayOrigin, routeId }), relayOrigin).toBe(true);
    }
  });

  it("refuses a grant that carries a key or any field beyond where to knock", () => {
    expect(
      decodes(decodeRelayGrantV1, {
        relayOrigin: "https://relay.example.org",
        routeId,
        routeKey,
      }),
    ).toBe(false);
  });

  it("refuses a relay origin that is not one canonical HTTPS origin", () => {
    for (const relayOrigin of [
      "http://relay.example.org",
      "https://relay.example.org/",
      "https://relay.example.org/path",
      "https://relay.example.org:443",
      "https://user@relay.example.org",
      "https://Relay.Example.org",
      "https://relay.example.org:0",
      "https://relay.example.org:65536",
      // A URL parser rewrites each of these to another spelling of the same address.
      "https://127.1",
      "https://0x7f.0.0.1",
      "https://2130706433",
      "https://010.0.0.1",
      "https://[0:0::1]",
      "https://[::ffff:1.2.3.4]",
      "https://[1:0:0:0:0:0:0:1]",
      "https://[0001::1]",
      "https://[1:0::2:0:0:0:3]",
      "https://[1]",
    ]) {
      expect(decodes(decodeRelayGrantV1, { relayOrigin, routeId }), relayOrigin).toBe(false);
    }
  });

  it("refuses a relay pin in any form other than a SHA-256 pin", () => {
    for (const relayPin of [`sha512-${routeId}`, routeId, `sha256-${routeId.slice(1)}`]) {
      expect(
        decodes(decodeRelayGrantV1, {
          relayOrigin: "https://relay.example.org",
          relayPin,
          routeId,
        }),
        relayPin,
      ).toBe(false);
    }
  });
});
