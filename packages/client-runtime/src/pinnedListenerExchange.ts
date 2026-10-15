// A pinned listener `fetch` for a platform whose TLS layer is a native
// module rather than a socket this package can drive: the phone. The module
// does one thing, an exchange: dial a judged address, run a TLS 1.3
// handshake that it refuses unless the served key's pin is on the list it was
// given, and only then write the request bytes and read the reply to the end.
// Everything that decides what may be sent stays here, in the same trust rule
// the Node transport applies: which pins pass, which address may be dialled,
// and what a refusal is called. HTTP/1.1 framing lives here too, so the
// native code never parses anything the listener sends.

import {
  judgeListenerAddresses,
  judgeListenerCertificate,
  ListenerTrustRefused,
  MAX_STAGED_TRUST_WINDOW_MS,
  type ListenerOriginTrust,
  type ListenerTrust,
} from "./remoteListenerTrust";

export interface PinnedListenerExchangeRequest {
  /** The IP address to dial, already judged private; never a name. */
  readonly address: string;
  readonly port: number;
  /** The server name to send, when the origin names its host rather than an address. */
  readonly serverName: string | undefined;
  /** A served leaf whose SubjectPublicKeyInfo pin is not one of these is refused during the handshake. */
  readonly pins: ReadonlyArray<string>;
  /** The whole HTTP/1.1 request, written only after the handshake passed the pin. */
  readonly request: Uint8Array;
  readonly signal: AbortSignal | undefined;
}

export type PinnedListenerExchangeOutcome =
  | {
      readonly status: "responded";
      /** The pin of the leaf the handshake accepted. */
      readonly servedPin: string;
      /** Every byte the listener sent before it closed the connection. */
      readonly response: Uint8Array;
    }
  /** The handshake refused the served key; nothing was written. */
  | { readonly status: "refused"; readonly servedPin: string | undefined }
  | {
      readonly status: "failed";
      readonly reason: "unreachable" | "handshake-failed" | "connection-failed" | "too-large";
    };

/** The native side of a pinned listener fetch. */
export interface PinnedListenerExchangePort {
  /** Every address the name resolves to. */
  readonly resolve: (hostname: string) => Promise<ReadonlyArray<string>>;
  readonly exchange: (
    request: PinnedListenerExchangeRequest,
  ) => Promise<PinnedListenerExchangeOutcome>;
}

const HTTPS_ORIGIN = /^https:\/\/(\[[0-9A-Fa-f:]+\]|[A-Za-z0-9.-]+)(?::([0-9]{1,5}))?$/;
const IPV4_LITERAL = /^[0-9]{1,3}(?:\.[0-9]{1,3}){3}$/;
const TEXT_CONTENT = /^(?:text\/|application\/(?:json|x-ndjson|[^;]*\+json))/i;
/** Headers the transport writes itself; a caller's value would change the framing. */
const FRAMING_HEADERS: ReadonlySet<string> = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "upgrade",
]);

/**
 * A `fetch` that reaches one pinned listener origin through a native
 * exchange. A refusal throws `ListenerTrustRefused` before any request byte
 * is written; an unreachable listener or an unreadable reply throws a
 * `TypeError`, as the platform `fetch` does. It refuses a URL on any other
 * origin, never follows a redirect, and never uses the platform `fetch`.
 * Request bodies are text or bytes; the reply arrives whole once the
 * listener closes the connection.
 */
