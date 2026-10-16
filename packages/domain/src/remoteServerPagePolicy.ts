/**
 * How the desktop's forwarder serves a dev server of another paired computer
 * to a page on this one: the page's name, who may reach it, and which headers
 * cross between the page and the host's proxy route.
 *
 * Every page is served on loopback under its own `*.octant.localhost` name, so
 * its cookies and storage stay apart from the person's own `localhost`
 * servers, from other opened pages, and from Octant. Loopback is open to every
 * process on the computer and every such name is same-site with every other,
 * so neither the name nor `SameSite` proves where a request came from: a page
 * is reached only with the secret its Open minted, and only by a request the
 * browser marks as the page's own or as typed by the person.
 */

import { isOctantCookieName, type RemoteServerRelayHeader } from "./remoteServerProxyRelayPolicy";

/** Every opened page's name ends in this; Chromium and the macOS resolver send it to loopback. */
export const REMOTE_SERVER_PAGE_DOMAIN = "octant.localhost";

/**
 * The forwarder's ports: one fixed default and the nine after it. The port is
 * part of every page's origin, so the forwarder keeps the one it last held and
 * moves forward only when that one is taken.
 */
export const REMOTE_SERVER_FORWARDER_PORTS = { first: 47_610, count: 10 } as const;

/** Octant's browser carries a page's secret in this header, and only to the page's exact origin. */
export const REMOTE_SERVER_PAGE_ACCESS_HEADER = "x-octant-page-access";

/**
 * The default browser carries the secret in this cookie. It is named `octant-`
 * so the host's relay would refuse to carry it either way.
 */
export const REMOTE_SERVER_PAGE_ACCESS_COOKIE = "octant-page-access";

/** The path the default browser loads once to turn a one-time token into the access cookie. */
export const REMOTE_SERVER_PAGE_CLAIM_PATH = "/.octant/claim";

/** The largest body the forwarder hashes into a proof and sends; the host's relay takes no more. */
export const REMOTE_SERVER_PAGE_MAX_BODY_BYTES = 8 * 1_024 * 1_024;

/**
 * What the forwarder hashes to name a page: the host and the thread. With the
 * port in front, the same server keeps the same name across reopens, dev
 * server restarts, and app restarts, so its cookies and storage survive them.
 */
