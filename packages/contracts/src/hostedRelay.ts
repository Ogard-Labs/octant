import { Schema } from "effect";

/**
 * Wire contract of the hosted relay: the frames a host connector, a paired
 * device, and a relay exchange before a splice, and the grant a host gives a
 * device. Canonical: docs/design/hosted-relay.md.
 *
 * The relay is a blind pipe. Nothing here names a host, a device, a listener
 * address, or key material the host or device trusts; a route key is a public
 * key whose only use is proving to the relay who may register its route.
 */

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/** The ALPN of the outer TLS hop to a relay; it versions the frame protocol. */
export const RELAY_ALPN_PROTOCOL = "octant-relay-1";

/**
 * The largest frame body, in bytes, excluding its length prefix. Every frame
 * is far smaller; the bound lets a relay refuse a frame from its prefix alone.
 */
export const RELAY_FRAME_MAX_BYTES = 4_096;

/** Each frame is preceded by its body length as a big-endian unsigned integer of this many bytes. */
export const RELAY_FRAME_LENGTH_PREFIX_BYTES = 2;

// 32 bytes as unpadded base64url: 43 characters whose last one carries no spare bits.
const base64Url32Bytes = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/),
);

/** Unpadded base64url SHA-256 of a route key, derived as the design states. */
export const RelayRouteId = base64Url32Bytes.pipe(Schema.brand("RelayRouteId"));
export type RelayRouteId = typeof RelayRouteId.Type;

/** 256 random bits the relay names on the control connection; single use. */
export const RelayStreamId = base64Url32Bytes.pipe(Schema.brand("RelayStreamId"));
export type RelayStreamId = typeof RelayStreamId.Type;

/** 256 random bits the relay issues for one route registration; single use. */
export const RelayChallenge = base64Url32Bytes.pipe(Schema.brand("RelayChallenge"));
export type RelayChallenge = typeof RelayChallenge.Type;

/**
 * An Ed25519 SubjectPublicKeyInfo as unpadded base64url: the fixed 12-byte
 * algorithm prefix (`MCowBQYDK2VwAyEA`), then the 32-byte key. Any other
 * algorithm is refused rather than negotiated.
 */
export const RelayRouteKey = Schema.String.pipe(
  Schema.pattern(/^MCowBQYDK2VwAyEA[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/),
  Schema.brand("RelayRouteKey"),
);
export type RelayRouteKey = typeof RelayRouteKey.Type;

/** A 64-byte Ed25519 signature as unpadded base64url. */
export const RelayRouteSignature = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z0-9_-]{85}[AQgw]$/),
  Schema.brand("RelayRouteSignature"),
);
export type RelayRouteSignature = typeof RelayRouteSignature.Type;

/**
 * Why a relay refused a frame. An unknown route and a route whose host is not
 * connected share `route-unavailable`, so a refusal never tells a prober which
 * route ids exist.
 */
export const RelayRefusalReason = Schema.Literal(
  "route-unavailable",
  "stream-unavailable",
  "challenge-unavailable",
  "proof-refused",
  "route-limit",
  "rate-limited",
  "frame-refused",
);
export type RelayRefusalReason = typeof RelayRefusalReason.Type;

// ── Host connector to relay ──

/** First frame of the host's one control connection. */
export const RelayControlOpenFrame = Schema.Struct({
  kind: Schema.Literal("control-open"),
}).annotations(strict);

/** The host asks for a fresh challenge before registering one route. */
export const RelayRouteChallengeRequestFrame = Schema.Struct({
  kind: Schema.Literal("route-challenge-request"),
}).annotations(strict);

/**
 * The host registers a route: the route key must derive the route id, and the
 * signature must verify over the registration message for this challenge and
 * route, so knowing a route id is not enough to claim it.
 */
export const RelayRouteRegisterFrame = Schema.Struct({
  kind: Schema.Literal("route-register"),
  routeId: RelayRouteId,
  routeKey: RelayRouteKey,
  challenge: RelayChallenge,
  signature: RelayRouteSignature,
}).annotations(strict);

