import type {
  AggregateId,
  SafeNetworkPlace,
  SafeNetworkPrivateTag,
  ToolEgressRuleId,
} from "@octant/contracts";
import { canonicalToolEgressHost, canonicalToolEgressRuleHost } from "./toolEgressPolicy";

/**
 * Safe networks and the decision a provider runtime's egress proxy makes.
 * Canonical: docs/architecture.md § Octant Shield (safe networks) and
 * § Provider runtime network.
 *
 * A provider runtime below Full access reaches its provider's own endpoints,
 * the loopback ports its own launch serves Octant's tools on, the hosts its
 * Project's egress rules name, and the places the person trusts, and nothing
 * else. Nothing a runtime asks for, and no number of refusals, becomes a
 * place: places come only from a person in Settings › Access.
 */

/** One parsed address: four bytes for IPv4 (an IPv4-mapped IPv6 address is read as IPv4), sixteen for IPv6. */
interface ParsedAddress {
  readonly family: 4 | 6;
  readonly bytes: ReadonlyArray<number>;
}

interface AddressRange {
  readonly network: ParsedAddress;
  readonly prefix: number;
}

const IPV4_PART = /^(?:0|[1-9]\d{0,2})$/;

function parseIpv4(text: string): ParsedAddress | undefined {
  const parts = text.split(".");
  if (parts.length !== 4) return undefined;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!IPV4_PART.test(part)) return undefined;
    const value = Number(part);
    if (value > 255) return undefined;
    bytes.push(value);
  }
  return { family: 4, bytes };
}

function parseIpv6(text: string): ParsedAddress | undefined {
  if (text.length === 0 || text.includes("%")) return undefined;
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const groups = (half: string): number[] | undefined => {
    if (half.length === 0) return [];
    const values: number[] = [];
    const pieces = half.split(":");
    for (const [index, piece] of pieces.entries()) {
      if (index === pieces.length - 1 && piece.includes(".")) {
        const v4 = parseIpv4(piece);
        if (v4 === undefined) return undefined;
        const [a = 0, b = 0, c = 0, d = 0] = v4.bytes;
        values.push((a << 8) | b, (c << 8) | d);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/i.test(piece)) return undefined;
      values.push(Number.parseInt(piece, 16));
    }
    return values;
  };
  const head = groups(halves[0] ?? "");
  const tail = halves.length === 2 ? groups(halves[1] ?? "") : [];
  if (head === undefined || tail === undefined) return undefined;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return undefined;
  const all = [...head, ...Array.from({ length: missing }, () => 0), ...tail];
  const bytes = all.flatMap((group) => [group >> 8, group & 0xff]);
  const mapped =
    bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  return mapped ? { family: 4, bytes: bytes.slice(12) } : { family: 6, bytes };
}

/** An IPv4 or IPv6 address in its usual text form, `[::1]` included, or `undefined`. */
export function parseNetworkAddress(text: string): ParsedAddress | undefined {
  const bare = text.startsWith("[") && text.endsWith("]") ? text.slice(1, -1) : text;
  return bare.includes(":") ? parseIpv6(bare) : parseIpv4(bare);
}

function parseRange(text: string): AddressRange | undefined {
  const slash = text.indexOf("/");
  const network = parseNetworkAddress(slash === -1 ? text : text.slice(0, slash));
  if (network === undefined) return undefined;
  const width = network.bytes.length * 8;
  let prefix = width;
  if (slash !== -1) {
    const written = text.slice(slash + 1);
    if (!/^\d{1,3}$/.test(written)) return undefined;
    prefix = Number(written);
    if (prefix > width) return undefined;
  }
  return { network: masked(network, prefix), prefix };
}

function masked(address: ParsedAddress, prefix: number): ParsedAddress {
  return {
    family: address.family,
    bytes: address.bytes.map((byte, index) => {
      const keep = Math.min(Math.max(prefix - index * 8, 0), 8);
      return byte & ((0xff << (8 - keep)) & 0xff);
    }),
  };
}

function rangeContains(range: AddressRange, address: ParsedAddress): boolean {
  if (range.network.family !== address.family) return false;
  const candidate = masked(address, range.prefix);
  return candidate.bytes.every((byte, index) => byte === range.network.bytes[index]);
}

function rangesOverlap(a: AddressRange, b: AddressRange): boolean {
  if (a.network.family !== b.network.family) return false;
  return a.prefix <= b.prefix ? rangeContains(a, b.network) : rangeContains(b, a.network);
}

function rangeText(range: AddressRange): string {
  const { family, bytes } = range.network;
  if (family === 4) return `${bytes.join(".")}/${String(range.prefix)}`;
  const groups: string[] = [];
  for (let index = 0; index < 16; index += 2) {
    groups.push((((bytes[index] ?? 0) << 8) | (bytes[index + 1] ?? 0)).toString(16));
  }
  return `${groups.join(":").replace(/(^|:)0(:0)+(:|$)/, "::")}/${String(range.prefix)}`;
}

