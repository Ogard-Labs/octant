// A pinned listener `fetch` for a platform whose TLS layer is a native
// module rather than a socket this package can drive: the phone. The module
// does one thing, an exchange: dial a judged address, run a TLS 1.3
// handshake that it refuses unless the served key's pin is on the list it was
// given, and only then write the request bytes and hand back the reply's
// bytes as they arrive, so an event stream streams.
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
  /** Aborting while the exchange opens stops it before the request is written, if it can. */
  readonly signal: AbortSignal | undefined;
}

/** The next bytes of an opened exchange's reply, in the order the listener sent them. */
export type PinnedListenerExchangeRead =
  | { readonly status: "data"; readonly chunk: Uint8Array }
  /** The listener closed the connection. */
  | { readonly status: "end" }
  | { readonly status: "failed" };

export type PinnedListenerExchangeOpening =
  | {
      readonly status: "opened";
      /** The pin of the leaf the handshake accepted. */
      readonly servedPin: string;
      readonly read: () => Promise<PinnedListenerExchangeRead>;
      /** Closes the connection; a pending read then ends or fails. */
      readonly close: () => void;
    }
  /** The handshake refused the served key; nothing was written. */
  | { readonly status: "refused"; readonly servedPin: string | undefined }
  | {
      readonly status: "failed";
      readonly reason: "unreachable" | "handshake-failed" | "connection-failed";
    };

/** The native side of a pinned listener fetch. */
export interface PinnedListenerExchangePort {
  /** Every address the name resolves to. */
  readonly resolve: (hostname: string) => Promise<ReadonlyArray<string>>;
  /** Connects, passes the handshake only on a pin, writes the request, and opens the reply. */
  readonly open: (request: PinnedListenerExchangeRequest) => Promise<PinnedListenerExchangeOpening>;
}

const HTTPS_ORIGIN = /^https:\/\/(\[[0-9A-Fa-f:]+\]|[A-Za-z0-9.-]+)(?::([0-9]{1,5}))?$/;
const IPV4_LITERAL = /^[0-9]{1,3}(?:\.[0-9]{1,3}){3}$/;
/** The most a reply's status line and headers may hold. */
const MAX_HEAD_BYTES = 64 * 1024;
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

    // Resolving and reading the body awaited; an abort meanwhile must stop
    // the request before anything is dialled, not discard its answer after.
    signal?.throwIfAborted();
    const opening = await options.port.open({
      address: judged.address,
      port,
      serverName: isAddress ? undefined : hostname,
      pins,
      request,
      signal,
    });
    if (opening.status === "failed") throw new TypeError("The listener could not be reached.");
    if (opening.status === "refused") {
      throw new ListenerTrustRefused(refusalFor(options.trust, opening.servedPin, now()));
    }
    // The exchange already refused any other key; a reply under a key the
    // rule does not accept is never read.
    if (!pins.includes(opening.servedPin)) {
      opening.close();
      throw new ListenerTrustRefused(refusalFor(options.trust, opening.servedPin, now()));
    }
    const reply = new ReplyReader(opening);
    const abort = (): void => reply.close();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (signal?.aborted === true) throw signal.reason;
      return await readHttpResponse(reply, method, () => {
        signal?.removeEventListener("abort", abort);
      });
    } catch (error) {
      signal?.removeEventListener("abort", abort);
      reply.close();
      if (signal?.aborted === true) throw signal.reason;
      throw error;
    }
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

/** Bytes of an opened exchange, buffered only as far as framing needs. */
class ReplyReader {
  readonly #opening: Extract<PinnedListenerExchangeOpening, { readonly status: "opened" }>;
  #buffer: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  #ended = false;
  #closed = false;

  constructor(opening: Extract<PinnedListenerExchangeOpening, { readonly status: "opened" }>) {
    this.#opening = opening;
  }