/** The host withdraws a route; its splices end. */
export const RelayRouteUnregisterFrame = Schema.Struct({
  kind: Schema.Literal("route-unregister"),
  routeId: RelayRouteId,
}).annotations(strict);

/** First frame of a new host connection that answers a stream offer. */
export const RelayStreamAcceptFrame = Schema.Struct({
  kind: Schema.Literal("stream-accept"),
  streamId: RelayStreamId,
}).annotations(strict);

// ── Device to relay ──

/** First frame of a device's connection: the route its grant names. */
export const RelayRouteOpenFrame = Schema.Struct({
  kind: Schema.Literal("route-open"),
  routeId: RelayRouteId,
}).annotations(strict);

// ── Relay to host connector or device ──

export const RelayControlReadyFrame = Schema.Struct({
  kind: Schema.Literal("control-ready"),
}).annotations(strict);

export const RelayRouteChallengeFrame = Schema.Struct({
  kind: Schema.Literal("route-challenge"),
  challenge: RelayChallenge,
}).annotations(strict);

export const RelayRouteRegisteredFrame = Schema.Struct({
  kind: Schema.Literal("route-registered"),
  routeId: RelayRouteId,
}).annotations(strict);

export const RelayRouteUnregisteredFrame = Schema.Struct({
  kind: Schema.Literal("route-unregistered"),
  routeId: RelayRouteId,
}).annotations(strict);

/** On the control connection: a device knocked on this route; open a stream with this id. */
export const RelayStreamOfferFrame = Schema.Struct({
  kind: Schema.Literal("stream-offer"),
  routeId: RelayRouteId,
  streamId: RelayStreamId,
}).annotations(strict);

/**
 * Last frame on a device or host stream connection: every byte after it is
 * the spliced inner TLS session, which no frame decoder reads.
 */
export const RelaySpliceReadyFrame = Schema.Struct({
  kind: Schema.Literal("splice-ready"),
}).annotations(strict);

/** The relay refused the preceding frame; on a device or stream connection it then closes. */
export const RelayRefusedFrame = Schema.Struct({
  kind: Schema.Literal("refused"),
  reason: RelayRefusalReason,
  /** Only on the control connection, naming the route a registration refusal is about. */
  routeId: Schema.optional(RelayRouteId),
}).annotations(strict);

/** Every frame a host connector may send, on its control or a stream connection. */
export const RelayFrameFromHostV1 = Schema.Union(
  RelayControlOpenFrame,
  RelayRouteChallengeRequestFrame,
  RelayRouteRegisterFrame,
  RelayRouteUnregisterFrame,
  RelayStreamAcceptFrame,
);
export type RelayFrameFromHostV1 = typeof RelayFrameFromHostV1.Type;

/** Every frame a device may send. */
export const RelayFrameFromDeviceV1 = RelayRouteOpenFrame;
export type RelayFrameFromDeviceV1 = typeof RelayFrameFromDeviceV1.Type;

/** Every frame a relay may send. */
export const RelayFrameFromRelayV1 = Schema.Union(
  RelayControlReadyFrame,
  RelayRouteChallengeFrame,
  RelayRouteRegisteredFrame,
  RelayRouteUnregisteredFrame,
  RelayStreamOfferFrame,
  RelaySpliceReadyFrame,
  RelayRefusedFrame,
);
export type RelayFrameFromRelayV1 = typeof RelayFrameFromRelayV1.Type;

/** Every relay protocol frame, in either direction. */
export const RelayFrameV1 = Schema.Union(
  RelayFrameFromHostV1,
  RelayFrameFromDeviceV1,
  RelayFrameFromRelayV1,
);
export type RelayFrameV1 = typeof RelayFrameV1.Type;

/**
 * A canonical HTTPS origin: lowercase name, dotted-decimal IPv4 address, or
 * bracketed IPv6 address in its shortest form, an optional non-default port
 * without a leading zero, and nothing else. Judged by pattern rather than
 * `URL`, because the phone's JavaScript engine ships a `URL` that does not
 * canonicalize.
 */
