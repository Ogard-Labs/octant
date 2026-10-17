// The one way an Octant window reaches a computer paired through Other
// computers. The window's page policy lets it connect to loopback only, so it
// sends a request here and main sends it over the Node transport held to that
// computer's recorded pin: the address is judged, the served key must match the
// pin, and no request byte leaves before both pass.
//
// The window holds the device key and signs its own requests; main signs
// nothing and returns no key material. What main decides is where a request may
// go and what may come back:
//
//   - the origin must be a listed paired computer, matched exactly;
//   - the method and path must be on the short list the window needs;
//   - only the headers a signed request carries are sent, and the cookie may
//     name only that computer's Octant sessions;
//   - a redirect is returned, never followed;
//   - a reply loses its cookies and any header that looks like a credential,
//     and an oversized or slow reply fails instead of buffering.
//
// A computer forgotten while a request is in flight answers nothing.

import { createListenerFetch } from "@octant/client-runtime/remote-listener-tls-node";
import {
  LISTENER_TRUST_REFUSAL_COPY,
  ListenerTrustRefused,
  type ListenerOriginTrust,
} from "@octant/client-runtime/remote-listener-trust";
import type { PairedComputerPins } from "./pairedComputers";

export const PAIRED_COMPUTER_REQUEST_LIMITS = {
  requestBodyBytes: 8 * 1024 * 1024,
  responseBodyBytes: 16 * 1024 * 1024,
  timeoutMs: 30_000,
  pathChars: 2_048,
} as const;

/**
 * What a window may ask a paired computer for. Pairing and session routes under
 * `/api/remote/`, one dev-server grant route, and the two product reads the main
 * window makes of a paired computer: its resources and its running servers.
 * Anything else, including the relay under `/api/server-proxy/` that the desktop's
 * own forwarder drives, is refused.
 */
export const PAIRED_COMPUTER_ALLOWED_REQUESTS = {
  methods: ["GET", "POST"],
  pathPrefixes: ["/api/remote/", "/api/code/local-servers/"],
  paths: ["/api/server-proxy/grants", "/api/host/resources"],
} as const;

/** The headers a signed request carries; every other name is refused, not dropped. */
const ALLOWED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  "accept",
  "content-type",
  "cookie",
  "origin",
  "sec-fetch-site",
  "x-octant-device-proof",
  "x-octant-csrf",
  "x-octant-command-id",
]);

/** Octant's own session cookies for a paired computer, and nothing else. */
const SESSION_COOKIE_PATTERN =
  /^__Secure-octant-(?:remote-session|server-proxy-session)=[A-Za-z0-9._~-]{1,512}$/;

/** A reply header that is a cookie or reads like a credential never reaches the window. */
const WITHHELD_RESPONSE_HEADER =
  /^set-cookie2?$|authorization|credential|secret|token|(^|-)key(-|$)/i;

export type PairedComputerAnswer =
  | {
      readonly status: "answered";
      readonly httpStatus: number;
      readonly headers: ReadonlyArray<readonly [string, string]>;
      readonly body: Uint8Array;
    }
  | { readonly status: "refused"; readonly message: string }
  | { readonly status: "unreachable"; readonly message: string };

const NOT_PAIRED = "Octant isn't paired with that computer.";

/**
 * Sends one window request to a listed paired computer. Every failure is a
 * value: `refused` when the request itself is not allowed, `unreachable` when
 * the computer could not be reached or answered something Octant will not pass on.
 */
export async function requestPairedComputer(input: {
  readonly request: unknown;
  readonly pins: PairedComputerPins;
  /** The Node transport; replaced only by tests. */
  readonly fetchFor?: (origin: string, trust: ListenerOriginTrust) => typeof globalThis.fetch;
}): Promise<PairedComputerAnswer> {
  const decoded = decodeRequest(input.request, input.pins);
  if (decoded.status === "refused") return decoded;
  const { origin, method, path, headers, body } = decoded;
  const pin = input.pins.pinFor(origin);
  if (pin === undefined) return { status: "refused", message: NOT_PAIRED };

  const trust: ListenerOriginTrust = { current: { kind: "pinned", pin } };
  const fetchFor = input.fetchFor ?? ((o, t) => createListenerFetch({ origin: o, trust: t }));
  const signal = AbortSignal.timeout(PAIRED_COMPUTER_REQUEST_LIMITS.timeoutMs);
  let response: Response;
  try {
    response = await fetchFor(origin, trust)(`${origin}${path}`, {
      method,
      headers,
      body: body ?? null,
      redirect: "manual",
      signal,
    });
  } catch (error) {
    if (error instanceof ListenerTrustRefused) {
      return { status: "unreachable", message: LISTENER_TRUST_REFUSAL_COPY[error.reason] };
    }
    return { status: "unreachable", message: "Octant couldn't reach that computer." };
  }
  const read = await readBounded(response, signal);
  // A computer forgotten (or re-paired under another key) while this request
  // was out answers nothing, whatever it sent back.
  if (input.pins.pinFor(origin) !== pin) return { status: "refused", message: NOT_PAIRED };
  if (read === undefined) {
    return { status: "unreachable", message: "That computer's answer was too large or too slow." };
  }
  const answered: Array<readonly [string, string]> = [];
  response.headers.forEach((value, name) => {
    if (!WITHHELD_RESPONSE_HEADER.test(name)) answered.push([name, value]);
  });
  return { status: "answered", httpStatus: response.status, headers: answered, body: read };
}