  /** Reads more bytes into the buffer; false once the listener closed the connection. */
  async #fill(): Promise<boolean> {
    // A closed exchange is read no further, whatever the module would answer.
    if (this.#ended || this.#closed) return false;
    const next = await this.#opening.read();
    if (next.status === "failed") throw new TypeError("The listener connection failed.");
    if (next.status === "end") {
      this.#ended = true;
      return false;
    }
    const joined = new Uint8Array(this.#buffer.byteLength + next.chunk.byteLength);
    joined.set(this.#buffer, 0);
    joined.set(next.chunk, this.#buffer.byteLength);
    this.#buffer = joined;
    return true;
  }

  /** Everything up to `delimiter`, which is consumed and not returned. */
  async until(delimiter: ReadonlyArray<number>, max: number): Promise<Uint8Array<ArrayBuffer>> {
    for (;;) {
      const index = indexOf(this.#buffer, delimiter);
      if (index >= 0) {
        const found = this.#buffer.subarray(0, index);
        this.#buffer = this.#buffer.subarray(index + delimiter.length);
        return found;
      }
      if (this.#buffer.byteLength > max || !(await this.#fill())) throw unreadable();
    }
  }

  /** Up to `max` bytes, waiting for at least one; undefined once the connection ended. */
  async some(max: number): Promise<Uint8Array<ArrayBuffer> | undefined> {
    if (this.#buffer.byteLength === 0 && !(await this.#fill())) return undefined;
    const taken = this.#buffer.subarray(0, Math.min(max, this.#buffer.byteLength));
    this.#buffer = this.#buffer.subarray(taken.byteLength);
    return taken;
  }

  /** Exactly `count` bytes, or a refusal when the connection ends first. */
  async exactly(count: number): Promise<Uint8Array<ArrayBuffer>> {
    while (this.#buffer.byteLength < count) {
      if (!(await this.#fill())) throw unreadable();
    }
    const taken = this.#buffer.subarray(0, count);
    this.#buffer = this.#buffer.subarray(count);
    return taken;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#opening.close();
  }
}

/**
 * Reads one HTTP/1.1 reply's head, then hands its body over as a stream that
 * delivers bytes as the listener sends them. A head, length, or chunking that
 * does not add up fails the response or its stream, so a truncated body never
 * reads as a complete one.
 */
async function readHttpResponse(
  reply: ReplyReader,
  method: string,
  settled: () => void,
): Promise<Response> {
  const head = latin1(await reply.until([13, 10, 13, 10], MAX_HEAD_BYTES));
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
  const chunked = /(?:^|,)\s*chunked\s*$/i.test(headers.get("transfer-encoding") ?? "");
  const lengthText = headers.get("content-length");
  if (!chunked && lengthText !== null && !/^[0-9]+$/.test(lengthText)) throw unreadable();
  if (method === "HEAD" || code === 204 || code === 205 || code === 304) {
    reply.close();
    settled();
    return new PinnedListenerResponse(code, headers, null);
  }
  headers.delete("transfer-encoding");
  let remaining = chunked ? 0 : lengthText === null ? Number.POSITIVE_INFINITY : Number(lengthText);
  let chunksDone = false;
  const finish = (controller: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>): void => {
    reply.close();
    settled();
    controller.close();
  };
  const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
    pull: async (controller) => {
      try {
        if (chunked) {
          if (chunksDone) return finish(controller);
          if (remaining === 0) {
            const sizeLine = latin1(await reply.until([13, 10], 1024));
            const size = /^([0-9A-Fa-f]{1,8})(?:;.*)?$/.exec(sizeLine)?.[1];
            if (size === undefined) throw unreadable();
            remaining = Number.parseInt(size, 16);
            if (remaining === 0) {
              // Trailers, if any, end with an empty line.
              while ((await reply.until([13, 10], MAX_HEAD_BYTES)).byteLength > 0);
              chunksDone = true;
              return finish(controller);
            }
          }
          const data = await reply.some(remaining);
          if (data === undefined) throw unreadable();
          remaining -= data.byteLength;
          if (remaining === 0) await reply.exactly(2).then(requireCrlf);
          controller.enqueue(data);
          return;
        }
        if (remaining === 0) return finish(controller);
        const data = await reply.some(Math.min(remaining, 64 * 1024));
        if (data === undefined) {
          if (Number.isFinite(remaining)) throw unreadable();
          return finish(controller);
        }
        remaining -= data.byteLength;
        controller.enqueue(data);
      } catch (error) {
        reply.close();
        settled();
        controller.error(error);
      }
    },
    cancel: () => {
      reply.close();
      settled();
    },
  });
  return new PinnedListenerResponse(code, headers, body);
}

function requireCrlf(bytes: Uint8Array): void {
  if (bytes[0] !== 13 || bytes[1] !== 10) throw unreadable();
}

/**
 * A response whose body is the exchange's stream. The phone's `Response`
 * cannot hold a stream body, so the body and its readers are served here.
 */
class PinnedListenerResponse extends Response {
  readonly #stream: ReadableStream<Uint8Array<ArrayBuffer>> | null;

  constructor(
    status: number,
    headers: Headers,
    stream: ReadableStream<Uint8Array<ArrayBuffer>> | null,
  ) {
    super(null, { status, headers });
    this.#stream = stream;
  }

  override get body(): ReadableStream<Uint8Array<ArrayBuffer>> | null {
    return this.#stream;
  }

  override async arrayBuffer(): Promise<ArrayBuffer> {
    const bytes = await this.bytes();
    const copy = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(copy).set(bytes);
    return copy;
  }

  override async bytes(): Promise<Uint8Array<ArrayBuffer>> {
    if (this.#stream === null) return new Uint8Array(0);
    const reader = this.#stream.getReader();
    const parts: Uint8Array<ArrayBuffer>[] = [];
    let total = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      parts.push(next.value);
      total += next.value.byteLength;
    }
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      joined.set(part, offset);
      offset += part.byteLength;
    }
    return joined;
  }

  override async text(): Promise<string> {
    return new TextDecoder().decode(await this.bytes());
  }

  override async json(): Promise<unknown> {
    return JSON.parse(await this.text());
  }

  override clone(): Response {
    throw new TypeError("A pinned listener response cannot be cloned.");
  }
}

function indexOf(bytes: Uint8Array, delimiter: ReadonlyArray<number>): number {
  for (let index = 0; index + delimiter.length <= bytes.byteLength; index += 1) {
    if (delimiter.every((byte, offset) => bytes[index + offset] === byte)) return index;
  }
  return -1;
}

/** Header and chunk-size text, one byte per character. */
function latin1(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return text;
}

function unreadable(): TypeError {
  return new TypeError("The listener sent a reply Octant cannot read.");
}