const RELAY_ORIGIN_SHAPE =
  /^https:\/\/(?:\[([0-9a-f:]+)\]|([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?))(?::([1-9][0-9]{0,4}))?$/;
const RelayOrigin = Schema.String.pipe(
  Schema.maxLength(300),
  Schema.filter((value) => {
    const shape = RELAY_ORIGIN_SHAPE.exec(value);
    if (shape === null) return false;
    const [, ipv6, name, port] = shape;
    if (ipv6 !== undefined && !isShortestIpv6(ipv6)) return false;
    if (name !== undefined && !isCanonicalName(name)) return false;
    return port === undefined || (Number(port) <= 65_535 && port !== "443");
  }),
);

const IPV4_OCTET = "(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])";
const DOTTED_DECIMAL_IPV4 = new RegExp(`^${IPV4_OCTET}(?:\\.${IPV4_OCTET}){3}$`);

/**
 * A URL parser reads a name whose last label is a number as an IPv4 address
 * and rewrites it (`127.1` and `0x7f.0.0.1` both become `127.0.0.1`), so such
 * a name is canonical only as four decimal octets.
 */
function isCanonicalName(name: string): boolean {
  const lastLabel = name.slice(name.lastIndexOf(".") + 1);
  const endsInNumber = /^(?:[0-9]+|0x[0-9a-f]*)$/.test(lastLabel);
  return !endsInNumber || DOTTED_DECIMAL_IPV4.test(name);
}

/**
 * Whether an IPv6 address is written as a URL serializer writes it: eight
 * groups without leading zeros, the first longest run of two or more zero
 * groups compressed to `::`, and no dotted IPv4 tail.
 */
function isShortestIpv6(address: string): boolean {
  const halves = address.split("::");
  if (halves.length > 2) return false;
  const groupsOf = (part: string | undefined) =>
    part === undefined || part === "" ? [] : part.split(":");
  const head = groupsOf(halves[0]);
  const tail = groupsOf(halves[1]);
  const written = [...head, ...tail];
  if (!written.every((group) => /^(?:0|[1-9a-f][0-9a-f]{0,3})$/.test(group))) return false;
  const omitted = 8 - written.length;
  if (halves.length === 1 ? omitted !== 0 : omitted < 1) return false;
  const groups = [...head, ...Array.from({ length: omitted }, () => "0"), ...tail];

  let compressAt = -1;
  let compressLength = 1;
  for (let start = 0; start < 8; start += 1) {
    let end = start;
    while (groups[end] === "0") end += 1;
    if (end - start > compressLength) {
      compressAt = start;
      compressLength = end - start;
    }
  }
  const shortest =
    compressAt === -1
      ? groups.join(":")
      : `${groups.slice(0, compressAt).join(":")}::${groups.slice(compressAt + compressLength).join(":")}`;
  return shortest === address;
}

/** `sha256-` plus the unpadded base64url SHA-256 of the relay certificate's public key. */
const RelayPin = Schema.String.pipe(Schema.pattern(/^sha256-[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/));

/**
 * Where a paired device may knock to reach its host through a relay. The host
 * gives it only over that device's authenticated session. It carries no key
 * and authorizes nothing at the host; the device keeps it beside the origin's
 * pinned trust.
 */
export const RelayGrantV1 = Schema.Struct({
  relayOrigin: RelayOrigin,
  /** Present when the person pinned a self-hosted relay's certificate instead of platform validation. */
  relayPin: Schema.optional(RelayPin),
  routeId: RelayRouteId,
}).annotations(strict);
export type RelayGrantV1 = typeof RelayGrantV1.Type;

export const decodeRelayFrameV1 = Schema.decodeUnknownEither(RelayFrameV1, {
  onExcessProperty: "error",
});
export const decodeRelayGrantV1 = Schema.decodeUnknownEither(RelayGrantV1, {
  onExcessProperty: "error",
});
