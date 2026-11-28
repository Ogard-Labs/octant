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
//
// Away from the private network, a computer this app chose to reach through
// its hub is reached through the hub's relay instead (decision H36): only
// when the direct connection failed before sending anything, and only with
// the relay address the computer told this app at home. Main runs the relay
// and its TLS, held to the same pin; the window signs the hub's admission,
// and nothing else, with its device key.

import {
  createListenerFetch,
  createRelayedListenerFetch,
  type ListenerFetch,
} from "@octant/client-runtime/remote-listener-tls-node";
import {
  REMOTE_RELAY_ADDRESS_PATH,
  createRelayFallbackFetch,
  relayAddressFromResponse,
  relayRouteFor,
} from "@octant/client-runtime/paired-host-relay";
import type {
  ListenerRelayRoute,
  RelayAdmissionSignature,
} from "@octant/client-runtime/relay-tunnel";
import { MAX_CODE_ATTACHMENT_BYTES } from "@octant/contracts/code";
import { MAX_WORK_ATTACHMENT_BYTES } from "@octant/contracts";
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
  /**
   * Provider CLI updates run up to 120 seconds on the remote host before the
   * post-update probe runs, so `/api/providers/commands` needs room past the
   * ordinary 30-second channel bound.
   */
  providerCommandTimeoutMs: 150_000,
  pathChars: 2_048,
} as const;

/**
 * What a window may ask a paired computer for, as exact method and path
 * patterns. Query parameters are free except where a route requires them.
 * Thread and evidence ids match only lowercase UUIDs. Code thread events are
 * carried only with `wait=0`, because without it the host holds the read open
 * past this channel's time limit. To-do routes refuse any device but the
 * person's own. A member of this host's hub, pinned from the host's roster,
 * may also be asked to admit the window as the guest the hub introduced; a
 * computer paired directly is never sent that request. Anything else,
 * including the relay under `/api/server-proxy/<grant>/` and forward
 * connections at `/api/server-proxy/<forward>`, which the desktop's own
 * forwarder and forward listener drive, is refused.
 */
