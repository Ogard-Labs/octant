import type { CanvasId } from "@octant/contracts/canvas";
import {
  CANVAS_NETWORK_MAX_CONCURRENT_REQUESTS,
  CANVAS_NETWORK_MAX_REDIRECTS,
  CANVAS_NETWORK_MAX_REQUESTS_PER_MINUTE,
  CANVAS_NETWORK_MAX_RESPONSE_BYTES,
  CANVAS_NETWORK_TOTAL_TIME_MS,
  canvasNetworkAddressRefusal,
  canvasNetworkUrlRefusal,
  type CanvasNetworkRefusalReason,
  type CanvasNetworkReserved,
} from "@octant/domain/canvas-network-policy";
import { createPinnedFetch, defaultResolveAll } from "../harness/nativeHarnessWebFetch";

/**
 * The host's fetch on behalf of a Canvas page whose **Allow network** switch
 * is on. Canonical: docs/design/canvas.md § Allow network.
 *
 * The page is script the person's agent wrote or the person imported, and the
 * request leaves from the person's machine. So the host decides where it may
 * go (the domain's destination rule), resolves a name once and connects only
 * to the addresses it judged, reads every redirect itself and judges it as a
 * new request, sends nothing that identifies the person or Octant, and bounds
 * what one Canvas can ask for.
 */

/** One connection to addresses the proxy already judged; it follows no redirect. */
export type CanvasNetworkConnect = (
  url: URL,
  connection: {
    /** The only addresses the connection may be made to. */
    readonly addresses: ReadonlyArray<string>;
    readonly headers: Readonly<Record<string, string>>;
    readonly signal: AbortSignal;
  },
) => Promise<Response>;

export type CanvasNetworkProxyRefusalReason =
  | CanvasNetworkRefusalReason
  | "unresolvable"
  | "unreachable"
  | "redirect-without-location"
  | "too-many-redirects"
  | "response-too-large"
  | "timed-out"
  | "too-many-at-once"
  | "too-many-requests";

export type CanvasNetworkProxyOutcome =
  | {
      readonly status: "fetched";
      readonly httpStatus: number;
      readonly contentType: string | undefined;
      readonly body: Uint8Array<ArrayBuffer>;
    }
  | { readonly status: "refused"; readonly reason: CanvasNetworkProxyRefusalReason };

export interface CanvasNetworkProxyOptions {
  /** Read on every connection: the machine's addresses change with its networks. */
  readonly reserved: () => CanvasNetworkReserved;
  readonly resolveAll?: (hostname: string) => Promise<ReadonlyArray<string>>;
  readonly connect?: CanvasNetworkConnect;
  readonly now?: () => number;
  readonly totalTimeMs?: number;
}

/**
 * The whole of what the host sends for a page. No cookie, credential, Octant
 * header, referrer, or header of the page's own goes with it; the transport
 * adds `Host`.
 */
const OUTGOING_HEADERS: Readonly<Record<string, string>> = { accept: "*/*" };
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const MINUTE_MS = 60_000;

/**
 * The transport the proxy uses outside tests: the harness's pinned transport,
 * handed the judged addresses in place of a resolver, so the name is never
 * looked up a second time. It judges each address once more where the socket
 * opens, which costs nothing and holds if a caller ever hands it an address
 * nobody judged.
 */
export function pinnedCanvasNetworkConnect(
  refusal: (address: string) => string | undefined,
): CanvasNetworkConnect {
  return (url, connection) =>
    createPinnedFetch({
      resolveAll: async () => connection.addresses,
      isPrivate: (address) => refusal(address) !== undefined,
    })(url, { signal: connection.signal, headers: connection.headers, redirect: "manual" });
}

const refused = (reason: CanvasNetworkProxyRefusalReason): CanvasNetworkProxyOutcome => ({
  status: "refused",
  reason,
});

export class CanvasNetworkProxy {
  readonly #reserved: () => CanvasNetworkReserved;
  readonly #resolveAll: (hostname: string) => Promise<ReadonlyArray<string>>;
  readonly #connect: CanvasNetworkConnect;
  readonly #now: () => number;
  readonly #totalTimeMs: number;
  /** Per Canvas: requests in flight, and when each of the last minute's requests began. */
  readonly #use = new Map<string, { inFlight: number; started: number[] }>();

