import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import {
  RELAY_FRAME_MAX_BYTES,
  RelayChallenge,
  RelayRouteId,
  type RelayFrameV1,
} from "@octant/contracts/hosted-relay";
import { describe, expect, it } from "vitest";
import {
  deriveRelayRouteId,
  encodeRelayFrame,
  readRelayFrame,
  relayRouteRegistrationMessage,
} from "./hostedRelayProtocol";

const sha256 = (message: Uint8Array) =>
  new Uint8Array(createHash("sha256").update(message).digest());

function ed25519RouteKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    privateKey,
    publicKey,
    subjectPublicKeyInfo: new Uint8Array(publicKey.export({ type: "spki", format: "der" })),
  };
}

function derivedRouteId(subjectPublicKeyInfo: Uint8Array) {
  const derivation = deriveRelayRouteId(subjectPublicKeyInfo, sha256);
  if (derivation.status !== "derived") throw new Error(`refused: ${derivation.reason}`);
  return derivation.routeId;
}

function framed(json: string): Uint8Array {
  const body = new TextEncoder().encode(json);
  const bytes = new Uint8Array(2 + body.byteLength);
  bytes[0] = (body.byteLength >> 8) & 0xff;
  bytes[1] = body.byteLength & 0xff;
  bytes.set(body, 2);
  return bytes;
}

describe("relay route ids", () => {
  it("derives the route id as the unpadded base64url SHA-256 of the label, a newline, and the key", () => {
    const { subjectPublicKeyInfo } = ed25519RouteKey();
    const expected = createHash("sha256")
      .update("octant.relay-route.v1\n")
      .update(subjectPublicKeyInfo)
      .digest("base64url");
    expect(derivedRouteId(subjectPublicKeyInfo)).toBe(expected);
  });

  it("gives the same key the same route id and different keys different route ids", () => {
    const first = ed25519RouteKey().subjectPublicKeyInfo;
    const second = ed25519RouteKey().subjectPublicKeyInfo;
    expect(derivedRouteId(first)).toBe(derivedRouteId(Uint8Array.from(first)));
    expect(derivedRouteId(first)).not.toBe(derivedRouteId(second));
  });

  it("refuses to derive a route id from a key that is not an Ed25519 public key", () => {
    const x25519 = new Uint8Array(
      generateKeyPairSync("x25519").publicKey.export({ type: "spki", format: "der" }),
    );
    const p256 = new Uint8Array(
      generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({
        type: "spki",
        format: "der",
      }),
    );
    const ed25519 = ed25519RouteKey().subjectPublicKeyInfo;
    for (const key of [x25519, p256, ed25519.slice(0, 43), new Uint8Array(0)]) {
      expect(deriveRelayRouteId(key, sha256)).toEqual({
        status: "refused",
        reason: "not-an-ed25519-key",
      });
    }
  });

  it("binds a registration signature to the challenge and the route it was made for", () => {
    const route = ed25519RouteKey();
    const routeId = derivedRouteId(route.subjectPublicKeyInfo);
    const otherRouteId = derivedRouteId(ed25519RouteKey().subjectPublicKeyInfo);
    const challenge = RelayChallenge.make("AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE");
    const otherChallenge = RelayChallenge.make("Zx9cV8bN7mL6kJ5hG4fD3sA2qW1eR0tY9uI8oP7aB6c");
    const message = relayRouteRegistrationMessage({ challenge, routeId });
    const signature = sign(null, message, route.privateKey);

    expect(verify(null, message, route.publicKey, signature)).toBe(true);
    expect(
      verify(
        null,
        relayRouteRegistrationMessage({ challenge: otherChallenge, routeId }),
        route.publicKey,
        signature,
      ),
    ).toBe(false);
    expect(
      verify(
        null,
        relayRouteRegistrationMessage({ challenge, routeId: otherRouteId }),
        route.publicKey,
        signature,
      ),
    ).toBe(false);
  });
});

describe("relay frames on the wire", () => {
  const routeOpen: RelayFrameV1 = {
    kind: "route-open",
    routeId: RelayRouteId.make("q3V0Yb6Hc8bE1pVmJx0T4d2Gf5aN9sK7wL1uR3yZ0cE"),
  };

  it("reads back the frame it wrote and reports how many bytes the frame used", () => {
    const bytes = encodeRelayFrame(routeOpen);
    const trailing = new Uint8Array([0x16, 0x03, 0x01]);
    const buffered = new Uint8Array(bytes.byteLength + trailing.byteLength);
    buffered.set(bytes);
    buffered.set(trailing, bytes.byteLength);

    expect(readRelayFrame(buffered)).toEqual({
      status: "read",
      frame: routeOpen,
      byteLength: bytes.byteLength,
    });
  });

  it("waits for the rest of a frame that has not fully arrived", () => {
    const bytes = encodeRelayFrame(routeOpen);
    expect(readRelayFrame(bytes.slice(0, 1))).toEqual({ status: "incomplete" });
    expect(readRelayFrame(bytes.slice(0, bytes.byteLength - 1))).toEqual({ status: "incomplete" });
  });

  it("refuses an oversized frame from its length prefix, before the body arrives", () => {
    const declared = RELAY_FRAME_MAX_BYTES + 1;
    expect(readRelayFrame(new Uint8Array([(declared >> 8) & 0xff, declared & 0xff]))).toEqual({
      status: "refused",
      reason: "oversized",
    });
    expect(readRelayFrame(new Uint8Array([0xff, 0xff]))).toEqual({
      status: "refused",
      reason: "oversized",
    });
  });

  it("refuses an empty frame, a frame that is not JSON, and text outside printable ASCII", () => {
    expect(readRelayFrame(new Uint8Array([0, 0]))).toEqual({
      status: "refused",
      reason: "malformed",
    });
    expect(readRelayFrame(framed("{not json"))).toEqual({ status: "refused", reason: "malformed" });
    expect(readRelayFrame(framed('{"kind":"splice-ready","note":"é"}'))).toEqual({
      status: "refused",
      reason: "malformed",
    });
    expect(readRelayFrame(framed('{\n"kind":"splice-ready"}'))).toEqual({
      status: "refused",
      reason: "malformed",
    });
  });

  it("refuses a well-formed frame carrying a field its kind does not define", () => {
    expect(
      readRelayFrame(
        framed(
          '{"kind":"route-open","routeId":"q3V0Yb6Hc8bE1pVmJx0T4d2Gf5aN9sK7wL1uR3yZ0cE","sni":"studio"}',
        ),
      ),
    ).toEqual({ status: "refused", reason: "malformed" });
  });

  it("accepts a frame of exactly the size limit and refuses one byte more", () => {
    const filler = (length: number) => `{"kind":"splice-ready"${" ".repeat(length - 23)}}`;
    expect(filler(RELAY_FRAME_MAX_BYTES)).toHaveLength(RELAY_FRAME_MAX_BYTES);
    expect(readRelayFrame(framed(filler(RELAY_FRAME_MAX_BYTES))).status).toBe("read");
    expect(readRelayFrame(framed(filler(RELAY_FRAME_MAX_BYTES + 1)))).toEqual({
      status: "refused",
      reason: "oversized",
    });
  });
});
