import { isPublicNetworkAddress } from "./networkAddressPolicy";
import { parseNetworkAddress } from "./safeNetworkPolicy";

/**
 * Where a Canvas page with **Allow network** on may ask the host to fetch
 * from. Canonical: docs/design/canvas.md § Allow network.
 *
 * The page is agent-written or imported script, and the host makes the
 * request from the person's machine. So the rule admits only what the open
 * internet could reach anyway: a public address over `http` or `https`. It
 * never admits the machine itself, the local network, a cloud metadata
 * address, an overlay network, or any Octant listener, whatever name points
 * there.
 */

/**
 * The most one fetched response may hold. A larger one is refused rather than
 * cut short, so a page never reads half a document as a whole one. The same 5
 * MiB a design's declared images are held to.
 */
export const CANVAS_NETWORK_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
/** One request, every redirect included, from the page's ask to the last byte. */
export const CANVAS_NETWORK_TOTAL_TIME_MS = 30_000;
/**
 * Requests one Canvas may have in flight. A page that asks for more is
 * refused, not queued: a queue would let it hold the host's sockets.
 */
export const CANVAS_NETWORK_MAX_CONCURRENT_REQUESTS = 4;
/**
 * Requests one Canvas may start in any minute. Enough for a dashboard that
 * polls a few sources; too few to make the person's address a crawler.
 */
export const CANVAS_NETWORK_MAX_REQUESTS_PER_MINUTE = 60;
/** Redirects followed for one request, each judged as a new destination. */
export const CANVAS_NETWORK_MAX_REDIRECTS = 5;
/** The longest address the proxy reads; a browser's own practical limit. */
export const CANVAS_NETWORK_MAX_URL_LENGTH = 2_048;

/**
 * What the proxy must never reach although the address may be public: the
 * machine's own interface addresses (every Octant listener binds one, on any
 * port) and the names its listeners answer to.
 */
export interface CanvasNetworkReserved {
  readonly addresses: ReadonlyArray<string>;
  readonly hosts: ReadonlyArray<string>;
}

export type CanvasNetworkRefusalReason =
  | "invalid-url"
  | "scheme-not-allowed"
  | "credentials-in-url"
  | "port-not-allowed"
  | "local-name"
  | "private-address"
  | "octant-address";

export type CanvasNetworkUrlDecision =
  | {
      readonly kind: "allowed";
      /** The address as the host will request it. */
      readonly url: string;
      /** The name or literal address to resolve, without brackets or a trailing dot. */
      readonly host: string;
    }
  | { readonly kind: "refused"; readonly reason: CanvasNetworkRefusalReason };

const refused = (reason: CanvasNetworkRefusalReason): CanvasNetworkUrlDecision => ({
  kind: "refused",
  reason,
});

/**
 * May the host ask for this address at all, before any name is resolved. It
 * is asked for the page's own request and again for every redirect. An
 * allowed name still has to resolve to addresses
 * `canvasNetworkAddressRefusal` admits.
 */
export function canvasNetworkUrlRefusal(
  address: string,
  reserved: CanvasNetworkReserved,
): CanvasNetworkUrlDecision {
  if (address.length > CANVAS_NETWORK_MAX_URL_LENGTH) return refused("invalid-url");
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return refused("invalid-url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return refused("scheme-not-allowed");
  if (url.username.length > 0 || url.password.length > 0) return refused("credentials-in-url");
  // The parser drops a scheme's own port, so anything left is another port.
  if (url.port.length > 0) return refused("port-not-allowed");
  const bare = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const host = bare.replace(/\.$/, "");
  if (host.length === 0) return refused("invalid-url");
  if (host === "localhost" || host.endsWith(".localhost")) return refused("local-name");
  if (reserved.hosts.some((name) => name.toLowerCase().replace(/\.$/, "") === host)) {
    return refused("octant-address");
  }
  // The parser has already read `2130706433` and `0x7f.1` as the addresses a
  // browser would connect to, so a literal is judged in its real form here.
  if (parseNetworkAddress(host) !== undefined) {
    const literal = canvasNetworkAddressRefusal(host, reserved);
    if (literal !== undefined) return refused(literal);
  }
  url.hash = "";
  return { kind: "allowed", url: url.toString(), host };
}

/**
 * Why the host may not connect to an address a name resolved to, or
 * `undefined` when it may. Asked for every address of every connection, at
 * the moment the host connects, so a name's answer is judged as it stands
 * then and not as it stood when the page first asked.
 */
export function canvasNetworkAddressRefusal(
  address: string,
  reserved: CanvasNetworkReserved,
): "private-address" | "octant-address" | undefined {
  const parsed = parseNetworkAddress(address);
  if (parsed === undefined || !isPublicNetworkAddress(address)) return "private-address";
  const same = (other: string): boolean => {
    const candidate = parseNetworkAddress(other);
    return (
      candidate !== undefined &&
      candidate.family === parsed.family &&
      candidate.bytes.every((byte, index) => byte === parsed.bytes[index])
    );
  };
  return reserved.addresses.some(same) ? "octant-address" : undefined;
}