export const PAIRED_COMPUTER_ALLOWED_REQUESTS: ReadonlyArray<{
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly path: string;
  /** Query parameters the request must carry with exactly these values. */
  readonly requiredQuery?: Readonly<Record<string, string>>;
  /** Sent only to a member of this host's hub, never to a computer paired directly. */
  readonly hubMemberOnly?: true;
  /** Longer bound when the host itself runs a bounded slow operation (such as a CLI update). */
  readonly timeoutMs?: number;
}> = [
  { method: "GET", path: "/api/remote/hello" },
  { method: "POST", path: "/api/remote/pairing" },
  { method: "POST", path: "/api/remote/pairing/status" },
  { method: "POST", path: "/api/remote/negotiate" },
  { method: "POST", path: "/api/remote/auth/challenge" },
  { method: "POST", path: "/api/remote/auth/session" },
  { method: "POST", path: "/api/remote/auth/server-proxy-session" },
  { method: "GET", path: "/api/remote/auth/device" },
  // Where the computer's hub relay is; the computer answers it only at home.
  { method: "GET", path: REMOTE_RELAY_ADDRESS_PATH },
  { method: "POST", path: "/api/remote/auth/sign-out" },
  { method: "POST", path: "/api/remote/auth/rotate-key" },
  { method: "POST", path: "/api/remote/auth/revoke-self" },
  { method: "POST", path: "/api/server-proxy/grants" },
  { method: "POST", path: "/api/server-proxy/forwards" },
  { method: "GET", path: "/api/host/resources" },
  { method: "POST", path: "/api/code/local-servers/commands" },
  { method: "POST", path: "/api/code/desktops" },
  { method: "POST", path: "/api/code/desktops/frame" },
  { method: "GET", path: "/api/todos" },
  { method: "GET", path: "/api/todos/changes" },
  { method: "POST", path: "/api/todos/commands" },
  ...[
    "/api/chat/bootstrap",
    "/api/chat/navigation",
    "/api/work/threads/bootstrap",
    "/api/work/navigation",
    "/api/reply-detail",
    "/api/extensions/snapshot",
    "/api/conversation-inputs",
    "/api/work/requests",
    "/api/code/attachments",
    "/api/work/attachments",
  ].map((path) => ({ method: "GET" as const, path })),
  ...[
    "/api/chat/commands",
    "/api/work/threads/commands",
    "/api/work/turns",
    "/api/work/turns/cancel",
    "/api/work/turns/rewind",
    "/api/work/mutations",
    "/api/work/requests/commands",
  ].map((path) => ({ method: "POST" as const, path })),
  { method: "POST", path: "/api/chat/attachments" },
  { method: "PUT", path: "/api/code/attachments" },
  { method: "PUT", path: "/api/work/attachments" },
  { method: "DELETE", path: "/api/code/attachments" },
  { method: "DELETE", path: "/api/work/attachments" },
  ...[
    "/api/chat/threads/:id",
    "/api/chat/threads/:id/window",
    "/api/chat/threads/:id/events",
    "/api/work/turns/transcript/:id",
    "/api/work/turns/window/:id",
    "/api/work/turns/stream/:id",
    "/api/code/content/:id",
    "/api/chat/attachments/:id",
  ].map((path) => ({ method: "GET" as const, path })),
  { method: "DELETE", path: "/api/chat/attachments/:id" },
  { method: "GET", path: "/api/code/bootstrap" },
  { method: "GET", path: "/api/code/navigation" },
  { method: "GET", path: "/api/video/jobs" },
  { method: "POST", path: "/api/video/clip" },
  { method: "GET", path: "/api/video/clip" },
  { method: "GET", path: "/api/code/threads/:id" },
  { method: "GET", path: "/api/code/threads/:id/conversation" },
  { method: "GET", path: "/api/code/threads/:id/conversation/window" },
  { method: "GET", path: "/api/code/threads/:id/follow-up" },
  { method: "POST", path: "/api/code/threads/:id/follow-up" },
  { method: "GET", path: "/api/code/threads/:id/events", requiredQuery: { wait: "0" } },
  { method: "GET", path: "/api/code/threads/:id/operations/:id/events" },
  { method: "GET", path: "/api/code/threads/:id/operations/:id/evidence/:id" },
  { method: "POST", path: "/api/code/commands" },
  { method: "POST", path: "/api/code/evidence/batch" },
  { method: "PUT", path: "/api/code/evidence" },
  { method: "GET", path: "/api/projects/bootstrap" },
  // Choosing a folder on that computer and making a Code Project from it, as
  // its own person; the host refuses any other device.
  { method: "POST", path: "/api/folders/browse" },
  { method: "POST", path: "/api/folders/select" },
  { method: "POST", path: "/api/projects/repository-bootstrap/clone" },
  { method: "POST", path: "/api/projects/repository-bootstrap/clone/status" },
  { method: "POST", path: "/api/projects/repository-bootstrap/clone/cancel" },
  { method: "POST", path: "/api/projects/repository-bootstrap/land-files" },
  { method: "POST", path: "/api/projects/commands" },
  { method: "GET", path: "/api/providers/bootstrap" },
  // Provider CLI updates and version checks on person-paired computers; the
  // remote host refuses every restricted or hub-introduced device itself.
  {
    method: "POST",
    path: "/api/providers/commands",
    timeoutMs: PAIRED_COMPUTER_REQUEST_LIMITS.providerCommandTimeoutMs,
  },
  { method: "GET", path: "/api/pending-requests" },
  // Listing and answering a thread's MCP tool approvals, which Needs you opens
  // there; the host answers only its own person's device.
  { method: "POST", path: "/api/extensions/tool-approvals" },
  { method: "POST", path: "/api/hub/guest", hubMemberOnly: true },
];

const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** True when `pathname` fills the allowed path, an `:id` segment taking only a lowercase UUID. */
function pathMatches(pattern: string, pathname: string): boolean {
  const expected = pattern.split("/");
  const actual = pathname.split("/");
  if (expected.length !== actual.length) return false;
  return expected.every((segment, index) => {
    const given = actual[index];
    if (given === undefined) return false;
    return segment === ":id" ? UUID_SEGMENT.test(given) : segment === given;
  });
}