export function createExchangeListenerFetch(options: {
  readonly origin: string;
  readonly trust: ListenerOriginTrust;
  readonly port: PinnedListenerExchangePort;
  readonly now?: () => number;
}): typeof globalThis.fetch {
  const match = HTTPS_ORIGIN.exec(options.origin);
  const host = match?.[1];
  if (match === null || host === undefined) {
    throw new Error("A listener origin must be exactly an HTTPS origin.");
  }
  const hostname = host.replace(/^\[(.*)\]$/, "$1");
  const port = match[2] === undefined ? 443 : Number(match[2]);
  const isAddress = IPV4_LITERAL.test(hostname) || hostname.includes(":");
  const now = options.now ?? Date.now;
  const encoder = new TextEncoder();

  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url !== options.origin && !url.startsWith(`${options.origin}/`)) {
      throw new TypeError("A listener fetch reaches only the origin it was made for.");
    }
    const target = url.slice(options.origin.length).replace(/#.*$/, "");
    const path = target === "" ? "/" : target;
    const fromRequest = typeof input === "object" && !(input instanceof URL) ? input : undefined;
    const signal = init?.signal ?? fromRequest?.signal ?? undefined;
    signal?.throwIfAborted();
    const method = (init?.method ?? fromRequest?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers ?? fromRequest?.headers);
    const body = await requestBody(init, fromRequest, encoder);

    const pins = acceptedPins(options.trust, now());
    if (pins.length === 0) {
      // Nothing this exchange may accept: a platform trust, or only pins
      // naming a hash this client does not know.
      throw new ListenerTrustRefused(refusalFor(options.trust, undefined, now()));
    }
    let addresses: ReadonlyArray<string>;
    try {
      addresses = isAddress ? [hostname] : await options.port.resolve(hostname);
    } catch {
      throw new TypeError("The listener could not be reached.");
    }
    const judged = judgeListenerAddresses(addresses);
    if (judged.status === "refused") throw new ListenerTrustRefused(judged.reason);

    const lines = [
      `${method} ${path} HTTP/1.1`,
      `Host: ${host}${match[2] === undefined ? "" : `:${match[2]}`}`,
    ];
    headers.forEach((value, name) => {
      if (!FRAMING_HEADERS.has(name.toLowerCase())) lines.push(`${name}: ${value}`);
    });
    lines.push("Connection: close");
    if (body !== undefined || method === "POST" || method === "PUT" || method === "PATCH") {
      lines.push(`Content-Length: ${body?.byteLength ?? 0}`);
    }
    const head = encoder.encode(`${lines.join("\r\n")}\r\n\r\n`);
    const request = new Uint8Array(head.byteLength + (body?.byteLength ?? 0));
    request.set(head, 0);
    if (body !== undefined) request.set(body, head.byteLength);

    const outcome = await options.port.exchange({
      address: judged.address,
      port,
      serverName: isAddress ? undefined : hostname,
      pins,
      request,
      signal,
    });
    signal?.throwIfAborted();
    if (outcome.status === "failed") {
      throw new TypeError(
        outcome.reason === "too-large"
          ? "The listener sent a reply larger than Octant reads."
          : "The listener could not be reached.",
      );
    }
    if (outcome.status === "refused") {
      throw new ListenerTrustRefused(refusalFor(options.trust, outcome.servedPin, now()));
    }
    // The exchange already refused any other key; a reply under a key the
    // rule does not accept is never read.
    if (!pins.includes(outcome.servedPin)) {
      throw new ListenerTrustRefused(refusalFor(options.trust, outcome.servedPin, now()));
    }
    return readHttpResponse(outcome.response, method);
  };
}

/** The pins a handshake may accept now: the current trust and a staged one still in its window. */
function acceptedPins(trust: ListenerOriginTrust, now: number): ReadonlyArray<string> {
  const pins: string[] = [];
  const add = (candidate: ListenerTrust): void => {
    if (candidate.kind !== "pinned") return;
    // The rule itself decides whether a pin's algorithm is known.
    const judged = judgeListenerCertificate({
      trust: { current: candidate },
      servedPin: candidate.pin,
      platformTrusted: false,
      now,
    });
    if (judged.status === "accepted") pins.push(candidate.pin);
  };
  add(trust.current);
  if (trust.staged !== undefined) {
    const until = Date.parse(trust.staged.until);
    if (until > now && until - now <= MAX_STAGED_TRUST_WINDOW_MS) add(trust.staged.trust);
  }
  return pins;
}

function refusalFor(trust: ListenerOriginTrust, servedPin: string | undefined, now: number) {
  const judged = judgeListenerCertificate({ trust, servedPin, platformTrusted: false, now });
  return judged.status === "refused" ? judged.reason : "pin-mismatch";
}

async function requestBody(
  init: RequestInit | undefined,
  fromRequest: Request | undefined,
  encoder: TextEncoder,
): Promise<Uint8Array | undefined> {
  const body = init?.body ?? undefined;
  if (body === undefined || body === null) {
    if (fromRequest === undefined || fromRequest.body === null) return undefined;
    return encoder.encode(await fromRequest.text());
  }
  if (typeof body === "string") return encoder.encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  throw new TypeError("A listener fetch sends only a text or byte body.");
}

/**
 * Reads one HTTP/1.1 reply that ends where the connection closed. A reply
 * whose head, length, or chunking does not add up is refused whole, so a
 * truncated body never reads as a complete one.
 */
