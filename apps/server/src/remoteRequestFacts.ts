// Lightweight, dependency-light derivation of immutable remote request facts.
//
// This module is intentionally split from `server.ts` so the Bun transport
// adapter can derive facts without transitively loading native modules (for
// example `node-pty`) that Bun cannot load in every environment. The fact
// *types* live in `server.ts` because it owns the `Serve` contract; only the
// pure derivation helpers and the process-scoped HMAC salt live here.
//
// The process HMAC salt is never exposed outside this module. Transport
// adapters call `deriveTransportFactsFromPeer`, which owns the salt internally.
// Tests use `resetProcessRequestFactsSaltForTests` to simulate a restart.

import { createHmac, randomBytes } from "node:crypto";
import { classifyRemoteListenerAddress } from "@octant/domain";
import type { RemoteListenerTrust, RequestTransportFacts, RemoteSourceClass } from "./server";

const IPV4_MAPPED_PREFIX = "::ffff:";

/**
 * Normalize a peer address so Node and Bun produce equivalent facts. Node
 * reports IPv4 connections on dual-stack sockets as `::ffff:x.x.x.x`; Bun's
 * `requestIP` reports them as plain IPv4 with `family: "IPv4"`. Stripping the
 * mapped prefix aligns both runtimes without altering IPv6 literals.
 */
export function normalizePeerAddress(address: string | undefined | null, _family?: string): string {
  if (address === undefined || address === null) return "";
  const trimmed = address.trim().toLowerCase();
  if (trimmed === "") return "";
  if (trimmed.startsWith(IPV4_MAPPED_PREFIX)) return trimmed.slice(IPV4_MAPPED_PREFIX.length);
  return trimmed;
}

/**
 * Classify a normalized peer address into a coarse source class. Public and
 * invalid addresses map to `unknown` so the remote boundary can reject
 * unclassifiable API traffic without trusting headers.
 */
export function classifyRemoteSourceClass(normalizedAddress: string): RemoteSourceClass {
  if (normalizedAddress === "") return "unknown";
  const listenerClass = classifyRemoteListenerAddress(normalizedAddress);
  if (listenerClass === "loopback") return "loopback";
  if (listenerClass === "lan-private") return "lan-private";
  if (listenerClass === "tailscale") return "tailscale";
  return "unknown";
}

/**
 * Derive a process-scoped opaque source key from a normalized peer address.
 * The raw address and salt never leave this function; only the HMAC digest is
 * returned. An empty address yields an empty key so the boundary can reject
 * missing peer identity.
 */
export function deriveRemoteSourceKey(normalizedAddress: string, salt: Uint8Array): string {
  if (normalizedAddress === "") return "";
  return createHmac("sha256", salt).update(normalizedAddress).digest("hex");
}

/**
 * Create transport facts from an explicit salt. Used by tests that need
 * deterministic keys. Production code should use `deriveTransportFactsFromPeer`
 * which owns the process salt internally.
 */
export function createRemoteRequestFacts(input: {
  readonly peerAddress: string | undefined | null;
  readonly family?: string;
  readonly listenerTrust: RemoteListenerTrust;
  readonly salt: Uint8Array;
}): RequestTransportFacts {
  const normalized = normalizePeerAddress(input.peerAddress, input.family);
  return Object.freeze({
    listenerTrust: input.listenerTrust,
    sourceClass: classifyRemoteSourceClass(normalized),
    sourceKey: deriveRemoteSourceKey(normalized, input.salt),
  });
}

let processRequestFactsSalt: Uint8Array | undefined;

/**
 * Lazily create and reuse one HMAC salt per process. A restart clears it
 * implicitly because the salt lives only in memory; tests call
 * `resetProcessRequestFactsSaltForTests` to simulate a restart.
 *
 * This function is not exported through `server.ts`; transport adapters use
 * `deriveTransportFactsFromPeer` instead so the salt cannot escape this module.
 */
function getProcessRequestFactsSalt(): Uint8Array {
  if (processRequestFactsSalt === undefined) {
    processRequestFactsSalt = randomBytes(32);
  }
  return processRequestFactsSalt;
}

/**
 * Adapter-facing helper: derive immutable transport facts from a peer address
 * using the internal process-scoped HMAC salt. The salt is never exposed to
 * the caller. Node and Bun transport adapters call this instead of
 * `createRemoteRequestFacts` + `getProcessRequestFactsSalt`.
 */
export function deriveTransportFactsFromPeer(input: {
  readonly peerAddress: string | undefined | null;
  readonly family?: string;
  readonly listenerTrust: RemoteListenerTrust;
}): RequestTransportFacts {
  return createRemoteRequestFacts({
    peerAddress: input.peerAddress,
    ...(input.family === undefined ? {} : { family: input.family }),
    listenerTrust: input.listenerTrust,
    salt: getProcessRequestFactsSalt(),
  });
}

/** Test seam: clear the process salt so the next access mints a fresh one. */
export function resetProcessRequestFactsSaltForTests(): void {
  processRequestFactsSalt = undefined;
}