const ranges = (...texts: ReadonlyArray<string>): ReadonlyArray<AddressRange> =>
  texts.flatMap((text) => {
    const range = parseRange(text);
    return range === undefined ? [] : [range];
  });

/**
 * Link-local addresses, where cloud metadata services answer. No tag holds
 * them and no range may cover any part of them, so trusting a place can never
 * hand a runtime the machine's cloud credentials.
 */
const LINK_LOCAL = ranges("169.254.0.0/16", "fe80::/10");
const LOOPBACK = ranges("127.0.0.0/8", "::1/128");

const PRIVATE_TAG_RANGES: Readonly<Record<SafeNetworkPrivateTag, ReadonlyArray<AddressRange>>> = {
  "this-mac": LOOPBACK,
  "local-network": ranges("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"),
  "overlay-network": ranges("100.64.0.0/10"),
};

export type SafeNetworkPlaceCheck =
  | { readonly kind: "place"; readonly place: SafeNetworkPlace }
  | {
      readonly kind: "refused";
      readonly reason: "invalid-place" | "covers-link-local";
    };

/**
 * The canonical form of a place a person typed, or why it cannot be one. A
 * host or domain is a DNS name in the form egress rules compare names in; a
 * leading `*.` on a domain is dropped, since a domain already covers its
 * subdomains. A range is written in CIDR form with its host bits cleared, and
 * may not overlap a link-local range.
 */
export function canonicalSafeNetworkPlace(place: SafeNetworkPlace): SafeNetworkPlaceCheck {
  const port = place.port === undefined ? {} : { port: place.port };
  switch (place.kind) {
    case "host": {
      const name = canonicalToolEgressHost(place.host.trim());
      return name.kind === "name"
        ? { kind: "place", place: { kind: "host", host: name.host, ...port } }
        : { kind: "refused", reason: "invalid-place" };
    }
    case "domain": {
      const typed = place.domain.trim();
      const name = canonicalToolEgressHost(typed.startsWith("*.") ? typed.slice(2) : typed);
      return name.kind === "name"
        ? { kind: "place", place: { kind: "domain", domain: name.host, ...port } }
        : { kind: "refused", reason: "invalid-place" };
    }
    case "range": {
      const range = parseRange(place.range.trim().toLowerCase());
      if (range === undefined) return { kind: "refused", reason: "invalid-place" };
      if (LINK_LOCAL.some((linkLocal) => rangesOverlap(linkLocal, range))) {
        return { kind: "refused", reason: "covers-link-local" };
      }
      return { kind: "place", place: { kind: "range", range: rangeText(range), ...port } };
    }
    case "private-network":
      return { kind: "place", place: { kind: "private-network", tag: place.tag, ...port } };
  }
}

function portMatches(place: SafeNetworkPlace, port: number): boolean {
  return place.port === undefined || place.port === port;
}

/** Whether a trusted place names this host (as a `host` or `domain` place) at this port. */
function placeNamesHost(
  places: ReadonlyArray<SafeNetworkPlace>,
  host: string,
  port: number,
): boolean {
  return places.some((place) => {
    if (!portMatches(place, port)) return false;
    if (place.kind === "host") return place.host === host;
    if (place.kind === "domain") return host === place.domain || host.endsWith(`.${place.domain}`);
    return false;
  });
}

/** Whether a trusted range or private-network tag holds this address at this port. Link-local never. */
export function safeNetworkHoldsAddress(
  places: ReadonlyArray<SafeNetworkPlace>,
  address: string,
  port: number,
): boolean {
  const parsed = parseNetworkAddress(address);
  if (parsed === undefined) return false;
  if (LINK_LOCAL.some((range) => rangeContains(range, parsed))) return false;
  return places.some((place) => {
    if (!portMatches(place, port)) return false;
    if (place.kind === "private-network") {
      return PRIVATE_TAG_RANGES[place.tag].some((range) => rangeContains(range, parsed));
    }
    if (place.kind === "range") {
      const range = parseRange(place.range);
      return range !== undefined && rangeContains(range, parsed);
    }
    return false;
  });
}

function isLoopbackAddress(address: string): boolean {
  const parsed = parseNetworkAddress(address);
  return parsed !== undefined && LOOPBACK.some((range) => rangeContains(range, parsed));
}

function isLinkLocalAddress(address: string): boolean {
  const parsed = parseNetworkAddress(address);
  return parsed !== undefined && LINK_LOCAL.some((range) => rangeContains(range, parsed));
}

/** A Project egress rule, as a provider runtime's proxy reads it: host, port, and expiry. */
export interface RuntimeEgressProjectRule {
  readonly id: ToolEgressRuleId;
  readonly projectId: AggregateId;
  readonly host: string;
  readonly port: number;
  readonly expiresAt: string;
}

