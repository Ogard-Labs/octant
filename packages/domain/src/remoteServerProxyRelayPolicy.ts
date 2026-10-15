/**
 * Which headers cross the host's proxy route on their way to a paired device's
 * granted dev server, and on the way back.
 *
 * The request arrives from the device's forwarder carrying Octant's own
 * credentials (the proxy session cookie, the device proof, the CSRF token)
 * beside the page's own headers. None of Octant's reach the dev server, and
 * nothing the dev server answers can pose as Octant's. Hop-by-hop headers
 * describe one connection and never cross; the host speaks for the request on
 * its own loopback connection.
 */

export type RemoteServerRelayHeader = readonly [name: string, value: string];

/** RFC 9110 connection-specific fields, plus the legacy ones proxies still meet. */
const HOP_BY_HOP: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Claims about who connected that only the host may make, and it makes none. */
const FORWARDED_IDENTITY: ReadonlySet<string> = new Set([
  "forwarded",
  "x-real-ip",
  "x-client-cert",
  "x-forwarded-client-cert",
  "ssl-client-cert",
]);

export interface RemoteServerRelayRequestHeadersInput {
  /** The request's headers as they reached the proxy route. */
  readonly headers: ReadonlyArray<RemoteServerRelayHeader>;
  /** The private listener's origin: the only `Origin` the proxy route admits. */
  readonly listenerOrigin: string;
  /** `/api/server-proxy/<grant id>`; a `Referer` under it names the same path upstream. */
  readonly grantPath: string;
  readonly upstream: { readonly scheme: "http" | "https"; readonly port: number };
  /** Bytes the host sends as the body, or `undefined` when it sends none. */
  readonly bodyBytes: number | undefined;
}

/**
 * The headers the host sends the dev server.
 *
 * `Host` is `localhost` at the server's port, and an `Origin` (which the proxy
 * route admits only as the listener's own) becomes the dev server's origin, so
 * a dev server's host and same-origin checks pass. A `Referer` under the
 * grant's path becomes the same path on the dev server; any other is dropped,
 * so the listener's address never reaches it. Cookies named for Octant are
 * removed and the page's own cookies pass. No forwarding header is added, and
 * the host asks the dev server to close the connection after answering.
 */
export function relayRequestHeaders(
  input: RemoteServerRelayRequestHeadersInput,
): ReadonlyArray<RemoteServerRelayHeader> {
  const upstreamOrigin = new URL(`${input.upstream.scheme}://localhost:${input.upstream.port}`);
  const dropped = connectionNamed(input.headers);
  const relayed: RemoteServerRelayHeader[] = [["host", upstreamOrigin.host]];
  for (const [rawName, value] of input.headers) {
    const name = rawName.toLowerCase();
    if (
      HOP_BY_HOP.has(name) ||
      FORWARDED_IDENTITY.has(name) ||
      dropped.has(name) ||
      name === "host" ||
      name === "content-length" ||
      name.startsWith("x-forwarded-") ||
      name.startsWith("x-octant-") ||
      // Fetch metadata describes the forwarder's request to the host, which the
      // forwarder has already judged against the page's own.
      name.startsWith("sec-fetch-")
    ) {
      continue;
    }
    if (name === "cookie") {
      const kept = value
        .split(";")
        .map((pair) => pair.trim())
        .filter((pair) => pair !== "" && !isOctantCookieName(cookieName(pair)));
      if (kept.length > 0) relayed.push(["cookie", kept.join("; ")]);
      continue;
    }
    if (name === "origin") {
      if (value === input.listenerOrigin) relayed.push(["origin", upstreamOrigin.origin]);
      continue;
    }
    if (name === "referer") {
      const referer = upstreamReferer(value, input, upstreamOrigin.origin);
      if (referer !== undefined) relayed.push(["referer", referer]);
      continue;
    }
    relayed.push([name, value]);
  }
  if (input.bodyBytes !== undefined) relayed.push(["content-length", String(input.bodyBytes)]);
  relayed.push(["connection", "close"]);
  return relayed;
}

/**
 * Response headers that act on the origin that receives them rather than on
 * the page: `Clear-Site-Data` would clear storage, and `Alt-Svc` would point
 * later connections elsewhere, for whichever origin first reads the response.
 */
const ORIGIN_DIRECTIVES: ReadonlySet<string> = new Set(["clear-site-data", "alt-svc"]);

/**
 * The dev server's response headers as the host relays them: without hop-by-hop
 * headers, without `Content-Length` (the body is streamed and may be cut short
 * by a revocation), without any `x-octant-` header, without `Clear-Site-Data`
 * or `Alt-Svc`, and without a `Set-Cookie` for a cookie named for Octant.
 * Everything else passes unchanged; the forwarder on the device rewrites what
 * the page's own address needs.
 */
export function relayResponseHeaders(
  headers: ReadonlyArray<RemoteServerRelayHeader>,
): ReadonlyArray<RemoteServerRelayHeader> {
  const dropped = connectionNamed(headers);
  const relayed: RemoteServerRelayHeader[] = [];
  for (const [rawName, value] of headers) {
    const name = rawName.toLowerCase();
    if (
      HOP_BY_HOP.has(name) ||
      ORIGIN_DIRECTIVES.has(name) ||
      dropped.has(name) ||
      name === "content-length" ||
      name.startsWith("x-octant-")
    ) {
      continue;
    }
    if (name === "set-cookie" && isOctantCookieName(cookieName(value))) continue;
    relayed.push([name, value]);
  }
  return relayed;
}

/**
 * Whether a cookie name is one of Octant's: `octant-` first, after an optional
 * `__Secure-` or `__Host-` prefix, in any case. Octant's session cookies and
 * any it adds later share the prefix, so neither direction of the relay needs
 * a list kept in step with them.
 */
export function isOctantCookieName(name: string): boolean {
  const lowered = name.trim().toLowerCase();
  const bare = lowered.startsWith("__secure-")
    ? lowered.slice("__secure-".length)
    : lowered.startsWith("__host-")
      ? lowered.slice("__host-".length)
      : lowered;
  return bare.startsWith("octant-");
}

function cookieName(pairOrSetCookie: string): string {
  const pair = pairOrSetCookie.split(";", 1)[0] ?? "";
  const separator = pair.indexOf("=");
  return separator < 0 ? pair : pair.slice(0, separator);
}

/** Headers a `Connection` field names are this hop's and go with it. */
function connectionNamed(headers: ReadonlyArray<RemoteServerRelayHeader>): ReadonlySet<string> {
  const named = new Set<string>();
  for (const [name, value] of headers) {
    if (name.toLowerCase() !== "connection") continue;
    for (const token of value.split(",")) {
      const trimmed = token.trim().toLowerCase();
      if (trimmed !== "") named.add(trimmed);
    }
  }
  return named;
}

function upstreamReferer(
  value: string,
  input: RemoteServerRelayRequestHeadersInput,
  upstreamOrigin: string,
): string | undefined {
  let referer: URL;
  try {
    referer = new URL(value);
  } catch {
    return undefined;
  }
  if (referer.origin !== input.listenerOrigin) return undefined;
  const { pathname } = referer;
  if (pathname !== input.grantPath && !pathname.startsWith(`${input.grantPath}/`)) {
    return undefined;
  }
  const path = pathname.slice(input.grantPath.length);
  return `${upstreamOrigin}${path === "" ? "/" : path}${referer.search}`;
}