type DecodedRequest =
  | {
      readonly status: "decoded";
      readonly origin: string;
      readonly method: string;
      readonly path: string;
      readonly headers: Readonly<Record<string, string>>;
      readonly body: Uint8Array<ArrayBuffer> | undefined;
    }
  | { readonly status: "refused"; readonly message: string };

function decodeRequest(value: unknown, pins: PairedComputerPins): DecodedRequest {
  const refuse = (message: string): { readonly status: "refused"; readonly message: string } => ({
    status: "refused",
    message,
  });
  if (typeof value !== "object" || value === null) return refuse("Octant refused that request.");
  const { origin, method, path, headers, body } = value as Record<string, unknown>;
  if (typeof origin !== "string" || pins.pinFor(origin) === undefined) return refuse(NOT_PAIRED);
  if (typeof method !== "string" || !isAllowedMethod(method)) {
    return refuse("Octant doesn't send that kind of request to another computer.");
  }
  if (!isAllowedPath(origin, path)) {
    return refuse("Octant doesn't send that request to another computer.");
  }
  const decodedHeaders = decodeHeaders(headers, origin);
  if (decodedHeaders === undefined) return refuse("Octant refused that request's headers.");
  let bytes: Uint8Array<ArrayBuffer> | undefined;
  if (body !== undefined && body !== null) {
    if (typeof body === "string") bytes = new TextEncoder().encode(body);
    else if (body instanceof Uint8Array) bytes = new Uint8Array(body);
    else return refuse("Octant refused that request's body.");
    if (bytes.byteLength > PAIRED_COMPUTER_REQUEST_LIMITS.requestBodyBytes) {
      return refuse("That request is too large to send to another computer.");
    }
    if (method === "GET" && bytes.byteLength > 0) {
      return refuse("Octant refused that request's body.");
    }
    if (bytes.byteLength === 0) bytes = undefined;
  }
  return {
    status: "decoded",
    origin,
    method,
    path: path as string,
    headers: decodedHeaders,
    body: bytes,
  };
}

function isAllowedMethod(method: string): boolean {
  return (PAIRED_COMPUTER_ALLOWED_REQUESTS.methods as ReadonlyArray<string>).includes(method);
}

/**
 * The path and query as sent on the wire: it must already be in the form a URL
 * parser would give it, so the request line, the signed path, and the allow
 * list all see the same string. Dot segments, a second slash, a scheme or
 * authority, and control characters never pass.
 */
function isAllowedPath(origin: string, path: unknown): boolean {
  if (typeof path !== "string" || path.length === 0) return false;
  if (path.length > PAIRED_COMPUTER_REQUEST_LIMITS.pathChars) return false;
  if (!path.startsWith("/") || path.startsWith("//") || /[\\#]/.test(path)) return false;
  if (hasControlOrSpace(path)) return false;
  let url: URL;
  try {
    url = new URL(path, origin);
  } catch {
    return false;
  }
  if (url.origin !== origin || `${url.pathname}${url.search}` !== path) return false;
  const { paths, pathPrefixes } = PAIRED_COMPUTER_ALLOWED_REQUESTS;
  const pathname = url.pathname;
  return (
    (paths as ReadonlyArray<string>).includes(pathname) ||
    (pathPrefixes as ReadonlyArray<string>).some(
      (prefix) => pathname.startsWith(prefix) && pathname.length > prefix.length,
    )
  );
}

/** A space or a control character; a header value may hold spaces, so they can be allowed. */
function hasControlOrSpace(text: string, allowSpace = false): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || code === 0x7f || (code === 0x20 && !allowSpace)) return true;
  }
  return false;
}

function decodeHeaders(
  value: unknown,
  origin: string,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const headers: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(value)) {
    const name = rawName.toLowerCase();
    if (
      typeof rawValue !== "string" ||
      rawValue.length > 4_096 ||
      hasControlOrSpace(rawValue, true)
    ) {
      return undefined;
    }
    if (!ALLOWED_REQUEST_HEADERS.has(name) || name in headers) return undefined;
    if (name === "cookie" && !SESSION_COOKIE_PATTERN.test(rawValue)) return undefined;
    if (name === "origin" && rawValue !== origin) return undefined;
    if (name === "sec-fetch-site" && rawValue !== "same-origin") return undefined;
    headers[name] = rawValue;
  }
  return headers;
}

/** Reads a reply up to the size limit, or nothing when it is larger or slower. */
async function readBounded(
  response: Response,
  signal: AbortSignal,
): Promise<Uint8Array | undefined> {
  const limit = PAIRED_COMPUTER_REQUEST_LIMITS.responseBodyBytes;
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    void response.body?.cancel().catch(() => undefined);
    return undefined;
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  // The request's timer stops mattering to the transport once the reply
  // starts, so a reply that stalls mid-body is cut off here.
  const expired = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), expired]);
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        void reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
  } catch {
    void reader.cancel().catch(() => undefined);
    return undefined;
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
