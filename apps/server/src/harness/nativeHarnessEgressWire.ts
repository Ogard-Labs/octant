/**
 * What the harness tool egress proxy reads before it decides: one HTTP/1.x
 * request head from a confined command and, inside a tunnel, the server name
 * of a TLS ClientHello. Canonical: docs/architecture.md § Harness tool egress
 * rules.
 *
 * Both readers refuse what they cannot read one way only. A proxy and an
 * origin that frame a request differently is how a second request hides inside
 * the first, and a ClientHello split across records is how a server name hides
 * from a reader that looks only at the first one, so a head that is not
 * plainly one request, or a ClientHello that does not parse to the end, is
 * refused rather than guessed at.
 */

export interface ProxyHeaderField {
  /** The name as the client spelled it; compared in lowercase. */
  readonly name: string;
  readonly value: string;
}

interface ProxyRequestHeadFields {
  /** The destination as the request names it, not yet judged. */
  readonly host: string;
  /** The port as the request names it, not yet judged; `80` when an `http://` target omits it. */
  readonly port: string;
  readonly version: "1.0" | "1.1";
  readonly headers: ReadonlyArray<ProxyHeaderField>;
}

export type ProxyRequestHead =
  | ({ readonly kind: "connect" } & ProxyRequestHeadFields)
  | ({
      readonly kind: "forward";
      readonly method: string;
      /** The origin-form target the origin receives. */
      readonly path: string;
    } & ProxyRequestHeadFields);

export type ProxyHeadRead =
  | { readonly status: "incomplete" }
  | { readonly status: "too-large" }
  | { readonly status: "malformed"; readonly detail: string }
  | {
      readonly status: "read";
      readonly head: ProxyRequestHead;
      /** Bytes the head took; anything after it belongs to the request's content or tunnel. */
      readonly headBytes: number;
    };

const HEAD_END = Buffer.from("\r\n\r\n", "latin1");
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const REQUEST_LINE = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+) ([\x21-\x7e]+) HTTP\/1\.([01])$/;
const HEADER_LINE = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*([\t\x20-\x7e\x80-\xff]*?)[ \t]*$/;
const MAX_HEADER_FIELDS = 100;

/** Fields a request may carry once; a second copy is how framing and identity get smuggled. */
const SINGLE_FIELDS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "proxy-authorization",
]);

/**
 * Fields `Connection` may not name. Naming one would make a hop-by-hop strip
 * remove the request's framing or its host on the way to the origin.
 */
const UNSTRIPPABLE_FIELDS = new Set(["host", "content-length", "transfer-encoding"]);

/**
 * Hop-by-hop fields the proxy removes before forwarding a plain request, with
 * any field `Connection` names. `Transfer-Encoding` stays: the content is
 * relayed byte for byte, so its framing has to reach the origin unchanged.
 */
const HOP_BY_HOP_FIELDS = new Set([
  "connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "upgrade",
]);