export function remoteServerPageLabelInput(input: {
  readonly hostId: string;
  readonly threadId: string;
}): string {
  return ["octant.remote-server-page.v1", input.hostId, input.threadId].join("\n");
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
/** 10 digest bytes are 16 base32 characters: short enough to read, too long to collide by chance. */
const LABEL_BYTES = 10;

/**
 * The page's name, `<port>-<label>.octant.localhost`, from the SHA-256 digest
 * of {@link remoteServerPageLabelInput}. Hashing is the caller's, since this
 * package does no I/O and holds no crypto.
 */
export function remoteServerPageName(input: {
  readonly port: number;
  readonly digest: Uint8Array;
}): string {
  if (input.digest.byteLength < LABEL_BYTES) {
    throw new RangeError("A page label needs at least 10 digest bytes.");
  }
  let label = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of input.digest.subarray(0, LABEL_BYTES)) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      label += BASE32[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  return `${String(input.port)}-${label}.${REMOTE_SERVER_PAGE_DOMAIN}`;
}

export type RemoteServerPageAdmission =
  | { readonly status: "admitted" }
  /**
   * `cross-site`: the browser says another site (a sibling `*.octant.localhost`
   * name among them) sent the request, or the request names another origin.
   * `no-access`: the request carries neither the page's secret header nor its
   * access cookie.
   */
  | { readonly status: "refused"; readonly reason: "cross-site" | "no-access" };

/**
 * Whether a request on a page's exact name may reach the dev server.
 *
 * Fetch metadata is judged first and only where the browser sends it:
 * `same-origin` (the page itself) and `none` (the person typed or Octant opened
 * the address) pass; `same-site` and `cross-site` do not, so a page on a
 * sibling name cannot drive this dev server through the person's browser even
 * though it shares the cookie. An `Origin` must be the page's own. Then the
 * secret must be presented, compared in constant time by the caller.
 */
export function judgeRemoteServerPageRequest(input: {
  readonly pageOrigin: string;
  readonly secFetchSite: string | undefined;
  readonly origin: string | undefined;
  readonly accessPresented: boolean;
}): RemoteServerPageAdmission {
  const site = input.secFetchSite?.trim().toLowerCase();
  if (site !== undefined && site !== "same-origin" && site !== "none") {
    return { status: "refused", reason: "cross-site" };
  }
  if (input.origin !== undefined && input.origin !== input.pageOrigin) {
    return { status: "refused", reason: "cross-site" };
  }
  if (!input.accessPresented) return { status: "refused", reason: "no-access" };
  return { status: "admitted" };
}

/** The value of the page's access cookie in a `Cookie` header, if one is there. */
export function remoteServerPageAccessCookie(cookieHeader: string | undefined): string | undefined {
  if (cookieHeader === undefined) return undefined;
  for (const pair of cookieHeader.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    if (pair.slice(0, separator).trim() !== REMOTE_SERVER_PAGE_ACCESS_COOKIE) continue;
    return pair.slice(separator + 1).trim();
  }
  return undefined;
}

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

export interface RemoteServerPageUpstreamInput {
  readonly headers: ReadonlyArray<RemoteServerRelayHeader>;
  /** `http://<name>:<forwarder port>`, the page's origin. */
  readonly pageOrigin: string;
  /** The paired host's private listener origin. */
  readonly listenerOrigin: string;
  /** `/api/server-proxy/<grant id>`. */
  readonly grantPath: string;
}

/**
 * The page's headers as the forwarder sends them to the host's proxy route.
 *
 * The host admits only its own listener's `Origin` and turns it into the dev
 * server's, and turns a `Referer` under the grant's path into the same path on
 * the dev server. So the page's origin becomes the listener's and a `Referer`
 * on the page becomes the grant's path, and the dev server sees itself in
 * both. The page's secret, in its header or cookie, never leaves this
 * computer. The forwarder speaks for the request to the host as the page's
 * own (`Sec-Fetch-Site: same-origin`), having already judged the browser's.
 */
export function remoteServerPageUpstreamHeaders(
  input: RemoteServerPageUpstreamInput,
): ReadonlyArray<RemoteServerRelayHeader> {
  const sent: RemoteServerRelayHeader[] = [];
  for (const [rawName, value] of input.headers) {
    const name = rawName.toLowerCase();
    if (
      HOP_BY_HOP.has(name) ||
      name === "host" ||
      name === "content-length" ||
      name.startsWith("x-octant-") ||
      name.startsWith("sec-fetch-")
    ) {
      continue;
    }
    if (name === "cookie") {
      const kept = value
        .split(";")
        .map((pair) => pair.trim())
        .filter((pair) => pair !== "" && !isOctantCookieName(pair.split("=", 1)[0] ?? ""));
      if (kept.length > 0) sent.push(["cookie", kept.join("; ")]);
      continue;
    }
    if (name === "origin") {
      if (value === input.pageOrigin) sent.push(["origin", input.listenerOrigin]);
      continue;
    }
    if (name === "referer") {
      const referer = pageReferer(value, input);
      if (referer !== undefined) sent.push(["referer", referer]);
      continue;
    }
    sent.push([name, value]);
  }
  sent.push(["sec-fetch-site", "same-origin"]);
  return sent;
}

function pageReferer(value: string, input: RemoteServerPageUpstreamInput): string | undefined {
  let referer: URL;
  try {
    referer = new URL(value);
  } catch {
    return undefined;
  }
  if (referer.origin !== input.pageOrigin) return undefined;
  return `${input.listenerOrigin}${input.grantPath}${referer.pathname}${referer.search}`;
}

const LOOPBACK_NAMES: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * A relayed response's headers as the page receives them.
 *
 * A `Location` that names the dev server's own origin (`localhost`,
 * `127.0.0.1`, or `[::1]` at its port, either scheme) is moved to the page's
 * name; relative and other-origin redirects stay as they are. A `Set-Cookie`
 * `Domain` naming `localhost` or a loopback address is dropped so the cookie
 * is host-only on the page's name, keeping `Path`, `SameSite`, and `Secure`.
 * `Strict-Transport-Security` is dropped, since the page is plain HTTP on
 * loopback and pinning HTTPS for its name would break it. Octant's own headers
 * and cookies never reach the page. Bodies are never rewritten.
 */
export function remoteServerPageResponseHeaders(input: {
  readonly headers: ReadonlyArray<RemoteServerRelayHeader>;
  readonly pageOrigin: string;
  readonly upstreamPort: number;
}): ReadonlyArray<RemoteServerRelayHeader> {
  const received: RemoteServerRelayHeader[] = [];
  for (const [rawName, value] of input.headers) {
    const name = rawName.toLowerCase();
    if (
      HOP_BY_HOP.has(name) ||
      name === "content-length" ||
      name === "strict-transport-security" ||
      name.startsWith("x-octant-")
    ) {
      continue;
    }
    if (name === "location") {
      received.push(["location", pageLocation(value, input)]);
      continue;
    }
    if (name === "set-cookie") {
      if (isOctantCookieName(value.split(";", 1)[0]?.split("=", 1)[0] ?? "")) continue;
      received.push(["set-cookie", hostOnlyCookie(value)]);
      continue;
    }
    received.push([name, value]);
  }
  return received;
}

function pageLocation(
  value: string,
  input: { readonly pageOrigin: string; readonly upstreamPort: number },
): string {
  let location: URL;
  try {
    // Only an absolute URL can name the dev server's origin; a relative one
    // already resolves against the page.
    location = new URL(value);
  } catch {
    return value;
  }
  if (location.protocol !== "http:" && location.protocol !== "https:") return value;
  const port = location.port === "" ? (location.protocol === "https:" ? 443 : 80) : location.port;
  if (!LOOPBACK_NAMES.has(location.hostname) || Number(port) !== input.upstreamPort) return value;
  return `${input.pageOrigin}${location.pathname}${location.search}${location.hash}`;
}

function hostOnlyCookie(value: string): string {
  const [pair, ...attributes] = value.split(";");
  const kept = attributes.filter((attribute) => {
    const separator = attribute.indexOf("=");
    if (separator < 0) return true;
    if (attribute.slice(0, separator).trim().toLowerCase() !== "domain") return true;
    const domain = attribute
      .slice(separator + 1)
      .trim()
      .toLowerCase()
      .replace(/^\./, "");
    return !LOOPBACK_NAMES.has(domain);
  });
  return [pair ?? "", ...kept].join(";");
}