function readHttpResponse(bytes: Uint8Array, method: string): Response {
  const headEnd = indexOfHeadEnd(bytes);
  if (headEnd < 0) throw unreadable();
  const head = latin1(bytes.subarray(0, headEnd));
  const [statusLine, ...headerLines] = head.split("\r\n");
  const status = /^HTTP\/1\.[01] ([1-5][0-9]{2})(?: .*)?$/.exec(statusLine ?? "");
  const code = Number(status?.[1]);
  if (status === null || code < 200) throw unreadable();
  const headers = new Headers();
  for (const line of headerLines) {
    const colon = line.indexOf(":");
    if (colon <= 0) throw unreadable();
    headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  const rest = bytes.subarray(headEnd + 4);
  let body: Uint8Array;
  if (method === "HEAD" || code === 204 || code === 205 || code === 304) {
    body = new Uint8Array(0);
  } else if (/(?:^|,)\s*chunked\s*$/i.test(headers.get("transfer-encoding") ?? "")) {
    body = readChunked(rest);
    headers.delete("transfer-encoding");
  } else if (headers.has("content-length")) {
    const length = headers.get("content-length") ?? "";
    if (!/^[0-9]+$/.test(length) || Number(length) > rest.byteLength) throw unreadable();
    body = rest.subarray(0, Number(length));
  } else {
    body = rest;
  }
  const bodyless = code === 204 || code === 205 || code === 304;
  const contentType = headers.get("content-type") ?? "";
  // The phone's `Response` reads bytes as Latin-1 text, so text is decoded here.
  const responseBody = bodyless
    ? null
    : TEXT_CONTENT.test(contentType)
      ? utf8(body)
      : new Uint8Array(body);
  return new Response(responseBody, { status: code, headers });
}

function readChunked(bytes: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  let offset = 0;
  let total = 0;
  for (;;) {
    const lineEnd = indexOfCrlf(bytes, offset);
    if (lineEnd < 0) throw unreadable();
    const sizeText = latin1(bytes.subarray(offset, lineEnd));
    const size = /^([0-9A-Fa-f]{1,8})(?:;.*)?$/.exec(sizeText);
    if (size?.[1] === undefined) throw unreadable();
    const length = Number.parseInt(size[1], 16);
    offset = lineEnd + 2;
    if (length === 0) return concat(parts, total);
    if (offset + length + 2 > bytes.byteLength) throw unreadable();
    if (bytes[offset + length] !== 13 || bytes[offset + length + 1] !== 10) throw unreadable();
    parts.push(bytes.subarray(offset, offset + length));
    total += length;
    offset += length + 2;
  }
}

function concat(parts: ReadonlyArray<Uint8Array>, total: number): Uint8Array {
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  return joined;
}

function indexOfHeadEnd(bytes: Uint8Array): number {
  for (let index = 0; index + 3 < bytes.byteLength; index += 1) {
    if (
      bytes[index] === 13 &&
      bytes[index + 1] === 10 &&
      bytes[index + 2] === 13 &&
      bytes[index + 3] === 10
    ) {
      return index;
    }
  }
  return -1;
}

function indexOfCrlf(bytes: Uint8Array, from: number): number {
  for (let index = from; index + 1 < bytes.byteLength; index += 1) {
    if (bytes[index] === 13 && bytes[index + 1] === 10) return index;
  }
  return -1;
}

/** Header and chunk-size text, one byte per character. */
function latin1(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return text;
}

/**
 * UTF-8 text, decoded here because the phone's JavaScript engine is not
 * guaranteed a `TextDecoder`. A malformed sequence reads as U+FFFD.
 */
function utf8(bytes: Uint8Array): string {
  const units: number[] = [];
  let index = 0;
  while (index < bytes.byteLength) {
    const first = bytes[index] ?? 0;
    const need =
      first < 0x80
        ? 0
        : first >= 0xc2 && first < 0xe0
          ? 1
          : first >= 0xe0 && first < 0xf0
            ? 2
            : first >= 0xf0 && first < 0xf5
              ? 3
              : -1;
    if (need < 0) {
      units.push(0xfffd);
      index += 1;
      continue;
    }
    let point = need === 0 ? first : first & (0x3f >> need);
    let valid = index + need < bytes.byteLength;
    for (let offset = 1; valid && offset <= need; offset += 1) {
      const next = bytes[index + offset] ?? 0;
      if ((next & 0xc0) !== 0x80) valid = false;
      else point = (point << 6) | (next & 0x3f);
    }
    const minimum = [0, 0x80, 0x800, 0x10000][need] ?? 0;
    if (!valid || point < minimum || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) {
      units.push(0xfffd);
      index += 1;
      continue;
    }
    if (point >= 0x10000) {
      point -= 0x10000;
      units.push(0xd800 + (point >> 10), 0xdc00 + (point & 0x3ff));
    } else {
      units.push(point);
    }
    index += need + 1;
  }
  let text = "";
  for (let start = 0; start < units.length; start += 4096) {
    text += String.fromCharCode(...units.slice(start, start + 4096));
  }
  return text;
}

function unreadable(): TypeError {
  return new TypeError("The listener sent a reply Octant cannot read.");
}