export function readProxyRequestHead(buffer: Buffer, maxBytes: number): ProxyHeadRead {
  const end = buffer.indexOf(HEAD_END);
  if (end === -1) {
    return buffer.length >= maxBytes ? { status: "too-large" } : { status: "incomplete" };
  }
  const headBytes = end + HEAD_END.length;
  if (headBytes > maxBytes) return { status: "too-large" };
  const lines = buffer.toString("latin1", 0, end).split("\r\n");
  // A bare CR or LF inside a line is a line break one parser sees and another does not.
  if (lines.some((line) => line.includes("\r") || line.includes("\n"))) {
    return malformed("a line ends without CRLF");
  }
  const requestLine = REQUEST_LINE.exec(lines[0] ?? "");
  if (requestLine === null) return malformed("unreadable request line");
  const [, method = "", target = "", minor = ""] = requestLine;
  const version = minor === "0" ? "1.0" : "1.1";

  const headers: ProxyHeaderField[] = [];
  const seen = new Set<string>();
  for (const line of lines.slice(1)) {
    if (line.startsWith(" ") || line.startsWith("\t")) return malformed("folded header line");
    const field = HEADER_LINE.exec(line);
    if (field === null) return malformed("unreadable header line");
    const [, name = "", value = ""] = field;
    const lower = name.toLowerCase();
    if (SINGLE_FIELDS.has(lower) && seen.has(lower)) return malformed(`repeated ${lower}`);
    seen.add(lower);
    headers.push({ name, value });
    if (headers.length > MAX_HEADER_FIELDS) return malformed("too many header fields");
  }

  const contentLength = fieldValue(headers, "content-length");
  const transferEncoding = fieldValue(headers, "transfer-encoding");
  if (contentLength !== undefined && !/^\d{1,15}$/.test(contentLength)) {
    return malformed("unreadable content-length");
  }
  if (transferEncoding !== undefined && transferEncoding.toLowerCase() !== "chunked") {
    return malformed("transfer-encoding other than chunked");
  }
  if (contentLength !== undefined && transferEncoding !== undefined) {
    return malformed("both content-length and transfer-encoding");
  }
  for (const named of connectionOptions(headers)) {
    if (!TOKEN.test(named)) return malformed("unreadable connection option");
    if (UNSTRIPPABLE_FIELDS.has(named)) return malformed(`connection names ${named}`);
  }

  if (method === "CONNECT") {
    if (
      transferEncoding !== undefined ||
      (contentLength !== undefined && Number(contentLength) > 0)
    ) {
      return malformed("CONNECT with content");
    }
    const authority = splitAuthority(target);
    return {
      status: "read",
      headBytes,
      head: { kind: "connect", host: authority.host, port: authority.port, version, headers },
    };
  }

  // Only the absolute form of a plain `http://` request is a proxy request:
  // HTTPS goes through CONNECT, and an origin-form request asks the proxy to
  // be the server.
  if (!/^http:\/\//i.test(target)) return malformed("not an absolute http:// request");
  if (target.includes("#")) return malformed("fragment in request target");
  const rest = target.slice("http://".length);
  const pathStart = rest.search(/[/?]/);
  const authorityText = pathStart === -1 ? rest : rest.slice(0, pathStart);
  const pathText = pathStart === -1 ? "/" : rest.slice(pathStart);
  const authority = splitAuthority(authorityText);
  const port = authority.port.length === 0 ? "80" : authority.port;

  // The origin routes on Host. One that names another host than the target
  // is a request for that other host wearing an allowed host's name.
  const host = fieldValue(headers, "host");
  if (host === undefined) return malformed("no host header");
  if (withoutDefaultPort(host) !== withoutDefaultPort(authorityText)) {
    return malformed("host header names another host than the target");
  }
  return {
    status: "read",
    headBytes,
    head: {
      kind: "forward",
      method,
      path: pathText.startsWith("?") ? `/${pathText}` : pathText,
      host: authority.host,
      port,
      version,
      headers,
    },
  };
}

/**
 * The head the origin receives: origin-form, with the proxy credentials and
 * hop-by-hop fields removed. `Connection: close` replaces the client's own
 * `Connection` so each proxied connection carries one exchange; a client that
 * reused it would otherwise send its next request, for whatever host, down a
 * connection already bound to this destination.
 */
export function forwardedRequestHead(head: Extract<ProxyRequestHead, { kind: "forward" }>): Buffer {
  const named = new Set(connectionOptions(head.headers));
  const lines = [`${head.method} ${head.path} HTTP/${head.version}`];
  for (const field of head.headers) {
    const lower = field.name.toLowerCase();
    if (HOP_BY_HOP_FIELDS.has(lower) || named.has(lower)) continue;
    lines.push(`${field.name}: ${field.value}`);
  }
  lines.push("Connection: close", "", "");
  return Buffer.from(lines.join("\r\n"), "latin1");
}

export function fieldValue(
  headers: ReadonlyArray<ProxyHeaderField>,
  name: string,
): string | undefined {
  return headers.find((field) => field.name.toLowerCase() === name)?.value;
}

function connectionOptions(headers: ReadonlyArray<ProxyHeaderField>): ReadonlyArray<string> {
  return headers
    .filter((field) => field.name.toLowerCase() === "connection")
    .flatMap((field) => field.value.split(","))
    .map((option) => option.trim().toLowerCase())
    .filter((option) => option.length > 0);
}

/** `host:port`, `[v6]:port`, or a bare host; the parts are judged by the egress decision. */
function splitAuthority(authority: string): { readonly host: string; readonly port: string } {
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    if (close === -1) return { host: authority, port: "" };
    const after = authority.slice(close + 1);
    return {
      host: authority.slice(0, close + 1),
      port: after.startsWith(":") ? after.slice(1) : after,
    };
  }
  const colon = authority.lastIndexOf(":");
  return colon === -1
    ? { host: authority, port: "" }
    : { host: authority.slice(0, colon), port: authority.slice(colon + 1) };
}

function withoutDefaultPort(authority: string): string {
  const lower = authority.toLowerCase();
  return lower.endsWith(":80") ? lower.slice(0, -3) : lower;
}

function malformed(detail: string): ProxyHeadRead {
  return { status: "malformed", detail };
}

