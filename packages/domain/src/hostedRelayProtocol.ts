import {
  decodeRelayFrameV1,
  RELAY_FRAME_LENGTH_PREFIX_BYTES,
  RELAY_FRAME_MAX_BYTES,
  RelayFrameV1,
  RelayRouteId,
  type RelayChallenge,
} from "@octant/contracts/hosted-relay";
import { Either, Schema } from "effect";

/**
 * The hosted relay's route id derivation, registration message, and frame
 * reading and writing. Canonical: docs/design/hosted-relay.md § Routes,
 * grants, and pairing, and § Wire contract.
 *
 * The host, the relay, and tests share these so a route id or a frame has one
 * spelling. Hashing is injected rather than imported to keep this pure; the
 * host and the relay pass their platform's SHA-256.
 */

/** Domain separation for route ids: the hash input is this label, a newline, then the key. */
export const RELAY_ROUTE_ID_LABEL = "octant.relay-route.v1";

/** Domain separation for the message a host signs to register a route. */
export const RELAY_ROUTE_REGISTRATION_LABEL = "octant.relay-route-registration.v1";

// DER of SEQUENCE { SEQUENCE { OID 1.3.101.112 (Ed25519) }, BIT STRING (33 bytes, 0 unused) }.
const ED25519_SPKI_PREFIX = Uint8Array.of(
  0x30,
  0x2a,
  0x30,
  0x05,
  0x06,
  0x03,
  0x2b,
  0x65,
  0x70,
  0x03,
  0x21,
  0x00,
);
const ED25519_SPKI_BYTES = ED25519_SPKI_PREFIX.byteLength + 32;
const SHA256_BYTES = 32;

export type RelayRouteIdDerivation =
  | { readonly status: "derived"; readonly routeId: RelayRouteId }
  | { readonly status: "refused"; readonly reason: "not-an-ed25519-key" };

/**
 * Derives a route id from the route key's SubjectPublicKeyInfo (DER): the
 * unpadded base64url SHA-256 of `octant.relay-route.v1`, a newline, and the
 * key. A key in any other algorithm is refused, so a route never rests on a
 * key the relay cannot verify a registration signature with.
 */
export function deriveRelayRouteId(
  subjectPublicKeyInfo: Uint8Array,
  sha256: (message: Uint8Array) => Uint8Array,
): RelayRouteIdDerivation {
  if (!isEd25519SubjectPublicKeyInfo(subjectPublicKeyInfo)) {
    return { status: "refused", reason: "not-an-ed25519-key" };
  }
  const label = asciiBytes(`${RELAY_ROUTE_ID_LABEL}\n`);
  const message = new Uint8Array(label.byteLength + subjectPublicKeyInfo.byteLength);
  message.set(label);
  message.set(subjectPublicKeyInfo, label.byteLength);
  const digest = sha256(message);
  if (digest.byteLength !== SHA256_BYTES) {
    throw new RangeError(`A SHA-256 digest is ${SHA256_BYTES} bytes, not ${digest.byteLength}.`);
  }
  return { status: "derived", routeId: Schema.decodeSync(RelayRouteId)(base64Url(digest)) };
}

/**
 * The bytes a host signs with a route key to register that route:
 * `octant.relay-route-registration.v1`, the relay's challenge, and the route
 * id, each on its own line. Binding both means a signature answers exactly one
 * challenge for exactly one route.
 */
export function relayRouteRegistrationMessage(input: {
  readonly challenge: RelayChallenge;
  readonly routeId: RelayRouteId;
}): Uint8Array {
  return asciiBytes(`${RELAY_ROUTE_REGISTRATION_LABEL}\n${input.challenge}\n${input.routeId}`);
}

export type RelayFrameReading =
  | { readonly status: "incomplete" }
  | {
      readonly status: "read";
      readonly frame: RelayFrameV1;
      /** Prefix and body; the bytes after them belong to the next frame or the splice. */
      readonly byteLength: number;
    }
  | { readonly status: "refused"; readonly reason: "oversized" | "malformed" };

/**
 * Reads the first frame from bytes received so far. A body longer than
 * {@link RELAY_FRAME_MAX_BYTES} is refused from the length prefix alone, so a
 * reader never buffers more than one frame's worth. The body must be printable
 * ASCII JSON whose fields are exactly those its kind defines; every field a
 * frame carries is ASCII, so anything else is not a frame.
 */
export function readRelayFrame(buffered: Uint8Array): RelayFrameReading {
  if (buffered.byteLength < RELAY_FRAME_LENGTH_PREFIX_BYTES) return { status: "incomplete" };
  const bodyLength = ((buffered[0] ?? 0) << 8) | (buffered[1] ?? 0);
  if (bodyLength > RELAY_FRAME_MAX_BYTES) return { status: "refused", reason: "oversized" };
  if (bodyLength === 0) return { status: "refused", reason: "malformed" };
  const byteLength = RELAY_FRAME_LENGTH_PREFIX_BYTES + bodyLength;
  if (buffered.byteLength < byteLength) return { status: "incomplete" };
  let text = "";
  for (let index = RELAY_FRAME_LENGTH_PREFIX_BYTES; index < byteLength; index += 1) {
    const byte = buffered[index] ?? 0;
    if (byte < 0x20 || byte > 0x7e) return { status: "refused", reason: "malformed" };
    text += String.fromCharCode(byte);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { status: "refused", reason: "malformed" };
  }
  const decoded = decodeRelayFrameV1(value);
  if (Either.isLeft(decoded)) return { status: "refused", reason: "malformed" };
  return { status: "read", frame: decoded.right, byteLength };
}

/** Writes one frame: its length prefix, then its compact JSON body. */
export function encodeRelayFrame(frame: RelayFrameV1): Uint8Array {
  const body = JSON.stringify(Schema.encodeSync(RelayFrameV1)(frame));
  // Every field is bounded far below the limit, so only a broken schema reaches this.
  if (body.length > RELAY_FRAME_MAX_BYTES) {
    throw new RangeError(`A relay frame body is at most ${RELAY_FRAME_MAX_BYTES} bytes.`);
  }
  const bytes = new Uint8Array(RELAY_FRAME_LENGTH_PREFIX_BYTES + body.length);
  bytes[0] = (body.length >> 8) & 0xff;
  bytes[1] = body.length & 0xff;
  bytes.set(asciiBytes(body), RELAY_FRAME_LENGTH_PREFIX_BYTES);
  return bytes;
}

function isEd25519SubjectPublicKeyInfo(key: Uint8Array): boolean {
  return (
    key.byteLength === ED25519_SPKI_BYTES &&
    ED25519_SPKI_PREFIX.every((byte, index) => key[index] === byte)
  );
}

/** Every caller passes validated ASCII, so a character code is a byte. */
function asciiBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index);
  return bytes;
}

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function base64Url(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < bytes.byteLength; index += 3) {
    const a = bytes[index] ?? 0;
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    const bits = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out +=
      BASE64URL_ALPHABET.charAt((bits >> 18) & 63) + BASE64URL_ALPHABET.charAt((bits >> 12) & 63);
    if (b !== undefined) out += BASE64URL_ALPHABET.charAt((bits >> 6) & 63);
    if (c !== undefined) out += BASE64URL_ALPHABET.charAt(bits & 63);
  }
  return out;
}