/** The routes a pairing uses; only these may be held to a pin that is staged and not yet recorded. */
const PAIRING_PATHS: ReadonlySet<string> = new Set([
  "/api/remote/hello",
  "/api/remote/pairing",
  "/api/remote/pairing/status",
]);

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
  "x-octant-code-thread-id",
  "x-octant-hub-link",
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
  /**
   * Signs a relay admission with the device key of the window that asked;
   * absent, this request never relays.
   */
  readonly admitRelay?: (origin: string, payload: string) => Promise<RelayAdmissionSignature>;
  /** The Node relay transport; replaced only by tests. */
  readonly relayedFetchFor?: (
    origin: string,
    trust: ListenerOriginTrust,
    route: ListenerRelayRoute,
  ) => ListenerFetch;
}): Promise<PairedComputerAnswer> {
  const decoded = decodeRequest(input.request, input.pins);
  if (decoded.status === "refused") return decoded;
  const { origin, method, path, headers, body, timeoutMs } = decoded;
  const pairing = PAIRING_PATHS.has(new URL(path, origin).pathname);
  const pin = input.pins.reachPinFor(origin, pairing);
  if (pin === undefined) return { status: "refused", message: NOT_PAIRED };

  const trust = input.pins.trustFor(origin, pairing);
  const hostId = input.pins.hostIdFor(origin);
  if (trust === undefined) return { status: "refused", message: NOT_PAIRED };
  const fetchFor =
    input.fetchFor ??
    ((o, t) =>
      createListenerFetch({
        origin: o,
        trust: t,
        ...(hostId === undefined ? {} : { hostId }),
        ...(input.pins.pinFor(o) === undefined
          ? {}
          : {
              onTrust: (previous: ListenerOriginTrust, next: ListenerOriginTrust) =>
                input.pins.rememberTrust(o, previous, next),
            }),
      }));
  const onTrust =
    input.pins.pinFor(origin) === undefined
      ? undefined
      : (previous: ListenerOriginTrust, next: ListenerOriginTrust) =>
          input.pins.rememberTrust(origin, previous, next);
  const relayedFetchFor =
    input.relayedFetchFor ??
    ((o: string, t: ListenerOriginTrust, route: ListenerRelayRoute) =>
      createRelayedListenerFetch({
        origin: o,
        trust: t,
        relay: route,
        ...(hostId === undefined ? {} : { hostId }),
        ...(onTrust === undefined ? {} : { onTrust }),
      }));
  let relayed = false;
  const admitRelay = input.admitRelay;
  // A pairing never relays: the computer refuses pairing through its hub, and
  // a computer not yet recorded has no relay choice. The hello does: it is a
  // live session's first call as much as a pairing's.
  const pathname = new URL(path, origin).pathname;
  const neverRelayed =
    input.pins.pinFor(origin) === undefined ||
    pathname === "/api/remote/pairing" ||
    pathname.startsWith("/api/remote/pairing/");
  const away = input.pins.relayAwayFor(origin);
  const direct = fetchFor(origin, trust);
  const transport =
    neverRelayed || admitRelay === undefined || hostId === undefined
      ? direct
      : createRelayFallbackFetch({
          ...(away === undefined ? {} : { away }),
          // Which path answered last is the one the reply came from.
          direct: (url, init) => {
            relayed = false;
            return direct(url, init);
          },
          relayed: () => {
            const route = relayRouteFor({
              choice: input.pins.relayFor(origin),
              signer: {
                targetMemberId: hostId,
                admit: (payload) => admitRelay(origin, payload),
              },
            });
            if (route === undefined) return undefined;
            const through = relayedFetchFor(
              origin,
              input.pins.trustFor(origin, false) ?? trust,
              route,
            );
            return (url, init) => {
              relayed = true;
              return through(url, init);
            };
          },
        });
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await transport(`${origin}${path}`, {
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
  const eventBatch =
    path.split("?", 1)[0]?.endsWith("/events") === true ||
    path.startsWith("/api/work/turns/stream/");
  const read = await readBounded(response, signal, eventBatch);
  // A computer forgotten (or re-paired under another key) while this request
  // was out answers nothing, whatever it sent back.
  const currentTrust = input.pins.trustFor(origin, pairing);
  if (
    currentTrust === undefined ||
    (input.pins.reachPinFor(origin, pairing) !== pin &&
      !(
        trust.staged?.trust.kind === "pinned" &&
        currentTrust.current.kind === "pinned" &&
        currentTrust.current.pin === trust.staged.trust.pin
      ))
  )
    return { status: "refused", message: NOT_PAIRED };
  if (read === undefined) {
    return { status: "unreachable", message: "That computer's answer was too large or too slow." };
  }
  // The relay address is kept only from the computer's own answer at home.
  if (!relayed && method === "GET" && path === REMOTE_RELAY_ADDRESS_PATH) {
    const learned = await relayAddressFromResponse(
      new Response(new Uint8Array(read), { status: response.status }),
    );
    if (learned !== "unchanged") input.pins.rememberRelayAddress(origin, learned);
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
      readonly timeoutMs: number;
    }
  | { readonly status: "refused"; readonly message: string };

function decodeRequest(value: unknown, pins: PairedComputerPins): DecodedRequest {
  const refuse = (message: string): { readonly status: "refused"; readonly message: string } => ({
    status: "refused",
    message,
  });
  if (typeof value !== "object" || value === null) return refuse("Octant refused that request.");
  const { origin, method, path, headers, body } = value as Record<string, unknown>;
  if (typeof origin !== "string" || pins.reachPinFor(origin, true) === undefined) {
    return refuse(NOT_PAIRED);
  }
  const allowed =
    typeof method === "string"
      ? matchAllowedRequest(origin, path, method, pins.isThroughHub(origin))
      : undefined;
  if (allowed === undefined) {
    return refuse("Octant doesn't send that request to another computer.");
  }
  const pathname = new URL(path as string, origin).pathname;
  // Held to the recorded pin unless this is a pairing route.
  if (pins.reachPinFor(origin, PAIRING_PATHS.has(pathname)) === undefined) {
    return refuse(NOT_PAIRED);
  }
  const rangedClip = method === "GET" && pathname === "/api/video/clip";
  const decodedHeaders = decodeHeaders(headers, origin, pathname, rangedClip);
  if (decodedHeaders === undefined || (rangedClip && decodedHeaders.range === undefined)) {
    return refuse("Octant refused that request's headers.");
  }
  let bytes: Uint8Array<ArrayBuffer> | undefined;
  if (body !== undefined && body !== null) {
    if (typeof body === "string") bytes = new TextEncoder().encode(body);
    else if (body instanceof Uint8Array) bytes = new Uint8Array(body);
    else return refuse("Octant refused that request's body.");
    const limit =
      method === "POST" && pathname === "/api/chat/attachments"
        ? MAX_CODE_ATTACHMENT_BYTES
        : method === "PUT" && pathname === "/api/code/attachments"
          ? MAX_CODE_ATTACHMENT_BYTES
          : method === "PUT" && pathname === "/api/work/attachments"
            ? MAX_WORK_ATTACHMENT_BYTES
            : PAIRED_COMPUTER_REQUEST_LIMITS.requestBodyBytes;
    if (bytes.byteLength > limit) {
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
    method: method as string,
    path: path as string,
    headers: decodedHeaders,
    body: bytes,
    timeoutMs: allowed.timeoutMs ?? PAIRED_COMPUTER_REQUEST_LIMITS.timeoutMs,
  };
}

/**
 * The path and query as sent on the wire: it must already be in the form a URL
 * parser would give it, so the request line, the signed path, and the allow
 * list all see the same string. Dot segments, a second slash, a scheme or
 * authority, and control characters never pass.
 */
function matchAllowedRequest(
  origin: string,
  path: unknown,
  method: string,
  hubMember: boolean,
): (typeof PAIRED_COMPUTER_ALLOWED_REQUESTS)[number] | undefined {
  if (typeof path !== "string" || path.length === 0) return undefined;
  if (path.length > PAIRED_COMPUTER_REQUEST_LIMITS.pathChars) return undefined;
  if (!path.startsWith("/") || path.startsWith("//") || /[\\#]/.test(path)) return undefined;
  if (hasControlOrSpace(path)) return undefined;
  let url: URL;
  try {
    url = new URL(path, origin);
  } catch {
    return undefined;
  }
  if (url.origin !== origin || `${url.pathname}${url.search}` !== path) return undefined;
  return PAIRED_COMPUTER_ALLOWED_REQUESTS.find(
    (allowed) =>
      allowed.method === method &&
      (allowed.hubMemberOnly !== true || hubMember) &&
      pathMatches(allowed.path, url.pathname) &&
      Object.entries(allowed.requiredQuery ?? {}).every(
        ([name, value]) => url.searchParams.get(name) === value,
      ),
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
  path: string,
  rangedClip: boolean,
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
    const attachment = /^\/api\/(chat|code|work)\/attachments(?:\/[^/]+)?$/.exec(path)?.[1];
    const attachmentHeader =
      attachment !== undefined &&
      new RegExp(`^x-octant-${attachment}-(?:thread-id|attachment-id|display-name)$`).test(name);
    // The host caps each video range below the desktop channel's reply bound.
    const videoRange = rangedClip && name === "range" && /^bytes=\d{1,10}-\d{0,10}$/.test(rawValue);
    if ((!ALLOWED_REQUEST_HEADERS.has(name) && !attachmentHeader && !videoRange) || name in headers)
      return undefined;
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
  eventBatch: boolean,
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
  let expire: (() => void) | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    expire = () => reject(signal.reason);
    if (signal.aborted) expire();
    else signal.addEventListener("abort", expire, { once: true });
  });
  const ndjson =
    eventBatch && response.headers.get("content-type")?.split(";", 1)[0] === "application/x-ndjson";
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
      if (ndjson && value.includes(10)) {
        // IPC replies are whole bodies. End on a complete frame; the ordinary
        // client reconnects with its last cursor, so an unfinished tail is replayed.
        const batch = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          batch.set(chunk, offset);
          offset += chunk.byteLength;
        }
        const end = batch.lastIndexOf(10) + 1;
        void reader.cancel().catch(() => undefined);
        return batch.slice(0, end);
      }
    }
  } catch {
    void reader.cancel().catch(() => undefined);
    return undefined;
  } finally {
    if (expire !== undefined) signal.removeEventListener("abort", expire);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