export interface RuntimeEgressRequest {
  readonly destination: { readonly host: string; readonly port: number };
  /** The provider's own endpoints: domains, each covering its subdomains, at port 443. */
  readonly providerDomains: ReadonlyArray<string>;
  /** Loopback ports the launch serves Octant's own tools on. */
  readonly launchLoopbackPorts: ReadonlyArray<number>;
  /** The places in force for the launch's Project, or the account default. */
  readonly places: ReadonlyArray<SafeNetworkPlace>;
  readonly projectRules: ReadonlyArray<RuntimeEgressProjectRule>;
  /** Hosts a reviewer let through for this launch alone. */
  readonly reviewerAllowed: ReadonlyArray<{ readonly host: string; readonly port: number }>;
  readonly now: string;
}

/** What let a request through; the address check after resolution depends on it. */
export type RuntimeEgressAllowedBy = "provider" | "launch" | "place" | "project-rule" | "reviewer";

export type RuntimeEgressDecision =
  | {
      readonly kind: "allow";
      readonly host: string;
      readonly port: number;
      readonly by: RuntimeEgressAllowedBy;
      readonly ruleId?: ToolEgressRuleId;
    }
  | { readonly kind: "refuse"; readonly reason: "ip-literal" | "invalid-port" | "invalid-name" }
  | {
      /** Unlisted: a reviewer may be asked, and the person sees it in Safe networks. */
      readonly kind: "refuse";
      readonly reason: "no-rule" | "expired";
      readonly host: string;
      readonly port: number;
    };

const PROVIDER_PORT = 443;

/**
 * May this provider runtime launch reach this destination now. A name is
 * never resolved to decide: a name nothing lists is refused before any lookup,
 * so a lookup cannot carry data out. An address (and `localhost`) passes only
 * inside a trusted range or tag, or at the launch's own loopback ports.
 */
export function decideProviderRuntimeEgress(request: RuntimeEgressRequest): RuntimeEgressDecision {
  const { port } = request.destination;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return { kind: "refuse", reason: "invalid-port" };
  }
  const raw = request.destination.host.toLowerCase();
  const literal =
    raw === "localhost" || raw === "localhost."
      ? "127.0.0.1"
      : parseNetworkAddress(raw) === undefined
        ? undefined
        : raw;
  if (literal !== undefined) {
    const host = raw.startsWith("[") ? raw.slice(1, -1) : raw.replace(/\.$/, "");
    if (isLoopbackAddress(literal) && request.launchLoopbackPorts.includes(port)) {
      return { kind: "allow", host, port, by: "launch" };
    }
    if (safeNetworkHoldsAddress(request.places, literal, port)) {
      return { kind: "allow", host, port, by: "place" };
    }
    return { kind: "refuse", reason: "ip-literal" };
  }
  const name = canonicalToolEgressHost(request.destination.host);
  if (name.kind === "refused") return { kind: "refuse", reason: name.reason };
  const host = name.host;
  if (
    port === PROVIDER_PORT &&
    request.providerDomains.some((domain) => host === domain || host.endsWith(`.${domain}`))
  ) {
    return { kind: "allow", host, port, by: "provider" };
  }
  if (placeNamesHost(request.places, host, port)) return { kind: "allow", host, port, by: "place" };
  const nowMs = Date.parse(request.now);
  let matchedExpired = false;
  for (const rule of request.projectRules) {
    if (rule.port !== port || !ruleHostMatches(rule.host, host)) continue;
    if (!(nowMs < Date.parse(rule.expiresAt))) {
      matchedExpired = true;
      continue;
    }
    return { kind: "allow", host, port, by: "project-rule", ruleId: rule.id };
  }
  if (request.reviewerAllowed.some((allowed) => allowed.host === host && allowed.port === port)) {
    return { kind: "allow", host, port, by: "reviewer" };
  }
  return { kind: "refuse", reason: matchedExpired ? "expired" : "no-rule", host, port };
}

/**
 * Whether the proxy may connect to a private address a destination resolved
 * to, once the decision above allowed it. A public address needs no such
 * check. A private one passes inside a trusted range or tag, on loopback at
 * the launch's own ports, or for a name the person trusted as a `host` or
 * `domain` place (they named that place; where it resolves is theirs to
 * trust). Link-local never passes.
 */
export function runtimeEgressPrivateAddressAllowed(input: {
  readonly address: string;
  readonly port: number;
  readonly by: RuntimeEgressAllowedBy;
  readonly places: ReadonlyArray<SafeNetworkPlace>;
  readonly launchLoopbackPorts: ReadonlyArray<number>;
}): boolean {
  if (isLinkLocalAddress(input.address)) return false;
  if (input.by === "launch") {
    return isLoopbackAddress(input.address) && input.launchLoopbackPorts.includes(input.port);
  }
  if (input.by === "place") return true;
  return safeNetworkHoldsAddress(input.places, input.address, input.port);
}

function ruleHostMatches(ruleHost: string, host: string): boolean {
  if (canonicalToolEgressRuleHost(ruleHost) !== ruleHost) return false;
  if (ruleHost.startsWith("*.")) return host.endsWith(ruleHost.slice(1));
  return ruleHost === host;
}