export type ClientHelloRead =
  | { readonly status: "incomplete" }
  /** The tunnel's first byte is not a TLS handshake record. */
  | { readonly status: "not-tls" }
  /** It starts as a TLS handshake that does not parse, or is larger than the proxy reads. */
  | { readonly status: "unreadable" }
  | { readonly status: "read"; readonly serverName: string | undefined };

const TLS_HANDSHAKE_RECORD = 0x16;
const TLS_CLIENT_HELLO = 0x01;
const TLS_MAX_RECORD = 16_384 + 2_048;
const SERVER_NAME_EXTENSION = 0x0000;
const SERVER_NAME_HOST = 0x00;

/**
 * The server name a ClientHello asks for, reassembled across as many
 * handshake records as it spans. A server name extension holds exactly one
 * host name or the hello is unreadable, so a second name cannot ride behind
 * the one the proxy checks.
 */
export function readClientHelloServerName(buffer: Buffer, maxBytes: number): ClientHelloRead {
  if (buffer.length === 0) return { status: "incomplete" };
  if (buffer[0] !== TLS_HANDSHAKE_RECORD) return { status: "not-tls" };
  const fragments: Buffer[] = [];
  let handshakeBytes = 0;
  let offset = 0;
  for (;;) {
    const handshake = Buffer.concat(fragments, handshakeBytes);
    if (handshake.length >= 4) {
      if (handshake[0] !== TLS_CLIENT_HELLO) return { status: "unreadable" };
      const length = handshake.readUIntBE(1, 3);
      if (length > maxBytes) return { status: "unreadable" };
      if (handshake.length >= 4 + length) {
        // Anything after the hello in the same records is not the hello's to explain.
        return clientHelloServerName(handshake.subarray(4, 4 + length));
      }
    }
    if (offset > maxBytes) return { status: "unreadable" };
    if (buffer.length < offset + 5) return { status: "incomplete" };
    if (buffer[offset] !== TLS_HANDSHAKE_RECORD || buffer[offset + 1] !== 0x03) {
      return { status: "unreadable" };
    }
    const recordLength = buffer.readUInt16BE(offset + 3);
    if (recordLength === 0 || recordLength > TLS_MAX_RECORD) return { status: "unreadable" };
    if (buffer.length < offset + 5 + recordLength) return { status: "incomplete" };
    fragments.push(buffer.subarray(offset + 5, offset + 5 + recordLength));
    handshakeBytes += recordLength;
    offset += 5 + recordLength;
  }
}

function clientHelloServerName(body: Buffer): ClientHelloRead {
  const unreadable = { status: "unreadable" } as const;
  let at = 2 + 32; // legacy version, random
  if (body.length < at + 1) return unreadable;
  at += 1 + (body[at] ?? 0); // session id
  if (body.length < at + 2) return unreadable;
  at += 2 + body.readUInt16BE(at); // cipher suites
  if (body.length < at + 1) return unreadable;
  at += 1 + (body[at] ?? 0); // compression methods
  if (at === body.length) return { status: "read", serverName: undefined };
  if (body.length < at + 2) return unreadable;
  const extensionsEnd = at + 2 + body.readUInt16BE(at);
  if (extensionsEnd !== body.length) return unreadable;
  at += 2;
  let serverName: string | undefined;
  let sawServerName = false;
  while (at < extensionsEnd) {
    if (extensionsEnd < at + 4) return unreadable;
    const type = body.readUInt16BE(at);
    const length = body.readUInt16BE(at + 2);
    const dataStart = at + 4;
    const dataEnd = dataStart + length;
    if (dataEnd > extensionsEnd) return unreadable;
    if (type === SERVER_NAME_EXTENSION) {
      if (sawServerName) return unreadable;
      sawServerName = true;
      const names = serverNames(body.subarray(dataStart, dataEnd));
      if (names === undefined || names.length !== 1) return unreadable;
      serverName = names[0];
    }
    at = dataEnd;
  }
  return { status: "read", serverName };
}

function serverNames(data: Buffer): ReadonlyArray<string> | undefined {
  if (data.length < 2 || data.readUInt16BE(0) !== data.length - 2) return undefined;
  const names: string[] = [];
  let at = 2;
  while (at < data.length) {
    if (data.length < at + 3) return undefined;
    const type = data[at];
    const length = data.readUInt16BE(at + 1);
    const end = at + 3 + length;
    if (end > data.length || type !== SERVER_NAME_HOST || length === 0) return undefined;
    const name = data.toString("latin1", at + 3, end);
    if (!/^[\x21-\x7e]+$/.test(name)) return undefined;
    names.push(name);
    at = end;
  }
  return names;
}
