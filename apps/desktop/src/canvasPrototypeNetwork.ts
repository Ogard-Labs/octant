import {
  CANVAS_NETWORK_PROXY_PATH_PREFIX,
  CANVAS_PROTOTYPE_NETWORK_RELAY_PREFIX,
} from "@octant/contracts/canvas-network";
import type { CanvasNetworkResource } from "@octant/domain/canvas-network-policy";

/**
 * The two decisions the desktop makes for a Canvas page whose "Allow network"
 * switch is on. Canonical: docs/design/canvas.md § Allow network.
 *
 * A prototype in the desktop app runs in the prototype host, whose process has
 * no route and no resolver, and that does not change with the switch on. The
 * page is not given a connection. It asks an address of the prototype host's
 * own scheme, the prototype host hands the question to the app's main process,
 * and the main process asks the host's Canvas network proxy under a token the
 * page never holds. These functions are the whole of what is admitted on the
 * way: which request of a page is such a question, and which one address the
 * main process then asks. Neither judges the address the page wants fetched;
 * the host's route holds that to the destination rule.
 */

const SURFACE_PATH =
  /^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(fetch|image|font)$/;
const RESOURCES: ReadonlySet<string> = new Set(["fetch", "image", "font"]);
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
/**
 * The longest request a page may hand over. The host refuses an address past
 * 2,048 characters; encoded three bytes to one that is 6,144, so anything
 * longer than this was never going to be fetched and is not carried across
 * two processes to find out.
 */
const MAX_RELAY_REQUEST_LENGTH = 8_192;

export type CanvasPrototypeRelayRefusal =
  | "not-the-relay"
  | "method-not-allowed"
  | "request-type-not-allowed"
  | "invalid-request"
  | "no-network";

export type CanvasPrototypeRelayDecision =
  | {
      readonly status: "relay";
      readonly surfaceId: string;
      /** Which of the host's three proxy paths the question is for. */
      readonly resource: CanvasNetworkResource;
      /** A `POST` carries the page's JSON body; the caller reads and bounds it. */
      readonly method: "GET" | "POST";
      readonly target: string;
    }
  /** A browser asking, before a page's JSON `POST`, whether it may send one. */
  | { readonly status: "preflight" }
  | { readonly status: "refused"; readonly reason: CanvasPrototypeRelayRefusal };

/**
 * Whether a request that reached the prototype host's scheme handler is a
 * page asking for a fetch: exactly
 * `octant-prototype://network/<surface id>/<fetch, image, or font>?url=<one
 * address>`, for a surface the main process said has a network, as a `GET`,
 * or for `fetch` alone as a `POST` that declares a JSON body. Every other
 * scheme, host, port, path, query, method, body type, and surface is refused
 * here and goes no further.
 */
export function canvasPrototypeRelayRequest(
  request: {
    readonly url: string;
    readonly method: string;
    /** The request's `Content-Type`, read only for a `POST`. */
    readonly contentType?: string | null;
  },
  hasNetwork: (surfaceId: string) => boolean,
): CanvasPrototypeRelayDecision {
  const refused = (reason: CanvasPrototypeRelayRefusal) => ({ status: "refused", reason }) as const;
  // The prefix is compared as written, before anything is parsed: a parser
  // would fold case, drop a default port, and set credentials aside, and none
  // of those spellings is the address the host wrote into the page.
  if (!request.url.startsWith(CANVAS_PROTOTYPE_NETWORK_RELAY_PREFIX)) {
    return refused("not-the-relay");
  }
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return refused("not-the-relay");
  }
  const path = SURFACE_PATH.exec(url.pathname);
  const surfaceId = path?.[1];
  const resource = path?.[2] as CanvasNetworkResource | undefined;
  if (
    url.hostname !== "network" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    request.url.includes("#") ||
    surfaceId === undefined ||
    resource === undefined ||
    // The path as written, so no dot segment or escape a parser resolved counts.
    !request.url.startsWith(`${CANVAS_PROTOTYPE_NETWORK_RELAY_PREFIX}${surfaceId}/${resource}`)
  ) {
    return refused("not-the-relay");
  }
  // An image or a font is only ever loaded; a script may also send JSON, and
  // a browser asks first whether it may.
  const method = request.method;
  if (method !== "GET" && (resource !== "fetch" || (method !== "POST" && method !== "OPTIONS"))) {
    return refused("method-not-allowed");
  }
  if (method === "OPTIONS") {
    return hasNetwork(surfaceId) ? { status: "preflight" } : refused("no-network");
  }
  const target = url.searchParams.get("url");
  if (
    request.url.length > MAX_RELAY_REQUEST_LENGTH ||
    url.searchParams.size !== 1 ||
    target === null ||
    target === ""
  ) {
    return refused("invalid-request");
  }
  if (!hasNetwork(surfaceId)) return refused("no-network");
  if (method === "POST") {
    const type = (request.contentType ?? "").split(";")[0]?.trim().toLowerCase();
    if (type !== "application/json") return refused("request-type-not-allowed");
  }
  return { status: "relay", surfaceId, resource, method, target };
}

/**
 * The one address the main process asks for a page's request: one of the
 * host's three Canvas network proxy paths under the surface's token, with the
 * address the page chose as a single encoded query value, so it can name
 * neither another path nor another host. `undefined` when the token is not
 * one the host could have minted, the path is not one of the three, or the
 * host is not the loopback one the desktop attached to.
 */
export function canvasNetworkRelayAddress(
  serverUrl: string | undefined,
  token: string,
  target: string,
  resource: CanvasNetworkResource = "fetch",
): string | undefined {
  if (serverUrl === undefined || !TOKEN.test(token) || !RESOURCES.has(resource)) return undefined;
  let server: URL;
  try {
    server = new URL(serverUrl);
  } catch {
    return undefined;
  }
  if (
    server.protocol !== "http:" ||
    server.hostname !== "127.0.0.1" ||
    server.username !== "" ||
    server.password !== ""
  ) {
    return undefined;
  }
  const path = `${CANVAS_NETWORK_PROXY_PATH_PREFIX}${token}/${resource}`;
  const address = new URL(`${path}?url=${encodeURIComponent(target)}`, server.origin);
  return address.origin === server.origin && address.pathname === path ? address.href : undefined;
}