  constructor(options: CanvasNetworkProxyOptions) {
    this.#reserved = options.reserved;
    this.#resolveAll = options.resolveAll ?? defaultResolveAll;
    this.#connect =
      options.connect ??
      pinnedCanvasNetworkConnect((address) =>
        canvasNetworkAddressRefusal(address, this.#reserved()),
      );
    this.#now = options.now ?? Date.now;
    this.#totalTimeMs = options.totalTimeMs ?? CANVAS_NETWORK_TOTAL_TIME_MS;
  }

  /** Fetch one address for one Canvas's page, or say why not. It never throws. */
  async fetch(canvasId: CanvasId, address: string): Promise<CanvasNetworkProxyOutcome> {
    const key = String(canvasId);
    const now = this.#now();
    const use = this.#use.get(key) ?? { inFlight: 0, started: [] };
    use.started = use.started.filter((at) => now - at < MINUTE_MS);
    if (use.inFlight >= CANVAS_NETWORK_MAX_CONCURRENT_REQUESTS) return refused("too-many-at-once");
    if (use.started.length >= CANVAS_NETWORK_MAX_REQUESTS_PER_MINUTE) {
      return refused("too-many-requests");
    }
    use.inFlight += 1;
    use.started.push(now);
    this.#use.set(key, use);

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#totalTimeMs);
    try {
      return await this.#follow(address, controller.signal);
    } catch {
      return refused(timedOut ? "timed-out" : "unreachable");
    } finally {
      clearTimeout(timer);
      use.inFlight -= 1;
      if (use.inFlight === 0 && use.started.length === 0) this.#use.delete(key);
    }
  }

  async #follow(address: string, signal: AbortSignal): Promise<CanvasNetworkProxyOutcome> {
    let current = address;
    for (let hop = 0; hop <= CANVAS_NETWORK_MAX_REDIRECTS; hop += 1) {
      const reserved = this.#reserved();
      const destination = canvasNetworkUrlRefusal(current, reserved);
      if (destination.kind === "refused") return refused(destination.reason);
      // The one resolution for this connection. Every address is judged, and
      // the connection is made to these addresses and no others.
      const addresses = await this.#resolveAll(destination.host);
      if (addresses.length === 0) return refused("unresolvable");
      for (const candidate of addresses) {
        const reason = canvasNetworkAddressRefusal(candidate, reserved);
        if (reason !== undefined) return refused(reason);
      }
      const url = new URL(destination.url);
      const response = await this.#connect(url, { addresses, headers: OUTGOING_HEADERS, signal });
      if (REDIRECT_STATUSES.has(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (location === null) return refused("redirect-without-location");
        try {
          current = new URL(location, url).toString();
        } catch {
          return refused("invalid-url");
        }
        continue;
      }
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (declared > CANVAS_NETWORK_MAX_RESPONSE_BYTES) {
        await response.body?.cancel();
        return refused("response-too-large");
      }
      const body = await readWithin(response, CANVAS_NETWORK_MAX_RESPONSE_BYTES);
      if (body === undefined) return refused("response-too-large");
      return {
        status: "fetched",
        httpStatus: response.status,
        contentType: response.headers.get("content-type") ?? undefined,
        body,
      };
    }
    return refused("too-many-redirects");
  }
}

/** The whole body, or `undefined` once it passes the bound. */
async function readWithin(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * What every answer of the proxy route carries. A proxied body is read by a
 * page's script and is never a document: on the host's own origin it would
 * run as Octant. `sandbox` and `attachment` hold even if a browser is pointed
 * at the address directly. Any origin may read the answer because the asking
 * page's origin is opaque and the token, not the origin, is the authority.
 */
const ANSWER_HEADERS: Readonly<Record<string, string>> = {
  "access-control-allow-origin": "*",
  "cache-control": "no-store",
  "content-disposition": "attachment",
  "content-security-policy": "sandbox; default-src 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

/** Why the route itself turns a request away, before the proxy is asked. */
export type CanvasNetworkRouteRefusalReason =
  | "token-not-live"
  | "not-a-script-request"
  | "method-not-allowed"
  | "invalid-request";

/** The HTTP status a refusal is answered with; the body names the reason. */
function refusalStatus(
  reason: CanvasNetworkProxyRefusalReason | CanvasNetworkRouteRefusalReason,
): number {
  switch (reason) {
    case "invalid-request":
      return 400;
    case "method-not-allowed":
      return 405;
    case "too-many-at-once":
    case "too-many-requests":
      return 429;
    case "timed-out":
      return 504;
    case "unresolvable":
    case "unreachable":
    case "redirect-without-location":
    case "too-many-redirects":
    case "response-too-large":
      return 502;
    default:
      return 403;
  }
}

/** The answer a page's request gets: the fetched status, type, and body, or a refusal it can read. */
export function canvasNetworkProxyResponse(
  outcome:
    | CanvasNetworkProxyOutcome
    | { readonly status: "refused"; readonly reason: CanvasNetworkRouteRefusalReason },
): Response {
  if (outcome.status === "refused") {
    return new Response(JSON.stringify({ refused: outcome.reason }), {
      status: refusalStatus(outcome.reason),
      headers: { ...ANSWER_HEADERS, "content-type": "application/json" },
    });
  }
  // A status outside what a response can carry is the far server's fault.
  const status = outcome.httpStatus >= 200 && outcome.httpStatus <= 599 ? outcome.httpStatus : 502;
  const bodyless = status === 204 || status === 205 || status === 304;
  return new Response(bodyless ? null : outcome.body, {
    status,
    headers: {
      ...ANSWER_HEADERS,
      "content-type": outcome.contentType ?? "application/octet-stream",
    },
  });
}
