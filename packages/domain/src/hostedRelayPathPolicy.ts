import type { RelayGrantV1 } from "@octant/contracts/hosted-relay";

/**
 * How a paired client chooses between a host's direct private path and its
 * relay. Canonical: docs/design/hosted-relay.md § Path choice on the client.
 *
 * The direct path is always tried first, on every connect and reconnect; the
 * relay is a fallback only for an origin whose record holds pinned trust and a
 * grant, and only once the direct path has failed to connect. Either path
 * holds the inner session to the same pin, so the choice never changes who
 * the client trusts.
 */

/** How long the direct path may take to connect before the client tries the relay. */
export const DIRECT_PATH_CONNECT_TIMEOUT_MS = 3_000;

/** What the client keeps for one paired host origin. */
export interface RelayPathRecord {
  /** The origin's current listener trust; only `pinned` can use a relay. */
  readonly trust: { readonly kind: "pinned" | "platform" };
  readonly grant?: RelayGrantV1;
  /** The person turned the relay off for this host on this device. */
  readonly relayTurnedOff: boolean;
}

/**
 * - `connected`: the direct path connected and passed the trust rule.
 * - `connecting`: still trying, for this long.
 * - `unreachable`: no connection: a connect error, a name that did not
 *   resolve, or the address rule refusing every resolved address before
 *   anything was sent.
 * - `trust-refused`: a peer answered and failed pinned trust or the signed
 *   host hello.
 */
export type DirectPathAttempt =
  | { readonly status: "connected" }
  | { readonly status: "connecting"; readonly elapsedMs: number }
  | { readonly status: "unreachable" }
  | { readonly status: "trust-refused" };

export type RemotePathChoice =
  | { readonly path: "direct" }
  | { readonly path: "direct-pending"; readonly remainingMs: number }
  | { readonly path: "relay"; readonly grant: RelayGrantV1 }
  | {
      readonly path: "none";
      readonly reason: "direct-refused" | "no-pinned-trust" | "no-grant" | "relay-turned-off";
    };

/**
 * Chooses the path for one connection attempt from the direct attempt so far.
 *
 * A direct attempt that reached a peer which failed pinned trust does not fall
 * back: that is the refusal the person must see, and a relay would hide it.
 */
export function chooseRemotePath(
  record: RelayPathRecord,
  direct: DirectPathAttempt,
): RemotePathChoice {
  switch (direct.status) {
    case "connected":
      return { path: "direct" };
    case "trust-refused":
      return { path: "none", reason: "direct-refused" };
    case "connecting":
      if (direct.elapsedMs < DIRECT_PATH_CONNECT_TIMEOUT_MS) {
        return {
          path: "direct-pending",
          remainingMs: DIRECT_PATH_CONNECT_TIMEOUT_MS - Math.max(0, direct.elapsedMs),
        };
      }
      return relayFallback(record);
    case "unreachable":
      return relayFallback(record);
  }
}

function relayFallback(record: RelayPathRecord): RemotePathChoice {
  if (record.trust.kind !== "pinned") return { path: "none", reason: "no-pinned-trust" };
  if (record.grant === undefined) return { path: "none", reason: "no-grant" };
  if (record.relayTurnedOff) return { path: "none", reason: "relay-turned-off" };
  return { path: "relay", grant: record.grant };
}
